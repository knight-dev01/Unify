import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { notifyCoursePublished, notifyInAppNewNote } from "../lib/email";
import { pushNewNote, pushAnnounce, pushToUser } from "../lib/push";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { requireAuthor } from "../middleware/requireAuthor";
import { requireCourseAccess } from "../middleware/requireCourseAccess";

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
  // Only students complete the full flow; lecturers/contributors stop
  // after name, so these accept missing AND explicit null (client state
  // initializes unpicked fields to null, not undefined).
  university: z.string().min(1).max(120).nullish(),
  faculty: z.string().min(1).max(120).nullish(),
  department: z.string().min(1).max(100).nullish(),
  level: z.string().min(1).max(40).nullish(),
  universityId: z.string().uuid().max(80).optional(),
  gradTarget: z.number().min(0).max(5).optional(),
  role: z.enum(["student", "lecturer", "contributor"]).default("student"),
  semester: z.string().min(1).max(40).optional(),
  courses: z.array(z.string().min(1).max(20)).max(30).optional(),
});

const profileSchema = onboardingSchema.partial().extend({ notifyNewNotes: z.boolean().optional() });

const progressSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  topic: z.number().int().min(0).max(100),
  lectureNo: z.number().int().min(1).max(3).default(1),
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
    // Students need a university; lecturers/contributors/admins stop after name.
    const onboarded =
      Boolean(p.university) ||
      ((p.role === "lecturer" || p.role === "contributor" || p.role === "admin") && Boolean(p.first_name));
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
    let resume: { course: string; week: number; topic: number; lecture: number } | null = null;
    const { data: saved } = await supabaseAdmin()
      .from("resume_state")
      .select("course,week,topic,lecture_no")
      .eq("user_id", userId)
      .single();
    if (saved) {
      const r = saved as { course: string; week: number; topic: number; lecture_no?: number };
      if (r.course) resume = { course: r.course, week: r.week, topic: r.topic, lecture: r.lecture_no || 1 };
    } else {
      const { data: last } = await supabaseAdmin()
        .from("topic_progress")
        .select("course,week,topic,lecture_no")
        .eq("user_id", userId)
        .order("completed_at", { ascending: false })
        .limit(1);
      const row = ((last ?? []) as { course: string; week: number; topic: number; lecture_no?: number }[])[0];
      if (row && row.course) resume = { course: row.course, week: row.week, topic: row.topic, lecture: row.lecture_no || 1 };
    }
    res.json({ onboarded, profile: data, isAdmin, courses, resume, avatar: await avatarFor(data as { avatar_url?: string; email?: string } | null) });
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
      lectureNo: z.number().int().min(1).max(3).default(1),
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
          lecture_no: parsed.data.lectureNo,
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

// ---- Web Push subscriptions (browser push, third notify leg) ----
const pushSubSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(300), auth: z.string().min(1).max(200) }),
});

