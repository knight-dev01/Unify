import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";

// Faculties and departments (migration 0045), managed in Admin › Faculties &
// departments. Every picker in the app reads GET /school/structure.
//  - Renaming a faculty or department carries the new name to every table
//    that stores it (profiles, class lists, class board posts, class rep
//    requests, live wires, role grants), so no class is split by a rename.
//  - Retiring a department hides it from pickers; people already in it keep it.
//  - Moving a department to another faculty updates its people's faculty.
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: (e as { message?: string })?.message || "Something went wrong" });

type Faculty = { id: string; name: string; university: string; status: "open" | "soon" | "later"; sort: number };
type Department = { id: string; faculty_id: string; name: string; code: string; active: boolean; sort: number };

let cache: { at: number; all: boolean; data: unknown } | null = null;
const forget = () => { cache = null; };

async function structure(all: boolean) {
  if (cache && cache.all === all && Date.now() - cache.at < 60_000) return cache.data;
  const sb = supabaseAdmin();
  const [{ data: fac, error: fErr }, { data: dep, error: dErr }] = await Promise.all([
    sb.from("faculties").select("id,name,university,status,sort").order("sort").order("name"),
    sb.from("departments").select("id,faculty_id,name,code,active,sort").order("sort").order("name"),
  ]);
  if (fErr) throw fErr;
  if (dErr) throw dErr;
  const deps = ((dep ?? []) as Department[]).filter((d) => all || d.active);
  const data = {
    faculties: ((fac ?? []) as Faculty[]).map((f) => ({
      id: f.id, name: f.name, university: f.university, status: f.status, sort: f.sort,
      departments: deps.filter((d) => d.faculty_id === f.id).map((d) => ({ id: d.id, name: d.name, code: d.code, active: d.active, sort: d.sort })),
    })),
  };
  cache = { at: Date.now(), all, data };
  return data;
}

async function isAdmin(id: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("profiles").select("is_admin,role,email").eq("id", id).maybeSingle();
  const p = data as { is_admin?: boolean; role?: string; email?: string } | null;
  if (p?.is_admin || p?.role === "admin") return true;
  const emails = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !!p?.email && emails.includes(p.email.toLowerCase());
}

// Public: pickers need it during onboarding too.
router.get("/school/structure", async (_req: Request, res: Response) => {
  try {
    res.json(await structure(false));
  } catch (e) {
    dbFail(res, e);
  }
});

router.get("/admin/structure", requireAuth, async (req: Request, res: Response) => {
  if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
  try {
    // Headcounts so the admin sees what a rename or retire touches.
    const [data, { data: people }] = await Promise.all([
      structure(true),
      supabaseAdmin().from("profiles").select("department").not("department", "is", null).limit(20000),
    ]);
    const count: Record<string, number> = {};
    for (const p of (people ?? []) as { department: string }[]) count[p.department] = (count[p.department] || 0) + 1;
    res.json({ ...(data as object), people: count });
  } catch (e) {
    dbFail(res, e);
  }
});

// Carry a renamed department / faculty to every table that stores the name.
async function renameDepartment(from: string, to: string) {
  const sb = supabaseAdmin();
  const tables = ["profiles", "class_lists", "hoc_posts", "hoc_requests", "live_wires", "role_grants"];
  const out = await Promise.all(tables.map((t) => sb.from(t).update({ department: to }).eq("department", from)));
  const err = out.find((r) => r.error)?.error;
  if (err) throw err;
}
async function renameFaculty(from: string, to: string) {
  const sb = supabaseAdmin();
  const out = await Promise.all(["profiles", "live_wires", "role_grants"].map((t) => sb.from(t).update({ faculty: to }).eq("faculty", from)));
  const err = out.find((r) => r.error)?.error;
  if (err) throw err;
}

const name = z.string().trim().min(3).max(120);
const facultySchema = z.object({ name, status: z.enum(["open", "soon", "later"]).default("open"), sort: z.number().int().min(0).max(999).optional() });
const departmentSchema = z.object({ facultyId: z.string().uuid(), name, code: z.string().trim().max(10).default(""), sort: z.number().int().min(0).max(999).optional() });

router.post("/admin/faculties", requireAuth, async (req: Request, res: Response) => {
  if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
  const parsed = facultySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Give the faculty a name (at least 3 letters).");
  try {
    const { error } = await supabaseAdmin().from("faculties").insert({ name: parsed.data.name, status: parsed.data.status, sort: parsed.data.sort ?? 50 });
    if (error) return String((error as { code?: string }).code) === "23505" ? fail(res, 409, "A faculty with that name already exists.") : dbFail(res, error);
    forget();
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

router.patch("/admin/faculties/:id", requireAuth, async (req: Request, res: Response) => {
  if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
  const parsed = facultySchema.partial().safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Check the faculty's details.");
  try {
    const sb = supabaseAdmin();
    const { data: cur } = await sb.from("faculties").select("name").eq("id", req.params.id).maybeSingle();
    if (!cur) return fail(res, 404, "That faculty is gone.");
    const { error } = await sb.from("faculties").update(parsed.data).eq("id", req.params.id);
    if (error) return String((error as { code?: string }).code) === "23505" ? fail(res, 409, "A faculty with that name already exists.") : dbFail(res, error);
    const old = (cur as { name: string }).name;
    if (parsed.data.name && parsed.data.name !== old) await renameFaculty(old, parsed.data.name);
    forget();
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/admin/departments", requireAuth, async (req: Request, res: Response) => {
  if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
  const parsed = departmentSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Pick a faculty and give the department a name (at least 3 letters).");
  try {
    const { error } = await supabaseAdmin().from("departments").insert({ faculty_id: parsed.data.facultyId, name: parsed.data.name, code: parsed.data.code.toUpperCase(), sort: parsed.data.sort ?? 50 });
    if (error) return String((error as { code?: string }).code) === "23505" ? fail(res, 409, "A department with that name already exists.") : dbFail(res, error);
    forget();
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

router.patch("/admin/departments/:id", requireAuth, async (req: Request, res: Response) => {
  if (!(await isAdmin(uid(req)))) return fail(res, 403, "Admins only.");
  const parsed = departmentSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Check the department's details.");
  try {
    const sb = supabaseAdmin();
    const { data: cur } = await sb.from("departments").select("name,faculty_id").eq("id", req.params.id).maybeSingle();
    if (!cur) return fail(res, 404, "That department is gone.");
    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.code !== undefined) patch.code = d.code.toUpperCase();
    if (d.active !== undefined) patch.active = d.active;
    if (d.sort !== undefined) patch.sort = d.sort;
    if (d.facultyId !== undefined) patch.faculty_id = d.facultyId;
    const { error } = await sb.from("departments").update(patch).eq("id", req.params.id);
    if (error) return String((error as { code?: string }).code) === "23505" ? fail(res, 409, "A department with that name already exists.") : dbFail(res, error);
    const was = cur as { name: string; faculty_id: string };
    if (d.name && d.name !== was.name) await renameDepartment(was.name, d.name);
    // Moved to another faculty: its people's faculty follows.
    if (d.facultyId && d.facultyId !== was.faculty_id) {
      const { data: f } = await sb.from("faculties").select("name").eq("id", d.facultyId).maybeSingle();
      if (f) await sb.from("profiles").update({ faculty: (f as { name: string }).name }).eq("department", d.name || was.name);
    }
    forget();
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
