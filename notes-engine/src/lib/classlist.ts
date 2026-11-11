import { supabaseAdmin } from "./supabase";
import { sendPushToUsers } from "./push";

// Class lists: one per class (institution + department + level). The HOC
// uploads it; each student claims their own entry once; attendance records
// attach to the entry (entry_id) so marks taken before a student claims, or
// before they even have an account, follow them when they do.

// Multi-university is coming: every list is tagged. Until institutions are
// configured per profile, everyone is LASU.
export const DEFAULT_INSTITUTION = "LASU";
export const institutionOf = (_p?: { university?: string | null } | null) => DEFAULT_INSTITUTION;

export type ListRow = { id: string; institution: string; department: string; level: string; created_at?: string; updated_at?: string };
export type EntryRow = {
  id: string;
  list_id: string;
  matric: string;
  full_name: string;
  student_id: string | null;
  claimed_at: string | null;
  claim_method: string | null;
  verified_email: string | null;
  removed_at: string | null;
  created_at?: string;
};
export const LIST_COLS = "id,institution,department,level,created_at,updated_at";
export const ENTRY_COLS = "id,list_id,matric,full_name,student_id,claimed_at,claim_method,verified_email,removed_at,created_at";

const variants = (code: string) => [...new Set([code, code.replace(/\s/g, "")])];

export async function listForClass(institution: string, department: string, level: string): Promise<ListRow | null> {
  const { data } = await supabaseAdmin()
    .from("class_lists")
    .select(LIST_COLS)
    .eq("institution", institution)
    .eq("department", department)
    .eq("level", level)
    .maybeSingle();
  return (data as ListRow | null) ?? null;
}

export async function ensureList(institution: string, department: string, level: string, by: string): Promise<ListRow> {
  const found = await listForClass(institution, department, level);
  if (found) return found;
  const { data, error } = await supabaseAdmin()
    .from("class_lists")
    .insert({ institution, department, level, created_by: by })
    .select(LIST_COLS)
    .single();
  if (error) {
    // Two uploads racing: the other one created it.
    const again = await listForClass(institution, department, level);
    if (again) return again;
    throw error;
  }
  return data as ListRow;
}

export async function logList(listId: string, actorId: string | null, action: string, detail: Record<string, unknown> = {}, entryId: string | null = null) {
  try {
    await supabaseAdmin().from("class_list_log").insert({ list_id: listId, entry_id: entryId, actor_id: actorId, action, detail });
  } catch {
    // the log must never block the change itself
  }
}

export async function touchList(listId: string) {
  await supabaseAdmin().from("class_lists").update({ updated_at: new Date().toISOString() }).eq("id", listId);
}

// The student's claimed entry (at most one, anywhere).
export async function entryOfStudent(studentId: string): Promise<EntryRow | null> {
  const { data } = await supabaseAdmin()
    .from("class_list_entries")
    .select(ENTRY_COLS)
    .eq("student_id", studentId)
    .is("removed_at", null)
    .order("claimed_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as EntryRow[])[0] ?? null;
}

// Names match loosely when they share a word of 3+ letters ("Ade John" / "ADEYEMI John").
export function namesOverlap(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3));
  const A = words(a);
  for (const w of words(b)) if (A.has(w)) return true;
  return false;
}

// Release an entry: typed marks stay with the entry (they were taken against the
// matric); passes scanned from the old holder's phone stay with that person.
export async function releaseEntry(entry: EntryRow, actorId: string | null, why: string): Promise<void> {
  const sb = supabaseAdmin();
  const prev = entry.student_id;
  await sb.from("class_list_entries").update({ student_id: null, claimed_at: null, claim_method: null, verified_email: null }).eq("id", entry.id);
  if (prev) {
    await sb.from("attendance_records").update({ student_id: null }).eq("entry_id", entry.id).eq("method", "typed").eq("student_id", prev);
    await sb.from("attendance_records").update({ entry_id: null }).eq("entry_id", entry.id).eq("student_id", prev);
    await sb.from("profiles").update({ attendance_matric: null, attendance_full_name: null }).eq("id", prev).eq("attendance_matric", entry.matric);
  }
  await logList(entry.list_id, actorId, "unclaim", { matric: entry.matric, name: entry.full_name, why, studentId: prev }, entry.id);
}

