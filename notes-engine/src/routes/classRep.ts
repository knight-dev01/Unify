import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { lagosNow } from "../lib/reminders";
import { pushToUser } from "../lib/push";

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
  const { data } = await sb.from("class_slots").select("id,course,day,start_time,end_time,venue").in("course", all).eq("day", day).order("start_time");
  const slots = (data ?? []) as Slot[];
  if (!slots.length) return [];
  const { data: ch } = await sb.from("slot_changes").select("slot_id,status,new_start,new_venue").in("slot_id", slots.map((s) => s.id)).eq("class_date", date);
  const byId = new Map(((ch ?? []) as Change[]).map((c) => [c.slot_id, c]));
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
export async function confirmTick(now = lagosNow()): Promise<number> {
  const sb = supabaseAdmin();
  const { data: ruleRows } = await sb.from("class_rules").select("course,confirm_when");
  const rules = (ruleRows ?? []) as { course: string; confirm_when: ConfirmWhen }[];
  if (!rules.length) return 0;
  const tomorrow = lagosNow(new Date(Date.now() + 86400000));
  let sent = 0;
  for (const r of rules) {
    // "Evening before": tomorrow's classes at 18:00 today. Otherwise today's.
    const target = r.confirm_when === "evening" ? tomorrow : now;
    // A 10-minute window so a missed tick (cold start) still sends; reminder_sends stops repeats.
    const inWindow = (at: number) => now.minutes >= at && now.minutes < at + 10;
    if (r.confirm_when === "evening" && !inWindow(18 * 60)) continue;
    const rows = await classesOn([r.course], target.date, target.day);
    for (const { slot, change } of rows) {
      if (change && change.status !== "unconfirmed") continue;
      if (r.confirm_when !== "evening") {
        const at = offsetMinutes(r.confirm_when, toMin(slot.start_time));
        if (at === null || !inWindow(at)) continue;
      }
      const { data: reps } = await sb.from("enrollments").select("user_id").eq("kind", "taking").in("course", variants(slot.course)).limit(3000);
      const ids = [...new Set(((reps ?? []) as { user_id: string }[]).map((x) => x.user_id))];
      if (!ids.length) continue;
      const { data: hocs } = await sb.from("profiles").select("id").in("id", ids.slice(0, 1000)).eq("is_hoc", true);
      for (const h of (hocs ?? []) as { id: string }[]) {
        const { data: claimed } = await sb
          .from("reminder_sends")
          .upsert({ user_id: h.id, slot: `confirm:${slot.id}`, sent_on: target.date }, { onConflict: "user_id,slot,sent_on", ignoreDuplicates: true })
          .select("user_id");
        if (!claimed?.length) continue;
        const when = r.confirm_when === "evening" ? "tomorrow" : "today";
        await pushToUser(h.id, {
          title: `Confirm ${slot.course} ${when} at ${slot.start_time.slice(0, 5)}`,
          body: "Is the class still on? Confirm it so your class knows.",
          url: "/home",
        }).catch(() => undefined);
        sent++;
      }
    }
  }
  return sent;
}

export default router;
