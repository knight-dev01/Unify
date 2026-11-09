import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { recordVital, snapshot, systemSnapshot, vitalsSnapshot } from "../lib/metrics";
import { raise, recentAlerts } from "../lib/alert";

// Live performance for the admin panel, and the browsers' own timings.
// Mounted at /v1 (see server.ts).
const router = Router();

async function isAdmin(userId: string): Promise<boolean> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("profiles").select("is_admin,role,email").eq("id", userId).single();
    const p = data as { is_admin?: boolean; role?: string; email?: string } | null;
    if (p?.is_admin || p?.role === "admin") return true;
    const list = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return !!(p?.email && list.includes(p.email.toLowerCase()));
  } catch {
    return false;
  }
}

async function adminOnly(req: Request, res: Response): Promise<boolean> {
  if (!(await isAdmin((req as AuthedRequest).userId || ""))) {
    res.status(403).json({ error: "Admin only" });
    return false;
  }
  return true;
}

const WINDOWS = new Set([15, 60, 180]);

router.get("/admin/metrics", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  const asked = Number(req.query.minutes) || 60;
  const minutes = WINDOWS.has(asked) ? asked : 60;
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...snapshot(minutes), system: systemSnapshot(), vitals: vitalsSnapshot(minutes), alerts: recentAlerts().slice(0, 30), serverTime: Date.now() });
});

// Sends a real alert email now, to prove the path works end to end.
router.post("/admin/alerts/test", requireAuth, async (req: Request, res: Response) => {
  if (!(await adminOnly(req, res))) return;
  const rec = await raise("test:" + Date.now(), "Test alert", "This is a test from the admin panel. If you can read this, alert emails work.", undefined, { force: true });
  res.json({ ok: rec.emailed, note: rec.note || "", alert: rec });
});

// Browsers report how a page really loaded (sampled, tiny, no personal data).
const vitalsLimit = rateLimit({ windowMs: 60 * 1000, max: 90, standardHeaders: true, legacyHeaders: false });
router.post("/metrics/vitals", vitalsLimit, (req: Request, res: Response) => {
  const parsed = z
    .object({ page: z.string().min(1).max(60), metrics: z.record(z.string(), z.number()).refine((o) => Object.keys(o).length <= 6) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad vitals" });
    return;
  }
  for (const [m, v] of Object.entries(parsed.data.metrics)) recordVital(parsed.data.page, m, v);
  res.status(204).end();
});

export default router;
