import { supabaseAdmin } from "./supabase";
import { inChunks, pageAll } from "./paging";

// Students never pick their courses: their class (department + level) takes a
// fixed set each semester, from the faculty's course sheet (course_departments,
// migration 0060). Compulsory (C) and required (R) courses are enrolled for
// them; electives and carryovers are theirs to add from Find courses.
// Rows added here are marked auto, so a change of department, level or
// semester swaps only these and never touches a course the student added.
// Safe to run twice at once (inserts ignore duplicates).

async function currentSemester(): Promise<string> {
  const { data } = await supabaseAdmin().from("app_settings").select("value").eq("key", "current_semester").maybeSingle();
  const v = (data as { value?: string } | null)?.value;
  return v === "Second Semester" ? v : "First Semester";
}

type Student = { id: string; department: string | null; level: string | null };

// userIds: just these students (onboarding, a profile edit). Omitted: every
// student (a new semester, the yearly promotion). Returns rows added.
export async function syncClassCourses(userIds?: string[]): Promise<number> {
  const sb = supabaseAdmin();
  const semester = await currentSemester();
  const [{ data: deps }, sheet] = await Promise.all([
    sb.from("departments").select("name,code"),
    pageAll<{ course: string; department: string; level: string }>((from, to) =>
      sb.from("course_departments").select("course,department,level").eq("semester", semester).in("status", ["C", "R"]).order("course").order("department").order("level").range(from, to)),
  ]);
  // Profiles store the department's name; the sheet uses its code.
  const codeOf = new Map<string, string>();
  for (const d of (deps ?? []) as { name: string; code: string }[]) {
    if (d.code) {
      codeOf.set(d.name.trim().toLowerCase(), d.code.toUpperCase());
      codeOf.set(d.code.trim().toLowerCase(), d.code.toUpperCase());
    }
  }
  const classOf = new Map<string, string[]>();
  for (const r of sheet) {
    const k = `${r.department}|${r.level}`;
    classOf.set(k, [...(classOf.get(k) || []), r.course]);
  }

  const students = userIds
    ? await inChunks<Student>(userIds, (c, from, to) => sb.from("profiles").select("id,department,level").in("id", c).or("role.is.null,role.eq.student").order("id").range(from, to))
    : await pageAll<Student>((from, to) => sb.from("profiles").select("id,department,level").or("role.is.null,role.eq.student").order("id").range(from, to));
  if (!students.length) return 0;
  const have = await inChunks<{ user_id: string; course: string; auto: boolean }>(students.map((s) => s.id), (c, from, to) =>
    sb.from("enrollments").select("user_id,course,auto").in("user_id", c).order("user_id").order("course").range(from, to));
  const haveOf = new Map<string, { course: string; auto: boolean }[]>();
  for (const h of have) haveOf.set(h.user_id, [...(haveOf.get(h.user_id) || []), h]);

  const add: { user_id: string; course: string; kind: string; auto: boolean }[] = [];
  for (const s of students) {
    const dept = codeOf.get((s.department || "").trim().toLowerCase()) || "";
    const wanted = new Set(dept && s.level ? classOf.get(`${dept}|${s.level}`) || [] : []);
    const mine = haveOf.get(s.id) || [];
    // Old class's auto courses go (new level, department or semester).
    const stale = mine.filter((m) => m.auto && !wanted.has(m.course)).map((m) => m.course);
    if (stale.length) await sb.from("enrollments").delete().eq("user_id", s.id).eq("auto", true).in("course", stale);
    const held = new Set(mine.map((m) => m.course));
    for (const course of wanted) if (!held.has(course)) add.push({ user_id: s.id, course, kind: "taking", auto: true });
  }
  for (let i = 0; i < add.length; i += 500) {
    const { error } = await sb.from("enrollments").upsert(add.slice(i, i + 500), { onConflict: "user_id,course", ignoreDuplicates: true });
    if (error) throw error;
  }
  if (!userIds && add.length) console.info(`[class-courses] ${semester}: added ${add.length} course(s) for ${students.length} student(s)`);
  return add.length;
}
