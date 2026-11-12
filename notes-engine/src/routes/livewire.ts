import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendPushToUsers } from "../lib/push";
import { DEFAULT_INSTITUTION } from "../lib/classlist";

// Live wire (mounted at /v1): urgent messages with a countdown, at the top
// of Home until the time runs out. Who can send, and to whom:
//  - Unify admins: everyone, a faculty, a department, a class or a course;
//  - deans: their faculty; HODs: their department;
//  - class reps and level admins: their class (department + level);
//  - lecturers and contributors: students taking a course they teach.
const router = Router();
router.use("/livewire", rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey }));
const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey, message: { error: "That's a lot of live wires in an hour. Wait a bit before sending another." } });

type Me = { id: string; first_name: string | null; role: string | null; is_admin: boolean | null; is_hoc: boolean | null; faculty: string | null; department: string | null; level: string | null; email: string | null };
type Grant = { role: "level_admin" | "hod" | "dean"; faculty: string; department: string; level: string };
type Wire = { id: string; author_id: string | null; author_name: string; author_role: string; scope: string; faculty: string; department: string; level: string; course: string; message: string; countdown_label: string; ends_at: string; created_at: string };
type Target = { scope: "all" | "faculty" | "department" | "class" | "course"; faculty?: string; department?: string; level?: string; course?: string; label: string };

const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });
const COLS = "id,author_id,author_name,author_role,scope,faculty,department,level,course,message,countdown_label,ends_at,created_at";

async function load(req: Request) {
  const sb = supabaseAdmin();
  const [{ data: me }, { data: grants }, { data: enr }] = await Promise.all([
    sb.from("profiles").select("id,first_name,role,is_admin,is_hoc,faculty,department,level,email").eq("id", uid(req)).maybeSingle(),
    sb.from("role_grants").select("role,faculty,department,level").eq("user_id", uid(req)),
    sb.from("enrollments").select("course,kind").eq("user_id", uid(req)),
  ]);
  const m = me as Me | null;
  let admin = !!m?.is_admin || m?.role === "admin";
  if (!admin && m?.email) admin = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).includes(m.email.toLowerCase());
  const rows = (enr ?? []) as { course: string; kind: string }[];
  return {
    me: m,
    admin,
    grants: (grants ?? []) as Grant[],
    taking: rows.filter((r) => r.kind === "taking").map((r) => r.course),
    teaching: rows.filter((r) => r.kind === "teaching").map((r) => r.course),
  };
}

