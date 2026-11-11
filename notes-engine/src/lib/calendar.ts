import { supabaseAdmin } from "./supabase";

// Semester calendar (Admin → Academic session): Week 1's start date and the
// number of teaching weeks. Used for "Week 3 of 12" on Home and to file
// attendance under a week. Cached for a minute.
let cache: { at: number; start: string | null; weeks: number } | null = null;

export async function getSemesterCalendar(): Promise<{ start: string | null; weeks: number }> {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  let start: string | null = null;
  let weeks = 12;
  try {
    const { data } = await supabaseAdmin().from("app_settings").select("key,value").in("key", ["semester_start", "semester_weeks"]);
    for (const r of (data ?? []) as { key: string; value: string }[]) {
      if (r.key === "semester_start" && /^\d{4}-\d{2}-\d{2}$/.test(r.value)) start = r.value;
      if (r.key === "semester_weeks" && Number(r.value) >= 6 && Number(r.value) <= 26) weeks = Number(r.value);
    }
  } catch {
    // no calendar yet
  }
  cache = { at: Date.now(), start, weeks };
  return cache;
}

export function forgetSemesterCalendar(): void {
  cache = null;
}

// Week number today (1-based), or null outside the semester / without a calendar.
export async function currentSemesterWeek(): Promise<number | null> {
  const cal = await getSemesterCalendar();
  if (!cal.start) return null;
  const w = Math.floor((Date.now() - new Date(`${cal.start}T00:00:00+01:00`).getTime()) / (7 * 86400000)) + 1;
  return w >= 1 && w <= cal.weeks ? w : null;
}
