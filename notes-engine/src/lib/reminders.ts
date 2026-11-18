import { supabaseAdmin } from "./supabase";
import { appBaseUrl, sendPushToUsers, type PushPayload } from "./push";

// Scheduled reminders (migration 0050). Two kinds, both Lagos time:
//  1. Personal: each person's own times (Me > Settings > Notifications), push
//     only, so the bell never fills with nudges. Students who already studied
//     today are skipped: the nudge is for the days they would have missed.
//  2. For everyone: admin-kept reminders (Admin > Reminders) with days of the
//     week and an audience. Bell + push.
// The server ticks every minute; the keep-alive pings every 5 minutes, so a
// send is never more than a few minutes late. A slot that is more than
// CATCH_UP minutes old (the server was asleep) is skipped, not sent late.

const CATCH_UP = 45;
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Audience = "all" | "students" | "lecturers" | "staff";

export function lagosNow(now = new Date()): { date: string; day: number; minutes: number; midnightIso: string } {
  const shifted = new Date(now.getTime() + 60 * 60 * 1000); // Lagos is UTC+1 all year
  const date = shifted.toISOString().slice(0, 10);
  return {
    date,
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    midnightIso: new Date(`${date}T00:00:00+01:00`).toISOString(),
  };
}

const toMin = (s: string): number | null => (TIME_RX.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);
const due = (slot: string, nowMin: number): boolean => {
  const m = toMin(slot);
  return m != null && nowMin >= m && nowMin - m < CATCH_UP;
};

// Defaults when someone never picked times: their study time from onboarding,
// plus an evening "keep the streak" nudge.
export function defaultTimes(studyTime?: string | null): string[] {
  const first: Record<string, string> = { morning: "07:30", afternoon: "13:30", evening: "18:30", night: "21:30" };
  const pick = first[studyTime || ""] || "08:00";
  return pick === "21:30" ? ["12:30", "21:30"] : [pick, "20:00"];
}

export function cleanTimes(times: string[]): string[] {
  return [...new Set(times.filter((t) => TIME_RX.test(t)))].sort().slice(0, 4);
}

type Person = { id: string; first_name: string | null; role: string | null; study_time: string | null; reminder_times: string[] | null };
type Resume = { user_id: string; course: string; week: number };

const STUDENT_LINES: ((n: string, r?: Resume) => { title: string; body: string })[] = [
  (n, r) => ({ title: r ? `${n}, ${r.course} is waiting` : `${n}, ten minutes today?`, body: r ? `Pick up Week ${r.week} where you stopped. One topic is enough.` : "Open a week and read one topic. Small steps add up." }),
  (n) => ({ title: "Keep your streak alive", body: `${n}, one topic or one quiz today keeps it going.` }),
  (n, r) => ({ title: "Quick recall?", body: r ? `A quick quiz on ${r.course}. See what stuck.` : `${n}, try a quick quiz on any course.` }),
  (n) => ({ title: "Your classes, your plan", body: `${n}, check today's timetable and what's coming up this week.` }),
  (n, r) => ({ title: `Study time, ${n}`, body: r ? `Your spot in ${r.course} Week ${r.week} is saved. Carry on.` : "Your notes are ready when you are." }),
];
const LECTURER_LINES: ((n: string) => { title: string; body: string })[] = [
  (n) => ({ title: `Your classes today, ${n}`, body: "See who is keeping up and what your students missed most." }),
  () => ({ title: "A quick look at your class", body: "Attendance, quiz results and messages, all in one place." }),
  () => ({ title: "Anything to share?", body: "Send a PDF or a short post to your class in a few taps." }),
];

function dayOfYear(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
}