router.post("/push/subscribe", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const parsed = pushSubSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const { error } = await supabaseAdmin().from("push_subscriptions").upsert(
      {
        user_id: userId,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
      },
      { onConflict: "endpoint" }
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.post("/push/unsubscribe", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const parsed = z.object({ endpoint: z.string().max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const sb = supabaseAdmin();
    if (parsed.data.endpoint) {
      await sb.from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", parsed.data.endpoint);
    } else {
      await sb.from("push_subscriptions").delete().eq("user_id", userId);
    }
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
    // Week counts ride along so catalog screens never fan out into one
    // request per course (that N+1 is what melts the server in a pilot).
    const { data: weekRows, error: weekErr } = await sb.from("weeks").select("course").limit(5000);
    if (weekErr) throw weekErr;
    const weeksByCourse: Record<string, number> = {};
    for (const w of ((weekRows ?? []) as { course: string }[])) {
      weeksByCourse[w.course] = (weeksByCourse[w.course] || 0) + 1;
    }
    // BUG-012: staff ride the catalog too (dashboard cards show avatars
    // of everyone assigned — lecturers AND contributors). Uploaded picture
    // wins, Gravatar-by-email is the automatic fallback. Batched, no N+1.
    const staffByCourse: Record<string, { name: string; avatar: string }[]> = {};
    try {
      const { data: teaching } = await sb.from("enrollments").select("course,user_id").eq("kind", "teaching").limit(2000);
      const ids = [...new Set(((teaching ?? []) as { course: string; user_id: string }[]).map((t) => t.user_id))].slice(0, 500);
      if (ids.length) {
        const { data: profs } = await sb.from("profiles").select("id,first_name,email,avatar_url").in("id", ids);
        const byId: Record<string, { name: string; email: string; avatar: string }> = {};
        for (const p of ((profs ?? []) as { id: string; first_name: string; email: string; avatar_url: string }[])) {
          if (p.first_name) byId[p.id] = { name: p.first_name, email: p.email || "", avatar: p.avatar_url || "" };
        }
        const { createHash } = await import("node:crypto");
        for (const t of ((teaching ?? []) as { course: string; user_id: string }[])) {
          const who = byId[t.user_id];
          if (!who) continue;
          const list = (staffByCourse[t.course] = staffByCourse[t.course] || []);
          if (list.some((s) => s.name === who.name) || list.length >= 4) continue;
          let avatar = who.avatar;
          if (!avatar && who.email) {
            avatar = `https://www.gravatar.com/avatar/${createHash("md5").update(who.email.trim().toLowerCase()).digest("hex")}?d=identicon&s=128`;
          }
          list.push({ name: who.name, avatar });
        }
      }
    } catch {
      // cards fall back to code-only
    }
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
      weeks: weeksByCourse[c.code] || 0,
      lecturers: (staffByCourse[c.code] || []).map((s) => s.name),
      staff: staffByCourse[c.code] || [],
    }));
    if (level) out = out.filter((c) => c.levels.includes(level));
    if (semester) out = out.filter((c) => c.semesters.includes(semester));
    res.json(out);
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: course search across code, title AND aliases (BUG-006: "ME 352"
// finds "MEE 352"). Level-scoped when given; spans both semesters with
// badges so nothing hides — enrollment stays the student's choice.
router.get("/courses/search", async (req: Request, res: Response) => {
  const q = String(req.query.q || "").trim();
  const level = String(req.query.level || "");
  if (q.length < 2) {
    res.status(400).json({ error: "Type at least 2 characters to search." });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const like = `%${q.replace(/[%_,]/g, "")}%`;
    const [coursesRes, aliasRes, linksRes, weeksRes] = await Promise.all([
      sb.from("courses").select("code,title").or(`code.ilike.${like},title.ilike.${like}`).limit(30),
      sb.from("course_aliases").select("alias,course").ilike("alias", like).limit(30),
      sb.from("course_levels").select("course,level,semester").limit(2000),
      sb.from("weeks").select("course").limit(5000),
    ]);
    const err = coursesRes.error || aliasRes.error || linksRes.error || weeksRes.error;
    if (err) throw err;
    const byCode = new Map<string, { code: string; title: string; viaAlias?: string }>();
    for (const c of ((coursesRes.data ?? []) as { code: string; title: string }[])) {
      if (c.code) byCode.set(c.code, { code: c.code, title: c.title });
    }
    const aliasTargets = (((aliasRes.data ?? []) as { alias: string; course: string }[]))
      .map((a) => a.course)
      .filter((code) => code && !byCode.has(code));
    if (aliasTargets.length) {
      const { data: extra } = await sb.from("courses").select("code,title").in("code", aliasTargets);
      for (const c of ((extra ?? []) as { code: string; title: string }[])) {
        if (c.code) byCode.set(c.code, { code: c.code, title: c.title });
      }
    }
    const aliasByCourse = new Map<string, string>();
    for (const a of ((aliasRes.data ?? []) as { alias: string; course: string }[])) {
      if (byCode.has(a.course) && !aliasByCourse.has(a.course)) aliasByCourse.set(a.course, a.alias);
    }
    const byCourse: Record<string, { levels: string[]; semesters: string[] }> = {};
    for (const l of ((linksRes.data ?? []) as { course: string; level: string; semester: string }[])) {
      const e = (byCourse[l.course] = byCourse[l.course] || { levels: [], semesters: [] });
      if (!e.levels.includes(l.level)) e.levels.push(l.level);
      if (l.semester && !e.semesters.includes(l.semester)) e.semesters.push(l.semester);
    }
    const weeksByCourse: Record<string, number> = {};
    for (const w of ((weeksRes.data ?? []) as { course: string }[])) {
      weeksByCourse[w.course] = (weeksByCourse[w.course] || 0) + 1;
    }
    let out = [...byCode.values()].map((c) => ({
      ...c,
      levels: (byCourse[c.code]?.levels || []).sort(),
      semesters: (byCourse[c.code]?.semesters || []).sort(),
      weeks: weeksByCourse[c.code] || 0,
      matchedAlias: aliasByCourse.get(c.code) || null,
    }));
    if (level) out = out.filter((c) => c.levels.includes(level));
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
  lecture_no?: number;
  version: number;
  title: string;
  note_json: unknown;
  author_id: string | null;
  created_at: string;
};

type TopicMeta = {
  topic: number;
  lecture: number;
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
      .select("id,course,week,topic,lecture_no,version,title,note_json,author_id,created_at")
      .eq("course", v)
      .eq("week", week)
      .order("lecture_no")
      .order("topic")
      .order("version", { ascending: false });
    if (error) throw error;
    out.push(...((data ?? []) as TopicNoteRow[]));
  }
  return out;
}

function groupTopics(rows: TopicNoteRow[]): { topics: unknown[]; meta: TopicMeta[]; lectures: number[] } {
  const byKey = new Map<string, TopicNoteRow[]>();
  for (const r of rows) {
    const lecture = r.lecture_no || 1;
    const key = `${lecture}::${r.topic}`;
    const list = byKey.get(key) || [];
    list.push(r);
    byKey.set(key, list);
  }
  const topics: unknown[] = [];
  const meta: TopicMeta[] = [];
  const lectureSet = new Set<number>();
  const sortedKeys = [...byKey.keys()].sort((a, b) => {
    const [la, ta] = a.split("::").map(Number);
    const [lb, tb] = b.split("::").map(Number);
    return la - lb || ta - tb;
  });
  for (const key of sortedKeys) {
    const list = byKey.get(key) as TopicNoteRow[];
    const [lecture, num] = key.split("::").map(Number);
    lectureSet.add(lecture);
    const sorted = [...list].sort((a, b) => b.version - a.version);
    const payload = sorted[0].note_json;
    topics.push(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), lecture }
        : payload
    );
    meta.push({
      topic: num,
      lecture,
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
  return { topics, meta, lectures: [...lectureSet].sort((a, b) => a - b) };
}

router.get("/courses/:code/weeks/:week", requireAuth, requireCourseAccess, async (req: Request, res: Response) => {
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
    const assembled = await assembleWeek(code, week);
    if (!assembled) {
      res.status(404).json({ error: "Week not found" });
      return;
    }
    res.json(assembled);
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Shared assembly (reader + public share links): shell + latest topics.
async function assembleWeek(
  code: string,
  week: number
): Promise<{ course: string; week: number; title: string; subtitle: string; note_json: unknown; topicMeta: TopicMeta[]; lectures: number[] } | null> {
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
  if (!shell && rows.length === 0) return null;
  if (rows.length === 0 && shell) {
    return { ...shell, topicMeta: [], lectures: [1] };
  }
  const { topics, meta, lectures } = groupTopics(rows);
  const shellNote = ((shell?.note_json ?? {}) as Record<string, unknown>) || {};
  const course = shell?.course ?? rows[0].course;
  const title = shell?.title || (typeof shellNote.title === "string" ? shellNote.title : `Week ${week}`);
  const subtitle = shell?.subtitle || (typeof shellNote.subtitle === "string" ? shellNote.subtitle : "");
  return {
    course,
    week,
    title,
    subtitle,
    note_json: { ...shellNote, course, week, title, subtitle, topics },
    topicMeta: meta,
    lectures,
  };
}

// ---- Expiring share links (/s/:token): any signed-in user shares a
// week; recipients read free until expiry, no account needed. ----
const shareCreateSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  ttlHours: z.number().int().min(1).max(720).default(168),
});

router.post("/share", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const parsed = shareCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const course = cleanCode(parsed.data.course);
  if (!course) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  try {
    // Sharing is an author/admin act (lecturers, contributors, admins).
    // Students read shared links; they don't mint them.
    const { data: prof } = await supabaseAdmin().from("profiles").select("role,is_admin").eq("id", userId).single();
    const p = prof as { role?: string; is_admin?: boolean } | null;
    const canShare = Boolean(p?.is_admin || (p?.role && ["lecturer", "contributor", "admin"].includes(p.role)));
    if (!canShare) {
      res.status(403).json({ error: "Only authors and admins can share notes" });
      return;
    }
    // Only share weeks that actually exist.
    const assembled = await assembleWeek(course, parsed.data.week);
    if (!assembled) {
      res.status(404).json({ error: "Week not found" });
      return;
    }
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(9).toString("base64url");
    const expires_at = new Date(Date.now() + parsed.data.ttlHours * 3600000).toISOString();
    const { error } = await supabaseAdmin().from("share_links").insert({
      token,
      user_id: userId,
      course,
      week: parsed.data.week,
      expires_at,
    });
    if (error) throw error;
    res.json({ ok: true, token, expires_at, views: 0 });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: resolve a share link (no session needed). 404 unknown, 410
// expired. Views count up; content is always the live latest version.
// Authed: my links (manage + revoke expired ones). Registered BEFORE
// /share/:token: Express matches in order, and "mine" would otherwise be
// swallowed as a token and 404 (that silently broke the live-links list).
router.get("/share/mine", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { data, error } = await supabaseAdmin()
      .from("share_links")
      .select("token,course,week,expires_at,views,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ links: data ?? [] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.get("/share/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token || "").slice(0, 64);
  if (!token) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("share_links")
      .select("course,week,expires_at,views")
      .eq("token", token)
      .single();
    if (error || !data) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    const row = data as { course: string; week: number; expires_at: string; views: number };
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(410).json({ error: "This link expired" });
      return;
    }
    const assembled = await assembleWeek(row.course, row.week);
    if (!assembled) {
      res.status(404).json({ error: "Week not found" });
      return;
    }
    await sb
      .from("share_links")
      .update({ views: (row.views || 0) + 1 })
      .eq("token", token);
    res.json({ ...assembled, share: { token, expires_at: row.expires_at, views: (row.views || 0) + 1 } });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.delete("/share/:token", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const { data: existing } = await sb
      .from("share_links")
      .select("user_id")
      .eq("token", req.params.token)
      .single();
    if (!existing) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    const owner = (existing as { user_id: string }).user_id === userId;
    let admin = owner;
    if (!owner) {
      const { data: prof } = await sb.from("profiles").select("is_admin,role").eq("id", userId).single();
      const p = prof as { is_admin?: boolean; role?: string } | null;
      admin = Boolean(p?.is_admin || p?.role === "admin");
    }
    if (!admin) {
      res.status(403).json({ error: "Not your link" });
      return;
    }
    const { error } = await sb.from("share_links").delete().eq("token", req.params.token);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Client error log (Sentry backup / Sentry alternative). ----
// Public by design: crashes happen pre-auth too. Tiny payloads, global
// rate limit applies, rows capped (oldest trimmed) so it can't be used
// as free storage.
const clientErrorSchema = z.object({
  kind: z.string().max(30).default("client"),
  message: z.string().max(500).default(""),
  stack: z.string().max(4000).default(""),
  url: z.string().max(300).default(""),
  appVersion: z.string().max(20).default(""),
});

router.post("/errors", async (req: Request, res: Response) => {
  const parsed = clientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    let userId: string | null = null;
    try {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token) {
        const { data } = await sb.auth.getUser(token);
        userId = data.user?.id ?? null;
      }
    } catch {
      userId = null;
    }
    const { error } = await sb.from("client_errors").insert({
      user_id: userId,
      kind: parsed.data.kind,
      message: parsed.data.message,
      stack: parsed.data.stack,
      url: parsed.data.url,
      app_version: parsed.data.appVersion,
    });
    if (error) throw error;
    // Cap: keep the latest 500, trim the rest (one cheap delete).
    await sb.from("client_errors").delete().lt(
      "created_at",
      new Date(Date.now() - 30 * 86400000).toISOString()
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: support channel config (WhatsApp number only — token never
// leaves the server). The app shows a help button when supported.
router.get("/support", async (_req: Request, res: Response) => {
  try {
    const { whatsappPublic } = await import("../lib/whatsapp");
    res.json(whatsappPublic());
  } catch {
    res.json({ supported: false, supportNumber: "" });
  }
});

// Admin: latest client errors (newest first).
router.get("/admin/errors", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const { data, error } = await supabaseAdmin()
      .from("client_errors")
      .select("kind,message,stack,url,app_version,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ errors: data ?? [] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Admin: latest client errors (newest first).
router.get("/admin/errors", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const { data, error } = await supabaseAdmin()
      .from("client_errors")
      .select("kind,message,stack,url,app_version,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ errors: data ?? [] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Staff role requests: apply as lecturer/contributor, admin approves.
// Until approval the account stays a student — picking a staff role in
// onboarding never grants powers by itself. ----

// Avatar shown across the app: uploaded picture wins, otherwise Gravatar
// from the email (works for every user with zero setup).
async function avatarFor(profile: { avatar_url?: string; email?: string } | null): Promise<string> {
  const up = (profile?.avatar_url || "").trim();
  if (up) return up;
  const email = (profile?.email || "").trim().toLowerCase();
  if (!email) return "";
  try {
    const { createHash } = await import("node:crypto");
    return `https://www.gravatar.com/avatar/${createHash("md5").update(email).digest("hex")}?d=identicon&s=128`;
  } catch {
    return "";
  }
}

async function adminRecipients(): Promise<{ ids: string[]; emails: { email: string; name: string }[] }> {
  const ids: string[] = [];
  const emails: { email: string; name: string }[] = [];
  try {
    const { data } = await supabaseAdmin()
      .from("profiles")
      .select("id,first_name,email")
      .or("is_admin.eq.true,role.eq.admin")
      .limit(50);
    for (const p of ((data ?? []) as { id: string; first_name: string; email: string }[])) {
      ids.push(p.id);
      if (p.email) emails.push({ email: p.email, name: p.first_name || "Admin" });
    }
  } catch {
    // notify best-effort
  }
  return { ids, emails };
}

const roleRequestSchema = z.object({
  role: z.enum(["lecturer", "contributor"]),
  level: z.string().max(40).default(""),
  courses: z.array(z.string().min(1).max(20)).max(10).default([]),
});

// Authed: file (or re-file) a staff role request.
router.post("/role-requests", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const parsed = roleRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data: prof } = await sb.from("profiles").select("first_name,email,role").eq("id", userId).single();
    const p = prof as { first_name?: string; email?: string; role?: string } | null;
    if (p?.role === "lecturer" || p?.role === "contributor" || p?.role === "admin") {
      res.status(400).json({ error: "You already hold a staff role." });
      return;
    }
    const courses = [...new Set(parsed.data.courses.map((c) => cleanCode(c)).filter(Boolean))];
    // One live request per user: re-filing replaces the pending one.
    await sb.from("role_requests").delete().eq("user_id", userId).eq("status", "pending");
    const { data: ins, error } = await sb
      .from("role_requests")
      .insert({ user_id: userId, role: parsed.data.role, level: parsed.data.level, courses })
      .select("id")
      .single();
    if (error) throw error;
    // Admins hear about it twice: bell notification + email.
    const label = parsed.data.role === "lecturer" ? "Lecturer" : "Contributor";
    const { ids, emails } = await adminRecipients();
    if (ids.length) {
      await sb.from("notifications").insert(
        ids.map((id) => ({
          user_id: id,
          type: "role_request",
          title: `New ${label} request: ${p?.first_name || "Unnamed"}`,
          body: `${p?.first_name || "Someone"} (${p?.email || "no email"}) wants the ${label} role${parsed.data.level ? ` · ${parsed.data.level}` : ""}${courses.length ? ` · ${courses.join(", ")}` : ""}.`,
          link: "/admin",
        }))
      );
    }
    if (emails.length) {
      const { sendSimpleEmail } = await import("../lib/email");
      const base = (process.env.CORS_ORIGIN || "").split(",")[0].trim() || "https://unify-virid.vercel.app";
      await sendSimpleEmail({
        to: emails,
        subject: `Unify: new ${label} request needs review`,
        html: `<div style="font-family:sans-serif;max-width:480px;"><p><strong>${p?.first_name || "Someone"}</strong> (${p?.email || "no email"}) requested the <strong>${label}</strong> role${parsed.data.level ? ` for <strong>${parsed.data.level}</strong>` : ""}${courses.length ? ` (${courses.join(", ")})` : ""}.</p><p><a href="${base}/admin" style="display:inline-block;padding:12px 24px;background:#10b981;color:#fff;border-radius:9999px;text-decoration:none;font-weight:800;">Review in admin panel</a></p></div>`,
      }).catch(() => {});
    }
    res.json({ ok: true, id: (ins as { id: string }).id });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: my pending request (onboarding shows "under review" instead of
// letting staff through).
router.get("/role-requests/mine", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { data, error } = await supabaseAdmin()
      .from("role_requests")
      .select("id,role,level,courses,status,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json({ request: ((data ?? []) as unknown[])[0] || null });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Admin: pending staff requests with applicant names.
router.get("/admin/role-requests", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("role_requests")
      .select("id,user_id,role,level,courses,status,created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    const rows = ((data ?? []) as { id: string; user_id: string; role: string; level: string; courses: string[]; status: string; created_at: string }[]);
    const ids = [...new Set(rows.map((r) => r.user_id))];
    let names: Record<string, { name: string; email: string }> = {};
    if (ids.length) {
      const { data: profs } = await sb.from("profiles").select("id,first_name,email").in("id", ids);
      for (const p of ((profs ?? []) as { id: string; first_name: string; email: string }[])) {
        names[p.id] = { name: p.first_name || "Unnamed", email: p.email || "" };
      }
    }
    res.json({
      requests: rows.map((r) => ({
        ...r,
        name: names[r.user_id]?.name || "Unnamed",
        email: names[r.user_id]?.email || "",
      })),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Contributor cap: at most 2 teaching courses per level. Lecturers are
// exempt (they teach whole departments); contributors are capped so one
// account can't sprawl across a faculty.
async function teachingCountsByLevel(userId: string): Promise<Record<string, number>> {
  const sb = supabaseAdmin();
  const { data: taking } = await sb.from("enrollments").select("course").eq("user_id", userId).eq("kind", "teaching");
  const courses = ((taking ?? []) as { course: string }[]).map((r) => r.course);
  if (!courses.length) return {};
  const { data: links } = await sb.from("course_levels").select("course,level").in("course", courses);
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const l of ((links ?? []) as { course: string; level: string }[])) {
    const k = `${l.course}::${l.level}`;
    if (seen.has(k)) continue;
    seen.add(k);
    counts[l.level] = (counts[l.level] || 0) + 1;
  }
  return counts;
}

// Admin: approve (grants role + enrolls teaching courses within cap) or
// reject a staff request. The applicant is notified both ways, by bell.
router.post("/admin/role-requests/:id", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = z.object({ approve: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Pass { approve: true|false }." });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data: rq } = await sb.from("role_requests").select("*").eq("id", req.params.id).single();
    const r = rq as { id: string; user_id: string; role: string; level: string; courses: string[]; status: string } | null;
    if (!r || r.status !== "pending") {
      res.status(404).json({ error: "Request not found or already decided." });
      return;
    }
    if (!parsed.data.approve) {
      await sb.from("role_requests").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("id", r.id);
      await sb.from("notifications").insert({
        user_id: r.user_id,
        type: "role",
        title: "Staff request not approved",
        body: "An admin reviewed your lecturer/contributor request and declined it this time. You keep full student access.",
        link: "/dashboard",
      });
      res.json({ ok: true, approved: false });
      return;
    }
    // Approve: grant the role first (enrollments are kinded by role).
    await sb.from("profiles").update({ role: r.role, level: r.level || undefined, updated_at: new Date().toISOString() }).eq("id", r.user_id);
    // Enroll requested teaching courses, honoring the contributor cap.
    const { data: prof } = await sb.from("profiles").select("role").eq("id", r.user_id).single();
    const isContributor = (prof as { role?: string } | null)?.role === "contributor";
    const counts = isContributor ? await teachingCountsByLevel(r.user_id) : {};
    const { data: links } = await sb.from("course_levels").select("course,level").in("course", r.courses.length ? r.courses : ["__none__"]);
    const levelOf: Record<string, string> = {};
    for (const l of ((links ?? []) as { course: string; level: string }[])) {
      if (!levelOf[l.course]) levelOf[l.course] = l.level;
    }
    const granted: string[] = [];
    const capped: string[] = [];
    for (const c of r.courses) {
      const lv = levelOf[c] || r.level || "";
      if (isContributor && lv && (counts[lv] || 0) >= 2) {
        capped.push(c);
        continue;
      }
      granted.push(c);
      if (isContributor && lv) counts[lv] = (counts[lv] || 0) + 1;
    }
    if (granted.length) {
      await sb.from("enrollments").upsert(
        granted.map((course) => ({ user_id: r.user_id, course, kind: "teaching" })),
        { onConflict: "user_id,course" }
      );
    }
    await sb.from("role_requests").update({ status: "approved", decided_at: new Date().toISOString() }).eq("id", r.id);
    const label = r.role === "lecturer" ? "Lecturer" : "Contributor";
    await sb.from("notifications").insert({
      user_id: r.user_id,
      type: "role",
      title: `You're now a ${label}`,
      body: granted.length
        ? `Approved! You teach ${granted.join(", ")}.${capped.length ? ` Held back by the 2-per-level cap: ${capped.join(", ")}.` : ""} Open the Studio to begin.`
        : "Approved! Open the Studio to begin.",
      link: r.role === "lecturer" ? "/classes" : "/studio",
    });
    res.json({ ok: true, approved: true, granted, capped });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed author: my contributions grouped by course (topics + versions),
// with level/semester context for the contributor dashboard.
router.get("/contributions", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const { data: prof } = await sb.from("profiles").select("role").eq("id", userId).single();
    const role = (prof as { role?: string } | null)?.role || "";
    if (!["lecturer", "contributor", "admin"].includes(role)) {
      const { data: isAdm } = await sb.from("profiles").select("is_admin").eq("id", userId).single();
      if (!(isAdm as { is_admin?: boolean } | null)?.is_admin) {
        res.status(403).json({ error: "Authors only." });
        return;
      }
    }
    const [mine, teaching, links] = await Promise.all([
      sb.from("topic_notes").select("course,week,topic,lecture_no,version").eq("author_id", userId).limit(5000),
      sb.from("enrollments").select("course").eq("user_id", userId).eq("kind", "teaching").limit(100),
      sb.from("course_levels").select("course,level,semester").limit(2000),
    ]);
    if (mine.error) throw mine.error;
    const lvl: Record<string, { level: string; semester: string }> = {};
    for (const l of ((links.data ?? []) as { course: string; level: string; semester: string }[])) {
      if (!lvl[l.course]) lvl[l.course] = { level: l.level, semester: l.semester };
    }
    const byCourse: Record<string, { topics: Set<string>; versions: number }> = {};
    for (const n of ((mine.data ?? []) as { course: string; week: number; topic: number; lecture_no?: number; version: number }[])) {
      const e = (byCourse[n.course] = byCourse[n.course] || { topics: new Set(), versions: 0 });
      e.topics.add(`${n.week}::${n.lecture_no || 1}::${n.topic}`);
      e.versions += 1;
    }
    const assigned = new Set(((teaching.data ?? []) as { course: string }[]).map((r) => r.course));
    const courses = [...new Set([...Object.keys(byCourse), ...assigned])].sort().map((course) => ({
      course,
      level: lvl[course]?.level || "",
      semester: lvl[course]?.semester || "",
      assigned: assigned.has(course),
      topics: byCourse[course]?.topics.size || 0,
      versions: byCourse[course]?.versions || 0,
    }));
    res.json({ courses });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed: upload a profile picture (staff and students alike). ≤2MB image
// into the avatars bucket; the public URL lands on the profile.
router.post("/avatar", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const parsed = z.object({ image: z.string().min(100).max(3000000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Pass { image: dataURL } (≤2MB)." });
    return;
  }
  const m = parsed.data.image.match(/^data:(image\/(png|jpeg|webp)):base64,(.+)$/);
  if (!m) {
    res.status(400).json({ error: "Image must be a PNG/JPEG/WEBP data URL." });
    return;
  }
  try {
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 2 * 1024 * 1024) {
      res.status(400).json({ error: "Image must be ≤2MB." });
      return;
    }
    const ext = m[2] === "png" ? "png" : m[2] === "webp" ? "webp" : "jpg";
    const path = `${userId}.${ext}`;
    const { error: upErr } = await supabaseAdmin().storage.from("avatars").upload(path, buf, {
      contentType: `image/${m[2]}`,
      upsert: true,
    });
    if (upErr) throw upErr;
    const { data } = supabaseAdmin().storage.from("avatars").getPublicUrl(path);
    await supabaseAdmin().from("profiles").update({ avatar_url: data.publicUrl, updated_at: new Date().toISOString() }).eq("id", userId);
    res.json({ ok: true, avatarUrl: data.publicUrl });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: per-topic version lists for a week (reader badges + author tools).
router.get("/courses/:code/weeks/:week/topics", requireAuth, requireCourseAccess, async (req: Request, res: Response) => {
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
router.get("/notes/:id", requireAuth, requireCourseAccess, async (req: Request, res: Response) => {
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
    // XP + progress + streaks are students-only. Authors/admins reading
    // outside preview record nothing (their taps must never mint XP or
    // pollute student stats).
    const { data: prof } = await sb.from("profiles").select("role").eq("id", userId).single();
    if ((prof as { role?: string } | null)?.role && (prof as { role?: string }).role !== "student") {
      res.json({ ok: true, xp: 0, streak: 0, awarded: 0 });
      return;
    }
    const { error: upErr } = await sb.from("topic_progress").upsert(
      { user_id: userId, course, week, topic, lecture_no: parsed.data.lectureNo, done: true, completed_at: new Date().toISOString() },
      { onConflict: "user_id,course,week,topic,lecture_no" }
    );
    if (upErr) throw upErr;
    // Keep the Resume card on the just-completed position.
    await sb.from("resume_state").upsert(
      {
        user_id: userId,
        course,
        week,
        topic,
        lecture_no: parsed.data.lectureNo,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    await sb.from("xp_events").insert({
      user_id: userId,
      amount: TOPIC_XP,
      reason: `topic_complete:${course}:w${week}:l${parsed.data.lectureNo}:t${topic}`,
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

// Authed author: publish a week of notes. Occupied weeks NEVER stack
// silently (BUG-007): without an explicit mode the API answers 409 and the
// Studio asks Replace / Add as new version / Cancel.
const publishSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  noteJson: z.object({}).passthrough(),
  mode: z.enum(["add", "replace"]).optional(),
});

async function nextTopicVersion(course: string, week: number, topic: number, lectureNo = 1): Promise<number> {
  const { data } = await supabaseAdmin()
    .from("topic_notes")
    .select("version")
    .eq("course", course)
    .eq("week", week)
    .eq("topic", topic)
    .eq("lecture_no", lectureNo)
    .order("version", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as { version: number }[];
  return (rows[0]?.version || 0) + 1;
}

router.post("/publish", requireAuth, requireAuthor, requireCourseAccess, async (req: Request, res: Response) => {
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
    // Occupied-week guard: stack only on explicit "add", wipe on "replace".
    const { data: existing } = await sb
      .from("topic_notes")
      .select("topic,version,title")
      .eq("course", code)
      .eq("week", week)
      .limit(100);
    const occupied = ((existing ?? []) as { topic: number; version: number; title: string }[]);
    if (occupied.length && parsed.data.mode !== "add" && parsed.data.mode !== "replace") {
      res.status(409).json({
        error: `Week ${week} already has ${occupied.length} published topic version(s).`,
        code: "WEEK_OCCUPIED",
        existing: {
          topics: [...new Set(occupied.map((r) => r.topic))].sort((a, b) => a - b),
          versions: occupied.length,
          titles: [...new Set(occupied.map((r) => r.title).filter(Boolean))].slice(0, 5),
        },
      });
      return;
    }
    const versions: { topic: number; lecture: number; version: number; id: string }[] = [];
    const cleanTopics = topics.flatMap((t) => {
      const num = Number((t as { number?: unknown }).number);
      if (!Number.isInteger(num) || num < 1 || num > 100) return [];
      const clsRaw = Number((t as { lecture?: unknown }).lecture);
      const cls = clsRaw === 2 || clsRaw === 3 ? clsRaw : 1;
      return [{ num, cls, title: typeof t.title === "string" ? t.title : "", noteJson: t }];
    });
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
    if (parsed.data.mode === "replace" && occupied.length) {
      // Replace runs as ONE database transaction (delete old rows +
      // progress, insert fresh v1s): concurrent publishers can never leave
      // a half-deleted week. Last writer still wins — but wins whole.
      const { data: rpcData, error: rpcErr } = await sb.rpc("replace_week_topics", {
        p_course: code,
        p_week: week,
        p_author: userId,
        p_rows: cleanTopics.map((t) => ({ topic: t.num, lecture: t.cls, version: 1, title: t.title, noteJson: t.noteJson })),
      });
      if (rpcErr) throw rpcErr;
      for (const v of ((rpcData ?? []) as { topic: number; lecture: number; version: number; id: string }[])) {
        versions.push(v);
      }
      res.json({ ok: true, course: code, week, versions });
      if (versions.length) {
        void notifyCoursePublished(code, week, versions).catch(() => {});
        void notifyInAppNewNote(code, week, versions).catch(() => {});
        void pushNewNote(code, week, versions).catch(() => {});
      }
      return;
    }
    for (const t of cleanTopics) {
      const version = await nextTopicVersion(code, week, t.num, t.cls);
      const { data: ins, error: insErr } = await sb
        .from("topic_notes")
        .insert({
          course: code,
          week,
          topic: t.num,
          lecture_no: t.cls,
          version,
          title: t.title,
          note_json: t.noteJson,
          author_id: userId,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      versions.push({ topic: t.num, lecture: t.cls, version, id: (ins as { id: string }).id });
    }
    res.json({ ok: true, course: code, week, versions });
    // Notify enrolled students (fire-and-forget; never blocks publish).
    if (versions.length) {
      void notifyCoursePublished(code, week, versions).catch(() => {});
      void notifyInAppNewNote(code, week, versions).catch(() => {});
      void pushNewNote(code, week, versions).catch(() => {});
    }
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Authed author: publish ONE topic. Occupied topics NEVER stack silently
// (BUG-007): without an explicit mode the API answers 409.
const topicPublishSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(52),
  topic: z.number().int().min(1).max(100),
  title: z.string().max(200).optional(),
  noteJson: z.object({}).passthrough(),
  mode: z.enum(["add", "replace"]).optional(),
  lectureNo: z.number().int().min(1).max(3).default(1),
});

router.post("/topics/publish", requireAuth, requireAuthor, requireCourseAccess, async (req: Request, res: Response) => {
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
    const lecture = parsed.data.lectureNo;
    const { data: existing } = await sb
      .from("topic_notes")
      .select("version,title")
      .eq("course", code)
      .eq("week", week)
      .eq("topic", topic)
      .eq("lecture_no", lecture)
      .order("version", { ascending: false })
      .limit(10);
    const occupied = ((existing ?? []) as { version: number; title: string }[]);
    if (occupied.length && parsed.data.mode !== "add" && parsed.data.mode !== "replace") {
      res.status(409).json({
        error: `Topic ${topic} already has v${occupied[0].version} published.`,
        code: "TOPIC_OCCUPIED",
        existing: { versions: occupied.map((r) => r.version), title: occupied[0].title || "" },
      });
      return;
    }
    if (parsed.data.mode === "replace" && occupied.length) {
      const { error: delErr } = await sb
        .from("topic_notes")
        .delete()
        .eq("course", code)
        .eq("week", week)
        .eq("topic", topic)
        .eq("lecture_no", lecture);
      if (delErr) throw delErr;
      await sb.from("topic_progress").delete().eq("course", code).eq("week", week).eq("topic", topic);
    }
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
    const version = await nextTopicVersion(code, week, topic, lecture);
    const { data: ins, error: insErr } = await sb
      .from("topic_notes")
      .insert({
        course: code,
        week,
        topic,
        lecture_no: lecture,
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
    void pushNewNote(code, week, [{ topic, version }]).catch(() => {});
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
      .select("topic,lecture_no")
      .eq("user_id", userId)
      .eq("course", course)
      .eq("week", week);
    if (error) throw error;
    res.json({ done: ((data ?? []) as { topic: number; lecture_no?: number }[]).map((r) => ({ topic: r.topic, lecture: r.lecture_no || 1 })) });
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
      sb.from("topic_notes").select("course,week,topic,lecture_no,version").eq("author_id", userId),
    ]);
    const courses = [
      ...new Set([
        ...(((teaching.data ?? []) as { course: string }[]).map((r) => r.course)),
        ...(((authored.data ?? []) as { course: string }[]).map((r) => r.course)),
      ]),
    ];
    const rows = ((mine.data ?? []) as { course: string; week: number; topic: number; lecture_no?: number; version: number }[]);
    const topics = new Set(rows.map((r) => `${r.course}|${r.week}|${r.lecture_no || 1}|${r.topic}`)).size;
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
      .select("id,course,week,topic,lecture_no,version,title,created_at")
      .eq("author_id", userId)
      .order("course")
      .order("week")
      .order("lecture_no")
      .order("topic")
      .order("version", { ascending: false });
    if (error) throw error;
    res.json({
      notes: ((data ?? []) as { lecture_no?: number; [k: string]: unknown }[]).map((r) => ({
        ...r,
        lecture: r.lecture_no || 1,
      })),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Lecturer timetable (recurring weekly slots) + class management. ----
// Slots are set once per course (day + time + venue) and repeat weekly.
// Managing needs the course: a teaching enrollment in it, or admin.
async function canManageCourse(userId: string, course: string): Promise<boolean> {
  try {
    const sb = supabaseAdmin();
    const { data: prof } = await sb.from("profiles").select("role,is_admin").eq("id", userId).single();
    const p = prof as { role?: string; is_admin?: boolean } | null;
    if (p?.is_admin || p?.role === "admin") return true;
    const { data: en } = await sb
      .from("enrollments")
      .select("course")
      .eq("user_id", userId)
      .eq("course", course)
      .eq("kind", "teaching")
      .limit(1);
    return ((en ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}

// Courses the caller teaches (lecturer Classes section).
router.get("/teaching", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const { data, error } = await supabaseAdmin()
      .from("enrollments")
      .select("course")
      .eq("user_id", userId)
      .eq("kind", "teaching")
      .order("course");
    if (error) throw error;
    res.json({ courses: ((data ?? []) as { course: string }[]).map((r) => r.course) });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Read a course timetable (every signed-in user: students see class times).
router.get("/timetable", requireAuth, async (req: Request, res: Response) => {
  const course = cleanCode(String(req.query.course || ""));
  if (!course) {
    res.status(400).json({ error: "Pass ?course=CODE." });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("class_slots")
      .select("id,course,lecturer_id,day,start_time,end_time,venue")
      .eq("course", course)
      .order("day")
      .order("start_time");
    if (error) throw error;
    const rows = ((data ?? []) as { id: string; course: string; lecturer_id: string; day: number; start_time: string; end_time: string; venue: string }[]);
    let names: Record<string, string> = {};
    const ids = [...new Set(rows.map((r) => r.lecturer_id))];
    if (ids.length) {
      const { data: profs } = await sb.from("profiles").select("id,first_name").in("id", ids);
      for (const p of ((profs ?? []) as { id: string; first_name: string }[])) {
        if (p.first_name) names[p.id] = p.first_name;
      }
    }
    res.json({
      slots: rows.map((r) => ({
        id: r.id,
        course: r.course,
        day: r.day,
        start: r.start_time,
        end: r.end_time,
        venue: r.venue,
        lecturer: names[r.lecturer_id] || "",
      })),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

const slotSchema = z.object({
  course: z.string().min(1).max(20),
  day: z.number().int().min(0).max(6),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  venue: z.string().max(120).default(""),
});

// Add a weekly slot (teaching lecturer or admin).
router.post("/timetable", requireAuth, requireAuthor, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const parsed = slotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const course = cleanCode(parsed.data.course);
  if (!course) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  if (parsed.data.end <= parsed.data.start) {
    res.status(400).json({ error: "End time must be after start time." });
    return;
  }
  if (!(await canManageCourse(userId, course))) {
    res.status(403).json({ error: "Only the course lecturer or an admin manages its timetable." });
    return;
  }
  // Timetable is lecturer management: contributors author content, they
  // don't set class times (even when assigned to the course).
  const { data: tprof } = await supabaseAdmin().from("profiles").select("role,is_admin").eq("id", userId).single();
  const tp = tprof as { role?: string; is_admin?: boolean } | null;
  if (!(tp?.is_admin || tp?.role === "admin" || tp?.role === "lecturer")) {
    res.status(403).json({ error: "Only the course lecturer or an admin manages its timetable." });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("class_slots")
      .insert({
        course,
        lecturer_id: userId,
        day: parsed.data.day,
        start_time: parsed.data.start,
        end_time: parsed.data.end,
        venue: parsed.data.venue,
      })
      .select("id")
      .single();
    if (error) {
      if (String((error as { code?: string }).code) === "23505") {
        res.status(409).json({ error: "That day and start time already has a slot.", code: "SLOT_OCCUPIED" });
        return;
      }
      throw error;
    }
    res.json({ ok: true, id: (data as { id: string }).id });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Remove a slot (own slots, or any slot for admins).
router.delete("/timetable/:id", requireAuth, requireAuthor, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  try {
    const sb = supabaseAdmin();
    const { data: slot } = await sb
      .from("class_slots")
      .select("id,course,lecturer_id")
      .eq("id", req.params.id)
      .single();
    const s = slot as { id: string; course: string; lecturer_id: string } | null;
    if (!s) {
      res.status(404).json({ error: "Slot not found." });
      return;
    }
    if (s.lecturer_id !== userId && !(await canManageCourse(userId, s.course))) {
      res.status(403).json({ error: "Only the course lecturer or an admin removes slots." });
      return;
    }
    const { error } = await sb.from("class_slots").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Class roster: lecturers (+admins) see who's taking their course.
// Contributors do NOT: they see their assigned courses + contribution
// counts (via /contributions), never the student list.
router.get("/courses/:code/students", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId as string;
  const course = cleanCode(decodeURIComponent(req.params.code));
  if (!course) {
    res.status(400).json({ error: "Invalid course" });
    return;
  }
  const { data: prof } = await supabaseAdmin().from("profiles").select("role,is_admin").eq("id", userId).single();
  const pr = prof as { role?: string; is_admin?: boolean } | null;
  const staff = Boolean(pr?.is_admin || pr?.role === "admin" || pr?.role === "lecturer");
  if (!staff || !(await canManageCourse(userId, course))) {
    res.status(403).json({ error: "Only the course lecturer or an admin sees the roster." });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data: taking, error: takeErr } = await sb
      .from("enrollments")
      .select("user_id")
      .eq("course", course)
      .eq("kind", "taking")
      .limit(500);
    if (takeErr) throw takeErr;
    const ids = ((taking ?? []) as { user_id: string }[]).map((r) => r.user_id);
    if (!ids.length) {
      res.json({ students: [] });
      return;
    }
    const [profs, prog, quiz] = await Promise.all([
      sb.from("profiles").select("id,first_name,email,level").in("id", ids),
      sb.from("topic_progress").select("user_id,completed_at").eq("course", course).in("user_id", ids).limit(5000),
      sb.from("quiz_attempts").select("user_id,created_at").eq("course", course).in("user_id", ids).limit(2000),
    ]);
    if (profs.error) throw profs.error;
    const doneBy: Record<string, number> = {};
    const activeBy: Record<string, string> = {};
    for (const p of ((prog.data ?? []) as { user_id: string; completed_at: string }[])) {
      doneBy[p.user_id] = (doneBy[p.user_id] || 0) + 1;
      if (!activeBy[p.user_id] || p.completed_at > activeBy[p.user_id]) activeBy[p.user_id] = p.completed_at;
    }
    const quizBy: Record<string, number> = {};
    for (const q of ((quiz.data ?? []) as { user_id: string; created_at: string }[])) {
      quizBy[q.user_id] = (quizBy[q.user_id] || 0) + 1;
      if (!activeBy[q.user_id] || q.created_at > activeBy[q.user_id]) activeBy[q.user_id] = q.created_at;
    }
    res.json({
      students: ((profs.data ?? []) as { id: string; first_name: string; email: string; level: string }[]).map((p) => ({
        id: p.id,
        name: p.first_name || "Unnamed",
        email: p.email || "",
        level: p.level || "",
        topicsDone: doneBy[p.id] || 0,
        quizzesTaken: quizBy[p.id] || 0,
        lastActive: activeBy[p.id] || null,
      })),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// Public: week list for a course (titles for pickers + student week lists).
router.get("/courses/:code/weeks", requireAuth, requireCourseAccess, async (req: Request, res: Response) => {
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

// ---- Content browsing: admins see everything; authors see the tree too
// (clients scope authors to their contributing level). ----
async function requireContentViewer(req: Request, res: Response): Promise<string | null> {
  const userId = (req as AuthedRequest).userId;
  if (!userId) {
    res.status(401).json({ error: "Missing session" });
    return null;
  }
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("profiles").select("is_admin,role").eq("id", userId).single();
    const prof = data as { is_admin?: boolean; role?: string } | null;
    if (
      prof?.is_admin ||
      prof?.role === "admin" ||
      prof?.role === "lecturer" ||
      prof?.role === "contributor"
    ) {
      return userId;
    }
  } catch {
    // deny below
  }
  res.status(403).json({ error: "Admins and authors only" });
  return null;
}

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
// Contributors see ONLY their assigned (teaching) courses, enforced here
// — clients must not be trusted with the filter (BUG-001).
router.get("/admin/content", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireContentViewer(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const { data: meProf } = await sb.from("profiles").select("role,is_admin").eq("id", adminId).single();
    const me = meProf as { role?: string; is_admin?: boolean } | null;
    let allowed: Set<string> | null = null;
    if (me?.role === "contributor" && !me?.is_admin) {
      const { data: mine } = await sb
        .from("enrollments")
        .select("course")
        .eq("user_id", adminId)
        .eq("kind", "teaching")
        .limit(100);
      allowed = new Set(
        ((mine ?? []) as { course: string }[]).map((r) => (r.course || "").toUpperCase().trim()).filter(Boolean)
      );
    }
    const [coursesRes, levelsRes, weeksRes, notesRes] = await Promise.all([
      sb.from("courses").select("code,title").order("code").limit(500),
      sb.from("course_levels").select("course,level,semester").limit(2000),
      sb.from("weeks").select("course,week,title").order("course").order("week").limit(5000),
      sb.from("topic_notes").select("course,week,topic,lecture_no,version,title").order("course").order("week").order("lecture_no").order("topic").order("version").limit(5000),
    ]);
    const err = coursesRes.error || levelsRes.error || weeksRes.error || notesRes.error;
    if (err) throw err;
    const levelByCourse = new Map<string, { level: string; semester: string }>();
    for (const r of ((levelsRes.data ?? []) as { course: string; level: string; semester: string }[])) {
      if (!levelByCourse.has(r.course)) levelByCourse.set(r.course, { level: r.level, semester: r.semester });
    }
    const topicsByWeek = new Map<string, { topic: number; lecture: number; versions: number; title: string }[]>();
    for (const n of ((notesRes.data ?? []) as { course: string; week: number; topic: number; lecture_no?: number; version: number; title: string }[])) {
      const lecture = n.lecture_no || 1;
      const key = `${n.course}::${n.week}`;
      const list = topicsByWeek.get(key) || [];
      const last = list[list.length - 1];
      if (last && last.topic === n.topic && last.lecture === lecture) {
        last.versions = Math.max(last.versions, n.version);
        if (!last.title && n.title) last.title = n.title;
      } else {
        list.push({ topic: n.topic, lecture, versions: n.version, title: n.title || "" });
      }
      topicsByWeek.set(key, list);
    }
    const weeksByCourse = new Map<string, { week: number; title: string; topics: { topic: number; lecture: number; versions: number; title: string }[] }[]>();
    for (const w of ((weeksRes.data ?? []) as { course: string; week: number; title: string }[])) {
      const list = weeksByCourse.get(w.course) || [];
      list.push({ week: w.week, title: w.title || "", topics: topicsByWeek.get(`${w.course}::${w.week}`) || [] });
      weeksByCourse.set(w.course, list);
    }
    const courses = (((coursesRes.data ?? []) as { code: string; title: string }[]))
      .filter((c) => !allowed || allowed.has((c.code || "").toUpperCase().trim()))
      .map((c) => {
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

// ---- Admin: recent activity for the oversight dashboard (latest
// signups + latest published note versions). ----
router.get("/admin/activity", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const [users, notes] = await Promise.all([
      sb.from("profiles").select("first_name,email,role,created_at").order("created_at", { ascending: false }).limit(5),
      sb.from("topic_notes").select("course,week,topic,version,title,created_at").order("created_at", { ascending: false }).limit(5),
    ]);
    if (users.error) throw users.error;
    if (notes.error) throw notes.error;
    res.json({ recentUsers: users.data ?? [], recentNotes: notes.data ?? [] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin: 14-day trends for the analytics charts (signups,
// published note versions, XP earned). Small tables, grouped in code. ----
router.get("/admin/trends", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const sb = supabaseAdmin();
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const [users, notes, xp] = await Promise.all([
      sb.from("profiles").select("created_at").gte("created_at", since).limit(5000),
      sb.from("topic_notes").select("created_at").gte("created_at", since).limit(5000),
      sb.from("xp_events").select("amount,created_at").gte("created_at", since).limit(10000),
    ]);
    if (users.error) throw users.error;
    if (notes.error) throw notes.error;
    if (xp.error) throw xp.error;
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) {
      days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    const bucket = (rows: { created_at: string }[]) => {
      const counts = Object.fromEntries(days.map((d) => [d, 0]));
      for (const r of rows) {
        const d = String(r.created_at || "").slice(0, 10);
        if (d in counts) counts[d] += 1;
      }
      return days.map((d) => ({ day: d.slice(5), count: counts[d] }));
    };
    const xpByDay = Object.fromEntries(days.map((d) => [d, 0]));
    for (const r of ((xp.data ?? []) as { amount: number; created_at: string }[])) {
      const d = String(r.created_at || "").slice(0, 10);
      if (d in xpByDay) xpByDay[d] += r.amount || 0;
    }
    res.json({
      signups: bucket((users.data ?? []) as { created_at: string }[]),
      notes: bucket((notes.data ?? []) as { created_at: string }[]),
      xp: days.map((d) => ({ day: d.slice(5), count: xpByDay[d] })),
    });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

// ---- Admin: assign teaching courses to an author (BUG-001). The
// contributor's reachable set IS this list — gates enforce it server-side.
router.get("/admin/users/:id/courses", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  try {
    const { data, error } = await supabaseAdmin()
      .from("enrollments")
      .select("course,kind")
      .eq("user_id", req.params.id);
    if (error) throw error;
    res.json({ courses: (data ?? []) as { course: string; kind: string }[] });
  } catch (e) {
    res.status(500).json(dbError(e));
  }
});

router.put("/admin/users/:id/courses", requireAuth, async (req: Request, res: Response) => {
  const adminId = await requireAdminUser(req, res);
  if (!adminId) return;
  const parsed = z.object({ courses: z.array(z.string().min(1).max(20)).max(10) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const codes = [...new Set(parsed.data.courses.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
    // Only real catalog courses can be assigned (typos fail loudly).
    const { data: known } = await sb.from("courses").select("code").in("code", codes.length ? codes : ["__none__"]);
    const valid = new Set(((known ?? []) as { code: string }[]).map((r) => r.code));
    const bad = codes.filter((c) => !valid.has(c));
    if (bad.length) {
      res.status(400).json({ error: `Unknown course codes: ${bad.join(", ")}` });
      return;
    }
    const { data: prof } = await sb.from("profiles").select("role").eq("id", req.params.id).single();
    const role = (prof as { role?: string } | null)?.role || "";
    const kind = role === "student" ? "taking" : "teaching";
    // Contributor cap (2 teaching courses per level): enforced on direct
    // assignment too, not just request approval. Lecturers are exempt.
    if (kind === "teaching" && role === "contributor" && codes.length) {
      const { data: links } = await sb.from("course_levels").select("course,level").in("course", codes);
      const perLevel: Record<string, number> = {};
      for (const l of ((links ?? []) as { course: string; level: string }[])) {
        perLevel[l.level] = (perLevel[l.level] || 0) + 1;
      }
      const over = Object.entries(perLevel).filter(([, n]) => n > 2);
      if (over.length) {
        res.status(400).json({ error: `Contributor cap: at most 2 courses per level (${over.map(([lv]) => lv).join(", ")} exceed it).` });
        return;
      }
    }
    await sb.from("enrollments").delete().eq("user_id", req.params.id).eq("kind", kind);
    if (codes.length) {
      const { error } = await sb
        .from("enrollments")
        .insert(codes.map((course) => ({ user_id: req.params.id, course, kind })));
      if (error) throw error;
    }
    res.json({ ok: true, courses: codes });
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
    if (role === "student" || role === "lecturer" || role === "contributor" || role === "admin") {
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
  role: z.enum(["student", "lecturer", "contributor", "admin"]).optional(),
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
    // Role changes notify the recipient (promotion or demotion).
    let roleChanged: string | null = null;
    if (parsed.data.role) {
      const { data: before } = await supabaseAdmin()
        .from("profiles")
        .select("role,first_name")
        .eq("id", req.params.id)
        .single();
      const oldRole = (before as { role?: string } | null)?.role;
      if (oldRole && oldRole !== parsed.data.role) roleChanged = parsed.data.role;
    }
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error) throw error;
    if (roleChanged) {
      const label = roleChanged.charAt(0).toUpperCase() + roleChanged.slice(1);
      const link = roleChanged === "student" ? "/course" : roleChanged === "admin" ? "/admin" : "/studio";
      const body =
        roleChanged === "student"
          ? "You now learn with guided paths, XP and streaks."
          : roleChanged === "admin"
            ? "You now manage the whole platform: users, courses, content and announcements."
            : "You now author notes. Open the Studio and pick your contributing level.";
      await supabaseAdmin().from("notifications").insert({
        user_id: req.params.id,
        type: "role",
        title: `Your role is now ${label}`,
        body,
        link,
      });
      void pushToUser(req.params.id, { title: `Your role is now ${label}`, body, url: link }).catch(() => {});
    }
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
  role: z.enum(["student", "lecturer", "contributor", "admin"]).default("student"),
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
    void pushAnnounce(parsed.data.title, parsed.data.body, parsed.data.link).catch(() => {});
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
    // Quiz stats are student metrics — authors/admins testing a quiz
    // record nothing.
    const { data: prof } = await supabaseAdmin().from("profiles").select("role").eq("id", userId).single();
    if ((prof as { role?: string } | null)?.role && (prof as { role?: string }).role !== "student") {
      res.json({ ok: true, recorded: false });
      return;
    }
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
