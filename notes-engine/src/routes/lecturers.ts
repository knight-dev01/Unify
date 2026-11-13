import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendPushToUsers } from "../lib/push";
import { claimStatuses, classKey } from "../lib/lecturerClaims";

// Lecturer side, phase 2 (Review Round 2, design L04 + S62):
//  - GET  /lecturer/claims          my courses with Waiting / confirmed status
//  - POST /lecturer/claims          add courses I teach (works straight away)
//  - DELETE /lecturer/claims/:code  drop a course I added
//  - GET  /hoc/lecturer-checks      class rep: lecturers waiting for my class's answer
//  - POST /hoc/lecturer-checks/:id  class rep: "Yes, they teach us" / "No"
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: (e as { message?: string })?.message || "Something went wrong" });
const clean = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const variants = (c: string) => [...new Set([c, c.replace(/\s/g, "")])];

type Prof = { id: string; first_name: string | null; title: string | null; role: string | null; is_hoc: boolean | null; is_admin: boolean | null; department: string | null; level: string | null; avatar_url: string | null };
async function me(req: Request): Promise<Prof | null> {
  const { data } = await supabaseAdmin().from("profiles").select("id,first_name,title,role,is_hoc,is_admin,department,level,avatar_url").eq("id", uid(req)).maybeSingle();
  return (data as Prof | null) ?? null;
}
const display = (p: { title?: string | null; first_name?: string | null }) => [p.title, p.first_name].filter(Boolean).join(" ") || "A lecturer";

router.get("/lecturer/claims", requireAuth, async (req: Request, res: Response) => {
  try {
    const m = await me(req);
    if (!m || m.role !== "lecturer") return fail(res, 403, "Lecturers only.");
    const { data } = await supabaseAdmin().from("enrollments").select("course").eq("user_id", m.id).eq("kind", "teaching");
    const courses = ((data ?? []) as { course: string }[]).map((r) => r.course);
    const st = await claimStatuses(m.id, courses);
    res.json({ courses: st.map((s) => ({ course: s.course, claimed: s.claimed, confirmed: s.confirmed.length, declined: s.declined.length, waiting: s.claimed && s.confirmed.length === 0 })) });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/lecturer/claims", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ courses: z.array(z.string().min(1).max(20)).min(1).max(20) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick at least one course.");
  try {
    const m = await me(req);
    if (!m || m.role !== "lecturer") return fail(res, 403, "Only lecturers add the courses they teach.");
    const sb = supabaseAdmin();
    const wanted = [...new Set(parsed.data.courses.map(clean))];
    const { data: known } = await sb.from("courses").select("code").in("code", wanted.flatMap(variants));
    const codes = [...new Set(((known ?? []) as { code: string }[]).map((r) => r.code))];
    if (!codes.length) return fail(res, 404, "Those courses aren't in the catalogue yet.");
    const { data: already } = await sb.from("enrollments").select("course").eq("user_id", m.id).eq("kind", "teaching").in("course", codes);
    const had = new Set(((already ?? []) as { course: string }[]).map((r) => r.course));
    const fresh = codes.filter((c) => !had.has(c));
    if (fresh.length) {
      const { error: eErr } = await sb.from("enrollments").upsert(fresh.map((course) => ({ user_id: m.id, course, kind: "teaching" })), { onConflict: "user_id,course" });
      if (eErr) throw eErr;
      const { error: cErr } = await sb.from("lecturer_claims").upsert(fresh.map((course) => ({ lecturer_id: m.id, course })), { onConflict: "lecturer_id,course" });
      if (cErr) throw cErr;
      // Ask the class reps of classes taking each course.
      for (const course of fresh) {
        const { data: takers } = await sb.from("enrollments").select("user_id").in("course", variants(course)).eq("kind", "taking").limit(5000);
        const ids = ((takers ?? []) as { user_id: string }[]).map((t) => t.user_id);
        if (!ids.length) continue;
        const hocs: string[] = [];
        for (let i = 0; i < ids.length; i += 500) {
          const { data } = await sb.from("profiles").select("id").in("id", ids.slice(i, i + 500)).eq("is_hoc", true);
          hocs.push(...((data ?? []) as { id: string }[]).map((p) => p.id));
        }
        if (!hocs.length) continue;
        const title = `Is ${display(m)} your ${course} lecturer?`;
        const body = "Confirm it so their posts and materials reach your class.";
        await sb.from("notifications").insert(hocs.map((user_id) => ({ user_id, type: "lecturer_check", title, body, course, link: "/class" })));
        void sendPushToUsers(hocs, { title, body, url: "/class" }).catch(() => {});
      }
    }
    res.json({ ok: true, added: fresh, already: codes.filter((c) => had.has(c)) });
  } catch (e) {
    dbFail(res, e);
  }
});