function personalPayload(p: Person, slotIndex: number, date: string, resume?: Resume): PushPayload {
  const name = (p.first_name || "").trim().split(/\s+/)[0] || "Hey";
  const i = dayOfYear(date) + slotIndex * 2;
  const teaches = p.role === "lecturer" || p.role === "contributor";
  if (teaches) {
    const line = LECTURER_LINES[i % LECTURER_LINES.length](name);
    return { ...line, url: `${appBaseUrl()}/home` };
  }
  const line = STUDENT_LINES[i % STUDENT_LINES.length](name, resume);
  const url = resume ? `/learn/${encodeURIComponent(resume.course)}/week/${resume.week}` : "/home";
  return { ...line, url: `${appBaseUrl()}${url}` };
}

// ---- Personal reminders ----
async function personalTick(now: ReturnType<typeof lagosNow>): Promise<number> {
  const sb = supabaseAdmin();
  // Only people with push on this or another device: no subscription, no nudge.
  const { data: subs } = await sb.from("push_subscriptions").select("user_id").limit(5000);
  const subscribed = [...new Set(((subs ?? []) as { user_id: string }[]).map((r) => r.user_id))];
  if (!subscribed.length) return 0;

  const people: Person[] = [];
  for (let i = 0; i < subscribed.length; i += 300) {
    const { data } = await sb
      .from("profiles")
      .select("id,first_name,role,study_time,reminder_times")
      .in("id", subscribed.slice(i, i + 300))
      .eq("reminders_on", true);
    people.push(...((data ?? []) as Person[]));
  }

  // Who has a slot due right now (and which one)?
  const dueNow: { p: Person; slot: string; index: number }[] = [];
  for (const p of people) {
    if (p.role === "admin") continue;
    const times = p.reminder_times && p.reminder_times.length ? cleanTimes(p.reminder_times) : defaultTimes(p.study_time);
    const index = times.findIndex((t) => due(t, now.minutes));
    if (index >= 0) dueNow.push({ p, slot: times[index], index });
  }
  if (!dueNow.length) return 0;

  const ids = dueNow.map((d) => d.p.id);
  const sent = new Set<string>();
  const studied = new Set<string>();
  const resume = new Map<string, Resume>();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const [s, x, r] = await Promise.all([
      sb.from("reminder_sends").select("user_id,slot").in("user_id", chunk).eq("sent_on", now.date),
      sb.from("xp_events").select("user_id").in("user_id", chunk).gte("created_at", now.midnightIso).limit(5000),
      sb.from("resume_state").select("user_id,course,week").in("user_id", chunk),
    ]);
    for (const row of (s.data ?? []) as { user_id: string; slot: string }[]) sent.add(`${row.user_id}|${row.slot}`);
    for (const row of (x.data ?? []) as { user_id: string }[]) studied.add(row.user_id);
    for (const row of (r.data ?? []) as Resume[]) resume.set(row.user_id, row);
  }

  const todo = dueNow.filter((d) => !sent.has(`${d.p.id}|${d.slot}`));
  if (!todo.length) return 0;
  // Claim the slots first (the primary key makes a second tick a no-op), then send.
  const { error } = await sb
    .from("reminder_sends")
    .upsert(todo.map((d) => ({ user_id: d.p.id, slot: d.slot, sent_on: now.date })), { onConflict: "user_id,slot,sent_on", ignoreDuplicates: true });
  if (error) throw error;

  // Same message, one fan-out.
  const groups = new Map<string, { payload: PushPayload; ids: string[] }>();
  for (const d of todo) {
    const isStudent = !d.p.role || d.p.role === "student";
    if (isStudent && studied.has(d.p.id)) continue; // already in today: no nudge needed
    const payload = personalPayload(d.p, d.index, now.date, resume.get(d.p.id));
    const key = JSON.stringify(payload);
    const g = groups.get(key) || { payload, ids: [] };
    g.ids.push(d.p.id);
    groups.set(key, g);
  }
  let n = 0;
  for (const g of groups.values()) {
    await sendPushToUsers(g.ids, g.payload);
    n += g.ids.length;
  }
  return n;
}

