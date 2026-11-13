// Which courses a student may add (Manage courses), shared by the enroll
// endpoint and the settings the app reads. Decided 13 Nov:
//  - lower levels: open (carryovers);
//  - higher levels: locked until the admin promotes the student (one click
//    in Admin › Academic session, nudged once the Second Semester ends);
//  - their own level: the running semester and earlier ones are open; the
//    next semester opens when the running one's teaching weeks are over (or
//    the admin switches the active semester).
// A course offered in several level/semester slots is open if any slot is.
export const LEVELS = ["100 Level", "200 Level", "300 Level", "400 Level", "500 Level"];
export const SEMESTER_ORDER = ["First Semester", "Second Semester"];

export const normLevel = (l: string | null | undefined) => (l || "").trim().replace(/^(\d{3})\s*L(evel)?$/i, "$1 Level");

// Teaching weeks over: the calendar's Week 1 Monday + weeks × 7 days has passed.
export function semesterEnded(cal: { start: string | null; weeks: number }, now = Date.now()): boolean {
  if (!cal.start) return false;
  const end = new Date(`${cal.start}T00:00:00+01:00`).getTime() + cal.weeks * 7 * 86400000;
  return now >= end;
}

export function slotLock(
  student: string | null | undefined,
  slot: { level: string; semester: string },
  current: string,
  ended: boolean
): string | null {
  const mine = LEVELS.indexOf(normLevel(student));
  const lvl = LEVELS.indexOf(normLevel(slot.level));
  if (mine < 0 || lvl < 0) return null; // no level (or an unknown one): nothing to lock
  if (lvl < mine) return null;
  if (lvl > mine) return `Opens when you move to ${LEVELS[lvl]}`;
  const sem = SEMESTER_ORDER.indexOf(slot.semester);
  const cur = SEMESTER_ORDER.indexOf(current);
  if (sem < 0 || cur < 0 || sem <= cur) return null;
  return ended ? null : `Opens when ${slot.semester} starts`;
}

// Null when the course can be added; otherwise why not (first locked reason).
export function courseLock(
  student: string | null | undefined,
  slots: { level: string; semester: string }[],
  current: string,
  ended: boolean
): string | null {
  if (!slots.length) return null;
  let reason: string | null = null;
  for (const s of slots) {
    const r = slotLock(student, s, current, ended);
    if (!r) return null;
    reason = reason || r;
  }
  return reason;
}