// Give an entry to a student. Their register name and matric become the list's.
export async function claimEntry(
  entry: EntryRow,
  studentId: string,
  method: "matric" | "email" | "hoc" | "auto",
  actorId: string | null,
  verifiedEmail?: string
): Promise<void> {
  const sb = supabaseAdmin();
  // One entry per student: let go of any other they held.
  const { data: held } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("student_id", studentId).neq("id", entry.id);
  for (const h of (held ?? []) as EntryRow[]) await releaseEntry(h, actorId, "claimed another entry");
  if (entry.student_id && entry.student_id !== studentId) await releaseEntry(entry, actorId, "given to another student");

  const { error } = await sb
    .from("class_list_entries")
    .update({ student_id: studentId, claimed_at: new Date().toISOString(), claim_method: method, verified_email: verifiedEmail ?? null })
    .eq("id", entry.id);
  if (error) throw error;
  await sb.from("profiles").update({ attendance_full_name: entry.full_name, attendance_matric: entry.matric }).eq("id", studentId);

  // Attach attendance both ways. A typed mark and a scanned pass in the same
  // session are the same attendance: keep the scan, drop the typed duplicate.
  const { data: mine } = await sb.from("attendance_records").select("session_id").eq("student_id", studentId).not("session_id", "is", null).limit(5000);
  const mySessions = [...new Set(((mine ?? []) as { session_id: string }[]).map((r) => r.session_id))];
  for (let i = 0; i < mySessions.length; i += 300) {
    await sb.from("attendance_records").delete().eq("entry_id", entry.id).is("student_id", null).in("session_id", mySessions.slice(i, i + 300));
  }
  await sb.from("attendance_records").update({ student_id: studentId }).eq("entry_id", entry.id).is("student_id", null);
  await sb.from("attendance_records").update({ entry_id: entry.id }).eq("student_id", studentId).is("entry_id", null);

  await logList(entry.list_id, actorId, "claim", { matric: entry.matric, name: entry.full_name, method, studentId }, entry.id);
}

export async function hocsOf(list: ListRow): Promise<string[]> {
  const { data } = await supabaseAdmin()
    .from("profiles")
    .select("id")
    .eq("is_hoc", true)
    .eq("department", list.department)
    .eq("level", list.level)
    .limit(10);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

export async function notifyHocs(list: ListRow, title: string, body: string): Promise<void> {
  try {
    const ids = await hocsOf(list);
    if (!ids.length) return;
    await supabaseAdmin().from("notifications").insert(ids.map((user_id) => ({ user_id, type: "class_list", title, body, link: "/class-list" })));
    await sendPushToUsers(ids, { title, body, url: "/class-list" });
  } catch {
    // never fail the request over a notification
  }
}

// ---------- Which lists does a course's register use? ----------
// Courses carry levels (course_levels) but no department, so: the lists for the
// course's level(s), in the departments of students taking it. Without a level
// on record, the (department, level) pairs of the takers.
type CourseLists = { lists: ListRow[]; takers: Set<string>; at: number };
const courseCache = new Map<string, CourseLists>();

export function forgetCourseLists() {
  courseCache.clear();
}

export async function listsForCourse(course: string): Promise<CourseLists> {
  const key = course.replace(/\s/g, "").toUpperCase();
  const hit = courseCache.get(key);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit;
  const sb = supabaseAdmin();
  const takers = new Set<string>();
  let last = "";
  for (;;) {
    let q = sb.from("enrollments").select("user_id").eq("kind", "taking").in("course", variants(course)).order("user_id").limit(1000);
    if (last) q = q.gt("user_id", last);
    const { data } = await q;
    const rows = (data ?? []) as { user_id: string }[];
    for (const r of rows) takers.add(r.user_id);
    if (rows.length < 1000) break;
    last = rows[rows.length - 1].user_id;
  }
  const ids = [...takers];
  const pairs = new Set<string>();
  const depts = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("profiles").select("department,level").in("id", ids.slice(i, i + 500));
    for (const p of (data ?? []) as { department: string | null; level: string | null }[]) {
      if (p.department) depts.add(p.department);
      if (p.department && p.level) pairs.add(`${p.department}\u0000${p.level}`);
    }
  }
  const { data: lv } = await sb.from("course_levels").select("level").in("course", variants(course));
  const levels = [...new Set(((lv ?? []) as { level: string }[]).map((r) => r.level))];
  let lists: ListRow[] = [];
  if (depts.size) {
    if (levels.length) {
      const { data } = await sb.from("class_lists").select(LIST_COLS).in("level", levels).in("department", [...depts]);
      lists = (data ?? []) as ListRow[];
    } else {
      const { data } = await sb.from("class_lists").select(LIST_COLS).in("department", [...depts]);
      lists = ((data ?? []) as ListRow[]).filter((l) => pairs.has(`${l.department}\u0000${l.level}`));
    }
  }
  const out = { lists, takers, at: Date.now() };
  courseCache.set(key, out);
  return out;
}

// Entries the register expects: everyone on those lists. The class list is the
// truth; a student who claimed their entry but hasn't added the course in Unify
// still counts (the register labels them, see notTaking()).
export const notTaking = (cl: CourseLists, e: EntryRow) => !!e.student_id && !cl.takers.has(e.student_id);
export async function expectedEntries(cl: CourseLists): Promise<EntryRow[]> {
  if (!cl.lists.length) return [];
  const out: EntryRow[] = [];
  const ids = cl.lists.map((l) => l.id);
  let from = 0;
  for (;;) {
    const { data } = await supabaseAdmin()
      .from("class_list_entries")
      .select(ENTRY_COLS)
      .in("list_id", ids)
      .is("removed_at", null)
      .order("full_name")
      .range(from, from + 999);
    const rows = (data ?? []) as EntryRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return out;
}
