import { supabaseAdmin } from "./supabase";
import { inChunks, pageAll } from "./paging";
import { emailRoom } from "./emailBudget";
import { sendSimpleEmail } from "./email";
import { brandEmail, emailBase, escHtml, panel } from "./email-templates";
import type { lagosNow } from "./reminders";

// The weekly summary email: what's new in your courses this week, your
// streak, and where you stopped. One per student per week, spread over the
// week (each student has their own day) so it never eats a whole day's
// email budget; students without push come first, and it only uses what's
// left of the day's budget after everything more urgent (lib/emailBudget).
// Sent from the reminder tick at 17:00 Lagos.
const SEND_AT = 17 * 60;
const WINDOW = 20; // minutes: a missed tick still sends
const FAKE = /@(test\.unify|unify\.learn)$/i;

const dayOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 7;
};
// Streak with weekends free (same rule as the app).
function streakOf(dates: string[]): number {
  const days = new Set(dates.map((d) => d.slice(0, 10)));
  let n = 0;
  const c = new Date();
  if (!days.has(c.toISOString().slice(0, 10))) c.setUTCDate(c.getUTCDate() - 1);
  for (let i = 0; i < 120; i++) {
    const k = c.toISOString().slice(0, 10);
    if (days.has(k)) n += 1;
    else if (c.getUTCDay() !== 0 && c.getUTCDay() !== 6) break;
    c.setUTCDate(c.getUTCDate() - 1);
  }
  return n;
}

type Student = { id: string; email: string | null; first_name: string | null };

