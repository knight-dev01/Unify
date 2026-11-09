import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";

// Classroom features on top of v1: Head-of-Class posts and in-person
// attendance by session code. Mounted at /v1 (see server.ts).
//
// Attendance model: a lecturer opens a session for a course they teach (open
// for N minutes). The 6-digit code ROTATES every ROTATE_SECONDS: it is an
// HMAC of the session id and the current time window, so nothing is stored
// and a code photographed or shared in a group chat dies within a minute.
// The current and previous window are both accepted so a student who is
// mid-typing at the boundary isn't rejected. Students enter the code or scan
// the QR (a link that opens the app with the code filled in). One record per
// student per session.
const router = Router();

// A lecture hall shares one campus IP, so per-IP caps would lock out a class:
// the general cap is generous, and check-in is limited per signed-in student.
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false });
const checkinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Runs after requireAuth, so userId is set; one student can't guess codes.
  keyGenerator: (req) => (req as AuthedRequest).userId || "anon",
});
router.use(["/hoc", "/attendance", "/materials"], limiter);

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
const ROTATE_SECONDS = 30;
const attendanceKey = () =>
  process.env.ATTENDANCE_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "unify-dev-attendance";
const windowNow = () => Math.floor(Date.now() / 1000 / ROTATE_SECONDS);
function codeFor(sessionId: string, windowIdx: number): string {
  const h = createHmac("sha256", attendanceKey()).update(`${sessionId}:${windowIdx}`).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, "0");
}
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

