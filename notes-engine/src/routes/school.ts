import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { DEFAULT_INSTITUTION, institutionOf } from "../lib/classlist";
import { currentSemesterWeek } from "../lib/calendar";

// School-level pages (mounted at /v1):
//  - S44 Guide: one step-by-step guide per school, kept by the admins;
//  - S56 Contributors: who is writing notes for a class's courses, and
//    whether they're keeping up with the semester (class reps + admins).
const router = Router();
router.use(["/guide", "/admin/guide", "/hoc/contributors"], rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey }));

type Me = { id: string; first_name: string | null; role: string | null; is_admin: boolean | null; is_hoc: boolean | null; department: string | null; level: string | null; university: string | null; email: string | null };
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });

async function whoami(req: Request): Promise<{ me: Me | null; admin: boolean }> {
  const { data } = await supabaseAdmin().from("profiles").select("id,first_name,role,is_admin,is_hoc,department,level,university,email").eq("id", uid(req)).maybeSingle();
  const me = data as Me | null;
  let admin = !!me?.is_admin || me?.role === "admin";
  if (!admin && me?.email) {
    const emails = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    admin = emails.includes(me.email.toLowerCase());
  }
  return { me, admin };
}

// ---------- S44 Guide ----------
type Step = { title: string; body: string; where: string };
type Guide = { institution: string; title: string; intro: string; steps: Step[]; published: boolean; updated_at: string };

router.get("/guide", requireAuth, async (req: Request, res: Response) => {
  try {
    const { me, admin } = await whoami(req);
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const institution = admin && typeof req.query.institution === "string" && req.query.institution ? req.query.institution.slice(0, 40) : institutionOf(me);
    const { data, error } = await supabaseAdmin().from("school_guides").select("institution,title,intro,steps,published,updated_at").eq("institution", institution).maybeSingle();
    if (error) throw error;
    const g = data as Guide | null;
    // Students only ever see a published guide; admins see drafts to edit them.
    if (!g || (!g.published && !admin)) return res.json({ guide: null, canEdit: admin });
    res.json({ guide: g, canEdit: admin });
  } catch (e) {
    dbFail(res, e);
  }
});

const stepSchema = z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().max(600).default(""), where: z.string().trim().max(120).default("") });
const guideSchema = z.object({
  institution: z.string().trim().min(2).max(40).default(DEFAULT_INSTITUTION),
  title: z.string().trim().min(2).max(120),
  intro: z.string().trim().max(600).default(""),
  steps: z.array(stepSchema).min(1).max(20),
  published: z.boolean().default(true),
});

router.put("/admin/guide", requireAuth, async (req: Request, res: Response) => {
  const parsed = guideSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Each step needs a title (2+ letters). Up to 20 steps.");
  try {
    const { me, admin } = await whoami(req);
    if (!admin || !me) return fail(res, 403, "Admins only.");
    const d = parsed.data;
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin()
      .from("school_guides")
      .upsert({ institution: d.institution, title: d.title, intro: d.intro, steps: d.steps, published: d.published, updated_by: me.id, updated_at: now }, { onConflict: "institution" });
    if (error) throw error;
    res.json({ ok: true, updated_at: now });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- S56 Contributors ----------
// A class = department + level. Its courses are the ones its students take
// (at least two of them, or one in a very small class). For each course:
// the contributors writing it, the weeks published so far, and whether that
// keeps up with the semester (on track = no more than a week behind).
router.get("/hoc/contributors", requireAuth, async (req: Request, res: Response) => {
  try {
    const { me, admin } = await whoami(req);
    if (!me) return fail(res, 404, "Finish onboarding first.");
    if (!me.is_hoc && !admin) return fail(res, 403, "Class reps only.");
    const department = admin && typeof req.query.department === "string" ? req.query.department : me.department || "";
    const level = admin && typeof req.query.level === "string" ? req.query.level : me.level || "";
    if (!department || !level) return fail(res, 400, "Set your department and level first.");
    const sb = supabaseAdmin();

    const { data: classmates } = await sb.from("profiles").select("id").eq("department", department).eq("level", level).eq("role", "student").limit(2000);
    const ids = ((classmates ?? []) as { id: string }[]).map((p) => p.id);
    const taking: Record<string, number> = {};
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await sb.from("enrollments").select("course").eq("kind", "taking").in("user_id", ids.slice(i, i + 300));
      for (const r of (data ?? []) as { course: string }[]) taking[r.course] = (taking[r.course] || 0) + 1;
    }
    const min = ids.length < 4 ? 1 : 2;
    const courses = Object.keys(taking).filter((c) => taking[c] >= min).sort();
    const week = await currentSemesterWeek();
    if (!courses.length) return res.json({ department, level, week, courses: [], contributors: 0, onTrack: 0, behind: 0 });

    const [{ data: teach }, { data: notes }] = await Promise.all([
      sb.from("enrollments").select("user_id,course").eq("kind", "teaching").in("course", courses),
      sb.from("topic_notes").select("course,week,created_at,author_id,is_seed").in("course", courses).limit(20000),
    ]);
    const teacherIds = [...new Set(((teach ?? []) as { user_id: string }[]).map((t) => t.user_id))];
    const { data: people } = teacherIds.length
      ? await sb.from("profiles").select("id,first_name,role").in("id", teacherIds)
      : { data: [] };
    const who = new Map(((people ?? []) as { id: string; first_name: string | null; role: string | null }[]).map((p) => [p.id, p]));

    const weeksBy: Record<string, Set<number>> = {};
    const lastBy: Record<string, string> = {};
    const lastByAuthor: Record<string, string> = {};
    for (const n of (notes ?? []) as { course: string; week: number; created_at: string; author_id: string | null; is_seed: boolean | null }[]) {
      (weeksBy[n.course] ||= new Set()).add(n.week);
      if (!lastBy[n.course] || n.created_at > lastBy[n.course]) lastBy[n.course] = n.created_at;
      if (n.author_id && !n.is_seed && (!lastByAuthor[`${n.author_id}|${n.course}`] || n.created_at > lastByAuthor[`${n.author_id}|${n.course}`])) lastByAuthor[`${n.author_id}|${n.course}`] = n.created_at;
    }

    const contributorSet = new Set<string>();
    let onTrack = 0;
    let behind = 0;
    const rows = courses.map((course) => {
      const published = weeksBy[course]?.size || 0;
      const latestWeek = weeksBy[course]?.size ? Math.max(...weeksBy[course]) : 0;
      const status: "on_track" | "behind" | "unknown" = week == null ? "unknown" : latestWeek >= week - 1 ? "on_track" : "behind";
      if (status === "on_track") onTrack += 1;
      if (status === "behind") behind += 1;
      const people = ((teach ?? []) as { user_id: string; course: string }[])
        .filter((t) => t.course === course)
        .map((t) => who.get(t.user_id))
        .filter((p): p is NonNullable<typeof p> => !!p && (p.role === "contributor" || p.role === "lecturer"))
        .map((p) => {
          if (p.role === "contributor") contributorSet.add(p.id);
          return { id: p.id, name: p.first_name || "Unnamed", role: p.role as "contributor" | "lecturer", lastPublished: lastByAuthor[`${p.id}|${course}`] || null };
        });
      return { course, students: taking[course], weeksPublished: published, latestWeek, lastPublished: lastBy[course] || null, status, people };
    });
    res.json({ department, level, week, courses: rows, contributors: contributorSet.size, onTrack, behind });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
