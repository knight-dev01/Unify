import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";

// Review 3 (C1, C10): who teaches a course and in which weeks, plus a short
// introduction to the course. The class rep (or an admin) sets them; everyone
// in the course sees them on the course page. A name links to a lecturer on
// Unify Learn when one teaching the course has the same surname, so a lecturer
// who joins later shows with their profile without anyone re-entering it.
// Mounted at /v1 (see server.ts). Migration 0053.
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : "Something went wrong." });

const variants = (code: string) => [...new Set([code, code.replace(/\s/g, "")])];
// "mee352" / "MEE  352" -> "MEE 352"
function canonical(raw: string): string {
  const c = raw.trim().toUpperCase().replace(/\s+/g, " ");
  return /^[A-Z]+\d/.test(c) ? c.replace(/^([A-Z]+)(\d)/, "$1 $2") : c;
}
const TITLES = /^(prof(essor)?|dr|engr|mr|mrs|ms|miss|arc|pharm)\.?\s+/i;
function surname(name: string): string {
  let n = name.trim();
  while (TITLES.test(n)) n = n.replace(TITLES, "");
  const parts = n.split(/[\s.]+/).filter(Boolean);
  return (parts[parts.length - 1] || "").toLowerCase();
}
const titleCase = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s'’\-.])([a-z])/g, (_, a, b) => a + b.toUpperCase());

type Prof = { id: string; is_admin: boolean | null; is_hoc: boolean | null; role: string | null; email: string | null };

async function canEdit(userId: string, course: string): Promise<boolean> {
  const sb = supabaseAdmin();
  const { data } = await sb.from("profiles").select("id,is_admin,is_hoc,role,email").eq("id", userId).maybeSingle();
  const p = data as Prof | null;
  if (!p) return false;
  if (p.is_admin || p.role === "admin") return true;
  const admins = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (p.email && admins.includes(p.email.toLowerCase())) return true;
  if (!p.is_hoc) return false;
  const { data: e } = await sb.from("enrollments").select("course").eq("user_id", userId).eq("kind", "taking").in("course", variants(course)).limit(1);
  return !!(e && e.length);
}

type AppLecturer = { id: string; name: string; title: string; department: string; avatar: string; persona: string };
async function appLecturers(course: string): Promise<AppLecturer[]> {
  const sb = supabaseAdmin();
  const { data: t } = await sb.from("enrollments").select("user_id").eq("kind", "teaching").in("course", variants(course)).limit(20);
  const ids = [...new Set(((t ?? []) as { user_id: string }[]).map((r) => r.user_id))];
  if (!ids.length) return [];
  const { data } = await sb.from("profiles").select("id,first_name,title,department,avatar_url,box_boy_persona,role").in("id", ids).eq("role", "lecturer");
  return ((data ?? []) as { id: string; first_name: string | null; title: string | null; department: string | null; avatar_url: string | null; box_boy_persona: string | null }[])
    .filter((p) => p.first_name)
    .map((p) => ({ id: p.id, name: titleCase(p.first_name as string), title: p.title || "", department: p.department || "", avatar: p.avatar_url || "", persona: p.box_boy_persona || "" }));
}

export type CourseLecturer = {
  name: string;
  weekFrom: number | null;
  weekTo: number | null;
  // Set when this person is on Unify Learn and teaches the course.
  lecturer: AppLecturer | null;
};

// The course's lecturers for the course page. Order of preference:
// 1. what the class rep set (names + week ranges),
// 2. lecturers on Unify Learn teaching the course,
// 3. names from the faculty course list (migration 0051).
export async function courseLecturers(rawCourse: string): Promise<{ intro: string; set: boolean; lecturers: CourseLecturer[] }> {
  const course = canonical(rawCourse);
  const sb = supabaseAdmin();
  const [{ data: rows }, { data: info }, app] = await Promise.all([
    sb.from("course_lecturer_weeks").select("name,week_from,week_to,position").in("course", variants(course)).order("position"),
    sb.from("courses").select("intro,lecturer_names").in("code", variants(course)).limit(1),
    appLecturers(course),
  ]);
  const c = ((info ?? [])[0] as { intro?: string | null; lecturer_names?: string | null } | undefined) || {};
  const bySurname = new Map(app.map((a) => [surname(a.name), a]));
  const set = (rows ?? []) as { name: string; week_from: number; week_to: number }[];
  if (set.length) {
    const used = new Set<string>();
    const lecturers = set.map((r) => {
      const a = bySurname.get(surname(r.name)) || null;
      if (a) used.add(a.id);
      return { name: a ? [a.title, a.name].filter(Boolean).join(" ") : r.name, weekFrom: r.week_from, weekTo: r.week_to, lecturer: a };
    });
    return { intro: c.intro || "", set: true, lecturers };
  }
  if (app.length) {
    return { intro: c.intro || "", set: false, lecturers: app.slice(0, 4).map((a) => ({ name: [a.title, a.name].filter(Boolean).join(" "), weekFrom: app.length === 1 ? 1 : null, weekTo: app.length === 1 ? 12 : null, lecturer: a })) };
  }
  const named = (c.lecturer_names || "").split("/").map((n) => n.trim()).filter(Boolean).slice(0, 4);
  return { intro: c.intro || "", set: false, lecturers: named.map((n) => ({ name: n, weekFrom: named.length === 1 ? 1 : null, weekTo: named.length === 1 ? 12 : null, lecturer: null })) };
}

router.get("/courses/:code/lecturers", requireAuth, async (req: Request, res: Response) => {
  const course = canonical(decodeURIComponent(req.params.code || "")).slice(0, 20);
  if (!course) return fail(res, 400, "Which course?");
  try {
    const [data, edit, app] = await Promise.all([courseLecturers(course), canEdit(uid(req), course), appLecturers(course)]);
    res.json({ course, ...data, canEdit: edit, onApp: app.map((a) => ({ id: a.id, name: [a.title, a.name].filter(Boolean).join(" ") })) });
  } catch (e) {
    dbFail(res, e);
  }
});

const Body = z.object({
  intro: z.string().max(600).optional(),
  lecturers: z
    .array(z.object({ name: z.string().trim().min(2, "Add each lecturer's name.").max(80), weekFrom: z.number().int().min(1).max(20), weekTo: z.number().int().min(1).max(20) }))
    .min(1, "Add at least one lecturer.")
    .max(4, "Up to 4 lecturers."),
});

router.put("/courses/:code/lecturers", requireAuth, async (req: Request, res: Response) => {
  const course = canonical(decodeURIComponent(req.params.code || "")).slice(0, 20);
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Check the lecturers.");
  const { intro, lecturers } = parsed.data;
  if (lecturers.some((l) => l.weekTo < l.weekFrom)) return fail(res, 400, "A lecturer's last week can't be before their first week.");
  try {
    if (!(await canEdit(uid(req), course))) return fail(res, 403, "Only the class rep for this course can change its lecturers.");
    const sb = supabaseAdmin();
    const { error: delErr } = await sb.from("course_lecturer_weeks").delete().in("course", variants(course));
    if (delErr) throw delErr;
    const { error } = await sb.from("course_lecturer_weeks").insert(
      lecturers.map((l, i) => ({ course, position: i + 1, name: l.name.replace(/\s+/g, " "), week_from: l.weekFrom, week_to: l.weekTo, set_by: uid(req) })),
    );
    if (error) throw error;
    if (intro !== undefined) {
      const { error: iErr } = await sb.from("courses").update({ intro: intro.trim() || null }).in("code", variants(course));
      if (iErr) throw iErr;
    }
    res.json({ ok: true, ...(await courseLecturers(course)) });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
