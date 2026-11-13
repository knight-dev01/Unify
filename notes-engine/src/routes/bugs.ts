import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";

// Bug reports from inside the app (Me › Report a bug).
//  - POST /bug-reports: anyone signed in; what went wrong (+ what they were
//    doing), with the screen, app version and device the app attaches. Every
//    admin gets it on their bell.
//  - GET /admin/bug-reports?status=open|resolved|all: admins, newest first.
//  - POST /admin/bug-reports/:id/resolve (and /reopen): admins.
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: (e as { message?: string })?.message || "Something went wrong" });

// A handful an hour per person is plenty; stops a stuck button flooding admins.
const reportLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey, message: { error: "That's a lot of reports in an hour. Try again a little later." } });

async function isAdmin(id: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("profiles").select("is_admin,role,email").eq("id", id).maybeSingle();
  const p = data as { is_admin?: boolean; role?: string; email?: string } | null;
  if (p?.is_admin || p?.role === "admin") return true;
  const emails = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !!p?.email && emails.includes(p.email.toLowerCase());
}

const reportSchema = z.object({
  what: z.string().trim().min(5, "Tell us a little more about what went wrong.").max(2000),
  doing: z.string().trim().max(1000).optional(),
  page: z.string().max(300).optional(),
  appVersion: z.string().max(40).optional(),
  device: z.string().max(300).optional(),
});

router.post("/bug-reports", requireAuth, reportLimit, async (req: Request, res: Response) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Check the report and try again.");
  try {
    const sb = supabaseAdmin();
    const d = parsed.data;
    const { data, error } = await sb
      .from("bug_reports")
      .insert({ user_id: uid(req), what: d.what, doing: d.doing || null, page: d.page || null, app_version: d.appVersion || null, device: d.device || null })
      .select("id")
      .single();
    if (error) throw error;
    // Ring every admin's bell (best effort: the report is saved either way).
    try {
      const { data: admins } = await sb.from("profiles").select("id").or("is_admin.eq.true,role.eq.admin").limit(50);
      const { data: me } = await sb.from("profiles").select("first_name,role").eq("id", uid(req)).maybeSingle();
      const who = (me as { first_name?: string; role?: string } | null)?.first_name || "Someone";
      const rows = ((admins ?? []) as { id: string }[]).map((a) => ({
        user_id: a.id,
        type: "bug_report",
        title: `Bug report from ${who}`,
        body: d.what.slice(0, 140),
        link: "/admin/bugs",
      }));
      if (rows.length) await sb.from("notifications").insert(rows);
    } catch {
      // notification is a courtesy
    }
    res.json({ ok: true, id: (data as { id: string }).id });
  } catch (e) {
    dbFail(res, e);
  }
});

router.get("/admin/bug-reports", requireAuth, async (req: Request, res: Response) => {
  if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
  const status = String(req.query.status || "open");
  try {
    const sb = supabaseAdmin();
    let q = sb.from("bug_reports").select("id,user_id,what,doing,page,app_version,device,status,resolved_at,created_at").order("created_at", { ascending: false }).limit(200);
    if (status === "open" || status === "resolved") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as { id: string; user_id: string | null; what: string; doing: string | null; page: string | null; app_version: string | null; device: string | null; status: string; resolved_at: string | null; created_at: string }[];
    const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
    const who = new Map<string, { name: string; role: string; email: string }>();
    if (ids.length) {
      const { data: profs } = await sb.from("profiles").select("id,first_name,role,email").in("id", ids);
      for (const p of (profs ?? []) as { id: string; first_name: string | null; role: string | null; email: string | null }[]) {
        who.set(p.id, { name: p.first_name || "Unnamed", role: p.role || "student", email: p.email || "" });
      }
    }
    const { count: open } = await sb.from("bug_reports").select("id", { count: "exact", head: true }).eq("status", "open");
    res.json({
      open: open ?? 0,
      reports: rows.map((r) => ({
        id: r.id,
        what: r.what,
        doing: r.doing || "",
        page: r.page || "",
        appVersion: r.app_version || "",
        device: r.device || "",
        status: r.status,
        resolvedAt: r.resolved_at,
        createdAt: r.created_at,
        by: r.user_id ? who.get(r.user_id) || { name: "Unknown", role: "", email: "" } : { name: "Deleted account", role: "", email: "" },
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

for (const [action, status] of [["resolve", "resolved"], ["reopen", "open"]] as const) {
  router.post(`/admin/bug-reports/:id/${action}`, requireAuth, async (req: Request, res: Response) => {
    if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
    try {
      const patch = status === "resolved"
        ? { status, resolved_by: uid(req), resolved_at: new Date().toISOString() }
        : { status, resolved_by: null, resolved_at: null };
      const { error } = await supabaseAdmin().from("bug_reports").update(patch).eq("id", req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e) {
      dbFail(res, e);
    }
  });
}

export default router;