router.delete("/lecturer/claims/:code", requireAuth, async (req: Request, res: Response) => {
  try {
    const m = await me(req);
    if (!m || m.role !== "lecturer") return fail(res, 403, "Lecturers only.");
    const course = clean(decodeURIComponent(req.params.code));
    const sb = supabaseAdmin();
    const { data: claim } = await sb.from("lecturer_claims").select("id,course").eq("lecturer_id", m.id).in("course", variants(course)).maybeSingle();
    if (!claim) return fail(res, 403, "That course was assigned by the Unify team. Ask them to remove it.");
    await sb.from("lecturer_claims").delete().eq("id", (claim as { id: string }).id);
    await sb.from("enrollments").delete().eq("user_id", m.id).eq("kind", "teaching").eq("course", (claim as { course: string }).course);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Class rep: lecturers who added one of my class's courses and haven't had
// my class's answer yet.
router.get("/hoc/lecturer-checks", requireAuth, async (req: Request, res: Response) => {
  try {
    const m = await me(req);
    if (!m?.is_hoc || !m.department || !m.level) return res.json({ checks: [] });
    const sb = supabaseAdmin();
    const { data: mine } = await sb.from("enrollments").select("course").eq("user_id", m.id).eq("kind", "taking");
    const courses = ((mine ?? []) as { course: string }[]).flatMap((r) => variants(r.course));
    if (!courses.length) return res.json({ checks: [] });
    const { data: claims } = await sb.from("lecturer_claims").select("id,lecturer_id,course,created_at").in("course", courses);
    const rows = (claims ?? []) as { id: string; lecturer_id: string; course: string; created_at: string }[];
    if (!rows.length) return res.json({ checks: [] });
    const { data: answered } = await sb.from("lecturer_confirmations").select("claim_id").in("claim_id", rows.map((r) => r.id)).eq("department", m.department).eq("level", m.level);
    const done = new Set(((answered ?? []) as { claim_id: string }[]).map((a) => a.claim_id));
    const open = rows.filter((r) => !done.has(r.id));
    if (!open.length) return res.json({ checks: [] });
    const [{ data: lecs }, { data: titles }] = await Promise.all([
      sb.from("profiles").select("id,first_name,title,department,avatar_url").in("id", [...new Set(open.map((r) => r.lecturer_id))]),
      sb.from("courses").select("code,title").in("code", open.map((r) => r.course)),
    ]);
    const who = new Map(((lecs ?? []) as { id: string; first_name: string | null; title: string | null; department: string | null; avatar_url: string | null }[]).map((p) => [p.id, p]));
    const ct = new Map(((titles ?? []) as { code: string; title: string }[]).map((c) => [c.code, c.title]));
    res.json({
      class: `${m.level} ${m.department}`,
      checks: open.map((r) => {
        const p = who.get(r.lecturer_id);
        return { id: r.id, course: r.course, courseTitle: ct.get(r.course) || "", at: r.created_at, lecturer: { id: r.lecturer_id, name: p ? display(p) : "A lecturer", department: p?.department || "", avatar: p?.avatar_url || "" } };
      }),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/hoc/lecturer-checks/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ answer: z.enum(["yes", "no"]) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Answer yes or no.");
  try {
    const m = await me(req);
    if (!m?.is_hoc || !m.department || !m.level) return fail(res, 403, "Only your class rep answers this.");
    const sb = supabaseAdmin();
    const { data: claim } = await sb.from("lecturer_claims").select("id,lecturer_id,course").eq("id", req.params.id).maybeSingle();
    const c = claim as { id: string; lecturer_id: string; course: string } | null;
    if (!c) return fail(res, 404, "That request is gone.");
    const { data: mine } = await sb.from("enrollments").select("course").eq("user_id", m.id).eq("kind", "taking").in("course", variants(c.course)).limit(1);
    if (!mine?.length) return fail(res, 403, "Your class doesn't take that course.");
    const status = parsed.data.answer === "yes" ? "confirmed" : "declined";
    const { error } = await sb.from("lecturer_confirmations").upsert({ claim_id: c.id, department: m.department, level: m.level, status, decided_by: m.id, decided_at: new Date().toISOString() }, { onConflict: "claim_id,department,level" });
    if (error) throw error;
    const cls = `${m.level} ${m.department}`;
    const title = status === "confirmed" ? `${cls} confirmed you for ${c.course}` : `${cls} said you don't teach them ${c.course}`;
    const body = status === "confirmed" ? "Your posts and materials for the course now reach this class." : "If that's a mistake, ask their class rep or the Unify team.";
    await sb.from("notifications").insert({ user_id: c.lecturer_id, type: "lecturer_check", title, body, course: c.course, link: "/home" });
    void sendPushToUsers([c.lecturer_id], { title, body, url: "/home" }).catch(() => {});
    res.json({ ok: true, status, class: classKey(m.department, m.level) });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
