import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { requireAuthor } from "../middleware/requireAuthor";

const router = Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

const TOPIC_XP = 10;

const onboardingSchema = z.object({
  firstName: z.string().min(1).max(60),
  // Only students complete the full flow; lecturers/collaborators stop
  // after name, so these accept missing AND explicit null (client state
  // initializes unpicked fields to null, not undefined).
  university: z.string().min(1).max(120).nullish(),
  faculty: z.string().min(1).max(120).nullish(),
  department: z.string().min(1).max(100).nullish(),
  level: z.string().min(1).max(40).nullish(),
  universityId: z.string().uuid().max(80).optional(),
  gradTarget: z.number().min(0).max(5).optional(),
  role: z.enum(["student", "lecturer", "collaborator"]).default("student"),
});

const profileSchema = onboardingSchema.partial();

const progressSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  topic: z.number().int().min(0).max(100),
});

function dbError(e: unknown): { error: string; message: string } {
  return { error: "Database error", message: e instanceof Error ? e.message : String(e) };
}

function calcStreak(dateIsos: string[]): number {
  const days = new Set(dateIsos.map((d) => d.slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// Public: never dead-ends onboarding when seeded.
router.get("/universities", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("universities")
      .select("id,name,short_name")
      .order("name");
    if (error) throw error;
    res.json(data ?? []);
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: own profile, or onboarded:false when missing.
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { data, error } = await supabaseAdmin().from("profiles").select("*").eq("id", userId).single();
    if (error || !data) {
      res.json({ onboarded: false, profile: null });
      return;
    }
    const p = data as { university?: string; role?: string; first_name?: string; is_admin?: boolean };
    // Students need a university; lecturers/collaborators stop after name.
    const onboarded =
      Boolean(p.university) ||
      ((p.role === "lecturer" || p.role === "collaborator") && Boolean(p.first_name));
    let isAdmin = Boolean(p.is_admin);
    if (!isAdmin) {
      const adminEmails = (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (adminEmails.length) {
        try {
          const uRes = await supabaseAdmin().auth.admin.getUserById(userId);
          const email = ((uRes.data as { user?: { email?: string } } | null)?.user?.email || "").toLowerCase();
          if (email && adminEmails.includes(email)) isAdmin = true;
        } catch {
          // stay non-admin
        }
      }
    }
    res.json({ onboarded, profile: data, isAdmin });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: partial profile update (display name etc). Full setup goes via /onboarding.
router.put("/me", requireAuth, async (req: Request, res: Response) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  const d = parsed.data;
  try {
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .upsert(
        {
          id: userId,
          first_name: d.firstName,
          university: d.university,
          faculty: d.faculty,
          department: d.department,
          level: d.level,
          university_id: d.universityId,
          grad_target: d.gradTarget,
          // role is immutable: never updated via PUT (see POST lock above)
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      )
      .select("*")
      .single();
    if (error) throw error;
    res.json({ ok: true, profile: data });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: complete onboarding (server-validated — replaces client Firestore write).
router.post("/onboarding", requireAuth, async (req: Request, res: Response) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  const d = parsed.data;
  // Roles are immutable: new profiles may set one, existing ones keep theirs.
  try {
    const { data: existing } = await supabaseAdmin()
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();
    const current = (existing as { role?: string } | null)?.role;
    if (current && d.role !== current) {
      res.status(403).json({ error: "Role cannot be changed once assigned" });
      return;
    }
  } catch {
    // No existing profile (or lookup failed) -> treat as new, continue.
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .upsert(
        {
          id: userId,
          first_name: d.firstName,
          university: d.university,
          faculty: d.faculty,
          department: d.department,
          level: d.level,
          university_id: d.universityId ?? null,
          grad_target: d.gradTarget ?? null,
          role: d.role,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      )
      .select("*")
      .single();
    if (error) throw error;
    res.json({ ok: true, profile: data });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: course list, each with its levels. ?level= filters to a level.
router.get("/courses", async (req: Request, res: Response) => {
  const level = String(req.query.level || "");
  try {
    const sb = supabaseAdmin();
    const { data: courses, error } = await sb.from("courses").select("code,title").order("code");
    if (error) throw error;
    const { data: links, error: linkErr } = await sb.from("course_levels").select("course,level");
    if (linkErr) throw linkErr;
    const byCourse: Record<string, string[]> = {};
    for (const l of ((links ?? []) as { course: string; level: string }[])) {
      (byCourse[l.course] = byCourse[l.course] || []).push(l.level);
    }
    let out = ((courses ?? []) as { code: string; title: string }[]).map((c) => ({
      ...c,
      levels: (byCourse[c.code] || []).sort(),
    }));
    if (level) out = out.filter((c) => c.levels.includes(level));
    res.json(out);
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: one week of a course (noteJson payload).
router.get("/courses/:code/weeks/:week", async (req: Request, res: Response) => {
  const code = decodeURIComponent(req.params.code).toUpperCase();
  const week = Number(req.params.week);
  if (!Number.isInteger(week) || week < 1) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const variants = [...new Set([code, code.replace(/\s/g, "")])];
    for (const v of variants) {
      const { data, error } = await sb
        .from("weeks")
        .select("course,week,title,subtitle,note_json")
        .eq("course", v)
        .eq("week", week)
        .single();
      if (!error && data) {
        res.json(data);
        return;
      }
    }
    res.status(404).json({ error: "Week not found" });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: mark topic complete -> +XP, returns total xp + streak.
router.post("/progress", requireAuth, async (req: Request, res: Response) => {
  const parsed = progressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  const { course, week, topic } = parsed.data;
  try {
    const sb = supabaseAdmin();
    const { error: upErr } = await sb.from("topic_progress").upsert(
      { user_id: userId, course, week, topic, done: true, completed_at: new Date().toISOString() },
      { onConflict: "user_id,course,week,topic" }
    );
    if (upErr) throw upErr;
    await sb.from("xp_events").insert({
      user_id: userId,
      amount: TOPIC_XP,
      reason: `topic_complete:${course}:w${week}:t${topic}`,
    });
    const { data: xpRows } = await sb
      .from("xp_events")
      .select("amount,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(120);
    const rows = (xpRows ?? []) as { amount: number; created_at: string }[];
    const xp = rows.reduce((s, r) => s + (r.amount || 0), 0);
    res.json({ ok: true, xp, streak: calcStreak(rows.map((r) => r.created_at)) });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed author: publish a week of notes (creates/overwrites the week row
// learners read). This is how studio-authored content reaches the app.
const publishSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  noteJson: z.object({}).passthrough(),
});

router.post("/publish", requireAuth, requireAuthor, async (req: Request, res: Response) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { course, week, noteJson } = parsed.data;
  const userId = (req as AuthedRequest).userId as string;
  const code = course.toUpperCase();
  const note = noteJson as { title?: unknown; subtitle?: unknown };
  try {
    const { error } = await supabaseAdmin()
      .from("weeks")
      .upsert(
        {
          course: code,
          week,
          author_id: userId,
          title:
            parsed.data.title ??
            (typeof note.title === "string" ? note.title : `Week ${week}`),
          subtitle:
            parsed.data.subtitle ?? (typeof note.subtitle === "string" ? note.subtitle : ""),
          note_json: noteJson,
        },
        { onConflict: "course,week" }
      );
    if (error) throw error;
    res.json({ ok: true, course: code, week });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: xp total + streak + per-course topic counts for the dashboard.
router.get("/stats", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const { data: xpRows } = await sb
      .from("xp_events")
      .select("amount,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);
    const rows = (xpRows ?? []) as { amount: number; created_at: string }[];
    const { data: progRows } = await sb.from("topic_progress").select("course").eq("user_id", userId);
    const counts: Record<string, number> = {};
    for (const r of ((progRows ?? []) as { course: string }[])) {
      counts[r.course] = (counts[r.course] || 0) + 1;
    }
    const { data: quizRows } = await sb.from("quiz_attempts").select("score,total").eq("user_id", userId).limit(200);
    const qa = ((quizRows ?? []) as { score: number; total: number }[]).filter((r) => r.total > 0);
    res.json({
      xp: rows.reduce((s, r) => s + (r.amount || 0), 0),
      streak: calcStreak(rows.map((r) => r.created_at)),
      courses: Object.entries(counts).map(([course, topics]) => ({ course, topics })),
      quizzesTaken: qa.length,
      quizAvg: qa.length ? Math.round((qa.reduce((s, r) => s + r.score / r.total, 0) / qa.length) * 100) : 0,
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: completed topic indices for one week (client holds nothing locally).
router.get("/progress", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const course = String(req.query.course || "").toUpperCase();
  const week = Number(req.query.week);
  if (!course || !Number.isInteger(week) || week < 1) {
    res.status(400).json({ error: "Invalid course/week" });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("topic_progress")
      .select("topic")
      .eq("user_id", userId)
      .eq("course", course)
      .eq("week", week);
    if (error) throw error;
    res.json({ done: ((data ?? []) as { topic: number }[]).map((r) => r.topic) });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: weeks this user published (author dashboard lists own notes).
router.get("/authored", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { data, error } = await supabaseAdmin()
      .from("weeks")
      .select("course,week,title,subtitle")
      .eq("author_id", userId)
      .order("course")
      .order("week");
    if (error) throw error;
    res.json({ notes: data ?? [] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: week list for a course (titles for pickers + student week lists).
router.get("/courses/:code/weeks", async (req: Request, res: Response) => {
  const code = decodeURIComponent(req.params.code).toUpperCase();
  try {
    const sb = supabaseAdmin();
    const variants = [...new Set([code, code.replace(/\s/g, "")])];
    const seen = new Map<number, { week: number; title: string; subtitle: string }>();
    for (const v of variants) {
      const { data, error } = await sb
        .from("weeks")
        .select("week,title,subtitle")
        .eq("course", v)
        .order("week");
      if (error) throw error;
      for (const r of ((data ?? []) as { week: number; title: string; subtitle: string }[])) {
        if (!seen.has(r.week)) seen.set(r.week, r);
      }
    }
    res.json({ weeks: [...seen.values()].sort((a, b) => a.week - b.week) });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin (platform owner): stats, user management ----
async function requireAdminUser(req: Request, res: Response): Promise<string | null> {
  const userId = (req as AuthedRequest).userId;
  if (!userId) {
    res.status(401).json({ error: "Missing session" });
    return null;
  }
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("profiles").select("is_admin").eq("id", userId).single();
    if ((data as { is_admin?: boolean } | null)?.is_admin) return userId;
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.length) {
      const uRes = await sb.auth.admin.getUserById(userId);
      const email = ((uRes.data as { user?: { email?: string } } | null)?.user?.email || "").toLowerCase();
      if (email && adminEmails.includes(email)) return userId;
    }
  } catch {
    // deny below
  }
  res.status(403).json({ error: "Admin only" });
  return null;
}

router.get("/admin/stats", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const [users, weeks, xp] = await Promise.all([
      sb.from("profiles").select("id,role", { count: "exact" }),
      sb.from("weeks").select("course", { count: "exact" }),
      sb.from("xp_events").select("amount"),
    ]);
    const rows = ((users.data ?? []) as { role?: string }[]);
    const byRole: Record<string, number> = {};
    for (const r of rows) {
      const k = r.role || "unknown";
      byRole[k] = (byRole[k] || 0) + 1;
    }
    const xpRows = ((xp.data ?? []) as { amount: number }[]);
    res.json({
      users: users.count ?? rows.length,
      byRole,
      weeks: weeks.count ?? 0,
      xpTotal: xpRows.reduce((s, r) => s + (r.amount || 0), 0),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.get("/admin/users", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const q = String(req.query.q || "").toLowerCase();
  const role = String(req.query.role || "");
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    let query = supabaseAdmin()
      .from("profiles")
      .select("id,first_name,email,university,faculty,department,level,role,is_admin,created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (role === "student" || role === "lecturer" || role === "collaborator") {
      query = query.eq("role", role);
    }
    const { data, error } = await query;
    if (error) throw error;
    let rows = ((data ?? []) as Record<string, unknown>[]);
    if (q) {
      rows = rows.filter(
        (r) =>
          String(r.first_name || "").toLowerCase().includes(q) ||
          String(r.email || "").toLowerCase().includes(q)
      );
    }
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

const adminUserSchema = z.object({
  role: z.enum(["student", "lecturer", "collaborator"]).optional(),
  is_admin: z.boolean().optional(),
});

router.patch("/admin/users/:id", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = adminUserSchema.safeParse(req.body);
  if (!parsed.success || (!("role" in parsed.data) && !("is_admin" in parsed.data))) {
    res.status(400).json({ error: "Provide role and/or is_admin" });
    return;
  }
  if (req.params.id === adminId && parsed.data.is_admin === false) {
    res.status(403).json({ error: "You cannot remove your own admin flag" });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error) throw error;
    res.json({ ok: true, profile: data });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.delete("/admin/users/:id", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  if (req.params.id === adminId) {
    res.status(403).json({ error: "You cannot delete yourself" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    try {
      await sb.auth.admin.deleteUser(req.params.id);
    } catch {
      // auth row may already be gone; profile delete still proceeds
    }
    const { error } = await sb.from("profiles").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin catalog: universities ----
const adminUniSchema = z.object({
  name: z.string().min(1).max(120),
  short_name: z.string().max(20).optional(),
});

router.post("/admin/universities", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = adminUniSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("universities")
      .upsert(
        { name: parsed.data.name, short_name: parsed.data.short_name ?? null },
        { onConflict: "name" }
      )
      .select("*")
      .single();
    if (error) throw error;
    res.json({ ok: true, university: data });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.delete("/admin/universities/:id", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    await sb.from("profiles").update({ university_id: null }).eq("university_id", req.params.id);
    const { error } = await sb.from("universities").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin catalog: courses per level ----
const adminCourseSchema = z.object({
  code: z.string().min(1).max(20),
  title: z.string().min(1).max(120),
  levels: z.array(z.string().min(1).max(40)).min(1).max(8),
});

router.post("/admin/courses", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = adminCourseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const code = parsed.data.code.toUpperCase();
  try {
    const sb = supabaseAdmin();
    const { error: cErr } = await sb.from("courses").upsert({ code, title: parsed.data.title }, { onConflict: "code" });
    if (cErr) throw cErr;
    await sb.from("course_levels").delete().eq("course", code);
    const { error: lErr } = await sb
      .from("course_levels")
      .insert(parsed.data.levels.map((level) => ({ course: code, level })));
    if (lErr) throw lErr;
    res.json({ ok: true, course: code });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.delete("/admin/courses/:code", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const code = decodeURIComponent(req.params.code).toUpperCase();
    await sb.from("course_levels").delete().eq("course", code);
    const { error } = await sb.from("courses").delete().eq("code", code);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin: invite a user by email (Supabase sends the invite; the
// profile shell carries the starting role so onboarding resumes correctly).
router.post("/admin/users/invite", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = z
    .object({
      email: z.string().email().max(120),
      role: z.enum(["student", "lecturer", "collaborator"]).default("student"),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.auth.admin.inviteUserByEmail(parsed.data.email);
    if (error) throw error;
    const newId = (data as { user?: { id?: string } } | null)?.user?.id;
    if (newId) {
      await sb.from("profiles").upsert(
        { id: newId, email: parsed.data.email.toLowerCase(), role: parsed.data.role },
        { onConflict: "id" }
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: record a completed quiz attempt (feeds stats: taken + average).
const quizSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  score: z.number().int().min(0).max(100),
  total: z.number().int().min(1).max(100),
});

router.post("/quiz/attempt", requireAuth, async (req: Request, res: Response) => {
  const parsed = quizSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.score > parsed.data.total) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { error } = await supabaseAdmin().from("quiz_attempts").insert({
      user_id: userId,
      course: parsed.data.course.toUpperCase(),
      week: parsed.data.week,
      score: parsed.data.score,
      total: parsed.data.total,
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin: AI model registry health ----
router.get("/admin/models", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    if (req.query.refresh) {
      const { syncModelsOnce } = await import("../lib/ai");
      await syncModelsOnce().catch(() => {});
    }
    const { data, error } = await supabaseAdmin()
      .from("ai_models")
      .select("model,failures,last_ok")
      .order("failures")
      .order("model");
    if (error) throw error;
    res.json({
      provider: (process.env.AI_PROVIDER || "gemini").toLowerCase(),
      default: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      models: data ?? [],
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.post("/admin/models/reset", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = z.object({ model: z.string().max(120).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    if (parsed.data.model) {
      const { error } = await sb.from("ai_models").update({ failures: 0 }).eq("model", parsed.data.model);
      if (error) throw error;
    } else {
      const { error } = await sb.from("ai_models").update({ failures: 0 }).neq("model", "");
      if (error) throw error;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

export default router;
