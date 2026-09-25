import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { notifyCoursePublished, notifyInAppNewNote } from "../lib/email";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { requireAuthor } from "../middleware/requireAuthor";

const router = Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

const TOPIC_XP = 10;

// Course codes are user-typed in several places: normalize once (trim +
// upper) and treat blank as invalid. Without this, a whitespace-only code
// sails through min(1) validation and poisons lookups with invisible rows.
function cleanCode(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  return s ? s : null;
}

const LEVEL_ORDER = ["100 Level", "200 Level", "300 Level", "400 Level", "500 Level"];
const SEMESTERS = ["First Semester", "Second Semester"] as const;

// Admin-owned active semester (students see only this semester's courses).
async function getCurrentSemester(): Promise<string> {
  try {
    const { data } = await supabaseAdmin()
      .from("app_settings")
      .select("value")
      .eq("key", "current_semester")
      .single();
    const v = (data as { value?: string } | null)?.value;
    if (v && (SEMESTERS as readonly string[]).includes(v)) return v;
  } catch {
    // fall through to default
  }
  return "First Semester";
}

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
  semester: z.string().min(1).max(40).optional(),
  courses: z.array(z.string().min(1).max(20)).max(30).optional(),
});

const profileSchema = onboardingSchema.partial().extend({ notifyNewNotes: z.boolean().optional() });

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
    const p = data as {
      university?: string;
      role?: string;
      first_name?: string;
      is_admin?: boolean;
      email?: string;
      email_confirmed?: boolean;
    };
    // Students need a university; lecturers/collaborators/admins stop after name.
    const onboarded =
      Boolean(p.university) ||
      ((p.role === "lecturer" || p.role === "collaborator" || p.role === "admin") && Boolean(p.first_name));
    // One-time backfill (then only while unconfirmed): email + confirmation
    // from Auth, so publish notifications can reach confirmed inboxes.
    if (!p.email || !p.email_confirmed) {
      try {
        const uRes = await supabaseAdmin().auth.admin.getUserById(userId);
        const u = (uRes.data as { user?: { email?: string; email_confirmed_at?: string } } | null)?.user;
        if (u?.email) {
          await supabaseAdmin()
            .from("profiles")
            .update({
              email: u.email.toLowerCase(),
              email_confirmed: Boolean(u.email_confirmed_at),
              updated_at: new Date().toISOString(),
            })
            .eq("id", userId);
          p.email = u.email.toLowerCase();
          p.email_confirmed = Boolean(u.email_confirmed_at);
        }
      } catch {
        // notify targeting degrades gracefully without it
      }
    }
    // Effective admin: the is_admin flag, ADMIN_EMAILS, or the admin role.
    // (Admin is a first-class role now; the flag stays for older accounts.)
    let isAdmin = Boolean(p.is_admin) || p.role === "admin";
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
    const { data: enrolled } = await supabaseAdmin()
      .from("enrollments")
      .select("course")
      .eq("user_id", userId);
    // Never hand blank codes to clients (they render as ghost courses).
    const courses = ((enrolled ?? []) as { course: string }[])
      .map((r) => r.course)
      .filter((c) => c && c.trim());
    // Resume: live position if tracked, else the most recently completed
    // topic (pre-tracking progress still resumes somewhere sensible).
    let resume: { course: string; week: number; topic: number } | null = null;
    const { data: saved } = await supabaseAdmin()
      .from("resume_state")
      .select("course,week,topic")
      .eq("user_id", userId)
      .single();
    if (saved) {
      const r = saved as { course: string; week: number; topic: number };
      if (r.course) resume = { course: r.course, week: r.week, topic: r.topic };
    } else {
      const { data: last } = await supabaseAdmin()
        .from("topic_progress")
        .select("course,week,topic")
        .eq("user_id", userId)
        .order("completed_at", { ascending: false })
        .limit(1);
      const row = ((last ?? []) as { course: string; week: number; topic: number }[])[0];
      if (row && row.course) resume = { course: row.course, week: row.week, topic: row.topic };
    }
    res.json({ onboarded, profile: data, isAdmin, courses, resume });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: platform settings students need (active semester picker source).