// ---- Reminders for everyone ----
type Scheduled = { id: string; title: string; body: string; link: string | null; audience: Audience; send_at: string; days: number[]; active: boolean; last_sent_on: string | null };

export async function audienceIds(audience: Audience): Promise<string[]> {
  const sb = supabaseAdmin();
  const ids: string[] = [];
  let last = "";
  for (;;) {
    let q = sb.from("profiles").select("id").order("id").limit(1000);
    if (audience === "students") q = q.or("role.is.null,role.eq.student");
    if (audience === "lecturers") q = q.eq("role", "lecturer");
    if (audience === "staff") q = q.in("role", ["lecturer", "contributor"]);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as { id: string }[];
    ids.push(...rows.map((r) => r.id));
    if (rows.length < 1000) break;
    last = rows[rows.length - 1].id;
  }
  return ids;
}

export async function sendScheduled(r: Pick<Scheduled, "title" | "body" | "link" | "audience">, onlyTo?: string[]): Promise<number> {
  const sb = supabaseAdmin();
  const ids = onlyTo || (await audienceIds(r.audience));
  const link = r.link || "/home";
  const rows = ids.map((user_id) => ({ user_id, type: "reminder", title: r.title, body: r.body, link }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("notifications").insert(rows.slice(i, i + 200));
    if (error) throw error;
  }
  await sendPushToUsers(ids, { title: r.title, body: r.body, url: link.startsWith("http") ? link : `${appBaseUrl()}${link}` });
  return ids.length;
}

async function scheduledTick(now: ReturnType<typeof lagosNow>): Promise<number> {
  const sb = supabaseAdmin();
  const { data } = await sb.from("scheduled_reminders").select("*").eq("active", true);
  let n = 0;
  for (const r of (data ?? []) as Scheduled[]) {
    if (!r.days.includes(now.day) || r.last_sent_on === now.date || !due(r.send_at, now.minutes)) continue;
    // Claim today's send so a second tick (or a second server) can't repeat it.
    const { data: claimed } = await sb
      .from("scheduled_reminders")
      .update({ last_sent_on: now.date })
      .eq("id", r.id)
      .or(`last_sent_on.is.null,last_sent_on.neq.${now.date}`)
      .select("id");
    if (!claimed || !claimed.length) continue;
    n += await sendScheduled(r);
  }
  return n;
}

let running = false;
export async function reminderTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = lagosNow();
    // Class reps: "confirm your class" at the time they chose (Review 3, C11).
    // Required lazily: routes/classRep imports this file.
    const confirm = (require("../routes/classRep") as { confirmTick: (n: typeof now) => Promise<number> }).confirmTick;
    const [a, b, c] = await Promise.allSettled([personalTick(now), scheduledTick(now), confirm(now)]);
    if (c.status === "rejected") console.warn("[reminders] confirm tick failed", c.reason instanceof Error ? c.reason.message : c.reason);
    if (a.status === "rejected") console.warn("[reminders] personal tick failed", a.reason instanceof Error ? a.reason.message : a.reason);
    if (b.status === "rejected") console.warn("[reminders] scheduled tick failed", b.reason instanceof Error ? b.reason.message : b.reason);
    const sentPersonal = a.status === "fulfilled" ? a.value : 0;
    const sentAll = b.status === "fulfilled" ? b.value : 0;
    if (sentPersonal || sentAll) console.info(`[reminders] ${now.date} ${now.minutes}: personal ${sentPersonal}, for everyone ${sentAll}`);
    // Keep the send log short: a week is plenty.
    if (now.minutes === 3 * 60) {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      await supabaseAdmin().from("reminder_sends").delete().lt("sent_on", weekAgo);
    }
  } catch (e) {
    console.warn("[reminders] tick failed", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

export function startReminders(): void {
  if (process.env.REMINDERS_OFF === "1") return;
  setInterval(() => void reminderTick(), 60000).unref();
  setTimeout(() => void reminderTick(), 15000).unref();
}
