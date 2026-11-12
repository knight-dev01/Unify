import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendPushToUsers } from "../lib/push";
import { DEFAULT_INSTITUTION, ENTRY_COLS, type EntryRow, type ListRow, LIST_COLS } from "../lib/classlist";

// Scoped roles and what they unlock (mounted at /v1):
//  - level_admin: answers class rep requests for one department + level;
//  - hod / dean: attendance reports for their department / faculty, counts only;
//  - Unify admins grant these by email, and can do everything a scoped role can.
const router = Router();
router.use(["/roles", "/hoc/requests", "/reports", "/admin/role-grants", "/admin/overview"], rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey }));

type Grant = { id: string; user_id: string; role: "level_admin" | "hod" | "dean"; institution: string; faculty: string; department: string; level: string; created_at: string };
type Me = { id: string; first_name: string | null; role: string | null; is_admin: boolean | null; is_hoc: boolean | null; department: string | null; level: string | null; faculty: string | null };

const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });

async function whoami(req: Request): Promise<{ me: Me | null; admin: boolean; grants: Grant[] }> {
  const sb = supabaseAdmin();
  const [{ data: me }, { data: grants }] = await Promise.all([
    sb.from("profiles").select("id,first_name,role,is_admin,is_hoc,department,level,faculty").eq("id", uid(req)).maybeSingle(),
    sb.from("role_grants").select("*").eq("user_id", uid(req)),
  ]);
  const m = me as Me | null;
  let admin = !!m?.is_admin || m?.role === "admin";
  if (!admin) {
    const emails = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (emails.length) {
      const { data: e } = await sb.from("profiles").select("email").eq("id", uid(req)).maybeSingle();
      const email = ((e as { email?: string } | null)?.email || "").toLowerCase();
      if (email && emails.includes(email)) admin = true;
    }
  }
  return { me: m, admin, grants: (grants ?? []) as Grant[] };
}

const covers = (g: Grant, department: string, level: string) => g.role === "level_admin" && g.department === department && g.level === level;

async function notify(userIds: string[], title: string, body: string, link: string) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    await supabaseAdmin().from("notifications").insert(ids.map((user_id) => ({ user_id, type: "role_update", title, body, link })));
    await sendPushToUsers(ids, { title, body, url: link });
  } catch {
    // never fail the request over a notification
  }
}

