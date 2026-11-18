import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { lagosNow } from "../lib/reminders";
import { pushToUser } from "../lib/push";
import { inChunks, pageAll, repsAmong } from "../lib/paging";

// Class rep tools from Review 3:
// - C7: "Confirm today": today's classes in the courses the rep takes, with
//   whether each is confirmed, cancelled or moved.
// - C11: when classes get confirmed (the rep gets a reminder then) and the
//   latest a lecturer can cancel through the app. One rule for all the
//   rep's courses, stored per course (migration 0054).
// Mounted at /v1 (see server.ts).
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : "Something went wrong." });
const variants = (code: string) => [...new Set([code, code.replace(/\s/g, "")])];

export type ConfirmWhen = "evening" | "2h" | "1h";
export type CancelBy = "evening" | "2h" | "1h" | "any";
const DEFAULT_RULE: { confirmWhen: ConfirmWhen; cancelBy: CancelBy } = { confirmWhen: "evening", cancelBy: "any" };

async function hocCourses(userId: string): Promise<string[] | null> {
  const sb = supabaseAdmin();
  const { data: p } = await sb.from("profiles").select("is_hoc").eq("id", userId).maybeSingle();
  if (!(p as { is_hoc?: boolean } | null)?.is_hoc) return null;
  const { data } = await sb.from("enrollments").select("course").eq("user_id", userId).eq("kind", "taking").limit(60);
  return [...new Set(((data ?? []) as { course: string }[]).map((r) => r.course))];
}

// The rule for a course (any spelling), or the default.
export async function ruleFor(course: string): Promise<{ confirmWhen: ConfirmWhen; cancelBy: CancelBy; set: boolean }> {
  const { data } = await supabaseAdmin().from("class_rules").select("confirm_when,cancel_by").in("course", variants(course)).limit(1);
  const r = (data ?? [])[0] as { confirm_when: ConfirmWhen; cancel_by: CancelBy } | undefined;
  return r ? { confirmWhen: r.confirm_when, cancelBy: r.cancel_by, set: true } : { ...DEFAULT_RULE, set: false };
}

// Minutes from Lagos midnight of the class day to the moment (may be negative:
// "the evening before" is 18:00 the day before, i.e. -360).
function offsetMinutes(when: ConfirmWhen | CancelBy, startMin: number): number | null {
  if (when === "any") return null;
  if (when === "evening") return -6 * 60;
  return startMin - (when === "2h" ? 120 : 60);
}
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const lagosInstant = (date: string, minutes: number) => new Date(new Date(`${date}T00:00:00+01:00`).getTime() + minutes * 60000);

// Used by POST /timetable/:id/change: a lecturer cancelling after the rep's
// cut-off is refused (the class rep can still cancel, or send a live wire).
export async function lecturerCancelTooLate(course: string, date: string, start: string): Promise<string | null> {
  const rule = await ruleFor(course);
  const off = offsetMinutes(rule.cancelBy, toMin(start));
  if (off === null) return null;
  if (Date.now() <= lagosInstant(date, off).getTime()) return null;
  const when = rule.cancelBy === "evening" ? "by 6 PM the evening before" : rule.cancelBy === "2h" ? "at least 2 hours before" : "at least 1 hour before";
  return `Your class rep asks lecturers to cancel ${when}. Ask the class rep to cancel it, or to send a live wire.`;
}

router.get("/hoc/class-rules", requireAuth, async (req: Request, res: Response) => {
  try {
    const courses = await hocCourses(uid(req));
    if (!courses) return fail(res, 403, "Only class reps set class rules.");
    const rule = courses.length ? await ruleFor(courses[0]) : { ...DEFAULT_RULE, set: false };
    res.json({ ...rule, courses: courses.length });
  } catch (e) {
    dbFail(res, e);
  }
});

router.put("/hoc/class-rules", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ confirmWhen: z.enum(["evening", "2h", "1h"]), cancelBy: z.enum(["evening", "2h", "1h", "any"]) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick when classes are confirmed and the latest a lecturer can cancel.");
  try {
    const courses = await hocCourses(uid(req));
    if (!courses) return fail(res, 403, "Only class reps set class rules.");
    if (!courses.length) return fail(res, 400, "Add your class's courses first.");
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin().from("class_rules").upsert(
      courses.map((course) => ({ course, confirm_when: parsed.data.confirmWhen, cancel_by: parsed.data.cancelBy, set_by: uid(req), updated_at: now })),
      { onConflict: "course" },
    );
    if (error) throw error;
    res.json({ ok: true, ...parsed.data, set: true, courses: courses.length });
  } catch (e) {
    dbFail(res, e);
  }
});

type Slot = { id: string; course: string; day: number; start_time: string; end_time: string; venue: string };
type Change = { slot_id: string; status: string; new_start: string | null; new_venue: string | null };

async function classesOn(courses: string[], date: string, day: number): Promise<{ slot: Slot; change: Change | null }[]> {
  if (!courses.length) return [];
  const sb = supabaseAdmin();
  const all = [...new Set(courses.flatMap(variants))];
  const slots = await inChunks<Slot>(all, (c, from, to) => sb.from("class_slots").select("id,course,day,start_time,end_time,venue").in("course", c).eq("day", day).order("start_time").order("id").range(from, to));
  if (!slots.length) return [];
  slots.sort((x, y) => x.start_time.localeCompare(y.start_time));
  const ch = await inChunks<Change>(slots.map((s) => s.id), (c, from, to) => sb.from("slot_changes").select("slot_id,status,new_start,new_venue").in("slot_id", c).eq("class_date", date).order("slot_id").range(from, to));
  const byId = new Map(ch.map((c) => [c.slot_id, c]));
  return slots.map((slot) => ({ slot, change: byId.get(slot.id) || null }));
}

