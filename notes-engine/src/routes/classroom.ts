import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";

// Classroom features on top of v1: Head-of-Class posts and in-person
// attendance by session code. Mounted at /v1 (see server.ts).
//
// Attendance model: a lecturer opens a session for a course they teach and
// gets a 6-digit code that stays valid for N minutes; enrolled students
// enter it on their phone. One record per student per session.
const router = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
// Codes are 6 digits, so guesses must be expensive: tight per-IP cap on check-in.
const checkinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 25, standardHeaders: true, legacyHeaders: false });
router.use(["/hoc", "/attendance"], limiter);

type Prof = {
  id: string;
  first_name: string | null;
  role: string | null;
  is_admin: boolean | null;
  is_hoc: boolean | null;
  department: string | null;
  level: string | null;
  attendance_full_name: string | null;
  attendance_matric: string | null;
};

const PROFILE_COLS = "id,first_name,role,is_admin,is_hoc,department,level,attendance_full_name,attendance_matric";

async function getProfile(userId: string): Promise<Prof | null> {
  const { data } = await supabaseAdmin().from("profiles").select(PROFILE_COLS).eq("id", userId).single();
  return (data as Prof | null) ?? null;
}

const uid = (req: Request) => (req as AuthedRequest).userId as string;
const clean = (raw: unknown) => String(raw ?? "").trim().toUpperCase();
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) =>
  res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });
// Course codes appear both as "CHE 201" and "CHE201": match either.
const variants = (code: string) => [...new Set([code, code.replace(/\s/g, "")])];

// ---------- Head of Class ----------

