// Streaks, one rule everywhere (Home, the streak screen, the weekly email):
//  - Study days in a row, counting back from today (or yesterday, if today
//    has nothing yet).
//  - Weekends are free (Review 3, C5/C13): a Saturday or Sunday without
//    study never breaks it, and one with study still counts.
//  - Streak freeze (Duolingo-style, automatic): one missed weekday in any
//    7 days is forgiven, so a single busy day doesn't wipe a long streak.
//    A second miss within 7 days of the first ends it. A frozen day doesn't
//    add to the count; it just doesn't break it.
const DAY = 86400000;
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const FREEZE_EVERY_DAYS = 7;

export function streakDetail(dateIsos: string[], now = new Date()): { streak: number; frozen: string[] } {
  const days = new Set(dateIsos.map((d) => d.slice(0, 10)));
  let streak = 0;
  const frozen: string[] = [];
  let lastFreeze: number | null = null; // time of the most recent freeze, walking back
  const cursor = new Date(now);
  if (!days.has(keyOf(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < 800; i++) {
    const key = keyOf(cursor);
    if (days.has(key)) streak += 1;
    else if (!isWeekend(cursor)) {
      const canFreeze = lastFreeze == null || lastFreeze - cursor.getTime() >= FREEZE_EVERY_DAYS * DAY;
      if (!canFreeze) break;
      // Only worth a freeze if there's study before the gap to carry on from.
      const before = new Date(cursor);
      let found = false;
      for (let j = 0; j < 3 && !found; j++) {
        before.setUTCDate(before.getUTCDate() - 1);
        if (days.has(keyOf(before))) found = true;
        else if (!isWeekend(before)) break;
      }
      if (!found) break;
      lastFreeze = cursor.getTime();
      frozen.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  // A freeze with nothing counted after it isn't a saved streak.
  return { streak, frozen: streak ? frozen : [] };
}

export function calcStreak(dateIsos: string[], now = new Date()): number {
  return streakDetail(dateIsos, now).streak;
}

// Longest run over the last `days` days, same rules (weekends free, one
// freeze per 7 days).
export function longestRun(active: Set<string>, days: number, now = Date.now()): number {
  let longest = 0;
  let run = 0;
  let lastFreeze: number | null = null;
  for (let i = days - 1; i >= 0; i--) {
    const at = new Date(now - i * DAY);
    const d = keyOf(at);
    if (active.has(d)) run += 1;
    else if (!isWeekend(at)) {
      if (run > 0 && (lastFreeze == null || at.getTime() - lastFreeze >= FREEZE_EVERY_DAYS * DAY)) lastFreeze = at.getTime();
      else { run = 0; lastFreeze = null; }
    }
    longest = Math.max(longest, run);
  }
  return longest;
}