// C7: today's classes to confirm (from 5 PM, tomorrow's: the evening-before
// reminder lands at 6 PM and opens Home).
router.get("/hoc/today", requireAuth, async (req: Request, res: Response) => {
  try {
    const courses = await hocCourses(uid(req));
    if (!courses) return fail(res, 403, "Only class reps confirm classes.");
    const now = lagosNow();
    const late = now.minutes >= 17 * 60;
    const target = late ? lagosNow(new Date(Date.now() + 86400000)) : now;
    const rows = await classesOn(courses, target.date, target.day);
    res.json({
      date: target.date,
      when: late ? "tomorrow" : "today",
      classes: rows.map(({ slot, change }) => ({
        id: slot.id,
        course: slot.course,
        start: slot.start_time.slice(0, 5),
        end: slot.end_time.slice(0, 5),
        venue: slot.venue || "",
        status: change?.status || "normal",
        newStart: change?.new_start || "",
        newVenue: change?.new_venue || "",
        past: !late && toMin(slot.end_time) < now.minutes,
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

// Reminder tick (lib/reminders.ts): at each course's confirm time, remind
// the class reps taking it to confirm the class (once per class per day).
// Runs every minute, so it's batched: a fixed handful of queries however many
// courses, classes and reps there are (it used to query per rule, per class
// and per rep).
export async function confirmTick(now = lagosNow()): Promise<number> {
  const sb = supabaseAdmin();
  // A 10-minute window so a missed tick (cold start) still sends; reminder_sends stops repeats.
  const inWindow = (at: number) => now.minutes >= at && now.minutes < at + 10;
  const rules = await pageAll<{ course: string; confirm_when: ConfirmWhen }>((from, to) => sb.from("class_rules").select("course,confirm_when").order("course").range(from, to));
  if (!rules.length) return 0;
  const tomorrow = lagosNow(new Date(Date.now() + 86400000));
  // "Evening before": tomorrow's classes, in the 18:00 window. Otherwise today's.
  const evening = inWindow(18 * 60) ? rules.filter((r) => r.confirm_when === "evening").map((r) => r.course) : [];
  const sameDay = rules.filter((r) => r.confirm_when !== "evening");
  const whenOf = new Map(sameDay.flatMap((r) => variants(r.course).map((v) => [v, r.confirm_when] as const)));

  const due: { slot: Slot; date: string; when: "today" | "tomorrow" }[] = [];
  for (const { slot, change } of await classesOn(evening, tomorrow.date, tomorrow.day)) {
    if (!change || change.status === "unconfirmed") due.push({ slot, date: tomorrow.date, when: "tomorrow" });
  }
  const todayRows = await classesOn(sameDay.map((r) => r.course), now.date, now.day);
  for (const { slot, change } of todayRows) {
    if (change && change.status !== "unconfirmed") continue;
    const rule = whenOf.get(slot.course);
    const at = rule ? offsetMinutes(rule, toMin(slot.start_time)) : null;
    if (at !== null && inWindow(at)) due.push({ slot, date: now.date, when: "today" });
  }
  if (!due.length) return 0;

  // Class reps taking each due course: one paged lookup for all of them.
  const courses = [...new Set(due.flatMap((d) => variants(d.slot.course)))];
  const taking = await pageAll<{ user_id: string; course: string }>((from, to) =>
    sb.from("enrollments").select("user_id,course").eq("kind", "taking").in("course", courses).order("user_id").order("course").range(from, to),
  );
  const reps = new Set(await repsAmong(taking.map((t) => t.user_id)));
  const repsOf = new Map<string, Set<string>>();
  for (const t of taking) {
    if (!reps.has(t.user_id)) continue;
    const key = t.course.replace(/\s/g, "");
    if (!repsOf.has(key)) repsOf.set(key, new Set());
    repsOf.get(key)!.add(t.user_id);
  }

  // Claim every (rep, class, date) in one upsert; only the rows that come
  // back are new, so each reminder goes out once.
  const want = due.flatMap((d) => [...(repsOf.get(d.slot.course.replace(/\s/g, "")) || [])].map((user_id) => ({ user_id, slot: `confirm:${d.slot.id}`, sent_on: d.date })));
  if (!want.length) return 0;
  const { data: claimed } = await sb.from("reminder_sends").upsert(want, { onConflict: "user_id,slot,sent_on", ignoreDuplicates: true }).select("user_id,slot");
  const fresh = new Set(((claimed ?? []) as { user_id: string; slot: string }[]).map((c) => `${c.user_id}|${c.slot}`));
  let sent = 0;
  for (const d of due) {
    for (const id of repsOf.get(d.slot.course.replace(/\s/g, "")) || []) {
      if (!fresh.has(`${id}|confirm:${d.slot.id}`)) continue;
      await pushToUser(id, {
        title: `Confirm ${d.slot.course} ${d.when} at ${d.slot.start_time.slice(0, 5)}`,
        body: "Is the class still on? Confirm it so your class knows.",
        url: "/home",
      }).catch(() => undefined);
      sent++;
    }
  }
  return sent;
}

export default router;
