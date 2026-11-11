import { clientKey } from "../middleware/limits";
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendPushToUsers } from "../lib/push";
import { currentSemesterWeek } from "../lib/calendar";
import { ENTRY_COLS, entryOfStudent, expectedEntries, institutionOf, listForClass, listsForCourse, notTaking, type EntryRow } from "../lib/classlist";

// Classroom features on top of v1: Head-of-Class posts and in-person
// attendance by session code. Mounted at /v1 (see server.ts).
//
// Attendance model: the lecturer or the class rep (HOC) opens a session for a
// course (open for N minutes). In class, students never scan: each student
// shows MY PASS, a QR that rotates every PASS_SECONDS (an HMAC of their id and
// the time window, so nothing is stored and a screenshot sent to a friend dies
// within a minute), and the HOC or lecturer scans it. A student with a dead
// phone is typed in by matric number and marked "typed". Online classes have no
// room to scan in, so the lecturer shares a 6-digit code (an HMAC of the
// session id and a 10-minute window) in the meeting chat and students type it.
// One record per student per session. No photos are taken.
const router = Router();

// A lecture hall shares one campus IP, so per-IP caps would lock out a class:
// the general cap is generous, and check-in is limited per signed-in student.
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey });
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
// In-room sessions rotate every 30 s (a photo of the screen goes stale). An ONLINE class has no
// screen to scan: the lecturer pastes the code into the meeting chat, so it has to survive long
// enough to be typed, and rotates every 10 minutes instead. Online sessions are marked by the
// `code` column holding "online" (the column is otherwise unused, so no migration is needed).
const ONLINE_ROTATE_SECONDS = 600;
const isOnline = (s: { code?: string | null }) => s.code === "online";
const rotateOf = (s: { code?: string | null }) => (isOnline(s) ? ONLINE_ROTATE_SECONDS : ROTATE_SECONDS);
const windowOf = (s: { code?: string | null }, now = Date.now()) => Math.floor(now / 1000 / rotateOf(s));
const windowNow = () => Math.floor(Date.now() / 1000 / ROTATE_SECONDS);
function codeFor(sessionId: string, windowIdx: number): string {
  const h = createHmac("sha256", attendanceKey()).update(`${sessionId}:${windowIdx}`).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, "0");
}
const variants = (code: string) => [...new Set([code, code.replace(/\s/g, "")])];

// ---------- Student pass ----------
// QR text: UP1.<studentId>.<window>.<signature>. The scanner accepts the current
// window and one either side (a pass shown at the boundary, or clocks a little apart).
const PASS_SECONDS = 30;
const passWindow = (now = Date.now()) => Math.floor(now / 1000 / PASS_SECONDS);
const passSig = (studentId: string, w: number) =>
  createHmac("sha256", attendanceKey()).update(`pass:${studentId}:${w}`).digest("base64url").slice(0, 16);