// Posts for my department + level (students, HOC and lecturers read them).
router.get("/hoc/posts", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getProfile(uid(req));
    if (!me?.department || !me?.level) {
      res.json({ posts: [], isHoc: !!me?.is_hoc });
      return;
    }
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("hoc_posts")
      .select("id,author_id,type,title,content,created_at")
      .eq("department", me.department)
      .eq("level", me.level)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; author_id: string; type: string; title: string | null; content: string; created_at: string }[];
    const ids = [...new Set(rows.map((r) => r.author_id))];
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: authors } = await sb.from("profiles").select("id,first_name").in("id", ids);
      for (const a of (authors ?? []) as { id: string; first_name: string | null }[]) names[a.id] = a.first_name || "HOC";
    }
    res.json({
      isHoc: !!me.is_hoc,
      department: me.department,
      level: me.level,
      posts: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        createdAt: r.created_at,
        author: names[r.author_id] || "HOC",
        mine: r.author_id === me.id,
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

const postSchema = z.object({
  type: z.enum(["announcement", "tip", "question"]),
  title: z.string().trim().max(120).optional(),
  content: z.string().trim().min(1).max(1000),
});

router.post("/hoc/posts", requireAuth, async (req: Request, res: Response) => {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Write something (up to 1000 characters).");
  try {
    const me = await getProfile(uid(req));
    if (!me || !(me.is_hoc || me.is_admin)) return fail(res, 403, "Only your Head of Class can post here.");
    if (!me.department || !me.level) return fail(res, 400, "Set your department and level in Me first.");
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("hoc_posts")
      .insert({
        author_id: me.id,
        department: me.department,
        level: me.level,
        type: parsed.data.type,
        title: parsed.data.title || null,
        content: parsed.data.content,
      })
      .select("id")
      .single();
    if (error) throw error;
    // Announcements ping the class (same department + level), best effort.
    if (parsed.data.type === "announcement") {
      try {
        const { data: mates } = await sb
          .from("profiles")
          .select("id")
          .eq("department", me.department)
          .eq("level", me.level)
          .eq("role", "student")
          .neq("id", me.id)
          .limit(500);
        const rows = ((mates ?? []) as { id: string }[]).map((m) => ({
          user_id: m.id,
          type: "hoc_post",
          title: parsed.data.title || "New announcement from your HOC",
          body: parsed.data.content.slice(0, 140),
          link: "/hoc",
        }));
        if (rows.length) await sb.from("notifications").insert(rows);
      } catch {
        // posting must not fail because notifications did
      }
    }
    res.json({ ok: true, id: (data as { id: string }).id });
  } catch (e) {
    dbFail(res, e);
  }
});

router.delete("/hoc/posts/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getProfile(uid(req));
    const sb = supabaseAdmin();
    const { data: post } = await sb.from("hoc_posts").select("author_id").eq("id", req.params.id).single();
    const authorId = (post as { author_id?: string } | null)?.author_id;
    if (!authorId) return fail(res, 404, "That post is gone.");
    if (authorId !== me?.id && !me?.is_admin) return fail(res, 403, "You can only delete your own posts.");
    const { error } = await sb.from("hoc_posts").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// A student asks to be their class's HOC: admins get a notification and
// approve it with /hoc/grant.
router.post("/hoc/request", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getProfile(uid(req));
    if (!me) return fail(res, 404, "Finish onboarding first.");
    if (me.is_hoc) return fail(res, 400, "You are already a Head of Class.");
    if (me.role !== "student") return fail(res, 400, "Only students can be Head of Class.");
    const sb = supabaseAdmin();
    const { data: admins } = await sb.from("profiles").select("id").eq("is_admin", true);
    const rows = ((admins ?? []) as { id: string }[]).map((a) => ({
      user_id: a.id,
      type: "role_request",
      title: `HOC request: ${me.first_name || "Unnamed"}`,
      body: `${me.first_name || "A student"} (${me.department || "no department"} · ${me.level || "no level"}) asks to be Head of Class. Grant it from the HOC section of the admin panel.`,
      link: "/admin",
    }));
    if (rows.length) await sb.from("notifications").insert(rows);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Admin: grant or revoke HOC by email.
router.post("/hoc/grant", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ email: z.string().email(), revoke: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter a valid email.");
  try {
    const me = await getProfile(uid(req));
    if (!me?.is_admin) return fail(res, 403, "Admins only.");
    const sb = supabaseAdmin();
    const email = parsed.data.email.trim().toLowerCase();
    const { data: target } = await sb.from("profiles").select("id,first_name,role").ilike("email", email).maybeSingle();
    const t = target as { id: string; first_name: string | null; role: string | null } | null;
    if (!t) return fail(res, 404, "No account with that email.");
    if (t.role !== "student") return fail(res, 400, "Only students can be Head of Class.");
    const revoke = !!parsed.data.revoke;
    const { error } = await sb
      .from("profiles")
      .update({ is_hoc: !revoke, hoc_approved_at: revoke ? null : new Date().toISOString(), hoc_approved_by: revoke ? null : me.id })
      .eq("id", t.id);
    if (error) throw error;
    await sb.from("notifications").insert({
      user_id: t.id,
      type: "role_update",
      title: revoke ? "HOC role removed" : "You're now your class's HOC",
      body: revoke ? "You are no longer Head of Class." : "You can now post announcements and tips for your class.",
      link: revoke ? "/me" : "/hoc",
    });
    res.json({ ok: true, name: t.first_name, isHoc: !revoke });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Attendance ----------

// Student: name + matric number lecturers see on the register.
router.get("/attendance/profile", requireAuth, async (req: Request, res: Response) => {
  const me = await getProfile(uid(req));
  res.json({ fullName: me?.attendance_full_name || "", matric: me?.attendance_matric || "" });
});

router.put("/attendance/profile", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ fullName: z.string().trim().min(2).max(100), matric: z.string().trim().min(3).max(30) })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter your full name and matric number.");
  try {
    const { error } = await supabaseAdmin()
      .from("profiles")
      .update({ attendance_full_name: parsed.data.fullName, attendance_matric: parsed.data.matric.toUpperCase() })
      .eq("id", uid(req));
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Can this user take attendance for the course? Teaching enrolment, or admin.
async function canTeach(me: Prof, course: string): Promise<boolean> {
  if (me.is_admin) return true;
  if (me.role !== "lecturer" && me.role !== "contributor") return false;
  const { data } = await supabaseAdmin()
    .from("enrollments")
    .select("course")
    .eq("user_id", me.id)
    .eq("kind", "teaching")
    .in("course", variants(course))
    .limit(1);
  return !!(data && data.length);
}

async function enrolledCount(course: string): Promise<number> {
  const { count } = await supabaseAdmin()
    .from("enrollments")
    .select("user_id", { count: "exact", head: true })
    .eq("kind", "taking")
    .in("course", variants(course));
  return count ?? 0;
}

type SessionRow = { id: string; course_code: string; created_by: string; code: string; week: number | null; opens_at: string; closes_at: string; closed_at: string | null };

async function rosterFor(session: SessionRow) {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("attendance_records")
    .select("student_id,scanned_at")
    .eq("session_id", session.id)
    .order("scanned_at", { ascending: true });
  const rows = (data ?? []) as { student_id: string; scanned_at: string }[];
  const ids = rows.map((r) => r.student_id);
  const info: Record<string, { name: string; matric: string }> = {};
  if (ids.length) {
    const { data: ps } = await sb.from("profiles").select("id,first_name,attendance_full_name,attendance_matric").in("id", ids);
    for (const p of (ps ?? []) as { id: string; first_name: string | null; attendance_full_name: string | null; attendance_matric: string | null }[]) {
      info[p.id] = { name: p.attendance_full_name || p.first_name || "Student", matric: p.attendance_matric || "" };
    }
  }
  return rows.map((r) => ({ studentId: r.student_id, at: r.scanned_at, name: info[r.student_id]?.name || "Student", matric: info[r.student_id]?.matric || "" }));
}

const sessionOut = (s: SessionRow) => ({
  id: s.id,
  course: s.course_code,
  code: s.code,
  week: s.week,
  opensAt: s.opens_at,
  closesAt: s.closes_at,
  open: !s.closed_at && new Date(s.closes_at).getTime() > Date.now(),
});

// Lecturer: open a session. Replaces any session of theirs still open for the course.
router.post("/attendance/sessions", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ course: z.string().min(1).max(20), week: z.number().int().min(1).max(30).optional(), minutes: z.number().int().min(1).max(60).optional() })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick a course.");
  try {
    const me = await getProfile(uid(req));
    const course = clean(parsed.data.course);
    if (!me || !(await canTeach(me, course))) return fail(res, 403, "You can only take attendance for courses you teach.");
    const sb = supabaseAdmin();
    await sb
      .from("attendance_sessions")
      .update({ closed_at: new Date().toISOString() })
      .eq("created_by", me.id)
      .in("course_code", variants(course))
      .is("closed_at", null);
    // A code must be unique among open sessions or a student could land in the wrong class.
    let code = "";
    for (let i = 0; i < 10; i++) {
      const c = String(randomInt(100000, 1000000));
      const { data: clash } = await sb.from("attendance_sessions").select("id").eq("code", c).is("closed_at", null).gt("closes_at", new Date().toISOString()).limit(1);
      if (!clash || !clash.length) {
        code = c;
        break;
      }
    }
    if (!code) return fail(res, 503, "Couldn't make a code just now. Try again.");
    const closesAt = new Date(Date.now() + (parsed.data.minutes ?? 15) * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from("attendance_sessions")
      .insert({ course_code: course, created_by: me.id, code, week: parsed.data.week ?? null, closes_at: closesAt })
      .select("id,course_code,created_by,code,week,opens_at,closes_at,closed_at")
      .single();
    if (error) throw error;
    res.json({ session: sessionOut(data as SessionRow), present: [], enrolled: await enrolledCount(course) });
  } catch (e) {
    dbFail(res, e);
  }
});

// Lecturer: my latest session for a course (open or not) with the live register.
router.get("/attendance/sessions", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const me = await getProfile(uid(req));
    if (!me || !(await canTeach(me, course))) return fail(res, 403, "You can only view attendance for courses you teach.");
    const { data } = await supabaseAdmin()
      .from("attendance_sessions")
      .select("id,course_code,created_by,code,week,opens_at,closes_at,closed_at")
      .in("course_code", variants(course))
      .order("opens_at", { ascending: false })
      .limit(1);
    const s = ((data ?? []) as SessionRow[])[0];
    if (!s) {
      res.json({ session: null, present: [], enrolled: await enrolledCount(course) });
      return;
    }
    res.json({ session: sessionOut(s), present: await rosterFor(s), enrolled: await enrolledCount(course) });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/attendance/sessions/:id/close", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getProfile(uid(req));
    const sb = supabaseAdmin();
    const { data } = await sb.from("attendance_sessions").select("id,course_code,created_by").eq("id", req.params.id).single();
    const s = data as { id: string; course_code: string; created_by: string } | null;
    if (!s) return fail(res, 404, "Session not found.");
    if (s.created_by !== me?.id && !me?.is_admin) return fail(res, 403, "That isn't your session.");
    await sb.from("attendance_sessions").update({ closed_at: new Date().toISOString() }).eq("id", s.id);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Student: enter the code to be marked present.
router.post("/attendance/checkin", requireAuth, checkinLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter the 6-digit code from your lecturer.");
  try {
    const me = await getProfile(uid(req));
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const { data } = await sb
      .from("attendance_sessions")
      .select("id,course_code,created_by,code,week,opens_at,closes_at,closed_at")
      .eq("code", parsed.data.code)
      .is("closed_at", null)
      .gt("closes_at", new Date().toISOString())
      .limit(1);
    const s = ((data ?? []) as SessionRow[])[0];
    if (!s) return fail(res, 404, "That code isn't open. Check it with your lecturer.");
    const { data: enr } = await sb
      .from("enrollments")
      .select("course")
      .eq("user_id", me.id)
      .eq("kind", "taking")
      .in("course", variants(s.course_code))
      .limit(1);
    if (!enr || !enr.length) return fail(res, 403, `You're not enrolled in ${s.course_code}. Add it from Class first.`);
    const { error } = await sb
      .from("attendance_records")
      .insert({ student_id: me.id, course_code: s.course_code, scanned_by: s.created_by, verified: true, week: s.week, session_id: s.id });
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.json({ ok: true, already: true, course: s.course_code });
        return;
      }
      throw error;
    }
    res.json({ ok: true, already: false, course: s.course_code });
  } catch (e) {
    dbFail(res, e);
  }
});

// Student: attendance per enrolled course (attended / sessions held) + recent marks.
router.get("/attendance/mine", requireAuth, async (req: Request, res: Response) => {
  try {
    const sb = supabaseAdmin();
    const me = uid(req);
    const { data: enr } = await sb.from("enrollments").select("course").eq("user_id", me).eq("kind", "taking");
    const courses = ((enr ?? []) as { course: string }[]).map((r) => r.course);
    const { data: recs } = await sb
      .from("attendance_records")
      .select("course_code,scanned_at")
      .eq("student_id", me)
      .order("scanned_at", { ascending: false })
      .limit(200);
    const records = (recs ?? []) as { course_code: string; scanned_at: string }[];
    const out = [] as { course: string; held: number; attended: number }[];
    for (const course of courses) {
      const { count } = await sb
        .from("attendance_sessions")
        .select("id", { count: "exact", head: true })
        .in("course_code", variants(course));
      const norm = (c: string) => c.replace(/\s/g, "").toUpperCase();
      out.push({ course, held: count ?? 0, attended: records.filter((r) => norm(r.course_code) === norm(course)).length });
    }
    res.json({ courses: out, recent: records.slice(0, 10).map((r) => ({ course: r.course_code, at: r.scanned_at })) });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