// Lecturers teach it; admins always; a class rep (HOC) may scan for a course they take.
async function canScan(me: Prof, course: string): Promise<boolean> {
  if (await canTeach(me, course)) return true;
  if (!me.is_hoc) return false;
  const { data } = await supabaseAdmin()
    .from("enrollments")
    .select("course")
    .eq("user_id", me.id)
    .eq("kind", "taking")
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

const sessionOut = (s: SessionRow) => {
  const open = !s.closed_at && new Date(s.closes_at).getTime() > Date.now();
  const w = windowNow();
  return {
    id: s.id,
    course: s.course_code,
    // Only open sessions expose a code; a closed one shows nothing to copy.
    code: open ? codeFor(s.id, w) : "",
    rotatesAt: new Date((w + 1) * ROTATE_SECONDS * 1000).toISOString(),
    rotateSeconds: ROTATE_SECONDS,
    week: s.week,
    opensAt: s.opens_at,
    closesAt: s.closes_at,
    open,
  };
};

// Who started it, so the other person sees "Started by Dr Ade" and both are in sync.
async function sessionView(s: SessionRow, meId: string) {
  const { data } = await supabaseAdmin().from("profiles").select("first_name,role,is_hoc").eq("id", s.created_by).maybeSingle();
  const p = data as { first_name: string | null; role: string | null; is_hoc: boolean | null } | null;
  const role = p?.role === "lecturer" ? "lecturer" : p?.is_hoc ? "class rep" : p?.role === "admin" ? "admin" : "";
  return { ...sessionOut(s), startedBy: { name: p?.first_name || "Your lecturer", role, mine: s.created_by === meId } };
}

// Lecturer: open a session. Replaces any session of theirs still open for the course.
router.post("/attendance/sessions", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ course: z.string().min(1).max(20), week: z.number().int().min(1).max(30).optional(), minutes: z.number().int().min(1).max(60).optional() })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick a course.");
  try {
    const me = await getProfile(uid(req));
    const course = clean(parsed.data.course);
    if (!me || !(await canScan(me, course))) return fail(res, 403, "You can only take attendance for courses you teach or represent.");
    const sb = supabaseAdmin();
    // ONE live session per course, shared by the lecturer and the class rep: if
    // either of them already opened it, the other joins it (same QR, same
    // register) instead of starting a rival one that would split the class.
    const { data: live } = await sb
      .from("attendance_sessions")
      .select("id,course_code,created_by,code,week,opens_at,closes_at,closed_at")
      .in("course_code", variants(course))
      .is("closed_at", null)
      .gt("closes_at", new Date().toISOString())
      .order("opens_at", { ascending: false })
      .limit(1);
    const joined = ((live ?? []) as SessionRow[])[0];
    if (joined) {
      res.json({ session: await sessionView(joined, me.id), present: await rosterFor(joined), enrolled: await enrolledCount(course), joined: true });
      return;
    }
    // Tidy any expired-but-unclosed leftovers for this course.
    await sb
      .from("attendance_sessions")
      .update({ closed_at: new Date().toISOString() })
      .in("course_code", variants(course))
      .is("closed_at", null);
    const closesAt = new Date(Date.now() + (parsed.data.minutes ?? 15) * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from("attendance_sessions")
      .insert({ course_code: course, created_by: me.id, code: "", week: parsed.data.week ?? null, closes_at: closesAt })
      .select("id,course_code,created_by,code,week,opens_at,closes_at,closed_at")
      .single();
    if (error) throw error;
    res.json({ session: await sessionView(data as SessionRow, me.id), present: [], enrolled: await enrolledCount(course) });
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
    if (!me || !(await canScan(me, course))) return fail(res, 403, "You can only view attendance for courses you teach or represent.");
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
    res.json({ session: await sessionView(s, me.id), present: await rosterFor(s), enrolled: await enrolledCount(course) });
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
    // The session is shared: the lecturer or the class rep for this course can end it.
    if (!me || !(await canScan(me, s.course_code))) return fail(res, 403, "You can't end this session.");
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
    // Find the open session whose current (or previous) rotating code matches
    // AND that the student is enrolled in: two sessions sharing a code in the
    // same window (1 in a million) can't send them to the wrong class.
    const { data: openRows } = await sb
      .from("attendance_sessions")
      .select("id,course_code,created_by,code,week,opens_at,closes_at,closed_at")
      .is("closed_at", null)
      .gt("closes_at", new Date().toISOString())
      .limit(500);
    const w = windowNow();
    const matches = ((openRows ?? []) as SessionRow[]).filter((r) => {
      const c = parsed.data.code;
      return codeFor(r.id, w) === c || codeFor(r.id, w - 1) === c;
    });
    if (!matches.length) return fail(res, 404, "That code isn't open any more. Codes change every 30 seconds: check the screen again.");
    let s: SessionRow | undefined;
    for (const m of matches) {
      const { data: e } = await sb.from("enrollments").select("course").eq("user_id", me.id).eq("kind", "taking").in("course", variants(m.course_code)).limit(1);
      if (e && e.length) { s = m; break; }
    }
    if (!s) return fail(res, 403, `You're not enrolled in ${matches[0].course_code}. Add it from Courses first.`);
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

// ---------- Lecturer materials (shared as links) ----------

const MATERIAL_TYPES = ["slides", "notes", "past-paper"] as const;

// Anyone signed in can read a course's materials (links to Drive, OneDrive, ...).
router.get("/materials", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("lecturer_materials")
      .select("id,uploaded_by,course_code,week_number,type,title,file_url,created_at")
      .in("course_code", variants(course))
      .order("week_number", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const me = uid(req);
    res.json({
      materials: ((data ?? []) as { id: string; uploaded_by: string; week_number: number; type: string; title: string | null; file_url: string; created_at: string }[]).map((m) => ({
        id: m.id,
        week: m.week_number,
        type: m.type,
        title: m.title || "",
        url: m.file_url,
        createdAt: m.created_at,
        mine: m.uploaded_by === me,
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

const materialSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(30),
  type: z.enum(MATERIAL_TYPES),
  title: z.string().trim().min(1).max(120),
  url: z.string().trim().max(500).url().refine((u) => /^https:\/\//i.test(u), "Use an https link."),
});

router.post("/materials", requireAuth, async (req: Request, res: Response) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Add a title and paste a full https link.");
  try {
    const me = await getProfile(uid(req));
    const course = clean(parsed.data.course);
    if (!me || !(await canTeach(me, course))) return fail(res, 403, "You can only share materials for courses you teach.");
    const { data, error } = await supabaseAdmin()
      .from("lecturer_materials")
      .insert({ uploaded_by: me.id, course_code: course, week_number: parsed.data.week, type: parsed.data.type, title: parsed.data.title, file_url: parsed.data.url })
      .select("id")
      .single();
    if (error) throw error;
    res.json({ ok: true, id: (data as { id: string }).id });
  } catch (e) {
    dbFail(res, e);
  }
});

router.delete("/materials/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getProfile(uid(req));
    const sb = supabaseAdmin();
    const { data } = await sb.from("lecturer_materials").select("uploaded_by").eq("id", req.params.id).single();
    const owner = (data as { uploaded_by?: string } | null)?.uploaded_by;
    if (!owner) return fail(res, 404, "That item is gone.");
    if (owner !== me?.id && !me?.is_admin) return fail(res, 403, "You can only remove your own materials.");
    const { error } = await sb.from("lecturer_materials").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- CGPA planner (students) ----------
// The planner used to read and write these tables straight from the browser,
// where row-level security silently returned nothing and ignored writes.
// Everything goes through here now, scoped to the signed-in student.

router.use("/cgpa", limiter);

async function requireStudent(req: Request, res: Response): Promise<Prof | null> {
  const me = await getProfile(uid(req));
  if (!me) {
    fail(res, 404, "Finish onboarding first.");
    return null;
  }
  if ((me.role || "student") !== "student") {
    fail(res, 403, "The CGPA planner is for students.");
    return null;
  }
  return me;
}

router.get("/cgpa", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await requireStudent(req, res);
    if (!me) return;
    const sb = supabaseAdmin();
    const { data: prof } = await sb
      .from("profiles")
      .select("cgpa_current,cgpa_target,hide_cgpa,cgpa_units_done,cgpa_units_total,level")
      .eq("id", me.id)
      .single();
    const p = (prof ?? {}) as { cgpa_current: number | null; cgpa_target: number | null; hide_cgpa: boolean | null; cgpa_units_done: number | null; cgpa_units_total: number | null; level: string | null };
    const { data: enr } = await sb.from("enrollments").select("course").eq("user_id", me.id).eq("kind", "taking");
    const codes = ((enr ?? []) as { course: string }[]).map((r) => r.course);
    const titles: Record<string, string> = {};
    if (codes.length) {
      const { data: cs } = await sb.from("courses").select("code,title").in("code", codes);
      for (const c of (cs ?? []) as { code: string; title: string }[]) titles[c.code] = c.title;
    }
    const saved: Record<string, { status: string; units: number; grade: number | null }> = {};
    if (codes.length) {
      const { data: st } = await sb.from("course_status").select("course_code,status,units,grade").eq("user_id", me.id).in("course_code", codes);
      for (const r of (st ?? []) as { course_code: string; status: string; units: number; grade: number | null }[]) saved[r.course_code] = r;
    }
    res.json({
      cgpaCurrent: p.cgpa_current != null ? Number(p.cgpa_current) : null,
      cgpaTarget: p.cgpa_target != null ? Number(p.cgpa_target) : null,
      hideCgpa: !!p.hide_cgpa,
      unitsDone: p.cgpa_units_done,
      unitsTotal: p.cgpa_units_total,
      level: p.level,
      courses: codes.map((code) => ({
        code,
        title: titles[code] || code,
        status: saved[code]?.status || "not_yet",
        units: saved[code]?.units || 3,
        grade: saved[code]?.grade != null ? Number(saved[code].grade) : null,
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

const cgpaSchema = z
  .object({
    cgpaCurrent: z.number().min(0).max(5).optional(),
    cgpaTarget: z.number().min(0.5).max(5).optional(),
    unitsDone: z.number().int().min(0).max(400).optional(),
    unitsTotal: z.number().int().min(1).max(500).optional(),
    hide: z.boolean().optional(),
    courses: z
      .array(
        z.object({
          code: z.string().min(1).max(20),
          status: z.enum(["done", "priority", "not_yet"]),
          units: z.number().int().min(1).max(8),
          grade: z.number().min(0).max(5).nullish(),
        })
      )
      .max(60)
      .optional(),
  })
  .refine((v) => v.unitsDone == null || v.unitsTotal == null || v.unitsTotal >= v.unitsDone, {
    message: "Total units can't be less than the units you've completed.",
  });

router.put("/cgpa", requireAuth, async (req: Request, res: Response) => {
  const parsed = cgpaSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Check the numbers and try again.");
  try {
    const me = await requireStudent(req, res);
    if (!me) return;
    const sb = supabaseAdmin();
    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.cgpaCurrent != null) patch.cgpa_current = Math.round(d.cgpaCurrent * 100) / 100;
    if (d.cgpaTarget != null) patch.cgpa_target = Math.round(d.cgpaTarget * 100) / 100;
    if (d.unitsDone != null) patch.cgpa_units_done = d.unitsDone;
    if (d.unitsTotal != null) patch.cgpa_units_total = d.unitsTotal;
    if (d.hide != null) patch.hide_cgpa = d.hide;
    if (Object.keys(patch).length) {
      const { error } = await sb.from("profiles").update(patch).eq("id", me.id);
      if (error) throw error;
    }
    if (d.courses && d.courses.length) {
      // Only courses the student is actually enrolled in: no arbitrary codes.
      const { data: enr } = await sb.from("enrollments").select("course").eq("user_id", me.id).eq("kind", "taking");
      const mine = new Set(((enr ?? []) as { course: string }[]).map((r) => r.course));
      const rows = d.courses
        .filter((c) => mine.has(c.code))
        .map((c) => ({ user_id: me.id, course_code: c.code, status: c.status, units: c.units, grade: c.grade ?? null, updated_at: new Date().toISOString() }));
      if (rows.length) {
        const { error } = await sb.from("course_status").upsert(rows, { onConflict: "user_id,course_code" });
        if (error) throw error;
      }
    }
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Persona (profile picture) ----------
// Everyone can pick one of the five Box Boy personas as their picture.
// This replaces a browser-side profiles update that row-level security
// silently ignored, so personas never actually saved.
const PERSONA_KEYS = ["go-getter", "comeback", "curious", "team-player", "on-the-move"] as const;

router.put("/persona", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ persona: z.enum(PERSONA_KEYS), clearPhoto: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick one of the Box Boys.");
  try {
    const patch: Record<string, unknown> = { box_boy_persona: parsed.data.persona };
    // "Use my Box Boy instead": drop the uploaded photo so the persona shows.
    if (parsed.data.clearPhoto) patch.avatar_url = "";
    const { error } = await supabaseAdmin().from("profiles").update(patch).eq("id", uid(req));
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