// The audiences this person may send to.
function targetsFor(x: Awaited<ReturnType<typeof load>>): Target[] {
  const { me, admin, grants, teaching } = x;
  if (!me) return [];
  const out: Target[] = [];
  if (admin) out.push({ scope: "all", label: "Everyone on Unify" });
  for (const g of grants) {
    if (g.role === "dean") out.push({ scope: "faculty", faculty: g.faculty, label: g.faculty });
    if (g.role === "hod") out.push({ scope: "department", department: g.department, label: g.department });
    if (g.role === "level_admin") out.push({ scope: "class", department: g.department, level: g.level, label: `${g.level} ${g.department}` });
  }
  if (me.is_hoc && me.department && me.level) out.push({ scope: "class", department: me.department, level: me.level, label: `Your class · ${me.level} ${me.department}` });
  if (me.role === "lecturer" || me.role === "contributor" || admin) for (const c of teaching) out.push({ scope: "course", course: c, label: `Students taking ${c}` });
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = `${t.scope}|${t.faculty || ""}|${t.department || ""}|${t.level || ""}|${t.course || ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const roleLabel = (x: Awaited<ReturnType<typeof load>>, t: Target) =>
  x.admin && t.scope === "all" ? "Unify" :
  t.scope === "faculty" ? "Dean" :
  t.scope === "department" ? "Head of department" :
  t.scope === "course" ? (x.me?.role === "contributor" ? "Contributor" : "Lecturer") :
  x.me?.is_hoc ? "Class rep" : x.admin ? "Unify" : "Level admin";

// Does this wire reach this person?
function reaches(w: Wire, me: Me, taking: string[], teaching: string[]): boolean {
  if (w.author_id === me.id) return true;
  switch (w.scope) {
    case "all": return true;
    case "faculty": return !!me.faculty && me.faculty === w.faculty;
    case "department": return !!me.department && me.department === w.department;
    case "class": return me.department === w.department && me.level === w.level;
    case "course": return taking.includes(w.course) || teaching.includes(w.course);
    default: return false;
  }
}

router.get("/livewire", requireAuth, async (req: Request, res: Response) => {
  try {
    const x = await load(req);
    if (!x.me) return fail(res, 404, "Finish onboarding first.");
    const { data, error } = await supabaseAdmin().from("live_wires").select(COLS).is("cancelled_at", null).gt("ends_at", new Date().toISOString()).order("ends_at", { ascending: true }).limit(200);
    if (error) throw error;
    const me = x.me;
    const wires = ((data ?? []) as Wire[])
      .filter((w) => reaches(w, me, x.taking, x.teaching))
      .slice(0, 5)
      .map((w) => ({ id: w.id, message: w.message, author: w.author_name, role: w.author_role, scope: w.scope, course: w.course, level: w.level, department: w.department, label: w.countdown_label, endsAt: w.ends_at, createdAt: w.created_at, mine: w.author_id === me.id, canEnd: w.author_id === me.id || x.admin }));
    res.json({ wires, targets: targetsFor(x) });
  } catch (e) {
    dbFail(res, e);
  }
});

const sendSchema = z.object({
  message: z.string().trim().min(5).max(280),
  scope: z.enum(["all", "faculty", "department", "class", "course"]),
  faculty: z.string().max(120).optional(),
  department: z.string().max(120).optional(),
  level: z.string().max(40).optional(),
  course: z.string().max(20).optional(),
  minutes: z.number().int().min(5).max(7 * 24 * 60),
  label: z.enum(["starts", "deadline", "ends"]).default("ends"),
});

router.post("/livewire", requireAuth, sendLimit, async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Write a message (5 to 280 characters) and pick a time between 5 minutes and 7 days.");
  try {
    const x = await load(req);
    if (!x.me) return fail(res, 404, "Finish onboarding first.");
    const d = parsed.data;
    const t = targetsFor(x).find((o) => o.scope === d.scope && (o.faculty || "") === (d.faculty || "") && (o.department || "") === (d.department || "") && (o.level || "") === (d.level || "") && (o.course || "") === (d.course || ""));
    if (!t) return fail(res, 403, "You can't send a live wire to that group.");
    const sb = supabaseAdmin();
    // Keep it urgent: at most three running at once per sender.
    const { count } = await sb.from("live_wires").select("id", { count: "exact", head: true }).eq("author_id", x.me.id).is("cancelled_at", null).gt("ends_at", new Date().toISOString());
    if ((count ?? 0) >= 3) return fail(res, 409, "You already have three live wires running. End one before sending another.");
    const endsAt = new Date(Date.now() + d.minutes * 60000).toISOString();
    const row = {
      institution: DEFAULT_INSTITUTION, author_id: x.me.id, author_name: x.me.first_name || "", author_role: roleLabel(x, t),
      scope: t.scope, faculty: t.faculty || "", department: t.department || "", level: t.level || "", course: t.course || "",
      message: d.message, countdown_label: d.label, ends_at: endsAt,
    };
    const { data, error } = await sb.from("live_wires").insert(row).select("id").single();
    if (error) throw error;
    res.json({ ok: true, id: (data as { id: string }).id, endsAt });
    // Bell + push for everyone it reaches (after replying: never slow the sender down).
    void (async () => {
      try {
        let ids: string[] = [];
        if (t.scope === "course") {
          const { data: e } = await sb.from("enrollments").select("user_id").eq("course", t.course || "").eq("kind", "taking").limit(5000);
          ids = ((e ?? []) as { user_id: string }[]).map((r) => r.user_id);
        } else {
          let q = sb.from("profiles").select("id").eq("role", "student").limit(10000);
          if (t.scope === "faculty") q = q.eq("faculty", t.faculty || "");
          if (t.scope === "department") q = q.eq("department", t.department || "");
          if (t.scope === "class") q = q.eq("department", t.department || "").eq("level", t.level || "");
          const { data: p } = await q;
          ids = ((p ?? []) as { id: string }[]).map((r) => r.id);
        }
        ids = ids.filter((id) => id !== x.me!.id);
        if (!ids.length) return;
        const title = `Live wire · ${row.author_role}${row.author_name ? ` ${row.author_name}` : ""}`;
        for (let i = 0; i < ids.length; i += 500) {
          await sb.from("notifications").insert(ids.slice(i, i + 500).map((user_id) => ({ user_id, type: "live_wire", title, body: d.message, link: "/home" })));
        }
        await sendPushToUsers(ids, { title, body: d.message, url: "/home" });
      } catch (e) {
        console.warn("[livewire] fan-out failed", e instanceof Error ? e.message : e);
      }
    })();
  } catch (e) {
    dbFail(res, e);
  }
});

// End early: the sender or an admin.
router.delete("/livewire/:id", requireAuth, async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 400, "Unknown live wire.");
  try {
    const x = await load(req);
    if (!x.me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const { data } = await sb.from("live_wires").select("id,author_id").eq("id", req.params.id).maybeSingle();
    const w = data as { id: string; author_id: string | null } | null;
    if (!w) return fail(res, 404, "That live wire is gone.");
    if (w.author_id !== x.me.id && !x.admin) return fail(res, 403, "Only the sender or a Unify admin can end it.");
    const { error } = await sb.from("live_wires").update({ cancelled_at: new Date().toISOString() }).eq("id", w.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
