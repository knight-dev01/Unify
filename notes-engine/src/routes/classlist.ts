import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendSimpleEmail } from "../lib/email";
import { parseClassList, ParseError, normalizeMatric, tidyName } from "../lib/classlistParse";
import {
  ENTRY_COLS,
  LIST_COLS,
  claimEntry,
  ensureList,
  entryOfStudent,
  forgetCourseLists,
  institutionOf,
  listForClass,
  logList,
  namesOverlap,
  notifyHocs,
  releaseEntry,
  touchList,
  type EntryRow,
  type ListRow,
} from "../lib/classlist";

// Class lists (mounted at /v1). Who sees what:
//  - the class's HOCs (and admins) manage the list and see every name + matric;
//  - a student sees only their own entry;
//  - lecturers see names only through the register of a course they teach.
const router = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey });
const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).userId || "anon",
});
const emailLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).userId || "anon",
  message: { error: "Too many codes today. Try again tomorrow, or claim with your matric number." },
});
router.use("/class-list", limiter);

type Me = {
  id: string;
  first_name: string | null;
  email: string | null;
  role: string | null;
  is_admin: boolean | null;
  is_hoc: boolean | null;
  department: string | null;
  level: string | null;
  university: string | null;
  attendance_full_name: string | null;
};
const ME_COLS = "id,first_name,email,role,is_admin,is_hoc,department,level,university,attendance_full_name";

const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string, extra: Record<string, unknown> = {}) => res.status(status).json({ error: message, ...extra });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });
const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

async function getMe(req: Request): Promise<Me | null> {
  const { data } = await supabaseAdmin().from("profiles").select(ME_COLS).eq("id", uid(req)).maybeSingle();
  return (data as Me | null) ?? null;
}

// The class a HOC manages: their own. Admins may name any class with ?department=&level=.
async function managedClass(req: Request, me: Me | null): Promise<{ department: string; level: string; institution: string } | { error: string; status: number }> {
  if (!me) return { error: "Finish onboarding first.", status: 404 };
  const q = { ...(req.query as Record<string, unknown>), ...((req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>) };
  if (me.is_admin && typeof q.department === "string" && typeof q.level === "string" && q.department && q.level) {
    return { department: q.department, level: q.level, institution: institutionOf(me) };
  }
  if (!me.is_hoc && !me.is_admin) return { error: "Only your class rep can manage the class list.", status: 403 };
  if (!me.department || !me.level) return { error: "Set your department and level in Me first.", status: 400 };
  return { department: me.department, level: me.level, institution: institutionOf(me) };
}

async function entryById(id: string): Promise<EntryRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await supabaseAdmin().from("class_list_entries").select(ENTRY_COLS).eq("id", id).maybeSingle();
  return (data as EntryRow | null) ?? null;
}

// The entry must be on the list this HOC manages (admins: any).
async function guardEntry(req: Request, res: Response): Promise<{ me: Me; entry: EntryRow; list: ListRow } | null> {
  const me = await getMe(req);
  const entry = await entryById(req.params.id);
  if (!entry) {
    fail(res, 404, "That entry is gone.");
    return null;
  }
  const { data } = await supabaseAdmin().from("class_lists").select(LIST_COLS).eq("id", entry.list_id).maybeSingle();
  const list = data as ListRow | null;
  const ok = !!me && !!list && (me.is_admin || (me.is_hoc && me.department === list.department && me.level === list.level));
  if (!ok || !me || !list) {
    fail(res, 403, "Only this class's rep can change its list.");
    return null;
  }
  return { me, entry, list };
}

const names = async (ids: string[]) => {
  const out: Record<string, { first: string; email: string }> = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 500) {
    const { data } = await supabaseAdmin().from("profiles").select("id,first_name,email").in("id", uniq.slice(i, i + 500));
    for (const p of (data ?? []) as { id: string; first_name: string | null; email: string | null }[]) out[p.id] = { first: p.first_name || "Student", email: p.email || "" };
  }
  return out;
};

// ---------- HOC: the list ----------

