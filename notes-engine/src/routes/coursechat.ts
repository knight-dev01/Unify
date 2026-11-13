import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";
import { sendPushToUsers } from "../lib/push";

// Lecturer <-> contributor messages, one thread per course (migration 0048).
// Everyone who teaches the course (lecturers and contributors) and admins can
// read and post; students never see it.
//  - GET  /course-chat/threads       my courses' threads, last message, unread count
//  - GET  /course-chat?course=CODE   the thread (newest 100), marks it read
//  - POST /course-chat               { course, body } → bell + push to the others
const router = Router();
const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: (e as { message?: string })?.message || "Something went wrong" });
const clean = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const variants = (c: string) => [...new Set([c, c.replace(/\s/g, "")])];

const postLimit = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey, message: { error: "Slow down a little." } });

type Me = { id: string; role: string | null; is_admin: boolean | null };
async function me(req: Request): Promise<Me | null> {
  const { data } = await supabaseAdmin().from("profiles").select("id,role,is_admin").eq("id", uid(req)).maybeSingle();
  return (data as Me | null) ?? null;
}
const isAdmin = (m: Me | null) => !!m && (!!m.is_admin || m.role === "admin");

// The people on a course's thread: everyone teaching it.
async function teamOf(course: string): Promise<string[]> {
  const { data } = await supabaseAdmin().from("enrollments").select("user_id").in("course", variants(course)).eq("kind", "teaching");
  return [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id))];
}
async function myCourses(m: Me): Promise<string[]> {
  const { data } = await supabaseAdmin().from("enrollments").select("course").eq("user_id", m.id).eq("kind", "teaching");
  return [...new Set(((data ?? []) as { course: string }[]).map((r) => r.course))];
}

router.get("/course-chat/threads", requireAuth, async (req: Request, res: Response) => {
  try {
    const m = await me(req);
    if (!m) return fail(res, 404, "Finish onboarding first.");
    const courses = await myCourses(m);
    if (!courses.length) return res.json({ threads: [] });
    const sb = supabaseAdmin();
    const [{ data: msgs }, { data: reads }] = await Promise.all([
      sb.from("course_messages").select("course,author_id,body,created_at").in("course", courses.flatMap(variants)).order("created_at", { ascending: false }).limit(500),
      sb.from("course_message_reads").select("course,read_at").eq("user_id", m.id),
    ]);
    const readAt = new Map(((reads ?? []) as { course: string; read_at: string }[]).map((r) => [r.course, r.read_at]));
    const rows = (msgs ?? []) as { course: string; author_id: string | null; body: string; created_at: string }[];
    res.json({
      threads: courses.map((course) => {
        const mine = rows.filter((r) => variants(course).includes(r.course));
        const seen = readAt.get(course) || "";
        return {
          course,
          last: mine[0] ? { body: mine[0].body.slice(0, 120), at: mine[0].created_at, mine: mine[0].author_id === m.id } : null,
          unread: mine.filter((r) => r.author_id !== m.id && r.created_at > seen).length,
        };
      }).sort((a, b) => (b.last?.at || "").localeCompare(a.last?.at || "")),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.get("/course-chat", requireAuth, async (req: Request, res: Response) => {
  const course = clean(req.query.course);
  if (!course) return fail(res, 400, "Pass ?course=CODE.");
  try {
    const m = await me(req);
    const team = await teamOf(course);
    if (!m || !(isAdmin(m) || team.includes(m.id))) return fail(res, 403, "Only the people who teach this course see its messages.");
    const sb = supabaseAdmin();
    const { data } = await sb.from("course_messages").select("id,author_id,body,created_at").in("course", variants(course)).order("created_at", { ascending: false }).limit(100);
    const rows = ((data ?? []) as { id: string; author_id: string | null; body: string; created_at: string }[]).reverse();
    const ids = [...new Set([...team, ...rows.map((r) => r.author_id || "")].filter(Boolean))];
    const { data: people } = ids.length ? await sb.from("profiles").select("id,first_name,title,role,avatar_url").in("id", ids) : { data: [] };
    const who = new Map(((people ?? []) as { id: string; first_name: string | null; title: string | null; role: string | null; avatar_url: string | null }[]).map((p) => [p.id, p]));
    const name = (id: string | null) => { const p = id ? who.get(id) : null; return p ? [p.title, p.first_name].filter(Boolean).join(" ") || "Someone" : "Someone"; };
    await sb.from("course_message_reads").upsert({ user_id: m.id, course, read_at: new Date().toISOString() }, { onConflict: "user_id,course" });
    res.json({
      course,
      team: team.map((id) => ({ id, name: name(id), role: who.get(id)?.role || "", avatar: who.get(id)?.avatar_url || "" })),
      messages: rows.map((r) => ({ id: r.id, body: r.body, at: r.created_at, mine: r.author_id === m.id, author: name(r.author_id), role: (r.author_id && who.get(r.author_id)?.role) || "" })),
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.post("/course-chat", requireAuth, postLimit, async (req: Request, res: Response) => {
  const parsed = z.object({ course: z.string().min(1).max(20), body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Write a message (up to 2000 characters).");
  try {
    const m = await me(req);
    const course = clean(parsed.data.course);
    const team = await teamOf(course);
    if (!m || !(isAdmin(m) || team.includes(m.id))) return fail(res, 403, "Only the people who teach this course can message here.");
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("course_messages").insert({ course, author_id: m.id, body: parsed.data.body }).select("id,created_at").single();
    if (error) throw error;
    await sb.from("course_message_reads").upsert({ user_id: m.id, course, read_at: new Date().toISOString() }, { onConflict: "user_id,course" });
    const others = team.filter((x) => x !== m.id);
    if (others.length) {
      const { data: p } = await sb.from("profiles").select("first_name,title").eq("id", m.id).maybeSingle();
      const from = [(p as { title?: string } | null)?.title, (p as { first_name?: string } | null)?.first_name].filter(Boolean).join(" ") || "Someone";
      const title = `${course}: message from ${from}`;
      const body = parsed.data.body.slice(0, 140);
      const link = `/messages/${encodeURIComponent(course)}`;
      await sb.from("notifications").insert(others.map((user_id) => ({ user_id, type: "course_message", title, body, course, link })));
      void sendPushToUsers(others, { title, body, url: link }).catch(() => {});
    }
    res.json({ ok: true, id: (data as { id: string }).id, at: (data as { created_at: string }).created_at });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