const passToken = (studentId: string, w: number) => `UP1.${studentId}.${w}.${passSig(studentId, w)}`;
const PASS_RE = /^UP1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})\.([A-Za-z0-9_-]{16})$/i;
function readPass(token: string): { id: string } | { error: string } {
  const m = PASS_RE.exec(token.trim());
  if (!m) return { error: "That isn't a Unify pass. Ask them to open My pass in the app." };
  const [, id, wRaw, sig] = m;
  const w = Number(wRaw);
  const want = Buffer.from(passSig(id.toLowerCase(), w));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: "That pass isn't valid. Ask them to reopen My pass." };
  if (Math.abs(passWindow() - w) > 1) return { error: "That pass has expired. Ask them to reopen My pass and scan again." };
  return { id: id.toLowerCase() };
}

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
    // Who a post reaches, shown to the class rep: "Posting to Chemical Engineering · 200L · 84 students".
    // The class list is the count once it's up; before that, students in the class on Unify.
    let audience: { students: number; fromList: boolean } | undefined;
    if (me.is_hoc || me.is_admin) {
      const list = await listForClass(institutionOf(), me.department, me.level);
      if (list) {
        const { count } = await sb.from("class_list_entries").select("id", { count: "exact", head: true }).eq("list_id", list.id).is("removed_at", null);
        audience = { students: count ?? 0, fromList: true };
      } else {
        const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).eq("department", me.department).eq("level", me.level).eq("role", "student");
        audience = { students: count ?? 0, fromList: false };
      }
    }
    res.json({
      isHoc: !!me.is_hoc,
      department: me.department,
      level: me.level,
      audience,
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

// A student asks to be their class's rep: the request goes in the queue that
// their class's level admin answers (Unify admins can too), and both are told.
router.post("/hoc/request", requireAuth, async (req: Request, res: Response) => {
  const note = z.object({ note: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
  try {
    const me = await getProfile(uid(req));
    if (!me) return fail(res, 404, "Finish onboarding first.");
    if (me.is_hoc) return fail(res, 400, "You are already a Head of Class.");
    if (me.role !== "student") return fail(res, 400, "Only students can be Head of Class.");
    if (!me.department || !me.level) return fail(res, 400, "Set your department and level in Me first.");
    const sb = supabaseAdmin();
    const { error: reqErr } = await sb
      .from("hoc_requests")
      .insert({ user_id: me.id, institution: institutionOf(), department: me.department, level: me.level, note: note.success ? note.data.note || "" : "" });
    if (reqErr) {
      if ((reqErr as { code?: string }).code === "23505") return res.json({ ok: true, already: true });
      throw reqErr;
    }
    const { data: admins } = await sb.from("profiles").select("id").eq("is_admin", true);
    const { data: levelAdmins } = await sb
      .from("role_grants")
      .select("user_id")
      .eq("role", "level_admin")
      .eq("department", me.department)
      .eq("level", me.level);
    const ids = [...new Set([...((admins ?? []) as { id: string }[]).map((a) => a.id), ...((levelAdmins ?? []) as { user_id: string }[]).map((a) => a.user_id)])];
    const rows = ids.map((user_id) => ({
      user_id,
      type: "role_request",
      title: `Class rep request: ${me.first_name || "Unnamed"}`,
      body: `${me.first_name || "A student"} (${me.department} · ${me.level}) asks to be class rep. Answer it in Class rep requests.`,
      link: "/hoc/requests",
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
    // At most 3 class reps per class (department + level).
    if (!revoke) {
      const { data: tp } = await sb.from("profiles").select("department,level").eq("id", t.id).maybeSingle();
      const cls = tp as { department: string | null; level: string | null } | null;
      if (!cls?.department || !cls.level) return fail(res, 400, "They need a department and level on their profile first.");
      const { count } = await sb
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("is_hoc", true)
        .eq("department", cls.department)
        .eq("level", cls.level)
        .neq("id", t.id);
      if ((count ?? 0) >= 3) return fail(res, 409, `${cls.department} ${cls.level} already has 3 class reps. Remove one first.`);
    }
    const { error } = await sb
      .from("profiles")
      .update({ is_hoc: !revoke, hoc_approved_at: revoke ? null : new Date().toISOString(), hoc_approved_by: revoke ? null : me.id })
      .eq("id", t.id);
    if (error) throw error;
    await sb.from("notifications").insert({
      user_id: t.id,
      type: "role_update",
      title: revoke ? "HOC role removed" : "You're now your class's HOC",
      body: revoke ? "You are no longer Head of Class." : "Start with your class list: tap to set up your class in four quick steps.",
      link: revoke ? "/me" : "/hoc/welcome",
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
    // Once the class rep has uploaded the class list, the name and matric come
    // from the list: the student claims their entry instead (/class-list/claim).
    const me = await getProfile(uid(req));
    if (me?.department && me.level && (await listForClass(institutionOf(), me.department, me.level))) {
      return res.status(409).json({ error: "Your class list is up. Find yourself on it with your matric number.", classList: true });
    }
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

type SessionRow = {
  id: string; course_code: string; created_by: string; code: string; week: number | null;
  opens_at: string; closes_at: string; closed_at: string | null; slot_id?: string | null; label?: string | null;
};
const SESSION_COLS = "id,course_code,created_by,code,week,opens_at,closes_at,closed_at,slot_id,label";
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- Old attendance selfies ----------
// Selfies are no longer taken (dropped 2026-11-11). Photos left from earlier
// sessions sit in a private bucket; the sweep below deletes them, and closing a
// session still clears its folder.
const SELFIE_BUCKET = "attendance-selfies";
async function deleteSessionSelfies(sessionId: string): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const { data: files } = await sb.storage.from(SELFIE_BUCKET).list(sessionId, { limit: 1000 });
    const paths = (files ?? []).map((f) => `${sessionId}/${f.name}`);
    if (paths.length) await sb.storage.from(SELFIE_BUCKET).remove(paths);
  } catch {
    // the next sweep tries again
  }
}

async function sweepEndedSelfies(days: number): Promise<void> {
  try {
    const now = new Date().toISOString();
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await supabaseAdmin()
      .from("attendance_sessions")
      .select("id")
      .gt("opens_at", since)
      .or(`closed_at.not.is.null,closes_at.lt.${now}`)
      .order("opens_at", { ascending: false })
      .limit(300);
    for (const row of (data ?? []) as { id: string }[]) await deleteSessionSelfies(row.id);
  } catch {
    // best effort; runs again shortly
  }
}
setTimeout(() => void sweepEndedSelfies(14), 60 * 1000).unref();
setInterval(() => void sweepEndedSelfies(3), 5 * 60 * 1000).unref();

type StudentCard = { id: string; name: string; matric: string; level: string; department: string; avatar: string; persona: string };
type CardRow = { id: string; first_name: string | null; attendance_full_name: string | null; attendance_matric: string | null; level: string | null; department: string | null; avatar_url: string | null; box_boy_persona: string | null };
const CARD_COLS = "id,first_name,attendance_full_name,attendance_matric,level,department,avatar_url,box_boy_persona";
const toCard = (p: CardRow): StudentCard => ({
  id: p.id,
  name: p.attendance_full_name || p.first_name || "Student",
  matric: p.attendance_matric || "",
  level: p.level || "",
  department: p.department || "",
  avatar: p.avatar_url || "",
  persona: p.box_boy_persona || "",
});

type PresentRow = {
  studentId: string;
  entryId: string;
  at: string;
  name: string;
  matric: string;
  avatar: string;
  persona: string;
  method: "scan" | "typed" | "code";
  by: string;
  // null: the class rep hasn't uploaded a class list for this course yet.
  onList: boolean | null;
};

async function rosterFor(session: SessionRow, listIds?: Set<string>): Promise<PresentRow[]> {
  const sb = supabaseAdmin();
  if (!listIds) listIds = new Set((await listsForCourse(session.course_code)).lists.map((l) => l.id));
  const { data } = await sb
    .from("attendance_records")
    .select("student_id,entry_id,scanned_at,scanned_by,method")
    .eq("session_id", session.id)
    .order("scanned_at", { ascending: true });
  const rows = (data ?? []) as { student_id: string | null; entry_id: string | null; scanned_at: string; scanned_by: string; method: string | null }[];
  const ids = [...new Set([...rows.map((r) => r.student_id || ""), ...rows.map((r) => r.scanned_by)].filter(Boolean))];
  const info: Record<string, StudentCard> = {};
  if (ids.length) {
    const { data: ps } = await sb.from("profiles").select(CARD_COLS).in("id", ids);
    for (const p of (ps ?? []) as CardRow[]) info[p.id] = toCard(p);
  }
  const entryIds = [...new Set(rows.map((r) => r.entry_id || "").filter(Boolean))];
  const entries: Record<string, EntryRow> = {};
  for (let i = 0; i < entryIds.length; i += 300) {
    const { data: es } = await sb.from("class_list_entries").select(ENTRY_COLS).in("id", entryIds.slice(i, i + 300));
    for (const e of (es ?? []) as EntryRow[]) entries[e.id] = e;
  }
  return rows.map((r) => {
    const c = r.student_id ? info[r.student_id] : undefined;
    const e = r.entry_id ? entries[r.entry_id] : undefined;
    return {
      studentId: r.student_id || "",
      entryId: r.entry_id || "",
      at: r.scanned_at,
      // The class list is the source of truth for names on the register.
      name: e?.full_name || c?.name || "Student",
      matric: e?.matric || c?.matric || "",
      avatar: c?.avatar || "",
      persona: c?.persona || "",
      method: (r.method || "code") as "scan" | "typed" | "code",
      // Who marked them (the online code marks the student themselves).
      by: r.method === "code" ? "" : info[r.scanned_by]?.name || "",
      onList: listIds!.size ? !!e && listIds!.has(e.list_id) : null,
    };
  });
}

// The full register: who's present, and (once a class list exists) who's absent.
async function registerFor(session: SessionRow) {
  const cl = await listsForCourse(session.course_code);
  const listIds = new Set(cl.lists.map((l) => l.id));
  const present = await rosterFor(session, listIds);
  if (!cl.lists.length) return { present, absent: [] as { entryId: string; name: string; matric: string; joined: boolean; notTaking: boolean }[], listed: null as number | null, lists: [] as string[] };
  const expected = await expectedEntries(cl);
  const here = new Set(present.map((p) => p.entryId).filter(Boolean));
  const hereStudents = new Set(present.map((p) => p.studentId).filter(Boolean));
  const absent = expected
    .filter((e) => !here.has(e.id) && !(e.student_id && hereStudents.has(e.student_id)))
    .map((e) => ({ entryId: e.id, name: e.full_name, matric: e.matric, joined: !!e.student_id, notTaking: notTaking(cl, e) }));
  return { present, absent, listed: expected.length, lists: cl.lists.map((l) => `${l.department} · ${l.level}`) };
}

const sessionOut = (s: SessionRow) => {
  const open = !s.closed_at && new Date(s.closes_at).getTime() > Date.now();
  const rot = rotateOf(s);
  const w = windowOf(s);
  return {
    id: s.id,
    course: s.course_code,
    online: isOnline(s),
    // Only an open ONLINE class has a code to share; in class, passes are scanned.
    code: open && isOnline(s) ? codeFor(s.id, w) : "",
    rotatesAt: new Date((w + 1) * rot * 1000).toISOString(),
    rotateSeconds: rot,
    week: s.week,
    label: s.label || "",
    slotId: s.slot_id || "",
    opensAt: s.opens_at,
    closesAt: s.closes_at,
    open,
  };
};

// A new session tells the other half of the pair, so the lecturer and the class
// rep are always together: a lecturer starting it notifies the course's class
// reps; a class rep starting it notifies the lecturers who teach the course.
// In-app bell + push. Never allowed to fail the request.
// Online class: tell the students taking the course it is live, with the Meet link, so they
// join, get the code from the meeting chat, and come back to Unify to mark themselves present.
async function notifyOnline(me: Prof, session: SessionRow, meetLink?: string): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const course = session.course_code;
    const { data: taking } = await sb.from("enrollments").select("user_id").eq("kind", "taking").in("course", variants(course)).limit(2000);
    const ids = [...new Set(((taking ?? []) as { user_id: string }[]).map((r) => r.user_id))].filter((id) => id !== me.id);
    if (!ids.length) return;
    const who = me.first_name || "Your lecturer";
    const title = `${course} online class is live`;
    const body = `${who} started it. Join the meeting, then enter the attendance code shared there.`;
    const link = `/attendance/pass?online=1&course=${encodeURIComponent(course)}${meetLink ? `&m=${encodeURIComponent(meetLink)}` : ""}`;
    for (let i = 0; i < ids.length; i += 500) {
      await sb.from("notifications").insert(ids.slice(i, i + 500).map((user_id) => ({ user_id, type: "online_class", title, body, course, link })));
    }
    await sendPushToUsers(ids, { title, body, url: link });
  } catch {
    // starting the class must not fail because a notification did
  }
}

async function notifyPair(me: Prof, session: SessionRow): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const course = session.course_code;
    const { data: teach } = await sb.from("enrollments").select("user_id").eq("kind", "teaching").in("course", variants(course));
    const teacherIds = [...new Set(((teach ?? []) as { user_id: string }[]).map((r) => r.user_id))];
    const starterIsTeacher = me.is_admin || me.role === "lecturer" || teacherIds.includes(me.id);
    let recipients: string[] = [];
    if (starterIsTeacher) {
      const { data: taking } = await sb.from("enrollments").select("user_id").eq("kind", "taking").in("course", variants(course)).limit(2000);
      const takerIds = [...new Set(((taking ?? []) as { user_id: string }[]).map((r) => r.user_id))];
      if (takerIds.length) {
        const { data: reps } = await sb.from("profiles").select("id").eq("is_hoc", true).in("id", takerIds);
        recipients = ((reps ?? []) as { id: string }[]).map((r) => r.id);
      }
    } else {
      recipients = teacherIds;
    }
    recipients = recipients.filter((id) => id !== me.id);
    if (!recipients.length) return;
    const who = me.first_name || (starterIsTeacher ? "Your lecturer" : "Your class rep");
    const title = `Attendance is open for ${course}`;
    const body = `${who} started it. Open it to scan passes and watch the register.`;
    await sb.from("notifications").insert(
      recipients.map((user_id) => ({ user_id, type: "attendance_started", title, body, course, link: "/attendance/scanner" }))
    );
    await sendPushToUsers(recipients, { title, body, url: "/attendance/scanner" });
  } catch {
    // starting attendance must not fail because a notification did
  }
}

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
    .object({
      course: z.string().min(1).max(20),
      week: z.number().int().min(1).max(30).optional(),
      minutes: z.number().int().min(1).max(180).optional(),
      online: z.boolean().optional(),
      meetLink: z.string().trim().max(300).url().refine((u) => /^https:\/\//i.test(u), "Use a link that starts with https://").optional(),
      // Which class on the timetable this register is for, or an extra class.
      slotId: z.string().uuid().optional(),
      extra: z.boolean().optional(),
    })
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
      .select(SESSION_COLS)
      .in("course_code", variants(course))
      .is("closed_at", null)
      .gt("closes_at", new Date().toISOString())
      .order("opens_at", { ascending: false })
      .limit(1);
    const joined = ((live ?? []) as SessionRow[])[0];
    if (joined) {
      res.json({ session: await sessionView(joined, me.id), ...(await registerFor(joined)), enrolled: await enrolledCount(course), joined: true });
      return;
    }
    // Which class this new register is for (checked only when starting one, never when joining).
    let slotId: string | null = null;
    let label = parsed.data.extra ? "Extra class" : "";
    if (parsed.data.slotId && !parsed.data.extra) {
      const { data: slot } = await sb.from("class_slots").select("id,course,day,start_time").eq("id", parsed.data.slotId).maybeSingle();
      const sl = slot as { id: string; course: string; day: number; start_time: string } | null;
      if (!sl || (!variants(course).includes(sl.course) && !variants(sl.course).includes(course))) return fail(res, 400, "That class isn't on this course's timetable.");
      slotId = sl.id;
      label = `${DAY_SHORT[sl.day] || ""} ${sl.start_time}`.trim();
    }
    // Tidy any expired-but-unclosed leftovers for this course.
    await sb
      .from("attendance_sessions")
      .update({ closed_at: new Date().toISOString() })
      .in("course_code", variants(course))
      .is("closed_at", null);
    // In-room sessions are short (up to an hour); an online lecture can run up to three.
    const online = !!parsed.data.online;
    const mins = Math.min(parsed.data.minutes ?? (online ? 90 : 15), online ? 180 : 60);
    const closesAt = new Date(Date.now() + mins * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from("attendance_sessions")
      // No week given (started from the scanner, not a course week): file it under this week of the semester.
      .insert({ course_code: course, created_by: me.id, code: online ? "online" : "", week: parsed.data.week ?? (await currentSemesterWeek()), closes_at: closesAt, slot_id: slotId, label })
      .select(SESSION_COLS)
      .single();
    if (error) throw error;
    void notifyPair(me, data as SessionRow);
    if (online) void notifyOnline(me, data as SessionRow, parsed.data.meetLink);
    res.json({ session: await sessionView(data as SessionRow, me.id), ...(await registerFor(data as SessionRow)), enrolled: await enrolledCount(course) });
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
    // ?session=ID opens one past register (from the course page); otherwise the latest.
    const sid = String(req.query.session || "");
    let q = supabaseAdmin().from("attendance_sessions").select(SESSION_COLS).in("course_code", variants(course));
    if (/^[0-9a-f-]{36}$/i.test(sid)) q = q.eq("id", sid);
    const { data } = await q.order("opens_at", { ascending: false }).limit(1);
    const s = ((data ?? []) as SessionRow[])[0];
    if (!s) {
      res.json({ session: null, present: [], absent: [], listed: null, lists: [], enrolled: await enrolledCount(course) });
      return;
    }
    res.json({ session: await sessionView(s, me.id), ...(await registerFor(s)), enrolled: await enrolledCount(course) });
  } catch (e) {
    dbFail(res, e);
  }
});

// The register as a spreadsheet: present and absent, one row each.
router.get("/attendance/sessions/:id/register.csv", requireAuth, async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, "Session not found.");
  try {
    const me = await getProfile(uid(req));
    const { data } = await supabaseAdmin()
      .from("attendance_sessions")
      .select(SESSION_COLS)
      .eq("id", req.params.id)
      .maybeSingle();
    const s = data as SessionRow | null;
    if (!s) return fail(res, 404, "Session not found.");
    if (!me || !(await canScan(me, s.course_code))) return fail(res, 403, "You can only export registers for courses you teach or represent.");
    const reg = await registerFor(s);
    const how = { scan: "Pass scanned", typed: "Matric typed", code: "Online code" } as const;
    const esc = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? "'" : "") + v.replace(/"/g, '""')}"` : v);
    const lagos = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", hour12: false });
    const lines = [["Name", "Matric", "Status", "How", "Time (Lagos)", "Marked by", "On class list"].join(",")];
    for (const p of [...reg.present].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push([p.name, p.matric, "Present", how[p.method] || p.method, lagos(p.at), p.by, p.onList === null ? "" : p.onList ? "Yes" : "No"].map(esc).join(","));
    }
    for (const a of reg.absent) lines.push([a.name, a.matric, "Absent", a.notTaking ? "Hasn't added this course on Unify" : "", "", "", "Yes"].map(esc).join(","));
    const day = new Date(s.opens_at).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    const file = `${s.course_code.replace(/\s+/g, "")}-register-${day}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send("﻿" + lines.join("\r\n"));
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
    await deleteSessionSelfies(s.id); // attendance is recorded; the photos have done their job
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Student: my pass. The QR changes every PASS_SECONDS; the app fetches a new one at rotatesAt.
router.get("/attendance/pass", requireAuth, async (req: Request, res: Response) => {
  try {
    const { data } = await supabaseAdmin().from("profiles").select(CARD_COLS).eq("id", uid(req)).maybeSingle();
    if (!data) return fail(res, 404, "Finish onboarding first.");
    const w = passWindow();
    res.json({
      token: passToken(uid(req).toLowerCase(), w),
      rotatesAt: new Date((w + 1) * PASS_SECONDS * 1000).toISOString(),
      rotateSeconds: PASS_SECONDS,
      student: toCard(data as CardRow),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

// HOC or lecturer: scan a student's pass, or type their matric (dead phone) into an open session.
router.post("/attendance/sessions/:id/scan", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({ token: z.string().trim().min(1).max(200).optional(), matric: z.string().trim().min(3).max(30).optional() })
    .refine((b) => !!b.token !== !!b.matric)
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Scan a pass or type a matric number.");
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, "Session not found.");
  try {
    const me = await getProfile(uid(req));
    const sb = supabaseAdmin();
    const { data } = await sb
      .from("attendance_sessions")
      .select(SESSION_COLS)
      .eq("id", req.params.id)
      .maybeSingle();
    const s = data as SessionRow | null;
    if (!s) return fail(res, 404, "Session not found.");
    if (!me || !(await canScan(me, s.course_code))) return fail(res, 403, "You can only take attendance for courses you teach or represent.");
    if (s.closed_at || new Date(s.closes_at).getTime() <= Date.now()) return fail(res, 409, "This session has ended. Start a new one to keep marking.");

    const takers = async (ids: string[]) => {
      if (!ids.length) return [] as string[];
      const { data: e } = await sb.from("enrollments").select("user_id").eq("kind", "taking").in("course", variants(s.course_code)).in("user_id", ids);
      return [...new Set(((e ?? []) as { user_id: string }[]).map((r) => r.user_id))];
    };

    // Once the class rep has uploaded a class list, the register is the list:
    // a typed matric must be on it, and a scanned pass is matched to its entry.
    const cl = await listsForCourse(s.course_code);
    const listIds = cl.lists.map((l) => l.id);
    const blankCard = (name: string, matric: string): StudentCard => ({ id: "", name, matric, level: "", department: "", avatar: "", persona: "" });

    let studentId: string | null = null;
    let entry: EntryRow | null = null;
    const method = parsed.data.token ? "scan" : "typed";
    if (parsed.data.token) {
      const p = readPass(parsed.data.token);
      if ("error" in p) return fail(res, 400, p.error);
      studentId = p.id;
      if (listIds.length) {
        const { data: es } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("student_id", studentId).in("list_id", listIds).is("removed_at", null).limit(1);
        entry = ((es ?? []) as EntryRow[])[0] ?? null;
      }
    } else {
      const matric = clean(parsed.data.matric).replace(/\s+/g, "");
      if (listIds.length) {
        const { data: es } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("matric", matric).in("list_id", listIds).is("removed_at", null).limit(2);
        entry = ((es ?? []) as EntryRow[])[0] ?? null;
        if (!entry) {
          res.json({ status: "not_on_list", course: s.course_code, student: blankCard("Not on this class list", matric) });
          return;
        }
        studentId = entry.student_id;
      } else {
        const { data: ps } = await sb.from("profiles").select("id").eq("attendance_matric", matric).limit(5);
        const ids = ((ps ?? []) as { id: string }[]).map((r) => r.id);
        if (!ids.length) return fail(res, 404, `No student has set up ${matric} in Unify yet. Check the number.`);
        const inCourse = await takers(ids);
        if (inCourse.length > 1) return fail(res, 409, `More than one account uses ${matric}. Scan their pass instead.`);
        studentId = inCourse[0] || ids[0];
      }
    }

    let student: StudentCard;
    if (studentId) {
      const { data: prof } = await sb.from("profiles").select(CARD_COLS).eq("id", studentId).maybeSingle();
      if (!prof) return fail(res, 404, "That student's account no longer exists.");
      student = toCard(prof as CardRow);
      if (entry) student = { ...student, name: entry.full_name, matric: entry.matric };
    } else {
      // On the class list but not on Unify yet: marked against the entry.
      student = blankCard(entry!.full_name, entry!.matric);
    }
    // A pass from someone not taking the course and not on its class list.
    if (studentId && !entry && !(await takers([studentId])).length) {
      res.json({ status: "not_enrolled", course: s.course_code, student });
      return;
    }
    const onList = listIds.length ? !!entry : null;
    if (entry) {
      // Same person, other route: typed by matric earlier, or scanned earlier.
      const { data: dup } = await sb
        .from("attendance_records")
        .select("id")
        .eq("session_id", s.id)
        .or(studentId ? `entry_id.eq.${entry.id},student_id.eq.${studentId}` : `entry_id.eq.${entry.id}`)
        .limit(1);
      if (dup && dup.length) {
        res.json({ status: "already", course: s.course_code, student, onList });
        return;
      }
    }
    const { error } = await sb.from("attendance_records").insert({
      student_id: studentId,
      entry_id: entry?.id ?? null,
      course_code: s.course_code,
      scanned_by: me.id,
      verified: method === "scan",
      method,
      week: s.week,
      session_id: s.id,
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.json({ status: "already", course: s.course_code, student, onList });
        return;
      }
      throw error;
    }
    res.json({ status: "marked", method, course: s.course_code, student, onList });
  } catch (e) {
    dbFail(res, e);
  }
});

// Student, online class only: type the code shared in the meeting chat.
router.post("/attendance/checkin", requireAuth, checkinLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter the 6-digit code from the meeting chat.");
  try {
    const me = await getProfile(uid(req));
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    // Find the open online session whose current (or previous) rotating code matches
    // AND that the student is enrolled in: two sessions sharing a code in the
    // same window (1 in a million) can't send them to the wrong class.
    const { data: openRows } = await sb
      .from("attendance_sessions")
      .select(SESSION_COLS)
      .eq("code", "online")
      .is("closed_at", null)
      .gt("closes_at", new Date().toISOString())
      .limit(500);
    const matches = ((openRows ?? []) as SessionRow[]).filter((r) => {
      const c = parsed.data.code;
      const w = windowOf(r);
      return codeFor(r.id, w) === c || codeFor(r.id, w - 1) === c;
    });
    if (!matches.length) return fail(res, 404, "That code isn't open any more. Codes change every 10 minutes: check the meeting chat again.");
    let s: SessionRow | undefined;
    for (const m of matches) {
      const { data: e } = await sb.from("enrollments").select("course").eq("user_id", me.id).eq("kind", "taking").in("course", variants(m.course_code)).limit(1);
      if (e && e.length) { s = m; break; }
    }
    if (!s) return fail(res, 403, `You're not enrolled in ${matches[0].course_code}. Add it from Courses first.`);
    const entry = await entryOfStudent(me.id);
    const { error } = await sb
      .from("attendance_records")
      .insert({ student_id: me.id, entry_id: entry?.id ?? null, course_code: s.course_code, scanned_by: s.created_by, verified: true, method: "code", week: s.week, session_id: s.id });
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

// Course page: my attendance in this course week by week ("Came to 3 of 4
// classes held"), and for the class rep / lecturer the timetable classes to
// start a register for plus every register so far.
router.get("/attendance/course", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const me = await getProfile(uid(req));
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const { data: sess } = await sb
      .from("attendance_sessions")
      .select(SESSION_COLS)
      .in("course_code", variants(course))
      .order("opens_at", { ascending: false })
      .limit(500);
    const sessions = (sess ?? []) as SessionRow[];
    const ids = sessions.map((s) => s.id);

    // Mine: by account, or by my class-list entry (typed in before I joined).
    const entry = await entryOfStudent(me.id);
    const mineSet = new Set<string>();
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const { data } = await sb
        .from("attendance_records")
        .select("session_id")
        .in("session_id", chunk)
        .or(entry ? `student_id.eq.${me.id},entry_id.eq.${entry.id}` : `student_id.eq.${me.id}`);
      for (const r of (data ?? []) as { session_id: string }[]) mineSet.add(r.session_id);
    }
    const byWeek = new Map<number, { held: number; attended: number }>();
    for (const s of sessions) {
      const w = s.week ?? 0;
      const row = byWeek.get(w) || { held: 0, attended: 0 };
      row.held++;
      if (mineSet.has(s.id)) row.attended++;
      byWeek.set(w, row);
    }
    const mine = {
      held: sessions.length,
      attended: sessions.filter((s) => mineSet.has(s.id)).length,
      weeks: [...byWeek].map(([week, v]) => ({ week, ...v })).sort((a, b) => a.week - b.week),
    };

    const canTake = await canScan(me, course);
    if (!canTake) {
      res.json({ course, canTake, mine, slots: [], registers: [] });
      return;
    }
    const { data: slotRows } = await sb.from("class_slots").select("id,day,start_time,end_time,venue").in("course", variants(course)).order("day").order("start_time");
    const counts = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await sb.from("attendance_records").select("session_id").in("session_id", ids.slice(i, i + 300)).limit(20000);
      for (const r of (data ?? []) as { session_id: string }[]) counts.set(r.session_id, (counts.get(r.session_id) || 0) + 1);
    }
    const cl = await listsForCourse(course);
    const listed = cl.lists.length ? (await expectedEntries(cl)).length : null;
    res.json({
      course,
      canTake,
      mine,
      listed,
      slots: ((slotRows ?? []) as { id: string; day: number; start_time: string; end_time: string; venue: string }[]).map((s) => ({
        id: s.id, day: s.day, start: s.start_time, end: s.end_time, venue: s.venue || "",
      })),
      registers: sessions.map((s) => ({
        id: s.id,
        week: s.week,
        label: s.label || (isOnline(s) ? "Online class" : ""),
        opensAt: s.opens_at,
        open: !s.closed_at && new Date(s.closes_at).getTime() > Date.now(),
        present: counts.get(s.id) || 0,
      })),
    });
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

// A CGPA is a real number from 0.00 to 5.00 with at most two decimals. Anything
// else is rejected, never silently rounded.
const cgpaNumber = (min: number) =>
  z
    .number()
    .finite()
    .min(min)
    .max(5)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Use at most two decimal places.");

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
      .select("cgpa_current,cgpa_target,hide_cgpa,cgpa_units_done,cgpa_units_total,level,degree_years")
      .eq("id", me.id)
      .single();
    const p = (prof ?? {}) as { cgpa_current: number | null; cgpa_target: number | null; hide_cgpa: boolean | null; cgpa_units_done: number | null; cgpa_units_total: number | null; level: string | null; degree_years?: number | null };
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
      degreeYears: p.degree_years ?? null,
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
    cgpaCurrent: cgpaNumber(0).optional(),
    cgpaTarget: cgpaNumber(0.5).optional(),
    unitsDone: z.number().int().min(0).max(400).optional(),
    unitsTotal: z.number().int().min(1).max(500).optional(),
    degreeYears: z.number().int().min(3).max(7).optional(),
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
    // A target has to be a step up from where the student is now (unless they are already at 5.00).
    if (d.cgpaTarget != null) {
      let current = d.cgpaCurrent ?? null;
      if (current == null) {
        const { data: row } = await sb.from("profiles").select("cgpa_current").eq("id", me.id).single();
        const v = (row as { cgpa_current: number | null } | null)?.cgpa_current;
        current = v != null ? Number(v) : null;
      }
      if (current != null && current > 0 && current < 5 && d.cgpaTarget <= current) {
        return fail(res, 400, `Pick a target higher than your current CGPA (${current.toFixed(2)}).`);
      }
    }
    const patch: Record<string, unknown> = {};
    if (d.cgpaCurrent != null) patch.cgpa_current = Math.round(d.cgpaCurrent * 100) / 100;
    if (d.cgpaTarget != null) patch.cgpa_target = Math.round(d.cgpaTarget * 100) / 100;
    if (d.unitsDone != null) patch.cgpa_units_done = d.unitsDone;
    if (d.unitsTotal != null) patch.cgpa_units_total = d.unitsTotal;
    if (d.degreeYears != null) patch.degree_years = d.degreeYears;
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