// ---------- What I can do ----------
router.get("/roles/mine", requireAuth, async (req: Request, res: Response) => {
  try {
    const { admin, grants } = await whoami(req);
    res.json({
      admin,
      grants: grants.map((g) => ({ id: g.id, role: g.role, faculty: g.faculty, department: g.department, level: g.level })),
      canApproveHocs: admin || grants.some((g) => g.role === "level_admin"),
      canSeeReports: admin || grants.some((g) => g.role === "hod" || g.role === "dean"),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Admin: grant and remove scoped roles ----------
const grantSchema = z.object({
  email: z.string().email(),
  role: z.enum(["level_admin", "hod", "dean"]),
  faculty: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
  level: z.string().trim().max(40).optional(),
});

router.get("/admin/role-grants", requireAuth, async (req: Request, res: Response) => {
  try {
    const { admin } = await whoami(req);
    if (!admin) return fail(res, 403, "Admins only.");
    const sb = supabaseAdmin();
    const { data } = await sb.from("role_grants").select("*").order("created_at", { ascending: false }).limit(500);
    const rows = (data ?? []) as Grant[];
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const people: Record<string, { name: string; email: string }> = {};
    if (ids.length) {
      const { data: ps } = await sb.from("profiles").select("id,first_name,email").in("id", ids);
      for (const p of (ps ?? []) as { id: string; first_name: string | null; email: string | null }[]) people[p.id] = { name: p.first_name || "", email: p.email || "" };
    }
    res.json({ grants: rows.map((g) => ({ id: g.id, role: g.role, faculty: g.faculty, department: g.department, level: g.level, name: people[g.user_id]?.name || "", email: people[g.user_id]?.email || "" })) });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/admin/role-grants", requireAuth, async (req: Request, res: Response) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Enter an email and pick a role.");
  const d = parsed.data;
  if (d.role === "level_admin" && (!d.department || !d.level)) return fail(res, 400, "A level admin needs a department and a level.");
  if (d.role === "hod" && !d.department) return fail(res, 400, "A head of department needs a department.");
  if (d.role === "dean" && !d.faculty) return fail(res, 400, "A dean needs a faculty.");
  try {
    const { me, admin } = await whoami(req);
    if (!admin || !me) return fail(res, 403, "Admins only.");
    const sb = supabaseAdmin();
    const { data: t } = await sb.from("profiles").select("id,first_name").ilike("email", d.email.trim().toLowerCase()).maybeSingle();
    const target = t as { id: string; first_name: string | null } | null;
    if (!target) return fail(res, 404, "No account with that email. They need to sign up first.");
    const row = {
      user_id: target.id,
      role: d.role,
      institution: DEFAULT_INSTITUTION,
      faculty: d.role === "dean" ? d.faculty || "" : "",
      department: d.role === "dean" ? "" : d.department || "",
      level: d.role === "level_admin" ? d.level || "" : "",
      granted_by: me.id,
    };
    const { error } = await sb.from("role_grants").insert(row);
    if (error && (error as { code?: string }).code !== "23505") throw error;
    const what = d.role === "level_admin" ? `level admin for ${row.department} ${row.level}` : d.role === "hod" ? `head of department for ${row.department}` : `dean for ${row.faculty}`;
    await notify([target.id], "New role on Unify", `You're now ${what}.`, d.role === "level_admin" ? "/hoc/requests" : "/reports");
    res.json({ ok: true, name: target.first_name || "" });
  } catch (e) {
    dbFail(res, e);
  }
});

router.delete("/admin/role-grants/:id", requireAuth, async (req: Request, res: Response) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, "Not found.");
  try {
    const { admin } = await whoami(req);
    if (!admin) return fail(res, 403, "Admins only.");
    await supabaseAdmin().from("role_grants").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Class rep requests: the level admin's queue ----------
router.get("/hoc/requests", requireAuth, async (req: Request, res: Response) => {
  try {
    const { admin, grants } = await whoami(req);
    const scopes = grants.filter((g) => g.role === "level_admin");
    if (!admin && !scopes.length) return fail(res, 403, "Only level admins answer class rep requests.");
    const sb = supabaseAdmin();
    const { data } = await sb.from("hoc_requests").select("*").order("created_at", { ascending: false }).limit(300);
    const rows = ((data ?? []) as { id: string; user_id: string; department: string; level: string; note: string; status: string; created_at: string; decided_at: string | null }[])
      .filter((r) => admin || scopes.some((g) => covers(g, r.department, r.level)));
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const people: Record<string, { name: string; email: string }> = {};
    if (ids.length) {
      const { data: ps } = await sb.from("profiles").select("id,first_name,email").in("id", ids);
      for (const p of (ps ?? []) as { id: string; first_name: string | null; email: string | null }[]) people[p.id] = { name: p.first_name || "Student", email: p.email || "" };
    }
    // How many reps each class already has (max 3).
    const classes = [...new Set(rows.map((r) => `${r.department}\u0000${r.level}`))];
    const reps: Record<string, number> = {};
    for (const c of classes) {
      const [department, level] = c.split("\u0000");
      const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).eq("is_hoc", true).eq("department", department).eq("level", level);
      reps[c] = count ?? 0;
    }
    res.json({
      requests: rows.slice(0, 100).map((r) => ({
        id: r.id,
        name: people[r.user_id]?.name || "Student",
        email: people[r.user_id]?.email || "",
        department: r.department,
        level: r.level,
        note: r.note,
        status: r.status,
        at: r.created_at,
        repsInClass: reps[`${r.department}\u0000${r.level}`] ?? 0,
      })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/hoc/requests/:id", requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).safeParse(req.body);
  if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 400, "Approve or decline.");
  try {
    const { me, admin, grants } = await whoami(req);
    const sb = supabaseAdmin();
    const { data } = await sb.from("hoc_requests").select("*").eq("id", req.params.id).maybeSingle();
    const r = data as { id: string; user_id: string; department: string; level: string; status: string } | null;
    if (!r) return fail(res, 404, "That request is gone.");
    if (!me || !(admin || grants.some((g) => covers(g, r.department, r.level)))) return fail(res, 403, "Only this class's level admin can answer it.");
    if (r.status !== "pending") return fail(res, 409, "That request was already answered.");
    const { data: t } = await sb.from("profiles").select("id,department,level,role,is_hoc").eq("id", r.user_id).maybeSingle();
    const target = t as { id: string; department: string | null; level: string | null; role: string | null; is_hoc: boolean | null } | null;
    if (!target) return fail(res, 404, "That student's account is gone.");
    if (parsed.data.approve) {
      if (target.role !== "student") return fail(res, 400, "Only students can be class reps.");
      if (target.department !== r.department || target.level !== r.level) return fail(res, 409, "They've changed class since asking. Ask them to request again.");
      const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).eq("is_hoc", true).eq("department", r.department).eq("level", r.level).neq("id", target.id);
      if ((count ?? 0) >= 3) return fail(res, 409, `${r.department} ${r.level} already has 3 class reps.`);
      const { error } = await sb.from("profiles").update({ is_hoc: true, hoc_approved_at: new Date().toISOString(), hoc_approved_by: me.id }).eq("id", target.id);
      if (error) throw error;
    }
    await sb.from("hoc_requests").update({ status: parsed.data.approve ? "approved" : "rejected", decided_by: me.id, decided_at: new Date().toISOString() }).eq("id", r.id);
    await notify(
      [target.id],
      parsed.data.approve ? "You're your class's rep" : "Class rep request not approved",
      parsed.data.approve
        ? "Start with your class list: tap to set up your class in four quick steps."
        : `Your request to be class rep wasn't approved.${parsed.data.note ? ` "${parsed.data.note}"` : ""}`,
      parsed.data.approve ? "/hoc/welcome" : "/me"
    );
    res.json({ ok: true });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Reports for heads of department and the Dean: counts only ----------
router.get("/reports/attendance", requireAuth, async (req: Request, res: Response) => {
  try {
    const { admin, grants } = await whoami(req);
    const hod = grants.filter((g) => g.role === "hod").map((g) => g.department);
    const dean = grants.filter((g) => g.role === "dean").map((g) => g.faculty);
    if (!admin && !hod.length && !dean.length) return fail(res, 403, "Reports are for heads of department, the Dean and admins.");
    const sb = supabaseAdmin();
    let departments: string[] | null = null; // null = everything (admins)
    if (!admin) {
      const set = new Set(hod);
      if (dean.length) {
        const { data } = await sb.from("profiles").select("department").in("faculty", dean).not("department", "is", null).limit(5000);
        // Courses carry no faculty: a faculty's departments are the ones its students are in.
        for (const p of (data ?? []) as { department: string }[]) set.add(p.department);
      }
      departments = [...set];
    }
    let q = sb.from("class_lists").select(LIST_COLS).order("department").order("level");
    if (departments) q = q.in("department", departments.length ? departments : ["\u0000"]);
    const { data: listRows } = await q;
    const lists = (listRows ?? []) as ListRow[];

    const heldCache = new Map<string, number>();
    const held = async (course: string) => {
      const k = course.replace(/\s/g, "").toUpperCase();
      if (heldCache.has(k)) return heldCache.get(k)!;
      const { count } = await sb.from("attendance_sessions").select("id", { count: "exact", head: true }).in("course_code", [...new Set([course, course.replace(/\s/g, "")])]);
      heldCache.set(k, count ?? 0);
      return count ?? 0;
    };

    const out = [];
    for (const l of lists) {
      const entries: EntryRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await sb.from("class_list_entries").select(ENTRY_COLS).eq("list_id", l.id).is("removed_at", null).range(from, from + 999);
        const rows = (data ?? []) as EntryRow[];
        entries.push(...rows);
        if (rows.length < 1000) break;
      }
      const ids = entries.map((e) => e.id);
      const marks = new Map<string, number>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await sb.from("attendance_records").select("course_code").in("entry_id", ids.slice(i, i + 300)).limit(50000);
        for (const r of (data ?? []) as { course_code: string }[]) marks.set(r.course_code, (marks.get(r.course_code) || 0) + 1);
      }
      const courses = [];
      for (const [course, present] of [...marks].sort((a, b) => a[0].localeCompare(b[0]))) {
        const h = await held(course);
        courses.push({ course, held: h, marks: present, rate: h && entries.length ? Math.round((present / (h * entries.length)) * 100) : null });
      }
      out.push({ department: l.department, level: l.level, students: entries.length, onUnify: entries.filter((e) => e.student_id).length, courses });
    }
    res.json({ scope: admin ? "all" : [...hod.map((d) => `Department: ${d}`), ...dean.map((f) => `Faculty: ${f}`)].join(" · "), classes: out });
  } catch (e) {
    dbFail(res, e);
  }
});

// ---------- Admin overview: every module at a glance, plus what's new ----------
// One call for the admin Overview so nothing new is missed: counts that need
// attention (with where to act), this week's activity, setup gaps, and the
// latest release notes from CHANGELOG.md.
function releaseNotes(): { version: string; date: string; body: string }[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const candidates = [
    path.join(process.cwd(), "CHANGELOG.md"),
    path.join(process.cwd(), "..", "CHANGELOG.md"),
    path.join(__dirname, "..", "..", "..", "CHANGELOG.md"),
    path.join(__dirname, "..", "..", "..", "..", "CHANGELOG.md"),
  ];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const parts = text.split(/^## \[/m).slice(1, 6);
      return parts.map((part) => {
        const head = /^([^\]]+)\]\s*-?\s*([0-9-]*)/.exec(part);
        return { version: head?.[1] || "", date: head?.[2] || "", body: part.slice(part.indexOf("\n") + 1).trim().slice(0, 6000) };
      });
    } catch {
      // try the next place
    }
  }
  return [];
}

router.get("/admin/overview", requireAuth, async (req: Request, res: Response) => {
  try {
    const { me, admin } = await whoami(req);
    if (!admin || !me) return fail(res, 403, "Admins only.");
    const sb = supabaseAdmin();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const count = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;
    const head = { count: "exact" as const, head: true };
    const [
      hocPending, reportsOpen, claimsOpen, lists, entries, claimed, sessionsWeek, marksWeek,
      flags, changesWeek, postsWeek, levelAdmins, hods, deans, hocs, calendar,
      wiresLive, wiresWeek, gamePlays, guideRow, wiresList, gameRows,
    ] = await Promise.all([
      count(sb.from("hoc_requests").select("id", head).eq("status", "pending")),
      count(sb.from("content_reports").select("id", head).eq("status", "open")),
      count(sb.from("class_list_claims").select("id", head).eq("status", "open")),
      count(sb.from("class_lists").select("id", head)),
      count(sb.from("class_list_entries").select("id", head).is("removed_at", null)),
      count(sb.from("class_list_entries").select("id", head).is("removed_at", null).not("student_id", "is", null)),
      count(sb.from("attendance_sessions").select("id", head).gt("opens_at", weekAgo)),
      count(sb.from("attendance_records").select("id", head).gt("scanned_at", weekAgo)),
      count(sb.from("notifications").select("id", head).eq("user_id", me.id).eq("type", "attendance_flag").eq("read", false).gt("created_at", monthAgo)),
      count(sb.from("slot_changes").select("id", head).gt("created_at", weekAgo)),
      count(sb.from("course_posts").select("id", head).gt("created_at", weekAgo)),
      count(sb.from("role_grants").select("id", head).eq("role", "level_admin")),
      count(sb.from("role_grants").select("id", head).eq("role", "hod")),
      count(sb.from("role_grants").select("id", head).eq("role", "dean")),
      count(sb.from("profiles").select("id", head).eq("is_hoc", true)),
      sb.from("app_settings").select("key,value").in("key", ["semester_start", "semester_weeks", "current_semester"]),
      count(sb.from("live_wires").select("id", head).is("cancelled_at", null).gt("ends_at", new Date().toISOString())),
      count(sb.from("live_wires").select("id", head).gt("created_at", weekAgo)),
      count(sb.from("game_scores").select("id", head).gt("updated_at", weekAgo)),
      sb.from("school_guides").select("updated_at,published").eq("institution", "LASU").maybeSingle(),
      sb.from("live_wires").select("id,message,author_name,author_role,scope,course,department,level,ends_at").is("cancelled_at", null).gt("ends_at", new Date().toISOString()).order("ends_at", { ascending: true }).limit(20),
      sb.from("game_scores").select("user_id").gt("updated_at", weekAgo).limit(5000),
    ]);
    const cal: Record<string, string> = {};
    for (const r of ((calendar as { data: unknown }).data ?? []) as { key: string; value: string }[]) cal[r.key] = r.value;
    res.json({
      attention: [
        { key: "hoc", label: "Class rep requests waiting", n: hocPending, to: "/hoc/requests" },
        { key: "reports", label: "Student reports on notes, open", n: reportsOpen, to: "/content-reports" },
        { key: "claims", label: "Class-list requests waiting on class reps", n: claimsOpen, to: "" },
        { key: "flags", label: "Attendance marks questioned, unread", n: flags, to: "/notifications" },
      ],
      modules: [
        { key: "classlists", label: "Class lists", lines: [`${lists} class${lists === 1 ? "" : "es"} uploaded`, `${entries} students listed, ${claimed} on Unify`] },
        { key: "attendance", label: "Attendance (last 7 days)", lines: [`${sessionsWeek} register${sessionsWeek === 1 ? "" : "s"} taken`, `${marksWeek} students marked`], to: "/reports" },
        { key: "timetable", label: "Timetable (last 7 days)", lines: [`${changesWeek} class${changesWeek === 1 ? "" : "es"} cancelled, moved or unconfirmed`] },
        { key: "lecturers", label: "Lecturer posts (last 7 days)", lines: [`${postsWeek} post${postsWeek === 1 ? "" : "s"} to students`] },
        { key: "livewire", label: "Live wire", lines: [`${wiresLive} running now`, `${wiresWeek} sent in the last 7 days`] },
        { key: "games", label: "Games (last 7 days)", lines: [`${gamePlays} week games finished`, `${new Set(((gameRows as { data: unknown }).data as { user_id: string }[] | null ?? []).map((r) => r.user_id)).size} students playing`] },
        { key: "guide", label: "Student guide", lines: [(guideRow as { data: { updated_at?: string; published?: boolean } | null }).data?.updated_at ? `Updated ${new Date((guideRow as { data: { updated_at: string } }).data.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${(guideRow as { data: { published?: boolean } }).data.published === false ? " · draft" : ""}` : "Not set up"], to: "module:guide" },
        { key: "roles", label: "Roles", lines: [`${hocs} class reps`, `${levelAdmins} level admins · ${hods} HODs · ${deans} deans`], to: "/admin-roles" },
      ],
      setup: [
        !cal.semester_start ? { label: "Set the semester calendar (Week 1 start) so Home shows the week and attendance files by week", to: "module:session" } : null,
        levelAdmins === 0 ? { label: "No level admins yet: class rep requests come only to Unify admins", to: "/admin-roles" } : null,
        lists === 0 ? { label: "No class lists uploaded yet: registers can't show who's absent", to: "" } : null,
      ].filter(Boolean),
      calendar: { start: cal.semester_start || null, weeks: Number(cal.semester_weeks) || 12, semester: cal.current_semester || "" },
      liveWires: (((wiresList as { data: unknown }).data ?? []) as { id: string; message: string; author_name: string; author_role: string; scope: string; course: string; department: string; level: string; ends_at: string }[]).map((w) => ({ id: w.id, message: w.message, by: `${w.author_role}${w.author_name ? ` ${w.author_name}` : ""}`, to: w.scope === "course" ? w.course : w.scope === "class" ? `${w.level} ${w.department}` : w.scope === "all" ? "Everyone" : w.department || w.scope, endsAt: w.ends_at })),
      releaseNotes: releaseNotes(),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
