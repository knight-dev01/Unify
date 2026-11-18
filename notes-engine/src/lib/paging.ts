import { supabaseAdmin } from "./supabase";

// Supabase's API returns at most 1,000 rows per request (max_rows), whatever
// .limit() asks for. Anything that must reach every row (everyone taking a
// course, every push subscription, every student) pages through instead of
// trusting one big .limit(). These helpers keep that in one place.
export const PAGE = 1000;
// Long .in() lists go in the URL; 200 UUIDs keeps it well under proxy limits.
export const IN_CHUNK = 200;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

// Offset paging. `build(from, to)` must return a query with a stable
// .order() (e.g. by a primary key) and .range(from, to) applied.
export async function pageAll<T>(build: (from: number, to: number) => Page<T>, max = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Run a query per chunk of a long id list, one chunk at a time, and join the
// results. Each chunk is paged too, so no chunk can be cut at 1,000 rows.
export async function inChunks<T>(ids: string[], build: (chunk: string[], from: number, to: number) => Page<T>, size = IN_CHUNK): Promise<T[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += size) {
    const chunk = uniq.slice(i, i + size);
    out.push(...(await pageAll((from, to) => build(chunk, from, to))));
  }
  return out;
}

const variants = (code: string) => [code, code.replace(/\s/g, "")];

// Everyone taking any of these courses (any spelling), deduped.
export async function takersOf(courses: string[]): Promise<string[]> {
  const all = [...new Set(courses.filter(Boolean).flatMap(variants))];
  if (!all.length) return [];
  const rows = await pageAll<{ user_id: string }>((from, to) =>
    supabaseAdmin().from("enrollments").select("user_id").in("course", all).eq("kind", "taking").order("user_id").order("course").range(from, to),
  );
  return [...new Set(rows.map((r) => r.user_id))];
}

// The class reps among these users.
export async function repsAmong(ids: string[]): Promise<string[]> {
  const rows = await inChunks<{ id: string }>(ids, (c, from, to) => supabaseAdmin().from("profiles").select("id").in("id", c).eq("is_hoc", true).order("id").range(from, to));
  return rows.map((r) => r.id);
}
