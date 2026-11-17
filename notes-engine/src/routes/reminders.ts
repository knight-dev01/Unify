import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { pushToUser } from "../lib/push";
import { cleanTimes, defaultTimes, sendScheduled } from "../lib/reminders";

// Scheduled reminders (migration 0050): a person's own reminder times, and the
// reminders admins schedule for everyone. Mounted at /v1 (see server.ts).
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:30.");

async function isAdmin(userId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin().from("profiles").select("is_admin,role,email").eq("id", userId).single();
    const p = data as { is_admin?: boolean; role?: string; email?: string } | null;
    if (p?.is_admin || p?.role === "admin") return true;
    const list = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return !!(p?.email && list.includes(p.email.toLowerCase()));
  } catch {
    return false;
  }
}
async function adminOnly(req: Request, res: Response): Promise<boolean> {
  if (!(await isAdmin(uid(req)))) {
    res.status(403).json({ error: "Admin only" });
    return false;
  }
  return true;
}
const fail = (res: Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : "Something went wrong." });

// ---- My reminders ----
router.get("/me/reminders", requireAuth, async (req: Request, res: Response) => {
  try {
    const { data } = await supabaseAdmin().from("profiles").select("reminders_on,reminder_times,study_time").eq("id", uid(req)).maybeSingle();
    const p = data as { reminders_on?: boolean; reminder_times?: string[] | null; study_time?: string | null } | null;
    const custom = !!(p?.reminder_times && p.reminder_times.length);
    res.json({
      on: p?.reminders_on !== false,
      times: custom ? cleanTimes(p!.reminder_times!) : defaultTimes(p?.study_time),
      custom,
    });
  } catch (e) {
    fail(res, e);
  }
});

router.put("/me/reminders", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ on: z.boolean().optional(), times: z.array(TIME).max(4).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (parsed.data.on !== undefined) patch.reminders_on = parsed.data.on;
  // null (or an empty list) goes back to the defaults.
  if (parsed.data.times !== undefined) patch.reminder_times = parsed.data.times && parsed.data.times.length ? cleanTimes(parsed.data.times) : null;
  try {
    const { error } = await supabaseAdmin().from("profiles").update(patch).eq("id", uid(req));
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// "Send me one now": proves the whole chain (permission, subscription, push).
router.post("/me/reminders/test", requireAuth, async (req: Request, res: Response) => {
  try {
    await pushToUser(uid(req), { title: "Unify Learn reminders are on", body: "This is how a reminder looks. See you at your next study time.", url: "/home" });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// ---- Admin: reminders for everyone ----
const reminderSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(240),
  link: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || (v.startsWith("/") && !v.startsWith("//") && !v.includes("\\")) || v.startsWith("https://"), "A link must start with / (inside Unify) or https://")
    .optional(),
  audience: z.enum(["all", "students", "lecturers", "staff"]),
  sendAt: TIME,
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  active: z.boolean().optional(),
});
type Row = { id: string; title: string; body: string; link: string | null; audience: string; send_at: string; days: number[]; active: boolean; last_sent_on: string | null; created_at: string };
const out = (r: Row) => ({ id: r.id, title: r.title, body: r.body, link: r.link || "", audience: r.audience, sendAt: r.send_at, days: r.days, active: r.active, lastSentOn: r.last_sent_on });

router.get("/admin/reminders", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  try {
    const { data, error } = await supabaseAdmin().from("scheduled_reminders").select("*").order("send_at");
    if (error) throw error;
    res.json({ reminders: ((data ?? []) as Row[]).map(out) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/admin/reminders", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  const parsed = reminderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid body" });
    return;
  }
  const d = parsed.data;
  try {
    const { data, error } = await supabaseAdmin()
      .from("scheduled_reminders")
      .insert({ title: d.title, body: d.body, link: d.link || null, audience: d.audience, send_at: d.sendAt, days: [...new Set(d.days)].sort(), active: d.active !== false, created_by: uid(req) })
      .select("*")
      .single();
    if (error) throw error;
    res.json({ reminder: out(data as Row) });
  } catch (e) {
    fail(res, e);
  }
});

router.put("/admin/reminders/:id", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  const parsed = reminderSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid body" });
    return;
  }
  const d = parsed.data;
  const patch: Record<string, unknown> = {};
  if (d.title !== undefined) patch.title = d.title;
  if (d.body !== undefined) patch.body = d.body;
  if (d.link !== undefined) patch.link = d.link || null;
  if (d.audience !== undefined) patch.audience = d.audience;
  if (d.sendAt !== undefined) patch.send_at = d.sendAt;
  if (d.days !== undefined) patch.days = [...new Set(d.days)].sort();
  if (d.active !== undefined) patch.active = d.active;
  try {
    const { data, error } = await supabaseAdmin().from("scheduled_reminders").update(patch).eq("id", String(req.params.id)).select("*").single();
    if (error) throw error;
    res.json({ reminder: out(data as Row) });
  } catch (e) {
    fail(res, e);
  }
});

router.delete("/admin/reminders/:id", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  try {
    const { error } = await supabaseAdmin().from("scheduled_reminders").delete().eq("id", String(req.params.id));
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// Preview on the admin's own phone (bell + push), without touching the schedule.
router.post("/admin/reminders/:id/test", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  try {
    const { data } = await supabaseAdmin().from("scheduled_reminders").select("*").eq("id", String(req.params.id)).maybeSingle();
    if (!data) {
      res.status(404).json({ error: "That reminder is gone." });
      return;
    }
    const r = data as Row;
    await sendScheduled({ title: r.title, body: r.body, link: r.link, audience: "all" }, [uid(req)]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
