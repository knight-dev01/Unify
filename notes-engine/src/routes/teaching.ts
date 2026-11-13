import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendPushToUsers } from "../lib/push";
import { expectedEntries, listsForCourse } from "../lib/classlist";
import { postAudience, classKey } from "../lib/lecturerClaims";
import { currentSemesterWeek } from "../lib/calendar";

// Teaching side (mounted at /v1):
//  - content reports: students "Report a problem" (S27), lecturers "Review this week" (L13);
//  - lecturer posts to everyone taking a course (L15), shown on the course page;
//  - the lecturer's course report, counts only (L11), and attendance per student (L16);
//  - a lecturer's public profile (S53).
const router = Router();
router.use(["/content-reports", "/course-posts", "/lecturer", "/attendance/students"], rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey }));

const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });
const clean = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const variants = (c: string) => [...new Set([c, c.replace(/\s/g, "")])];
const titleCase = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s'’\-.])([a-z])/g, (_, a, b) => a + b.toUpperCase());

type Me = { id: string; first_name: string | null; role: string | null; is_admin: boolean | null; is_hoc: boolean | null; department: string | null; level: string | null };
async function me(req: Request): Promise<Me | null> {
  const { data } = await supabaseAdmin().from("profiles").select("id,first_name,role,is_admin,is_hoc,department,level").eq("id", uid(req)).maybeSingle();
  return (data as Me | null) ?? null;
}
async function enrolled(userId: string, course: string, kind: "taking" | "teaching") {
  const { data } = await supabaseAdmin().from("enrollments").select("course").eq("user_id", userId).eq("kind", kind).in("course", variants(course)).limit(1);
  return !!(data && data.length);
}
const isAdmin = (m: Me | null) => !!m && (!!m.is_admin || m.role === "admin");
async function teaches(m: Me | null, course: string) {
  if (!m) return false;
  if (isAdmin(m)) return true;
  return (m.role === "lecturer" || m.role === "contributor") && (await enrolled(m.id, course, "teaching"));
}
async function takersOf(course: string): Promise<string[]> {
  const ids: string[] = [];
  let last = "";
  for (;;) {
    let q = supabaseAdmin().from("enrollments").select("user_id").eq("kind", "taking").in("course", variants(course)).order("user_id").limit(1000);
    if (last) q = q.gt("user_id", last);
    const { data } = await q;
    const rows = (data ?? []) as { user_id: string }[];
    for (const r of rows) ids.push(r.user_id);
    if (rows.length < 1000) break;
    last = rows[rows.length - 1].user_id;
  }
  return [...new Set(ids)];
}