router.get("/settings", async (_req: Request, res: Response) => {
  res.json({ currentSemester: await getCurrentSemester() });
});

// Authed: enroll/unenroll in a course (taking for students, teaching for
// authors). This is the post-onboarding enrollment path (catalog buttons).
router.post("/enrollments", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ course: z.string().min(1).max(20), enroll: z.boolean() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  const code = cleanCode(parsed.data.course);
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data: courseRow } = await sb.from("courses").select("code").eq("code", code).single();
    if (!courseRow) {
      res.status(404).json({ error: "Course not found" });
      return;
    }
    if (parsed.data.enroll) {
      const { data: prof } = await sb.from("profiles").select("role").eq("id", userId).single();
      const kind = (prof as { role?: string } | null)?.role === "student" ? "taking" : "teaching";
      const { error } = await sb
        .from("enrollments")
        .upsert({ user_id: userId, course: code, kind }, { onConflict: "user_id,course" });
      if (error) throw error;
    } else {
      const { error } = await sb.from("enrollments").delete().eq("user_id", userId).eq("course", code);
      if (error) throw error;
    }
    const { data: enrolled } = await sb.from("enrollments").select("course").eq("user_id", userId);
    res.json({ ok: true, enrolled: ((enrolled ?? []) as { course: string }[]).map((r) => r.course) });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: re-enroll in every course with traces of this user (progress,
// resume). Self-heal for accounts whose enrollments were wiped (promote,
// admin cleanup) while learning history survived. Taking-kind only;
// existing rows untouched.
router.post("/enrollments/repair", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const [prog, resume, known] = await Promise.all([
      sb.from("topic_progress").select("course").eq("user_id", userId).limit(500),
      sb.from("resume_state").select("course").eq("user_id", userId).single(),
      sb.from("courses").select("code"),
    ]);
    const valid = new Set(
      ((known.data ?? []) as { code: string }[]).map((r) => r.code.toUpperCase())
    );
    const found = new Set<string>();
    for (const r of ((prog.data ?? []) as { course: string }[])) {
      const c = String(r.course || "").trim().toUpperCase();
      if (c && valid.has(c)) found.add(c);
    }
    const rc = (resume.data as { course?: string } | null)?.course;
    if (rc && rc.trim() && valid.has(rc.trim().toUpperCase())) {
      found.add(rc.trim().toUpperCase());
    }
    const { data: prof } = await sb.from("profiles").select("role").eq("id", userId).single();
    const kind = (prof as { role?: string } | null)?.role === "student" ? "taking" : "teaching";
    let restored = 0;
    for (const course of found) {
      const { error } = await sb
        .from("enrollments")
        .upsert({ user_id: userId, course, kind }, { onConflict: "user_id,course" });
      if (error) throw error;
      restored += 1;
    }
    const { data: enrolled } = await sb.from("enrollments").select("course").eq("user_id", userId);
    res.json({
      ok: true,
      restored,
      enrolled: ((enrolled ?? []) as { course: string }[]).map((r) => r.course),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});
// Authed: record the live learning position (week view / tab switch feeds
// the dashboard Resume card). Topic here is the reader tab index.
router.post("/resume", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({
      course: z.string().min(1).max(20),
      week: z.number().int().min(1).max(52),
      topic: z.number().int().min(0).max(100),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  const course = cleanCode(parsed.data.course);
  if (!course) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  try {
    const { error } = await supabaseAdmin()
      .from("resume_state")
      .upsert(
        {
          user_id: userId,
          course,
          week: parsed.data.week,
          topic: parsed.data.topic,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
    if (error) throw error;
    res.json({ ok: true });
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
          ...(typeof d.notifyNewNotes === "boolean" ? { notify_new_notes: d.notifyNewNotes } : {}),
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

// Authed: latest notifications + unread count (the bell badge polls this).
router.get("/notifications", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("notifications")
      .select("id,type,title,body,course,week,topic,link,read,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    const { count, error: cErr } = await sb
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("read", false);
    if (cErr) throw cErr;
    res.json({ notifications: data ?? [], unread: count ?? 0 });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: mark notifications read (explicit ids, or all:true).
router.post("/notifications/read", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ ids: z.array(z.string().uuid()).max(50).optional(), all: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  if (!parsed.data.ids?.length && !parsed.data.all) {
    res.status(400).json({ error: "Provide ids or all:true" });
    return;
  }
  const userId = (req as AuthedRequest).userId as string;
  try {
    const query = supabaseAdmin().from("notifications").update({ read: true }).eq("user_id", userId);
    if (parsed.data.ids?.length) query.in("id", parsed.data.ids);
    const { error } = await query;
    if (error) throw error;
    res.json({ ok: true });
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
  let isNewProfile = true;
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
    isNewProfile = !current;
  } catch {
    // No existing profile (or lookup failed) -> treat as new, continue.
    isNewProfile = true;
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
          semester: d.semester ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      )
      .select("*")
      .single();
    if (error) throw error;
    // Enrollments: full replace (taking for students, teaching for authors).
    if (d.courses && d.courses.length) {
      const sb2 = supabaseAdmin();
      const codes = [...new Set(d.courses.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
      const { data: known } = await sb2.from("courses").select("code").in("code", codes);
      const valid = new Set(((known ?? []) as { code: string }[]).map((r) => r.code));
      const kind = d.role === "student" ? "taking" : "teaching";
      await sb2.from("enrollments").delete().eq("user_id", userId);
      const rows = codes.filter((c) => valid.has(c)).map((course) => ({ user_id: userId, course, kind }));
      if (rows.length) {
        const { error: eErr } = await sb2.from("enrollments").insert(rows);
        if (eErr) throw eErr;
      }
    }
    // First onboarding ever: drop a welcome notification (re-saves skip it).
    if (isNewProfile) {
      try {
        const student = d.role === "student";
        await supabaseAdmin().from("notifications").insert({
          user_id: userId,
          type: "welcome",
          title: "Welcome to Unify Learn",
          body: student
            ? "Your courses are set. Open Week 1 of any course and mark your first topic complete."
            : "Your author account is ready. Open the Studio to publish your first topic.",
          link: student ? "/course" : "/studio",
        });
      } catch {
        // onboarding must never fail on a nicety
      }
    }
    res.json({ ok: true, profile: data });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: course list with levels + semesters. ?level= / ?semester= filter.
router.get("/courses", async (req: Request, res: Response) => {
  const level = String(req.query.level || "");
  const semester = String(req.query.semester || "");
  try {
    const sb = supabaseAdmin();
    const { data: courses, error } = await sb.from("courses").select("code,title").order("code");
    if (error) throw error;
    const { data: links, error: linkErr } = await sb.from("course_levels").select("course,level,semester");
    if (linkErr) throw linkErr;
    const byCourse: Record<string, { levels: string[]; semesters: string[] }> = {};
    for (const l of ((links ?? []) as { course: string; level: string; semester: string }[])) {
      const e = (byCourse[l.course] = byCourse[l.course] || { levels: [], semesters: [] });
      if (!e.levels.includes(l.level)) e.levels.push(l.level);
      if (l.semester && !e.semesters.includes(l.semester)) e.semesters.push(l.semester);
    }
    let out = ((courses ?? []) as { code: string; title: string }[])
      .filter((c) => c.code && c.code.trim())
      .map((c) => ({
      ...c,
      levels: (byCourse[c.code]?.levels || []).sort(),
      semesters: (byCourse[c.code]?.semesters || []).sort(),
    }));
    if (level) out = out.filter((c) => c.levels.includes(level));
    if (semester) out = out.filter((c) => c.semesters.includes(semester));
    res.json(out);
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: one week of a course. Topics assemble from the latest version
// of each topic_note (v1, v2, v3...); the weeks row is only the shell
// (title/subtitle/eoq). Legacy week-embedded topics still work until the
// boot backfill moves them into topic_notes.
type TopicNoteRow = {
  id: string;
  course: string;
  week: number;
  topic: number;
  version: number;
  title: string;
  note_json: unknown;
  author_id: string | null;
  created_at: string;
};

type TopicMeta = {
  topic: number;
  version: number;
  id: string;
  title: string;
  authorId: string | null;
  versions: { id: string; version: number; authorId: string | null; createdAt: string }[];
};

function courseVariants(code: string): string[] {
  return [...new Set([code, code.replace(/\s/g, "")])];
}

async function topicRowsFor(course: string, week: number): Promise<TopicNoteRow[]> {
  const sb = supabaseAdmin();
  const out: TopicNoteRow[] = [];
  for (const v of courseVariants(course)) {
    const { data, error } = await sb
      .from("topic_notes")
      .select("id,course,week,topic,version,title,note_json,author_id,created_at")
      .eq("course", v)
      .eq("week", week)
      .order("topic")
      .order("version", { ascending: false });
    if (error) throw error;
    out.push(...((data ?? []) as TopicNoteRow[]));
  }
  return out;
}

function groupTopics(rows: TopicNoteRow[]): { topics: unknown[]; meta: TopicMeta[] } {
  const byTopic = new Map<number, TopicNoteRow[]>();
  for (const r of rows) {
    const list = byTopic.get(r.topic) || [];
    list.push(r);
    byTopic.set(r.topic, list);
  }
  const topics: unknown[] = [];
  const meta: TopicMeta[] = [];
  for (const [num, list] of [...byTopic.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => b.version - a.version);
    topics.push(sorted[0].note_json);
    meta.push({
      topic: num,
      version: sorted[0].version,
      id: sorted[0].id,
      title: sorted[0].title,
      authorId: sorted[0].author_id,
      versions: sorted.map((r) => ({
        id: r.id,
        version: r.version,
        authorId: r.author_id,
        createdAt: r.created_at,
      })),
    });
  }
  return { topics, meta };
}

router.get("/courses/:code/weeks/:week", async (req: Request, res: Response) => {
  const code = cleanCode(decodeURIComponent(req.params.code));
  const week = Number(req.params.week);
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  if (!Number.isInteger(week) || week < 1) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    let shell: { course: string; week: number; title: string; subtitle: string; note_json: unknown } | null = null;
    for (const v of courseVariants(code)) {
      const { data, error } = await sb
        .from("weeks")
        .select("course,week,title,subtitle,note_json")
        .eq("course", v)
        .eq("week", week)
        .single();
      if (!error && data) {
        shell = data as { course: string; week: number; title: string; subtitle: string; note_json: unknown };
        break;
      }
    }
    const rows = await topicRowsFor(code, week);
    if (!shell && rows.length === 0) {
      res.status(404).json({ error: "Week not found" });
      return;
    }
    if (rows.length === 0 && shell) {
      res.json({ ...shell, topicMeta: [] });
      return;
    }
    const { topics, meta } = groupTopics(rows);
    const shellNote = ((shell?.note_json ?? {}) as Record<string, unknown>) || {};
    const course = shell?.course ?? rows[0].course;
    const title = shell?.title || (typeof shellNote.title === "string" ? shellNote.title : `Week ${week}`);
    const subtitle = shell?.subtitle || (typeof shellNote.subtitle === "string" ? shellNote.subtitle : "");
    res.json({
      course,
      week,
      title,
      subtitle,
      note_json: { ...shellNote, course, week, title, subtitle, topics },
      topicMeta: meta,
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: per-topic version lists for a week (reader badges + author tools).
router.get("/courses/:code/weeks/:week/topics", async (req: Request, res: Response) => {
  const code = cleanCode(decodeURIComponent(req.params.code));
  const week = Number(req.params.week);
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  if (!Number.isInteger(week) || week < 1) {
    res.status(400).json({ error: "Invalid week" });
    return;
  }
  try {
    const { meta } = groupTopics(await topicRowsFor(code, week));
    res.json({ topics: meta });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: one published topic version (for viewing older v1, v2...).
router.get("/notes/:id", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("topic_notes")
      .select("id,course,week,topic,version,title,note_json,author_id,created_at")
      .eq("id", req.params.id)
      .single();
    if (error || !data) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    const r = data as TopicNoteRow;
    res.json({
      id: r.id,
      course: r.course,
      week: r.week,
      topic: r.topic,
      version: r.version,
      title: r.title,
      noteJson: r.note_json,
      authorId: r.author_id,
      createdAt: r.created_at,
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: delete one topic version. Authors delete their own; admins any.
// Older versions automatically become current again.
router.delete("/notes/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const { data: found, error: findErr } = await sb
      .from("topic_notes")
      .select("id,course,week,topic,author_id")
      .eq("id", req.params.id)
      .single();
    if (findErr || !found) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    const row = found as { id: string; course: string; week: number; topic: number; author_id: string | null };
    const owner = row.author_id === userId;
    let admin = false;
    if (!owner) {
      const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", userId).single();
      admin = Boolean((prof as { is_admin?: boolean } | null)?.is_admin);
    }
    if (!owner && !admin) {
      res.status(403).json({ error: "You can only delete your own notes" });
      return;
    }
    const { error: delErr } = await sb.from("topic_notes").delete().eq("id", req.params.id);
    if (delErr) throw delErr;
    const { count } = await sb
      .from("topic_notes")
      .select("id", { count: "exact", head: true })
      .eq("course", row.course)
      .eq("week", row.week)
      .eq("topic", row.topic);
    res.json({ ok: true, remaining: count ?? 0 });
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
  const { week, topic } = parsed.data;
  const course = cleanCode(parsed.data.course);
  if (!course) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { error: upErr } = await sb.from("topic_progress").upsert(
      { user_id: userId, course, week, topic, done: true, completed_at: new Date().toISOString() },
      { onConflict: "user_id,course,week,topic" }
    );
    if (upErr) throw upErr;
    // Keep the Resume card on the just-completed position.
    await sb.from("resume_state").upsert(
      {
        user_id: userId,
        course,
        week,
        topic,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
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

// Authed author: publish a week of notes. Each topic is stored as a NEW
// version row (v1, v2, v3...) — publishing never overwrites, so re-testing
// Week 1 stacks a new version instead of killing the previous note.
// Identical content still stacks (explicit product choice).
const publishSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  noteJson: z.object({}).passthrough(),
});

async function nextTopicVersion(course: string, week: number, topic: number): Promise<number> {
  const { data } = await supabaseAdmin()
    .from("topic_notes")
    .select("version")
    .eq("course", course)
    .eq("week", week)
    .eq("topic", topic)
    .order("version", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as { version: number }[];
  return (rows[0]?.version || 0) + 1;
}

router.post("/publish", requireAuth, requireAuthor, async (req: Request, res: Response) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { course, week, noteJson } = parsed.data;
  const userId = (req as AuthedRequest).userId as string;
  const code = cleanCode(course);
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  const note = noteJson as { title?: unknown; subtitle?: unknown; topics?: unknown };
  const topics = Array.isArray(note.topics) ? (note.topics as Record<string, unknown>[]) : [];
  try {
    const sb = supabaseAdmin();
    // Safety: a course deleted mid-authoring must not FK-fail the publish.
    // Insert-only so admin-customized titles are never overwritten.
    const { data: courseRow } = await sb.from("courses").select("code").eq("code", code).single();
    if (!courseRow) {
      const { error: cErr } = await sb.from("courses").insert({ code, title: code });
      if (cErr) throw cErr;
    }
    // Week shell keeps title/subtitle/eoq only; topics live in topic_notes.
    const { error: shellErr } = await sb.from("weeks").upsert(
      {
        course: code,
        week,
        author_id: userId,
        title:
          parsed.data.title ??
          (typeof note.title === "string" ? note.title : `Week ${week}`),
        subtitle:
          parsed.data.subtitle ?? (typeof note.subtitle === "string" ? note.subtitle : ""),
        note_json: { ...(noteJson as Record<string, unknown>), topics: [] },
      },
      { onConflict: "course,week" }
    );
    if (shellErr) throw shellErr;
    const versions: { topic: number; version: number; id: string }[] = [];
    for (const t of topics) {
      const num = Number(t.number);
      if (!Number.isInteger(num) || num < 1 || num > 100) continue;
      const version = await nextTopicVersion(code, week, num);
      const { data: ins, error: insErr } = await sb
        .from("topic_notes")
        .insert({
          course: code,
          week,
          topic: num,
          version,
          title: typeof t.title === "string" ? t.title : "",
          note_json: t,
          author_id: userId,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      versions.push({ topic: num, version, id: (ins as { id: string }).id });
    }
    res.json({ ok: true, course: code, week, versions });
    // Notify enrolled students (fire-and-forget; never blocks publish).
    if (versions.length) {
      void notifyCoursePublished(code, week, versions).catch(() => {});
      void notifyInAppNewNote(code, week, versions).catch(() => {});
    }
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed author: publish ONE topic (new version v1, v2, v3...).
// Creates the week shell when missing so the week appears in lists.
const topicPublishSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  topic: z.number().int().min(1).max(100),
  title: z.string().max(200).optional(),
  noteJson: z.object({}).passthrough(),
});

router.post("/topics/publish", requireAuth, requireAuthor, async (req: Request, res: Response) => {
  const parsed = topicPublishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { course, week, topic, noteJson } = parsed.data;
  const userId = (req as AuthedRequest).userId as string;
  const code = cleanCode(course);
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  const single = noteJson as { title?: unknown };
  try {
    const sb = supabaseAdmin();
    const { data: courseRow } = await sb.from("courses").select("code").eq("code", code).single();
    if (!courseRow) {
      const { error: cErr } = await sb.from("courses").insert({ code, title: code });
      if (cErr) throw cErr;
    }
    const { data: shell } = await sb
      .from("weeks")
      .select("course")
      .eq("course", code)
      .eq("week", week)
      .single();
    if (!shell) {
      const { error: shellErr } = await sb.from("weeks").insert({
        course: code,
        week,
        author_id: userId,
        title: `Week ${week}`,
        subtitle: "",
        note_json: { course: code, week, topics: [], eoq: { questions: [] } },
      });
      if (shellErr) throw shellErr;
    }
    const version = await nextTopicVersion(code, week, topic);
    const { data: ins, error: insErr } = await sb
      .from("topic_notes")
      .insert({
        course: code,
        week,
        topic,
        version,
        title:
          parsed.data.title ?? (typeof single.title === "string" ? single.title : `Topic ${topic}`),
        note_json: noteJson,
        author_id: userId,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;
    res.json({ ok: true, id: (ins as { id: string }).id, version });
    // Notify enrolled students (fire-and-forget; never blocks publish).
    void notifyCoursePublished(code, week, [{ topic, version }]).catch(() => {});
    void notifyInAppNewNote(code, week, [{ topic, version }]).catch(() => {});
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
  const course = String(req.query.course || "").trim().toUpperCase();
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

// Authed author: impact stats for the author dashboard (topics published,
// students enrolled, completions and quizzes on own courses).
// Courses = union of teaching enrollments + authored topic rows.
router.get("/author/stats", requireAuth, requireAuthor, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const [teaching, authored, mine] = await Promise.all([
      sb.from("enrollments").select("course").eq("user_id", userId).eq("kind", "teaching"),
      sb.from("topic_notes").select("course").eq("author_id", userId),
      sb.from("topic_notes").select("course,week,topic,version").eq("author_id", userId),
    ]);
    const courses = [
      ...new Set([
        ...(((teaching.data ?? []) as { course: string }[]).map((r) => r.course)),
        ...(((authored.data ?? []) as { course: string }[]).map((r) => r.course)),
      ]),
    ];
    const rows = ((mine.data ?? []) as { course: string; week: number; topic: number; version: number }[]);
    const topics = new Set(rows.map((r) => `${r.course}|${r.week}|${r.topic}`)).size;
    let students = 0;
    let completions = 0;
    let quizzesTaken = 0;
    let quizAvg = 0;
    if (courses.length) {
      const [enr, prog, qa] = await Promise.all([
        sb.from("enrollments").select("user_id").eq("kind", "taking").in("course", courses).limit(2000),
        sb.from("topic_progress").select("course").in("course", courses).limit(2000),
        sb.from("quiz_attempts").select("score,total").in("course", courses).limit(1000),
      ]);
      students = new Set((((enr.data ?? []) as { user_id: string }[]).map((r) => r.user_id))).size;
      completions = ((prog.data ?? []) as unknown[]).length;
      const attempts = ((qa.data ?? []) as { score: number; total: number }[]).filter((r) => r.total > 0);
      quizzesTaken = attempts.length;
      quizAvg = attempts.length
        ? Math.round((attempts.reduce((s, r) => s + r.score / r.total, 0) / attempts.length) * 100)
        : 0;
    }
    res.json({
      courses: courses.length,
      topics,
      versions: rows.length,
      students,
      completions,
      quizzesTaken,
      quizAvg,
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});
// Authed: topic versions this user published (author dashboard lists own
// notes with version numbers + delete).
router.get("/authored", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { data, error } = await supabaseAdmin()
      .from("topic_notes")
      .select("id,course,week,topic,version,title,created_at")
      .eq("author_id", userId)
      .order("course")
      .order("week")
      .order("topic")
      .order("version", { ascending: false });
    if (error) throw error;
    res.json({ notes: data ?? [] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: week list for a course (titles for pickers + student week lists).
router.get("/courses/:code/weeks", async (req: Request, res: Response) => {
  const code = cleanCode(decodeURIComponent(req.params.code));
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
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
    const { data } = await sb.from("profiles").select("is_admin,role").eq("id", userId).single();
    const prof = data as { is_admin?: boolean; role?: string } | null;
    if (prof?.is_admin || prof?.role === "admin") return userId;
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
    const [users, weeks, topics, courses, xp] = await Promise.all([
      sb.from("profiles").select("id,role", { count: "exact" }),
      sb.from("weeks").select("course", { count: "exact" }),
      sb.from("topic_notes").select("id", { count: "exact", head: true }),
      sb.from("courses").select("code", { count: "exact", head: true }),
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
      topics: topics.count ?? 0,
      courses: courses.count ?? 0,
      xpTotal: xpRows.reduce((s, r) => s + (r.amount || 0), 0),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin: full content tree (every course → weeks → topics/versions).
// Lets an admin browse all notes without enrolling in anything.
router.get("/admin/content", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const [coursesRes, levelsRes, weeksRes, notesRes] = await Promise.all([
      sb.from("courses").select("code,title").order("code").limit(500),
      sb.from("course_levels").select("course,level,semester").limit(2000),
      sb.from("weeks").select("course,week,title").order("course").order("week").limit(5000),
      sb.from("topic_notes").select("course,week,topic,version,title").order("course").order("week").order("topic").order("version").limit(5000),
    ]);
    const err = coursesRes.error || levelsRes.error || weeksRes.error || notesRes.error;
    if (err) throw err;
    const levelByCourse = new Map<string, { level: string; semester: string }>();
    for (const r of ((levelsRes.data ?? []) as { course: string; level: string; semester: string }[])) {
      if (!levelByCourse.has(r.course)) levelByCourse.set(r.course, { level: r.level, semester: r.semester });
    }
    const topicsByWeek = new Map<string, { topic: number; versions: number; title: string }[]>();
    for (const n of ((notesRes.data ?? []) as { course: string; week: number; topic: number; version: number; title: string }[])) {
      const key = `${n.course}::${n.week}`;
      const list = topicsByWeek.get(key) || [];
      const last = list[list.length - 1];
      if (last && last.topic === n.topic) {
        last.versions = Math.max(last.versions, n.version);
        if (!last.title && n.title) last.title = n.title;
      } else {
        list.push({ topic: n.topic, versions: n.version, title: n.title || "" });
      }
      topicsByWeek.set(key, list);
    }
    const weeksByCourse = new Map<string, { week: number; title: string; topics: { topic: number; versions: number; title: string }[] }[]>();
    for (const w of ((weeksRes.data ?? []) as { course: string; week: number; title: string }[])) {
      const list = weeksByCourse.get(w.course) || [];
      list.push({ week: w.week, title: w.title || "", topics: topicsByWeek.get(`${w.course}::${w.week}`) || [] });
      weeksByCourse.set(w.course, list);
    }
    const courses = (((coursesRes.data ?? []) as { code: string; title: string }[])).map((c) => {
      const lv = levelByCourse.get(c.code);
      const weeks = weeksByCourse.get(c.code) || [];
      const topicCount = weeks.reduce((n, w) => n + w.topics.length, 0);
      return { code: c.code, title: c.title, level: lv?.level || "", semester: lv?.semester || "", weeks, weekCount: weeks.length, topicCount };
    });
    res.json({ courses });
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
    if (role === "student" || role === "lecturer" || role === "collaborator" || role === "admin") {
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
  role: z.enum(["student", "lecturer", "collaborator", "admin"]).optional(),
  is_admin: z.boolean().optional(),
  level: z
    .string()
    .min(1)
    .max(40)
    .refine((v) => [...LEVEL_ORDER, "Graduated"].includes(v), { message: "Unknown level" })
    .optional(),
});

router.patch("/admin/users/:id", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = adminUserSchema.safeParse(req.body);
  if (!parsed.success || (!("role" in parsed.data) && !("is_admin" in parsed.data) && !("level" in parsed.data))) {
    res.status(400).json({ error: "Provide role, level and/or is_admin" });
    return;
  }
  if (req.params.id === adminId && parsed.data.is_admin === false) {
    res.status(403).json({ error: "You cannot remove your own admin flag" });
    return;
  }
  if (req.params.id === adminId && parsed.data.role && parsed.data.role !== "admin") {
    res.status(403).json({ error: "You cannot demote your own admin role" });
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
  semester: z.enum(["First Semester", "Second Semester"]).default("First Semester"),
});

router.post("/admin/courses", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = adminCourseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const code = cleanCode(parsed.data.code);
  if (!code) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { error: cErr } = await sb.from("courses").upsert({ code, title: parsed.data.title }, { onConflict: "code" });
    if (cErr) throw cErr;
    await sb.from("course_levels").delete().eq("course", code);
    const { error: lErr } = await sb
      .from("course_levels")
      .insert(parsed.data.levels.map((level) => ({ course: code, level, semester: parsed.data.semester })));
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
    const code = cleanCode(decodeURIComponent(req.params.code));
    if (!code) {
      res.status(400).json({ error: "Invalid course" });
      return;
    }
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
  role: z.enum(["student", "lecturer", "collaborator", "admin"]).default("student"),
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

// ---- Admin: academic session (active semester + bulk promotion) ----
router.put("/admin/settings/semester", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = z.object({ semester: z.enum(SEMESTERS) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const { error } = await supabaseAdmin()
      .from("app_settings")
      .upsert(
        { key: "current_semester", value: parsed.data.semester, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    if (error) throw error;
    res.json({ ok: true, currentSemester: parsed.data.semester });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// One-click promotion: every student moves up exactly one level
// (500 Level -> Graduated). Taking-enrollments are cleared so students
// pick new-level courses; teaching assignments are kept.
router.post("/admin/users/promote", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("profiles").select("id,level").eq("role", "student");
    if (error) throw error;
    let promoted = 0;
    let graduated = 0;
    for (const p of ((data ?? []) as { id: string; level: string | null }[])) {
      const idx = LEVEL_ORDER.indexOf(p.level || "");
      if (idx === -1) continue;
      const next = idx + 1 < LEVEL_ORDER.length ? LEVEL_ORDER[idx + 1] : "Graduated";
      const { error: uErr } = await sb
        .from("profiles")
        .update({ level: next, updated_at: new Date().toISOString() })
        .eq("id", p.id);
      if (uErr) throw uErr;
      await sb.from("enrollments").delete().eq("user_id", p.id).eq("kind", "taking");
      if (next === "Graduated") graduated += 1;
      else promoted += 1;
    }
    res.json({ ok: true, promoted, graduated });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin: broadcast an announcement to every user (in-app bell) ----
router.post("/admin/announce", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = z
    .object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(500),
      link: z.string().max(300).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("profiles").select("id").limit(5000);
    if (error) throw error;
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    const rows = ids.map((user_id) => ({
      user_id,
      type: "announce",
      title: parsed.data.title,
      body: parsed.data.body,
      link: parsed.data.link || "/dashboard",
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: iErr } = await sb.from("notifications").insert(rows.slice(i, i + 200));
      if (iErr) throw iErr;
    }
    res.json({ ok: true, reached: ids.length });
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
  const course = cleanCode(parsed.data.course);
  if (!course) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  try {
    const { error } = await supabaseAdmin().from("quiz_attempts").insert({
      user_id: userId,
      course,
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
