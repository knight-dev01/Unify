import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientKey } from "../middleware/limits";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthedRequest } from "../middleware/requireAuth";

// Course games (mounted at /v1): Keywords and Crossword.
//  - POST /games/score: keep each student's best run per game per week; the
//    first completion of a week's game earns XP (replays never farm XP);
//  - GET /games/leaderboard: top players for a week, or a whole course;
//  - GET /games/mine: key terms mastered, per week and in total.
// Leaderboards show first names and Box Boy pictures only, never emails or
// matric numbers, and only to students taking the course (plus its teachers).
const router = Router();
router.use("/games", rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false, keyGenerator: clientKey }));

const uid = (req: Request) => (req as AuthedRequest).userId as string;
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const dbFail = (res: Response, e: unknown) => res.status(500).json({ error: "Database error", message: e instanceof Error ? e.message : String(e) });
const XP = { keywords: 15, crossword: 20 } as const;
type Row = { user_id: string; game: string; course: string; week: number; score: number; terms: number; hints: number; seconds: number; plays: number };

async function access(req: Request, course: string): Promise<{ ok: boolean; admin: boolean }> {
  const sb = supabaseAdmin();
  const [{ data: p }, { data: e }] = await Promise.all([
    sb.from("profiles").select("is_admin,role").eq("id", uid(req)).maybeSingle(),
    sb.from("enrollments").select("kind").eq("user_id", uid(req)).eq("course", course),
  ]);
  const prof = p as { is_admin: boolean | null; role: string | null } | null;
  const admin = !!prof?.is_admin || prof?.role === "admin";
  return { ok: admin || ((e ?? []) as unknown[]).length > 0, admin };
}

const scoreSchema = z.object({
  game: z.enum(["keywords", "crossword"]),
  course: z.string().trim().min(2).max(20),
  week: z.number().int().min(1).max(30),
  score: z.number().int().min(0).max(5000),
  terms: z.number().int().min(0).max(60),
  hints: z.number().int().min(0).max(200),
  seconds: z.number().int().min(0).max(24 * 3600),
});

router.post("/games/score", requireAuth, async (req: Request, res: Response) => {
  const parsed = scoreSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "That score doesn't look right.");
  const d = parsed.data;
  try {
    const a = await access(req, d.course);
    if (!a.ok) return fail(res, 403, "Add this course to play its games.");
    const sb = supabaseAdmin();
    const { data: prev } = await sb.from("game_scores").select("*").eq("user_id", uid(req)).eq("game", d.game).eq("course", d.course).eq("week", d.week).maybeSingle();
    const old = prev as (Row & { id: string }) | null;
    const better = !old || d.score > old.score;
    const now = new Date().toISOString();
    if (old) {
      await sb.from("game_scores").update({ plays: (old.plays || 1) + 1, updated_at: now, ...(better ? { score: d.score, terms: d.terms, hints: d.hints, seconds: d.seconds } : {}) }).eq("id", old.id);
    } else {
      await sb.from("game_scores").insert({ user_id: uid(req), game: d.game, course: d.course, week: d.week, score: d.score, terms: d.terms, hints: d.hints, seconds: d.seconds });
    }
    // XP once per game per week, on the first completed run.
    let xp = 0;
    if (!old) {
      xp = XP[d.game];
      await sb.from("xp_events").insert({ user_id: uid(req), amount: xp, reason: `game:${d.game}:${d.course}:w${d.week}` });
    }
    res.json({ ok: true, best: better ? d.score : old!.score, newBest: better, xp });
  } catch (e) {
    dbFail(res, e);
  }
});

router.get("/games/leaderboard", requireAuth, async (req: Request, res: Response) => {
  const course = String(req.query.course || "").trim().slice(0, 20);
  const week = req.query.week ? Number(req.query.week) : null;
  const game = req.query.game === "keywords" || req.query.game === "crossword" ? req.query.game : null;
  if (!course) return fail(res, 400, "Which course?");
  try {
    const a = await access(req, course);
    if (!a.ok) return fail(res, 403, "Add this course to see its leaderboard.");
    const sb = supabaseAdmin();
    let q = sb.from("game_scores").select("user_id,game,course,week,score,terms,hints,seconds,plays").eq("course", course).limit(5000);
    if (week) q = q.eq("week", week);
    if (game) q = q.eq("game", game);
    const { data, error } = await q;
    if (error) throw error;
    // A week board ranks one game's best runs; a course board adds up every game and week.
    const totals = new Map<string, { score: number; terms: number }>();
    for (const r of (data ?? []) as Row[]) {
      const t = totals.get(r.user_id) || { score: 0, terms: 0 };
      t.score += r.score;
      t.terms += r.terms;
      totals.set(r.user_id, t);
    }
    const ranked = [...totals.entries()].sort((x, y) => y[1].score - x[1].score || y[1].terms - x[1].terms);
    const top = ranked.slice(0, 10);
    const ids = top.map(([id]) => id);
    const { data: people } = ids.length ? await sb.from("profiles").select("id,first_name,box_boy_persona,role").in("id", ids) : { data: [] };
    const who = new Map(((people ?? []) as { id: string; first_name: string | null; box_boy_persona: string | null; role: string | null }[]).map((p) => [p.id, p]));
    const meIdx = ranked.findIndex(([id]) => id === uid(req));
    res.json({
      players: ranked.length,
      top: top.map(([id, t], i) => ({ rank: i + 1, name: (who.get(id)?.first_name || "A student").split(" ")[0], persona: who.get(id)?.box_boy_persona || null, score: t.score, terms: t.terms, me: id === uid(req) })),
      me: meIdx >= 0 ? { rank: meIdx + 1, score: ranked[meIdx][1].score, terms: ranked[meIdx][1].terms } : null,
    });
  } catch (e) {
    dbFail(res, e);
  }
});

router.get("/games/mine", requireAuth, async (req: Request, res: Response) => {
  const course = String(req.query.course || "").trim().slice(0, 20);
  try {
    let q = supabaseAdmin().from("game_scores").select("game,course,week,score,terms,hints,plays").eq("user_id", uid(req)).limit(1000);
    if (course) q = q.eq("course", course);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    // Key terms mastered: per week the most terms solved in either game.
    const perWeek = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.course}|${r.week}`;
      perWeek.set(k, Math.max(perWeek.get(k) || 0, r.terms));
    }
    res.json({ termsMastered: [...perWeek.values()].reduce((s, n) => s + n, 0), weeks: rows.map((r) => ({ game: r.game, course: r.course, week: r.week, best: r.score, terms: r.terms, plays: r.plays })) });
  } catch (e) {
    dbFail(res, e);
  }
});

export default router;