router.get("/class-list", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getMe(req);
    const cls = await managedClass(req, me);
    if ("error" in cls) return fail(res, cls.status, cls.error);
    const list = await listForClass(cls.institution, cls.department, cls.level);
    if (!list) {
      res.json({ list: null, class: cls, entries: [], claims: [], log: [] });
      return;
    }
    const sb = supabaseAdmin();
    const entries: EntryRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("list_id", list.id).order("full_name").range(from, from + 999);
      const rows = (data ?? []) as EntryRow[];
      entries.push(...rows);
      if (rows.length < 1000) break;
    }
    const { data: claimRows } = await sb
      .from("class_list_claims")
      .select("id,student_id,matric,full_name,reason,verified_email,note,created_at")
      .eq("list_id", list.id)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(200);
    const { data: logRows } = await sb
      .from("class_list_log")
      .select("id,entry_id,actor_id,action,detail,created_at")
      .eq("list_id", list.id)
      .order("created_at", { ascending: false })
      .limit(60);
    const claims = (claimRows ?? []) as { id: string; student_id: string; matric: string; full_name: string; reason: string; verified_email: string | null; note: string; created_at: string }[];
    const log = (logRows ?? []) as { id: string; entry_id: string | null; actor_id: string | null; action: string; detail: Record<string, unknown>; created_at: string }[];
    const who = await names([...entries.map((e) => e.student_id || ""), ...claims.map((c) => c.student_id), ...log.map((l) => l.actor_id || "")]);
    const byMatric = new Map(entries.map((e) => [e.matric, e]));
    res.json({
      list: { id: list.id, department: list.department, level: list.level, institution: list.institution, updatedAt: list.updated_at },
      class: cls,
      entries: entries.map((e) => ({
        id: e.id,
        name: e.full_name,
        matric: e.matric,
        claimed: !!e.student_id,
        claimedBy: e.student_id ? who[e.student_id]?.first || "Student" : "",
        claimMethod: e.claim_method || "",
        verifiedEmail: !!e.verified_email,
        removed: !!e.removed_at,
      })),
      claims: claims.map((c) => {
        const onList = byMatric.get(c.matric);
        return {
          id: c.id,
          reason: c.reason,
          matric: c.matric,
          name: c.full_name,
          account: who[c.student_id]?.first || "Student",
          accountEmail: who[c.student_id]?.email || "",
          verifiedEmail: c.verified_email || "",
          note: c.note,
          at: c.created_at,
          entry: onList ? { id: onList.id, name: onList.full_name, claimedBy: onList.student_id ? who[onList.student_id]?.first || "Student" : "" } : null,
        };
      }),
      log: log.map((l) => ({ id: l.id, action: l.action, detail: l.detail, at: l.created_at, by: l.actor_id ? who[l.actor_id]?.first || "Someone" : "Unify" })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

// Read a file or pasted text into rows for review. Nothing is saved.
const parseSchema = z.union([
  z.object({ text: z.string().min(1).max(500_000) }),
  z.object({ filename: z.string().max(200), data: z.string().min(1).max(6_000_000) }),
]);

router.post("/class-list/parse", requireAuth, async (req: Request, res: Response) => {
  const parsed = parseSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Upload a file (up to 4 MB) or paste the list.");
  try {
    const me = await getMe(req);
    const cls = await managedClass(req, me);
    if ("error" in cls) return fail(res, cls.status, cls.error);
    const result =
      "text" in parsed.data
        ? await parseClassList({ text: parsed.data.text })
        : await parseClassList({ filename: parsed.data.filename, data: Buffer.from(parsed.data.data, "base64") });
    if (!result.rows.length) {
      return fail(res, 422, "We couldn't find any matric numbers in that. Check it has a matric column, or paste the list as \"Name, Matric\" lines.", { problems: result.problems });
    }
    // Mark which rows are already on the list (a re-upload merges).
    const list = await listForClass(cls.institution, cls.department, cls.level);
    const existing = new Map<string, EntryRow>();
    if (list) {
      const ms = [...new Set(result.rows.map((r) => r.matric))];
      for (let i = 0; i < ms.length; i += 300) {
        const { data } = await supabaseAdmin().from("class_list_entries").select(ENTRY_COLS).eq("list_id", list.id).in("matric", ms.slice(i, i + 300));
        for (const e of (data ?? []) as EntryRow[]) existing.set(e.matric, e);
      }
    }
    res.json({
      ...result,
      rows: result.rows.map((r) => {
        const e = existing.get(r.matric);
        return { ...r, existing: e ? { name: e.full_name, removed: !!e.removed_at } : null };
      }),
    });
  } catch (e) {
    if (e instanceof ParseError) return fail(res, 422, e.message);
    dbFail(res, e);
  }
});

const MATRIC_OK = /^[A-Z0-9/\-]{4,30}$/;
const rowSchema = z.object({ name: z.string().trim().min(2).max(100), matric: z.string().trim().min(4).max(30) });

// Students whose self-typed matric matches a new entry (and whose name fits)
// are linked straight away, with the attendance they already have.
async function autoLink(list: ListRow, entries: EntryRow[], actorId: string): Promise<number> {
  const sb = supabaseAdmin();
  let linked = 0;
  const open = entries.filter((e) => !e.student_id && !e.removed_at);
  for (let i = 0; i < open.length; i += 200) {
    const chunk = open.slice(i, i + 200);
    const { data } = await sb
      .from("profiles")
      .select("id,attendance_matric,attendance_full_name,first_name,department,level")
      .in("attendance_matric", chunk.map((e) => e.matric));
    const ps = (data ?? []) as { id: string; attendance_matric: string; attendance_full_name: string | null; first_name: string | null; department: string | null; level: string | null }[];
    for (const e of chunk) {
      const hits = ps.filter((p) => p.attendance_matric === e.matric);
      if (hits.length !== 1) continue;
      const p = hits[0];
      if ((p.department && p.department !== list.department) || (p.level && p.level !== list.level)) continue;
      if (!namesOverlap(e.full_name, `${p.attendance_full_name || ""} ${p.first_name || ""}`)) continue;
      if (await entryOfStudent(p.id)) continue;
      await claimEntry(e, p.id, "auto", actorId);
      linked++;
    }
  }
  return linked;
}

// Save reviewed rows. New matrics are added, removed ones come back, and
// existing entries are left as they are (names are edited one at a time).
router.post("/class-list/entries", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ rows: z.array(rowSchema).min(1).max(3000), source: z.string().max(20).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Every row needs a name and a matric number.");
  try {
    const me = await getMe(req);
    const cls = await managedClass(req, me);
    if ("error" in cls) return fail(res, cls.status, cls.error);
    const bad = parsed.data.rows.find((r) => !MATRIC_OK.test(normalizeMatric(r.matric)));
    if (bad) return fail(res, 400, `"${bad.matric}" doesn't look like a matric number.`);
    const list = await ensureList(cls.institution, cls.department, cls.level, me!.id);
    const sb = supabaseAdmin();
    const rows = new Map<string, string>();
    for (const r of parsed.data.rows) rows.set(normalizeMatric(r.matric), tidyName(r.name));
    const ms = [...rows.keys()];
    const existing = new Map<string, EntryRow>();
    for (let i = 0; i < ms.length; i += 300) {
      const { data } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("list_id", list.id).in("matric", ms.slice(i, i + 300));
      for (const e of (data ?? []) as EntryRow[]) existing.set(e.matric, e);
    }
    const fresh = ms.filter((m) => !existing.has(m)).map((m) => ({ list_id: list.id, institution: list.institution, matric: m, full_name: rows.get(m)!, added_by: me!.id }));
    const restore = ms.filter((m) => existing.get(m)?.removed_at).map((m) => existing.get(m)!.id);
    const nameDiffers = ms.filter((m) => {
      const e = existing.get(m);
      return e && !e.removed_at && e.full_name.toLowerCase() !== rows.get(m)!.toLowerCase();
    });
    const added: EntryRow[] = [];
    for (let i = 0; i < fresh.length; i += 500) {
      const { data, error } = await sb.from("class_list_entries").insert(fresh.slice(i, i + 500)).select(ENTRY_COLS);
      if (error) throw error;
      added.push(...((data ?? []) as EntryRow[]));
    }
    if (restore.length) await sb.from("class_list_entries").update({ removed_at: null }).in("id", restore);
    await logList(list.id, me!.id, "upload", { source: parsed.data.source || "file", added: added.length, restored: restore.length, unchanged: ms.length - added.length - restore.length });
    await touchList(list.id);
    forgetCourseLists();
    const linked = await autoLink(list, added, me!.id);
    // Students who asked to be added and now are: settle their requests.
    const { data: waiting } = await sb.from("class_list_claims").select("id,student_id,matric").eq("list_id", list.id).eq("status", "open").eq("reason", "not_on_list");
    let settled = 0;
    for (const w of (waiting ?? []) as { id: string; student_id: string; matric: string }[]) {
      const e = added.find((a) => a.matric === w.matric);
      if (!e) continue;
      const { data: cur } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("id", e.id).single();
      if ((cur as EntryRow).student_id) continue;
      await claimEntry(cur as EntryRow, w.student_id, "hoc", me!.id);
      await sb.from("class_list_claims").update({ status: "approved", resolved_by: me!.id, resolved_at: new Date().toISOString() }).eq("id", w.id);
      settled++;
    }
    res.json({ ok: true, listId: list.id, added: added.length, restored: restore.length, unchanged: ms.length - added.length - restore.length, nameDiffers: nameDiffers.length, linked: linked + settled });
  } catch (e) {
    dbFail(res, e);
  }
});

router.patch("/class-list/entries/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(100).optional(), matric: z.string().trim().min(4).max(30).optional() }).safeParse(req.body);
  if (!parsed.success || (!parsed.data.name && !parsed.data.matric)) return fail(res, 400, "Enter a name or matric number.");
  try {
    const g = await guardEntry(req, res);
    if (!g) return;
    const patch: Record<string, string> = {};
    if (parsed.data.name) patch.full_name = tidyName(parsed.data.name);
    if (parsed.data.matric) {
      const m = normalizeMatric(parsed.data.matric);
      if (!MATRIC_OK.test(m)) return fail(res, 400, "That doesn't look like a matric number.");
      patch.matric = m;
    }
    const { error } = await supabaseAdmin().from("class_list_entries").update(patch).eq("id", g.entry.id);
    if (error) {
      if ((error as { code?: string }).code === "23505") return fail(res, 409, "Another entry already has that matric number.");
      throw error;
    }
    // A claimed student's register details follow the list.
    if (g.entry.student_id) {
      await supabaseAdmin()
        .from("profiles")
        .update({ attendance_full_name: patch.full_name ?? g.entry.full_name, attendance_matric: patch.matric ?? g.entry.matric })
        .eq("id", g.entry.student_id);
    }
    await logList(g.list.id, g.me.id, "edit", { from: { name: g.entry.full_name, matric: g.entry.matric }, to: { name: patch.full_name, matric: patch.matric } }, g.entry.id);
    await touchList(g.list.id);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Remove keeps the row (and its attendance) so it can be restored.
router.delete("/class-list/entries/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const g = await guardEntry(req, res);
    if (!g) return;
    if (g.entry.student_id) await releaseEntry(g.entry, g.me.id, "removed from the list");
    await supabaseAdmin().from("class_list_entries").update({ removed_at: new Date().toISOString() }).eq("id", g.entry.id);
    await logList(g.list.id, g.me.id, "remove", { matric: g.entry.matric, name: g.entry.full_name }, g.entry.id);
    await touchList(g.list.id);
    forgetCourseLists();
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/class-list/entries/:id/restore", requireAuth, async (req: Request, res: Response) => {
  try {
    const g = await guardEntry(req, res);
    if (!g) return;
    await supabaseAdmin().from("class_list_entries").update({ removed_at: null }).eq("id", g.entry.id);
    await logList(g.list.id, g.me.id, "restore", { matric: g.entry.matric, name: g.entry.full_name }, g.entry.id);
    forgetCourseLists();
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// Unlink the wrong account from an entry; the student can claim again.
router.post("/class-list/entries/:id/unclaim", requireAuth, async (req: Request, res: Response) => {
  try {
    const g = await guardEntry(req, res);
    if (!g) return;
    if (!g.entry.student_id) return fail(res, 400, "Nobody has claimed this entry.");
    const prev = g.entry.student_id;
    await releaseEntry(g.entry, g.me.id, "unlinked by the class rep");
    await supabaseAdmin().from("notifications").insert({
      user_id: prev,
      type: "class_list",
      title: "Your class-list entry was unlinked",
      body: `Your class rep unlinked ${g.entry.matric} from your account. Claim your own entry from My pass.`,
      link: "/attendance/pass",
    });
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- HOC inbox: claim problems ----------

router.post("/class-list/claims/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ action: z.enum(["approve", "reject"]), note: z.string().trim().max(300).optional() }).safeParse(req.body);
  if (!parsed.success || !isUuid(req.params.id)) return fail(res, 400, "Approve or reject.");
  try {
    const me = await getMe(req);
    const sb = supabaseAdmin();
    const { data } = await sb.from("class_list_claims").select("id,list_id,student_id,matric,full_name,reason,verified_email,status").eq("id", req.params.id).maybeSingle();
    const c = data as { id: string; list_id: string; student_id: string; matric: string; full_name: string; reason: string; verified_email: string | null; status: string } | null;
    if (!c) return fail(res, 404, "That request is gone.");
    if (c.status !== "open") return fail(res, 409, "That request was already handled.");
    const { data: l } = await sb.from("class_lists").select(LIST_COLS).eq("id", c.list_id).maybeSingle();
    const list = l as ListRow | null;
    if (!me || !list || !(me.is_admin || (me.is_hoc && me.department === list.department && me.level === list.level))) return fail(res, 403, "Only this class's rep can answer this.");

    if (parsed.data.action === "approve") {
      const { data: e } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("list_id", list.id).eq("matric", c.matric).maybeSingle();
      let entry = e as EntryRow | null;
      if (!entry) {
        // Not on the list: approving adds them.
        const { data: ins, error } = await sb
          .from("class_list_entries")
          .insert({ list_id: list.id, institution: list.institution, matric: c.matric, full_name: tidyName(c.full_name || "Student"), added_by: me.id })
          .select(ENTRY_COLS)
          .single();
        if (error) throw error;
        entry = ins as EntryRow;
        await logList(list.id, me.id, "add", { matric: entry.matric, name: entry.full_name, fromRequest: true }, entry.id);
        forgetCourseLists();
      } else if (entry.removed_at) {
        await sb.from("class_list_entries").update({ removed_at: null }).eq("id", entry.id);
        forgetCourseLists();
      }
      const prev = entry.student_id && entry.student_id !== c.student_id ? entry.student_id : null;
      await claimEntry(entry, c.student_id, c.verified_email ? "email" : "hoc", me.id, c.verified_email || undefined);
      if (prev) {
        await sb.from("notifications").insert({
          user_id: prev,
          type: "class_list",
          title: "Your class-list entry moved",
          body: `Your class rep gave ${entry.matric} to the student it belongs to. If that's wrong, talk to your class rep.`,
          link: "/attendance/pass",
        });
      }
    }
    await sb.from("class_list_claims").update({ status: parsed.data.action === "approve" ? "approved" : "rejected", resolved_by: me.id, resolved_at: new Date().toISOString() }).eq("id", c.id);
    await logList(list.id, me.id, parsed.data.action, { matric: c.matric, name: c.full_name, reason: c.reason, note: parsed.data.note || "" });
    await sb.from("notifications").insert({
      user_id: c.student_id,
      type: "class_list",
      title: parsed.data.action === "approve" ? "You're on the class list" : "Class-list request not approved",
      body:
        parsed.data.action === "approve"
          ? `Your class rep confirmed ${c.matric}. Your pass now shows your name from the list.`
          : `Your class rep didn't approve ${c.matric}.${parsed.data.note ? ` They said: "${parsed.data.note}"` : " Talk to them in class."}`,
      link: "/attendance/pass",
    });
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Student: claim my entry ----------

type Outcome =
  | { status: "claimed"; entry: { name: string; matric: string } }
  | { status: "sent_to_hoc"; reason: "not_on_list" | "already_claimed" }
  | { status: "not_found"; reason: "not_on_list" | "already_claimed" }
  | { status: "no_list" };

// askHoc: send a request to the class rep when it doesn't match. Without it the
// student just hears "not found" first (a typo shouldn't land in the HOC's inbox).
async function myClaim(me: Me, matricRaw: string, fullName: string, note: string, askHoc: boolean, verifiedEmail?: string): Promise<Outcome> {
  const sb = supabaseAdmin();
  const matric = normalizeMatric(matricRaw);
  if (!me.department || !me.level) return { status: "no_list" };
  const list = await listForClass(institutionOf(me), me.department, me.level);
  if (!list) return { status: "no_list" };
  const { data } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("list_id", list.id).eq("matric", matric).maybeSingle();
  const entry = data as EntryRow | null;
  if (entry && !entry.removed_at && (!entry.student_id || entry.student_id === me.id)) {
    await claimEntry(entry, me.id, verifiedEmail ? "email" : "matric", me.id, verifiedEmail);
    await sb.from("class_list_claims").update({ status: "approved", resolved_at: new Date().toISOString() }).eq("student_id", me.id).eq("status", "open");
    forgetCourseLists();
    return { status: "claimed", entry: { name: entry.full_name, matric: entry.matric } };
  }
  const reason = entry && !entry.removed_at ? "already_claimed" : "not_on_list";
  if (!askHoc && !verifiedEmail) return { status: "not_found", reason };
  // One open request per student: a new one replaces the old.
  await sb.from("class_list_claims").delete().eq("student_id", me.id).eq("status", "open");
  const { error } = await sb.from("class_list_claims").insert({
    list_id: list.id,
    student_id: me.id,
    matric,
    full_name: tidyName(fullName || me.attendance_full_name || me.first_name || ""),
    reason,
    verified_email: verifiedEmail ?? null,
    note,
  });
  if (error) throw error;
  const who = fullName || me.first_name || "A student";
  await notifyHocs(
    list,
    reason === "already_claimed" ? "Class list: matric already claimed" : "Class list: student not on the list",
    reason === "already_claimed"
      ? `${who} says ${matric} is theirs, but another account claimed it.${verifiedEmail ? " They verified their LASU email." : ""} Check it in Class list.`
      : `${who} (${matric}) isn't on your class list.${verifiedEmail ? " They verified their LASU email." : ""} Add them or decline in Class list.`
  );
  return { status: "sent_to_hoc", reason };
}

router.get("/class-list/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const me = await getMe(req);
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const list = me.department && me.level ? await listForClass(institutionOf(me), me.department, me.level) : null;
    const entry = await entryOfStudent(me.id);
    const { data: claim } = await sb.from("class_list_claims").select("matric,reason,created_at").eq("student_id", me.id).eq("status", "open").maybeSingle();
    const { data: code } = await sb.from("class_claim_codes").select("email,expires_at").eq("student_id", me.id).maybeSingle();
    const pending = code as { email: string; expires_at: string } | null;
    let size = 0;
    if (list) {
      const { count } = await sb.from("class_list_entries").select("id", { count: "exact", head: true }).eq("list_id", list.id).is("removed_at", null);
      size = count ?? 0;
    }
    res.json({
      list: list ? { department: list.department, level: list.level, size } : null,
      entry: entry ? { name: entry.full_name, matric: entry.matric, method: entry.claim_method || "", verifiedEmail: !!entry.verified_email } : null,
      request: claim ? { matric: (claim as { matric: string }).matric, reason: (claim as { reason: string }).reason, at: (claim as { created_at: string }).created_at } : null,
      emailPending: pending && new Date(pending.expires_at).getTime() > Date.now() ? { email: pending.email } : null,
      emailFormat: "firstname.lastnameMATRIC@st.lasu.edu.ng",
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/class-list/claim", requireAuth, claimLimiter, async (req: Request, res: Response) => {
  const parsed = z
    .object({ matric: z.string().trim().min(4).max(30), fullName: z.string().trim().max(100).optional(), note: z.string().trim().max(300).optional(), askHoc: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter your matric number.");
  if (parsed.data.askHoc && (parsed.data.fullName || "").length < 2) return fail(res, 400, "Add your full name so your class rep knows who you are.");
  try {
    const me = await getMe(req);
    if (!me) return fail(res, 404, "Finish onboarding first.");
    if (me.role !== "student") return fail(res, 400, "Only students claim a class-list entry.");
    res.json(await myClaim(me, parsed.data.matric, parsed.data.fullName || "", parsed.data.note || "", !!parsed.data.askHoc));
  } catch (e) {
    dbFail(res, e);
  }
});

router.delete("/class-list/request", requireAuth, async (req: Request, res: Response) => {
  try {
    await supabaseAdmin().from("class_list_claims").delete().eq("student_id", uid(req)).eq("status", "open");
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Student: verify with the LASU student email (optional for now) ----------
// LASU student emails read firstname.lastnameMATRIC@st.lasu.edu.ng: the matric is in the address.
const LASU_EMAIL = /^[a-z][a-z'\-]*\.[a-z][a-z'\-]*?(\d{6,12})@st\.lasu\.edu\.ng$/i;
const hashCode = (studentId: string, code: string) => createHash("sha256").update(`${studentId}:${code}`).digest("hex");

router.post("/class-list/verify-email/start", requireAuth, emailLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({ email: z.string().trim().max(120) }).safeParse(req.body);
  const email = (parsed.success ? parsed.data.email : "").toLowerCase();
  const m = LASU_EMAIL.exec(email);
  if (!m) return fail(res, 400, "Use your LASU student email: firstname.lastnameMATRIC@st.lasu.edu.ng");
  try {
    const me = await getMe(req);
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const { data: prev } = await sb.from("class_claim_codes").select("sent_at").eq("student_id", me.id).maybeSingle();
    const sentAt = (prev as { sent_at: string } | null)?.sent_at;
    if (sentAt && Date.now() - new Date(sentAt).getTime() < 60 * 1000) return fail(res, 429, "We just sent a code. Wait a minute before asking again.");
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const { error } = await sb.from("class_claim_codes").upsert({
      student_id: me.id,
      email,
      matric: m[1],
      code_hash: hashCode(me.id, code),
      attempts: 0,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    if (error) throw error;
    const sent = await sendSimpleEmail({
      to: [{ email, name: me.first_name || undefined }],
      subject: `${code} is your Unify class-list code`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0a0a0a"><p>Hi ${me.first_name ? me.first_name.replace(/[<>&"]/g, "") : "there"},</p><p>Your code to confirm your place on your class list is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for 15 minutes. If you didn't ask for this, ignore this email.</p><p>Unify Learn</p></div>`,
    });
    if (!sent) {
      await sb.from("class_claim_codes").delete().eq("student_id", me.id);
      return fail(res, 502, "We couldn't send to that address right now. Claim with your matric number instead; you can verify later.");
    }
    res.json({ ok: true, email, matric: m[1] });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/class-list/verify-email/confirm", requireAuth, claimLimiter, async (req: Request, res: Response) => {
  const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/), fullName: z.string().trim().max(100).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter the 6-digit code from the email.");
  try {
    const me = await getMe(req);
    if (!me) return fail(res, 404, "Finish onboarding first.");
    const sb = supabaseAdmin();
    const { data } = await sb.from("class_claim_codes").select("email,matric,code_hash,attempts,expires_at").eq("student_id", me.id).maybeSingle();
    const row = data as { email: string; matric: string; code_hash: string; attempts: number; expires_at: string } | null;
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return fail(res, 410, "That code has expired. Send a new one.");
    if (row.attempts >= 5) return fail(res, 429, "Too many wrong codes. Send a new one.");
    if (hashCode(me.id, parsed.data.code) !== row.code_hash) {
      await sb.from("class_claim_codes").update({ attempts: row.attempts + 1 }).eq("student_id", me.id);
      return fail(res, 400, "That code isn't right. Check the latest email.");
    }
    await sb.from("class_claim_codes").delete().eq("student_id", me.id);
    const out = await myClaim(me, row.matric, parsed.data.fullName || "", "", true, row.email);
    res.json({ ...out, verified: true, matric: row.matric });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
