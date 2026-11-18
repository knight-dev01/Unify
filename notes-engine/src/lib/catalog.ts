import { supabaseAdmin } from "./supabase";
import { pageAll } from "./paging";
import { cachedWeek } from "./weekCache";

// Catalogue tables that every course list reads whole (course levels, weeks,
// the notes index). They grow with every course added, so:
// - paged: one request stops at 1,000 rows, which cut off later courses;
// - cached 60 s in the week cache (cleared on any note or course write), so a
//   busy morning reads them once a minute instead of once per request.
// Shaped like a Supabase result so call sites keep their { data, error } code.
type Res<T> = { data: T[]; error: null };
const wrap = <T>(p: Promise<T[]>): Promise<Res<T>> => p.then((data) => ({ data, error: null }));

export type LevelRow = { course: string; level: string; semester: string };
export function catalogLevels(): Promise<Res<LevelRow>> {
  return wrap(cachedWeek("catalog:levels", () => pageAll<LevelRow>((from, to) =>
    supabaseAdmin().from("course_levels").select("course,level,semester").order("course").order("level").order("semester").range(from, to))));
}

export type WeekRow = { course: string; week: number; title: string | null };
export function catalogWeeks(): Promise<Res<WeekRow>> {
  return wrap(cachedWeek("catalog:weeks", () => pageAll<WeekRow>((from, to) =>
    supabaseAdmin().from("weeks").select("course,week,title").order("course").order("week").range(from, to))));
}

export type NoteIndexRow = { course: string; week: number; topic: number; lecture_no: number | null; version: number; title: string | null };
export function catalogNotes(): Promise<Res<NoteIndexRow>> {
  return wrap(cachedWeek("catalog:notes", () => pageAll<NoteIndexRow>((from, to) =>
    supabaseAdmin().from("topic_notes").select("course,week,topic,lecture_no,version,title").order("course").order("week").order("lecture_no").order("topic").order("version").order("id").range(from, to))));
}