// ---------- Content reports ----------
router.post("/content-reports", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({
      course: z.string().min(1).max(20),
      week: z.number().int().min(1).max(30),
      topic: z.string().trim().max(200).optional(),
      kind: z.enum(["problem", "review"]).optional(),
      reason: z.string().trim().max(60).optional(),
      text: z.string().trim().min(3).max(2000),
    })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Say what's wrong (a few words is fine).");
  try {
    const m = await me(req);
    if (!m) return fail(res, 404, "Finish onboarding first.");
    const course = clean(parsed.data.course);
    const kind = parsed.data.kind || "problem";
    if (kind === "review" && !(await teaches(m, course))) return fail(res, 403, "Only the course's lecturers review its weeks.");
    const sb = supabaseAdmin();
    const { error } = await sb.from("content_reports").insert({
      user_id: m.id, course, week: parsed.data.week, topic: parsed.data.topic || "", kind, reason: parsed.data.reason || "", text: parsed.data.text,
    });
    if (error) throw error;
    // Tell whoever writes this week (authors of its topics, or the course's teachers) and the admins.
    const { data: authors } = await sb.from("topic_notes").select("author_id").in("course", variants(course)).eq("week", parsed.data.week).limit(200);
    const { data: teachers } = await sb.from("enrollments").select("user_id").eq("kind", "teaching").in("course", variants(course)).limit(50);
    const { data: admins } = await sb.from("profiles").select("id").eq("is_admin", true).limit(50);
    const ids = [...new Set([
      ...((authors ?? []) as { author_id: string | null }[]).map((a) => a.author_id || ""),
      ...((teachers ?? []) as { user_id: string }[]).map((t) => t.user_id),
      ...((admins ?? []) as { id: string }[]).map((a) => a.id),
    ].filter((x) => x && x !== m.id))];
    if (ids.length) {
      const title = kind === "review" ? `${course} Week ${parsed.data.week}: lecturer review` : `${course} Week ${parsed.data.week}: problem reported`;
      const body = `${parsed.data.topic ? `${parsed.data.topic}: ` : ""}${parsed.data.text.slice(0, 140)}`;
      await sb.from("notifications").insert(ids.map((user_id) => ({ user_id, type: "content_report", title, body, course, week: parsed.data.week, link: `/content-reports?course=${encodeURIComponent(course)}` })));
    }
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Authors, the course's teachers and admins read the queue for a course (or all of theirs).
router.get("/content-reports", requireAuth, async (req: Request, res: Response) => {
  try {
    const m = await me(req);
    if (!m) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const course = clean(req.query.course);
    let courses: string[] | null = null;
    if (!isAdmin(m)) {
      const { data: t } = await sb.from("enrollments").select("course").eq("user_id", m.id).eq("kind", "teaching");
      const { data: a } = await sb.from("topic_notes").select("course").eq("author_id", m.id).limit(500);
      courses = [...new Set([...((t ?? []) as { course: string }[]).map((r) => r.course), ...((a ?? []) as { course: string }[]).map((r) => r.course)])];
      courses = courses.flatMap(variants);
      if (!courses.length) return fail(res, 403, "Reports are for the people who write and teach a course.");
    }
    let q = sb.from("content_reports").select("*").order("created_at", { ascending: false }).limit(200);
    if (course) q = q.in("course", variants(course));
    if (courses) q = q.in("course", courses);
    const { data } = await q;
    const rows = (data ?? []) as { id: string; user_id: string | null; course: string; week: number; topic: string; kind: string; reason: string; text: string; status: string; created_at: string }[];
    const ids = [...new Set(rows.map((r) => r.user_id || "").filter(Boolean))];
    const who: Record<string, { name: string; role: string }> = {};
    if (ids.length) {
      const { data: ps } = await sb.from("profiles").select("id,first_name,role").in("id", ids);
      for (const p of (ps ?? []) as { id: string; first_name: string | null; role: string | null }[]) who[p.id] = { name: p.first_name || "Someone", role: p.role || "student" };
    }
    res.json({
      reports: rows.map((r) => ({
        id: r.id, course: r.course, week: r.week, topic: r.topic, kind: r.kind, reason: r.reason, text: r.text, status: r.status, at: r.created_at,
        // Students who report stay anonymous to authors; lecturers' reviews are signed.
        from: r.kind === "review" ? who[r.user_id || ""]?.name || "A lecturer" : "A student",
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/content-reports/:id/resolve", requireAuth, async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, "Not found.");
  try {
    const m = await me(req);
    const sb = supabaseAdmin();
    const { data } = await sb.from("content_reports").select("course,week").eq("id", req.params.id).maybeSingle();
    const r = data as { course: string; week: number } | null;
    if (!r) return fail(res, 404, "Not found.");
    const { data: auth } = await sb.from("topic_notes").select("author_id").in("course", variants(r.course)).eq("week", r.week).eq("author_id", m?.id || "").limit(1);
    if (!(await teaches(m, r.course)) && !(auth && auth.length)) return fail(res, 403, "Only the week's authors and teachers can close this.");
    await sb.from("content_reports").update({ status: "resolved", resolved_by: m!.id }).eq("id", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Lecturer posts to a course (L15) ----------
router.post("/course-posts", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({
      course: z.string().min(1).max(20),
      type: z.enum(["announcement", "tip", "reminder", "test", "assignment", "exam", "notice"]),
      title: z.string().trim().max(120).optional(),
      content: z.string().trim().min(1).max(2000),
      // One class only ("department|level"); omitted = every class taking the course.
      audience: z.string().trim().max(160).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Write something (up to 2000 characters).");
  try {
    const m = await me(req);
    const course = clean(parsed.data.course);
    if (!m || !(m.role === "lecturer" || isAdmin(m)) || !(await teaches(m, course))) return fail(res, 403, "Only the course's lecturer posts to its students.");
    const sb = supabaseAdmin();
    // A course the lecturer added themselves reaches only classes whose rep confirmed them.
    const aud = isAdmin(m) ? { ok: true, ids: await takersOf(course), waiting: false } : await postAudience(m.id, course, await takersOf(course));
    if (!aud.ok) return fail(res, 403, "Waiting for a class rep to confirm you teach this course. Posts and files reach a class once its rep says yes.");
    const audience = parsed.data.audience || null;
    let reach = aud.ids;
    if (audience) {
      const keep: string[] = [];
      for (let i = 0; i < reach.length; i += 500) {
        const { data } = await sb.from("profiles").select("id,department,level").in("id", reach.slice(i, i + 500));
        for (const p of (data ?? []) as { id: string; department: string | null; level: string | null }[]) if (classKey(p.department, p.level) === audience) keep.push(p.id);
      }
      reach = keep;
    }
    const { error } = await sb.from("course_posts").insert({ author_id: m.id, course, type: parsed.data.type, title: parsed.data.title || null, content: parsed.data.content, audience });
    if (error) throw error;
    const ids = reach.filter((x) => x !== m.id);
    const kind: Record<string, string> = { tip: "a tip", reminder: "reminder", test: "test", assignment: "assignment", exam: "exam", notice: "notice", announcement: "announcement" };
    const title = parsed.data.title || `${course}: ${kind[parsed.data.type] || "announcement"} from your lecturer`;
    const body = parsed.data.content.slice(0, 140);
    const link = `/course/${encodeURIComponent(course)}`;
    for (let i = 0; i < ids.length; i += 500) {
      await sb.from("notifications").insert(ids.slice(i, i + 500).map((user_id) => ({ user_id, type: "lecturer_post", title, body, course, link })));
    }
    void sendPushToUsers(ids, { title, body, url: link }).catch(() => {});
    res.json({ ok: true, reached: ids.length });
  } catch (e) {
    dbFail(res, e);
  }
});

router.get("/course-posts", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const m = await me(req);
    if (!m || !(isAdmin(m) || (await enrolled(m.id, course, "taking")) || (await teaches(m, course)))) return fail(res, 403, "Add this course to see its posts.");
    const sb = supabaseAdmin();
    const { data } = await sb.from("course_posts").select("*").in("course", variants(course)).order("created_at", { ascending: false }).limit(30);
    const mineKey = classKey(m.department, m.level);
    const staff = isAdmin(m) || (await teaches(m, course));
    const rows = ((data ?? []) as { id: string; author_id: string | null; type: string; title: string | null; content: string; created_at: string; audience: string | null }[])
      .filter((r) => staff || !r.audience || r.audience === mineKey);
    const ids = [...new Set(rows.map((r) => r.author_id || "").filter(Boolean))];
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: ps } = await sb.from("profiles").select("id,first_name").in("id", ids);
      for (const p of (ps ?? []) as { id: string; first_name: string | null }[]) names[p.id] = titleCase(p.first_name || "Your lecturer");
    }
    res.json({ posts: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, content: r.content, at: r.created_at, author: names[r.author_id || ""] || "Your lecturer", mine: r.author_id === m.id, audience: r.audience })) });
  } catch (e) {
    dbFail(res, e);
  }
});

router.delete("/course-posts/:id", requireAuth, async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, "Not found.");
  try {
    const m = await me(req);
    const sb = supabaseAdmin();
    const { data } = await sb.from("course_posts").select("author_id").eq("id", req.params.id).maybeSingle();
    const p = data as { author_id: string | null } | null;
    if (!p) return fail(res, 404, "That post is gone.");
    if (p.author_id !== m?.id && !isAdmin(m)) return fail(res, 403, "You can only delete your own posts.");
    await sb.from("course_posts").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Lecturer course report: counts only, never names (L11) ----------
router.get("/lecturer/course-report", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const m = await me(req);
    if (!(await teaches(m, course))) return fail(res, 403, "Only the course's lecturers see its report.");
    const sb = supabaseAdmin();
    const takers = await takersOf(course);
    const { data: weekRows } = await sb.from("weeks").select("week,title").in("course", variants(course)).order("week");
    const weeks = new Map<number, string>();
    for (const w of (weekRows ?? []) as { week: number; title: string }[]) if (!weeks.has(w.week)) weeks.set(w.week, w.title || "");
    const studied = new Map<number, Set<string>>();
    // Each student's class (department|level), for the by-class breakdown.
    const classOf = new Map<string, string>();
    for (let i = 0; i < takers.length; i += 500) {
      const { data } = await sb.from("profiles").select("id,department,level").in("id", takers.slice(i, i + 500));
      for (const p of (data ?? []) as { id: string; department: string | null; level: string | null }[]) classOf.set(p.id, classKey(p.department, p.level));
    }
    const classCount = new Map<string, number>();
    for (const k of classOf.values()) classCount.set(k, (classCount.get(k) || 0) + 1);
    const quiz = new Map<number, { n: number; pct: number; people: Set<string> }>();
    for (let i = 0; i < takers.length; i += 300) {
      const chunk = takers.slice(i, i + 300);
      const [{ data: prog }, { data: qa }] = await Promise.all([
        sb.from("topic_progress").select("user_id,week").in("course", variants(course)).in("user_id", chunk).limit(50000),
        sb.from("quiz_attempts").select("user_id,week,score,total").in("course", variants(course)).in("user_id", chunk).limit(50000),
      ]);
      for (const p of (prog ?? []) as { user_id: string; week: number }[]) {
        const s = studied.get(p.week) || new Set<string>();
        s.add(p.user_id);
        studied.set(p.week, s);
      }
      for (const q of (qa ?? []) as { user_id: string; week: number; score: number; total: number }[]) {
        if (!q.total) continue;
        const e = quiz.get(q.week) || { n: 0, pct: 0, people: new Set<string>() };
        e.n++;
        e.pct += q.score / q.total;
        e.people.add(q.user_id);
        quiz.set(q.week, e);
      }
    }
    const total = takers.length;
    res.json({
      course,
      students: total,
      classes: [...classCount].sort((a, b) => b[1] - a[1]).map(([key, students]) => ({ key, students })),
      weeks: [...weeks].sort((a, b) => a[0] - b[0]).map(([week, title]) => {
        const s = studied.get(week)?.size || 0;
        const q = quiz.get(week);
        const byClass: Record<string, number> = {};
        for (const u of studied.get(week) || []) { const k = classOf.get(u) || "|"; byClass[k] = (byClass[k] || 0) + 1; }
        return {
          week, title, byClass,
          studied: s,
          studiedPct: total ? Math.round((s / total) * 100) : 0,
          quizTakers: q?.people.size || 0,
          quizAvg: q && q.n ? Math.round((q.pct / q.n) * 100) : null,
          attemptsPerStudent: q && q.people.size ? Math.round((q.n / q.people.size) * 10) / 10 : null,
        };
      }),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Attendance per student for a course (L16): names shown, as on registers ----------
router.get("/attendance/students", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const m = await me(req);
    const hoc = !!m?.is_hoc && (await enrolled(m.id, course, "taking"));
    if (!(await teaches(m, course)) && !hoc) return fail(res, 403, "Only the course's lecturers and class reps see this.");
    const sb = supabaseAdmin();
    const { data: sess } = await sb.from("attendance_sessions").select("id").in("course_code", variants(course)).limit(1000);
    const sessionIds = ((sess ?? []) as { id: string }[]).map((s) => s.id);
    const held = sessionIds.length;
    const byEntry = new Map<string, number>();
    const byStudent = new Map<string, number>();
    for (let i = 0; i < sessionIds.length; i += 200) {
      const { data } = await sb.from("attendance_records").select("student_id,entry_id").in("session_id", sessionIds.slice(i, i + 200)).limit(50000);
      for (const r of (data ?? []) as { student_id: string | null; entry_id: string | null }[]) {
        if (r.entry_id) byEntry.set(r.entry_id, (byEntry.get(r.entry_id) || 0) + 1);
        else if (r.student_id) byStudent.set(r.student_id, (byStudent.get(r.student_id) || 0) + 1);
      }
    }
    const cl = await listsForCourse(course);
    const rows: { name: string; matric: string; attended: number; pct: number | null; onUnify: boolean }[] = [];
    const seenStudents = new Set<string>();
    if (cl.lists.length) {
      for (const e of await expectedEntries(cl)) {
        const n = (byEntry.get(e.id) || 0) + (e.student_id ? byStudent.get(e.student_id) || 0 : 0);
        if (e.student_id) seenStudents.add(e.student_id);
        rows.push({ name: e.full_name, matric: e.matric, attended: n, pct: held ? Math.round((n / held) * 100) : null, onUnify: !!e.student_id });
      }
    }
    // Students taking the course who aren't on a class list (no list yet, or carryovers).
    const extra = (await takersOf(course)).filter((id) => !seenStudents.has(id));
    for (let i = 0; i < extra.length; i += 300) {
      const { data } = await sb.from("profiles").select("id,first_name,attendance_full_name,attendance_matric,role").in("id", extra.slice(i, i + 300));
      for (const p of (data ?? []) as { id: string; first_name: string | null; attendance_full_name: string | null; attendance_matric: string | null; role: string | null }[]) {
        if (p.role && p.role !== "student") continue;
        const n = byStudent.get(p.id) || 0;
        rows.push({ name: p.attendance_full_name || p.first_name || "Student", matric: p.attendance_matric || "", attended: n, pct: held ? Math.round((n / held) * 100) : null, onUnify: true });
      }
    }
    rows.sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101) || a.name.localeCompare(b.name));
    res.json({ course, held, students: rows });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- A lecturer's profile, as students see it (S53) ----------
router.get("/lecturer/profile/:id", requireAuth, async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, "Not found.");
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("profiles").select("id,first_name,title,bio,contact_email,links,role,department,faculty,avatar_url,box_boy_persona").eq("id", req.params.id).maybeSingle();
    const p = data as { id: string; first_name: string | null; title: string | null; bio: string | null; contact_email: string | null; links: string | null; role: string | null; department: string | null; faculty: string | null; avatar_url: string | null; box_boy_persona: string | null } | null;
    if (!p || p.role !== "lecturer") return fail(res, 404, "No lecturer here.");
    const { data: t } = await sb.from("enrollments").select("course").eq("user_id", p.id).eq("kind", "teaching");
    res.json({
      id: p.id, name: titleCase(p.first_name || "Lecturer"), department: p.department || "", faculty: p.faculty || "",
      avatar: p.avatar_url || "", persona: p.box_boy_persona || "",
      title: p.title || "", bio: p.bio || "", contactEmail: p.contact_email || "", links: p.links || "",
      courses: [...new Set(((t ?? []) as { course: string }[]).map((r) => r.course))].sort(),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Send a PDF (lecturer, Classroom and course pages) ----------
// The phone compresses the PDF, then uploads it straight to Storage through a
// one-time signed link (the API never carries the file). Sending it then
//  1. saves it to the course's materials (so the contributor can turn it into notes),
//  2. posts it to every class taking the course (bell + push, opens in one tap),
//  3. tells the course's contributors on their bell.
const PDF_BUCKET = "course-files";
const PDF_MAX = 25 * 1024 * 1024;
let pdfBucketReady = false;
async function ensurePdfBucket() {
  if (pdfBucketReady) return;
  const sb = supabaseAdmin();
  const { data } = await sb.storage.getBucket(PDF_BUCKET);
  if (!data) {
    const { error } = await sb.storage.createBucket(PDF_BUCKET, { public: true, fileSizeLimit: PDF_MAX, allowedMimeTypes: ["application/pdf"] });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
  pdfBucketReady = true;
}

router.post("/lecturer/pdf/upload-url", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ course: z.string().min(1).max(20), filename: z.string().min(1).max(200), size: z.number().int().min(1).max(PDF_MAX) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick a PDF up to 25 MB.");
  try {
    const m = await me(req);
    const course = clean(parsed.data.course);
    if (!m || !(m.role === "lecturer" || isAdmin(m)) || !(await teaches(m, course))) return fail(res, 403, "Only the course's lecturer sends files to its students.");
    if (!isAdmin(m) && !(await postAudience(m.id, course, [])).ok) return fail(res, 403, "Waiting for a class rep to confirm you teach this course. Posts and files reach a class once its rep says yes.");
    await ensurePdfBucket();
    const safe = parsed.data.filename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60) || "file";
    const path = `${course.replace(/[^A-Z0-9]/g, "")}/${Date.now()}-${safe}.pdf`;
    const { data, error } = await supabaseAdmin().storage.from(PDF_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw error || new Error("No upload link");
    res.json({ path, token: data.token, signedUrl: data.signedUrl, bucket: PDF_BUCKET });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/lecturer/pdf", requireAuth, async (req: Request, res: Response) => {
  const parsed = z
    .object({
      course: z.string().min(1).max(20),
      path: z.string().min(1).max(300),
      title: z.string().trim().min(1).max(120),
      message: z.string().trim().max(1000).optional(),
      week: z.number().int().min(1).max(30),
      type: z.enum(["slides", "notes", "past-paper"]).default("notes"),
      sizeKb: z.number().int().min(0).max(PDF_MAX / 1024).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Give the file a title and a week.");
  try {
    const m = await me(req);
    const course = clean(parsed.data.course);
    if (!m || !(m.role === "lecturer" || isAdmin(m)) || !(await teaches(m, course))) return fail(res, 403, "Only the course's lecturer sends files to its students.");
    const d = parsed.data;
    if (!d.path.startsWith(`${course.replace(/[^A-Z0-9]/g, "")}/`)) return fail(res, 400, "That file doesn't belong to this course.");
    const sb = supabaseAdmin();
    const url = sb.storage.from(PDF_BUCKET).getPublicUrl(d.path).data.publicUrl;
    // 1. Course materials (for the contributor and the course page).
    const { error: mErr } = await sb.from("lecturer_materials").insert({ uploaded_by: m.id, course_code: course, week_number: d.week, type: d.type, title: d.title, file_url: url });
    if (mErr) throw mErr;
    // 2. A post to every class taking the course.
    const size = d.sizeKb ? ` (${d.sizeKb >= 1024 ? `${(d.sizeKb / 1024).toFixed(1)} MB` : `${d.sizeKb} KB`})` : "";
    const content = `${d.message ? `${d.message}\n\n` : ""}📄 ${d.title}${size}: ${url}`;
    const { error: pErr } = await sb.from("course_posts").insert({ author_id: m.id, course, type: "announcement", title: `${d.title} (Week ${d.week})`, content });
    if (pErr) throw pErr;
    const ids = (isAdmin(m) ? await takersOf(course) : (await postAudience(m.id, course, await takersOf(course))).ids).filter((x) => x !== m.id);
    const title = `${course}: new PDF from your lecturer`;
    const body = d.message ? d.message.slice(0, 140) : d.title;
    const link = `/courses/${encodeURIComponent(course)}`;
    for (let i = 0; i < ids.length; i += 500) {
      await sb.from("notifications").insert(ids.slice(i, i + 500).map((user_id) => ({ user_id, type: "lecturer_post", title, body, course, link })));
    }
    void sendPushToUsers(ids, { title, body, url: link }).catch(() => {});
    // 3. The course's contributors: material to turn into notes.
    const { data: teachers } = await sb.from("enrollments").select("user_id").in("course", variants(course)).eq("kind", "teaching");
    const tIds = ((teachers ?? []) as { user_id: string }[]).map((t) => t.user_id).filter((x) => x !== m.id);
    if (tIds.length) {
      const { data: contribs } = await sb.from("profiles").select("id").in("id", tIds).eq("role", "contributor");
      const cIds = ((contribs ?? []) as { id: string }[]).map((c) => c.id);
      if (cIds.length) await sb.from("notifications").insert(cIds.map((user_id) => ({ user_id, type: "lecturer_material", title: `${course} Week ${d.week}: material from the lecturer`, body: d.title, course, link: "/studio" })));
    }
    res.json({ ok: true, reached: ids.length, url });
  } catch (e) {
    dbFail(res, e);
  }
});


// ---------- Lecturer: each week's status (L10) and their review of it (L13) ----------
// Weeks 1..(this semester week or the last published): notes out?, my review,
// materials I've sent, classes held and how many came. Plus the header: course
// title, level and its contributors.
router.get("/lecturer/week-status", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const m = await me(req);
    if (!(await teaches(m, course))) return fail(res, 403, "Only the course's lecturers see this.");
    const sb = supabaseAdmin();
    const [{ data: shells }, { data: topics }, { data: reviews }, { data: mats }, { data: sessions }, { data: info }, { data: levels }, { data: team }, semWeek, takers] = await Promise.all([
      sb.from("weeks").select("week,title").in("course", variants(course)),
      sb.from("topic_notes").select("week").in("course", variants(course)).limit(5000),
      sb.from("week_reviews").select("week,status,note,lecturer_id,updated_at").in("course", variants(course)),
      sb.from("lecturer_materials").select("week_number").in("course_code", variants(course)),
      sb.from("attendance_sessions").select("id,week").in("course_code", variants(course)).limit(2000),
      sb.from("courses").select("title").in("code", variants(course)).limit(1),
      sb.from("course_levels").select("level,semester").in("course", variants(course)).limit(10),
      sb.from("enrollments").select("user_id").in("course", variants(course)).eq("kind", "teaching"),
      currentSemesterWeek(),
      takersOf(course),
    ]);
    const titles = new Map<number, string>();
    for (const w of (shells ?? []) as { week: number; title: string }[]) titles.set(w.week, w.title || titles.get(w.week) || "");
    const published = new Set<number>([...titles.keys(), ...((topics ?? []) as { week: number }[]).map((t) => t.week)]);
    const matsBy = new Map<number, number>();
    for (const r of (mats ?? []) as { week_number: number }[]) matsBy.set(r.week_number, (matsBy.get(r.week_number) || 0) + 1);
    const sess = (sessions ?? []) as { id: string; week: number | null }[];
    const came = new Map<string, number>();
    for (let i = 0; i < sess.length; i += 300) {
      const { data } = await sb.from("attendance_records").select("session_id").in("session_id", sess.slice(i, i + 300).map((x) => x.id)).limit(50000);
      for (const r of (data ?? []) as { session_id: string }[]) came.set(r.session_id, (came.get(r.session_id) || 0) + 1);
    }
    const last = Math.max(0, ...published);
    const upTo = Math.min(26, Math.max(last, semWeek || 0, 1));
    const myReview = new Map(((reviews ?? []) as { week: number; status: string; note: string | null; lecturer_id: string; updated_at: string }[]).filter((r) => r.lecturer_id === m!.id).map((r) => [r.week, r]));
    const teamIds = ((team ?? []) as { user_id: string }[]).map((t) => t.user_id);
    const { data: contribs } = teamIds.length ? await sb.from("profiles").select("first_name").in("id", teamIds).eq("role", "contributor") : { data: [] };
    res.json({
      course,
      title: ((info ?? []) as { title: string }[])[0]?.title || "",
      levels: [...new Set(((levels ?? []) as { level: string }[]).map((l) => l.level))],
      contributors: ((contribs ?? []) as { first_name: string | null }[]).map((c) => c.first_name || "A contributor"),
      students: takers.length,
      semesterWeek: semWeek,
      weeks: Array.from({ length: upTo }, (_, i) => i + 1).map((week) => {
        const held = sess.filter((x) => x.week === week);
        const present = held.reduce((n, x) => n + (came.get(x.id) || 0), 0);
        const r = myReview.get(week);
        return {
          week,
          title: titles.get(week) || "",
          published: published.has(week),
          review: r ? { status: r.status, note: r.note || "", at: r.updated_at } : null,
          materials: matsBy.get(week) || 0,
          classesHeld: held.length,
          camePct: held.length && takers.length ? Math.round((present / (held.length * takers.length)) * 100) : null,
        };
      }),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/lecturer/week-review", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ course: z.string().min(1).max(20), week: z.number().int().min(1).max(30), status: z.enum(["reviewed", "changes"]), note: z.string().trim().max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick reviewed or needs changes.");
  try {
    const m = await me(req);
    const course = clean(parsed.data.course);
    if (!m || !(m.role === "lecturer" || isAdmin(m)) || !(await teaches(m, course))) return fail(res, 403, "Only the course's lecturer reviews its notes.");
    const d = parsed.data;
    if (d.status === "changes" && !d.note) return fail(res, 400, "Say what needs changing.");
    const sb = supabaseAdmin();
    const { error } = await sb.from("week_reviews").upsert({ course, week: d.week, lecturer_id: m.id, status: d.status, note: d.note || null, updated_at: new Date().toISOString() }, { onConflict: "course,week,lecturer_id" });
    if (error) throw error;
    // Tell the contributors; a "needs changes" note also lands in the course's messages.
    const { data: team } = await sb.from("enrollments").select("user_id").in("course", variants(course)).eq("kind", "teaching");
    const ids = ((team ?? []) as { user_id: string }[]).map((t) => t.user_id).filter((x) => x !== m.id);
    const { data: contribs } = ids.length ? await sb.from("profiles").select("id").in("id", ids).eq("role", "contributor") : { data: [] };
    const cIds = ((contribs ?? []) as { id: string }[]).map((c) => c.id);
    if (d.status === "changes") await sb.from("course_messages").insert({ course, author_id: m.id, body: `Week ${d.week} needs changes: ${d.note}` });
    if (cIds.length) {
      const title = d.status === "reviewed" ? `${course} Week ${d.week}: reviewed by the lecturer` : `${course} Week ${d.week}: the lecturer asked for changes`;
      const body = d.status === "reviewed" ? "Nice work. It's marked reviewed." : (d.note || "").slice(0, 140);
      const link = d.status === "reviewed" ? "/home" : `/messages/${encodeURIComponent(course)}`;
      await sb.from("notifications").insert(cIds.map((user_id) => ({ user_id, type: "week_review", title, body, course, link })));
      void sendPushToUsers(cIds, { title, body, url: link }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});


// ---------- Most missed quiz questions for a week (L11) ----------
// Wrong rate per question across attempts that recorded their answers.
router.get("/lecturer/missed", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  const week = Number(req.query.week);
  if (!course || !week) return fail(res, 400, "Pass ?course=CODE&week=N.");
  try {
    const m = await me(req);
    if (!(await teaches(m, course))) return fail(res, 403, "Only the course's lecturers see this.");
    const sb = supabaseAdmin();
    const [{ data: attempts }, { data: shell }] = await Promise.all([
      sb.from("quiz_attempts").select("asked,wrong").in("course", variants(course)).eq("week", week).not("asked", "is", null).limit(20000),
      sb.from("weeks").select("note_json").in("course", variants(course)).eq("week", week).limit(1),
    ]);
    const qs = ((((shell ?? []) as { note_json: { eoq?: { questions?: { question?: string }[] } } | null }[])[0]?.note_json?.eoq?.questions) || []);
    const asked = new Map<number, number>();
    const wrong = new Map<number, number>();
    for (const a of (attempts ?? []) as { asked: number[] | null; wrong: number[] | null }[]) {
      for (const i of a.asked || []) asked.set(i, (asked.get(i) || 0) + 1);
      for (const i of a.wrong || []) wrong.set(i, (wrong.get(i) || 0) + 1);
    }
    const strip = (t: string) => t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const rows = [...asked.entries()]
      .filter(([, n]) => n >= 3)
      .map(([i, n]) => ({ index: i, question: strip(qs[i]?.question || `Question ${i + 1}`).slice(0, 160), asked: n, wrongPct: Math.round(((wrong.get(i) || 0) / n) * 100) }))
      .filter((r) => r.wrongPct > 0)
      .sort((a, b) => b.wrongPct - a.wrongPct)
      .slice(0, 5);
    res.json({ week, attempts: (attempts ?? []).length, questions: rows });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Practice questions a lecturer adds (L11), shown to students ----------
const practiceSchema = z.object({
  course: z.string().min(1).max(20),
  week: z.number().int().min(1).max(30).optional(),
  question: z.string().trim().min(5).max(600),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(6),
  correctIndex: z.number().int().min(0).max(5),
  explanation: z.string().trim().max(600).optional(),
});
router.get("/practice", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const m = await me(req);
    const staff = await teaches(m, course);
    if (!m || !(staff || (await enrolled(m.id, course, "taking")))) return fail(res, 403, "Add this course to practise.");
    const { data } = await supabaseAdmin().from("practice_questions").select("id,week,question,options,correct_index,explanation,author_id,created_at").in("course", variants(course)).order("week", { ascending: true, nullsFirst: false }).order("created_at").limit(300);
    res.json({
      questions: ((data ?? []) as { id: string; week: number | null; question: string; options: string[]; correct_index: number; explanation: string | null; author_id: string | null }[]).map((q) => ({
        id: q.id, week: q.week, question: q.question, options: q.options, correctIndex: q.correct_index, explanation: q.explanation || "", mine: q.author_id === m.id,
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});
router.post("/practice", requireAuth, async (req: Request, res: Response) => {
  const parsed = practiceSchema.safeParse(req.body);
  if (!parsed.success || (parsed.success && parsed.data.correctIndex >= parsed.data.options.length)) return fail(res, 400, "Write the question, at least two options, and pick the right one.");
  try {
    const m = await me(req);
    const course = clean(parsed.data.course);
    if (!m || !(m.role === "lecturer" || isAdmin(m)) || !(await teaches(m, course))) return fail(res, 403, "Only the course's lecturer adds practice questions.");
    const d = parsed.data;
    const { error } = await supabaseAdmin().from("practice_questions").insert({ course, week: d.week ?? null, question: d.question, options: d.options, correct_index: d.correctIndex, explanation: d.explanation || null, author_id: m.id });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});
router.delete("/practice/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const m = await me(req);
    const sb = supabaseAdmin();
    const { data } = await sb.from("practice_questions").select("author_id").eq("id", req.params.id).maybeSingle();
    if (!data) return fail(res, 404, "That question is gone.");
    if ((data as { author_id: string | null }).author_id !== m?.id && !isAdmin(m)) return fail(res, 403, "You can only remove your own questions.");
    await sb.from("practice_questions").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});


export default router;