export async function digestTick(now: ReturnType<typeof lagosNow>): Promise<number> {
  if (now.minutes < SEND_AT || now.minutes >= SEND_AT + WINDOW) return 0;
  if (!process.env.BREVO_API_KEY) return 0;
  let room = await emailRoom("digest");
  if (room <= 0) return 0;
  const sb = supabaseAdmin();

  // Today's students: confirmed email, summaries on, their day of the week.
  const all = await pageAll<Student>((from, to) =>
    sb.from("profiles").select("id,email,first_name").or("role.is.null,role.eq.student").eq("email_confirmed", true).neq("email_updates", false).order("id").range(from, to));
  let due = all.filter((p) => p.email && !FAKE.test(p.email) && dayOf(p.id) === now.day);
  if (!due.length) return 0;

  // Not already sent this week (reminder_sends, slot "digest").
  const weekStart = new Date(`${now.date}T12:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const week = weekStart.toISOString().slice(0, 10);
  const sent = new Set((await inChunks<{ user_id: string }>(due.map((p) => p.id), (c, from, to) =>
    sb.from("reminder_sends").select("user_id").in("user_id", c).eq("slot", "digest").eq("sent_on", week).order("user_id").range(from, to))).map((r) => r.user_id));
  due = due.filter((p) => !sent.has(p.id));
  if (!due.length) return 0;

  // Students without push first: email is their only way to hear.
  const withPush = new Set((await inChunks<{ user_id: string }>(due.map((p) => p.id), (c, from, to) =>
    sb.from("push_subscriptions").select("user_id").in("user_id", c).order("user_id").range(from, to))).map((r) => r.user_id));
  due.sort((a, b) => Number(withPush.has(a.id)) - Number(withPush.has(b.id)));
  due = due.slice(0, room);
  const ids = due.map((p) => p.id);

  // What's new this week in their courses, their streak, where they stopped.
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [enrol, xp, resume] = await Promise.all([
    inChunks<{ user_id: string; course: string }>(ids, (c, from, to) => sb.from("enrollments").select("user_id,course").in("user_id", c).eq("kind", "taking").order("user_id").order("course").range(from, to)),
    inChunks<{ user_id: string; created_at: string; id: string }>(ids, (c, from, to) => sb.from("xp_events").select("id,user_id,created_at").in("user_id", c).gt("created_at", new Date(Date.now() - 60 * 86400000).toISOString()).order("id").range(from, to)),
    inChunks<{ user_id: string; course: string; week: number }>(ids, (c, from, to) => sb.from("resume_state").select("user_id,course,week").in("user_id", c).order("user_id").range(from, to)),
  ]);
  const courses = [...new Set(enrol.map((e) => e.course))];
  const fresh = await inChunks<{ course: string; week: number; id: string }>(courses, (c, from, to) =>
    sb.from("topic_notes").select("id,course,week").in("course", c).gt("created_at", since).order("id").range(from, to), 100);
  const newWeeks = new Map<string, Set<number>>();
  for (const n of fresh) {
    if (!newWeeks.has(n.course)) newWeeks.set(n.course, new Set());
    newWeeks.get(n.course)!.add(n.week);
  }
  const coursesOf = new Map<string, string[]>();
  for (const e of enrol) coursesOf.set(e.user_id, [...(coursesOf.get(e.user_id) || []), e.course]);
  const datesOf = new Map<string, string[]>();
  for (const x of xp) datesOf.set(x.user_id, [...(datesOf.get(x.user_id) || []), x.created_at]);
  const resumeOf = new Map(resume.map((r) => [r.user_id, r]));

  const base = emailBase();
  let n = 0;
  for (const p of due) {
    if (room <= 0) break;
    // Claim first, so a second tick never sends twice.
    const { data: claimed } = await sb.from("reminder_sends").upsert({ user_id: p.id, slot: "digest", sent_on: week }, { onConflict: "user_id,slot,sent_on", ignoreDuplicates: true }).select("user_id");
    if (!claimed?.length) continue;
    const first = (p.first_name || "").trim().split(/\s+/)[0];
    const lines = (coursesOf.get(p.id) || [])
      .filter((c) => newWeeks.has(c))
      .slice(0, 5)
      .map((c) => `<div style="padding:4px 0;"><strong>${escHtml(c)}</strong> &middot; new notes for Week ${[...newWeeks.get(c)!].sort((a, b) => a - b).join(", ")}</div>`);
    const streak = streakOf(datesOf.get(p.id) || []);
    const r = resumeOf.get(p.id);
    const cta = r ? { url: `${base}/learn/${encodeURIComponent(r.course)}/week/${r.week}`, label: `Pick up ${r.course} Week ${r.week}` } : { url: `${base}/home`, label: "Open Unify Learn" };
    const html = brandEmail({
      eyebrow: "Your week",
      title: lines.length ? "New notes in your courses" : streak ? `${streak}-day streak. Keep it going.` : "A few minutes this week?",
      pose: streak >= 3 ? "cheer" : "reading-standing",
      body:
        `<p style="margin:0 0 4px;">Hi${first ? ` ${escHtml(first)}` : ""},</p>` +
        (lines.length ? panel(lines.join("")) : `<p style="margin:0;">Nothing new in your courses this week. A short revision keeps last week's classes fresh.</p>`) +
        `<p style="margin:12px 0 0;">${streak ? `You're on a <strong>${streak}-day streak</strong>. Weekends are free.` : "One topic or one Term of the Day starts a new streak."}</p>`,
      cta,
      note: "Your weekly summary from Unify Learn. Turn it off in Settings, Notifications.",
    });
    const ok = await sendSimpleEmail({ to: [{ email: p.email!, name: p.first_name || undefined }], subject: lines.length ? "Unify Learn: new notes in your courses this week" : "Unify Learn: your week", html, priority: "digest" });
    if (ok) {
      n += 1;
      room -= 1;
      // Every email has an in-app twin: the same summary in the bell.
      const newIn = (coursesOf.get(p.id) || []).filter((c) => newWeeks.has(c)).slice(0, 5);
      await sb.from("notifications").insert({
        user_id: p.id,
        type: "digest",
        title: newIn.length ? "New notes in your courses" : "Your week on Unify Learn",
        body: newIn.length
          ? newIn.map((c) => `${c} Week ${[...newWeeks.get(c)!].sort((a, b) => a - b).join(", ")}`).join(" · ")
          : streak ? `You're on a ${streak}-day streak. Weekends are free.` : "One topic or one Term of the Day starts a new streak.",
        link: r ? `/learn/${encodeURIComponent(r.course)}/week/${r.week}` : "/home",
      }).then(() => {}, () => {});
    }
    else await sb.from("reminder_sends").delete().eq("user_id", p.id).eq("slot", "digest").eq("sent_on", week); // not sent: a later tick today can retry
  }
  if (n) console.info(`[digest] sent ${n} weekly summaries`);
  return n;
}
