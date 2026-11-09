import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "./supabase";

// Live performance metrics, kept in memory in one-minute buckets for the last
// 3 hours (a restart clears them: this is a live view, not an archive).
//
// - Every API request is recorded against a MODULE (Attendance, Studio, ...),
//   with status class and latency, so the admin panel can show requests, errors
//   and p50/p95/max per module for any minute.
// - Real users' browsers report Core Web Vitals (LCP, TTFB, ...) per page.
// - The server samples itself: memory, event-loop lag and a database round trip.

const KEEP_MIN = 180;
const SAMPLE_CAP = 120; // latency samples kept per module per minute

type Cell = { n: number; e4: number; e5: number; sum: number; max: number; ms: number[] };
const buckets = new Map<number, Map<string, Cell>>();
const minuteOf = (t = Date.now()) => Math.floor(t / 60000);

const MODULES: [RegExp, string][] = [
  [/^\/v1\/attendance/, "Attendance"],
  [/^\/v1\/hoc/, "Class board"],
  [/^\/v1\/materials/, "Materials"],
  [/^\/v1\/cgpa/, "CGPA"],
  [/^\/v1\/(admin|role-requests|support)/, "Admin"],
  [/^\/v1\/(notifications|push)/, "Notifications"],
  [/^\/v1\/(courses|enrollments|universities|teaching|settings)/, "Courses"],
  [/^\/v1\/timetable/, "Timetable"],
  [/^\/v1\/(progress|quiz|resume|topics|notes|stats)/, "Learning"],
  [/^\/v1\/(publish|author|authored|contributions)|^\/api\/(convert|save|upload|notes)/, "Studio"],
  [/^\/v1\/(me|onboarding|avatar|persona)/, "Profile"],
  [/^\/v1\/(share)|^\/s\//, "Sharing"],
  [/^\/v1\/errors/, "Client errors"],
  [/^\/v1\/metrics/, "Telemetry"],
];

export function moduleOf(path: string): string {
  for (const [rx, name] of MODULES) if (rx.test(path)) return name;
  return "Other";
}

function record(mod: string, status: number, ms: number, now = Date.now()): void {
  const m = minuteOf(now);
  let b = buckets.get(m);
  if (!b) {
    b = new Map();
    buckets.set(m, b);
    for (const k of buckets.keys()) if (k < m - KEEP_MIN) buckets.delete(k);
  }
  let c = b.get(mod);
  if (!c) {
    c = { n: 0, e4: 0, e5: 0, sum: 0, max: 0, ms: [] };
    b.set(mod, c);
  }
  c.n += 1;
  if (status >= 500) c.e5 += 1;
  else if (status >= 400 && status !== 401 && status !== 404) c.e4 += 1; // expired sessions and misses are not "errors"
  c.sum += ms;
  if (ms > c.max) c.max = ms;
  if (c.ms.length < SAMPLE_CAP) c.ms.push(ms);
  else c.ms[Math.floor(Math.random() * SAMPLE_CAP)] = ms;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/healthz" || req.path === "/v1/ping" || req.method === "OPTIONS") return next();
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    record(moduleOf(req.originalUrl.split("?")[0] || req.path), res.statusCode, ms);
  });
  next();
}

const pct = (sorted: number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export type Point = { t: number; n: number; e4: number; e5: number; p50: number; p95: number; max: number };

function summarize(cells: Cell[]): Omit<Point, "t"> {
  const ms = cells.flatMap((c) => c.ms).sort((a, b) => a - b);
  return {
    n: cells.reduce((s, c) => s + c.n, 0),
    e4: cells.reduce((s, c) => s + c.e4, 0),
    e5: cells.reduce((s, c) => s + c.e5, 0),
    p50: Math.round(pct(ms, 50)),
    p95: Math.round(pct(ms, 95)),
    max: Math.round(cells.reduce((m, c) => Math.max(m, c.max), 0)),
  };
}

/** Last `minutes` minutes (current one included), oldest first, per module and in total. */
export function snapshot(minutes: number) {
  const now = minuteOf();
  const from = now - Math.max(1, Math.min(KEEP_MIN, minutes)) + 1;
  const names = new Set<string>();
  for (let m = from; m <= now; m++) for (const k of buckets.get(m)?.keys() ?? []) names.add(k);
  const series = (pick: (b: Map<string, Cell>) => Cell[]): Point[] => {
    const out: Point[] = [];
    for (let m = from; m <= now; m++) out.push({ t: m * 60000, ...summarize(pick(buckets.get(m) ?? new Map())) });
    return out;
  };
  const total = series((b) => [...b.values()]);
  const modules = [...names].map((name) => {
    const per = series((b) => (b.get(name) ? [b.get(name) as Cell] : []));
    const all = summarize([...Array(now - from + 1).keys()].flatMap((i) => (buckets.get(from + i)?.get(name) ? [buckets.get(from + i)?.get(name) as Cell] : [])));
    return { name, ...all, rpm: Math.round((all.n / Math.max(1, minutes)) * 10) / 10, errRate: all.n ? Math.round((all.e5 / all.n) * 1000) / 10 : 0, series: per };
  });
  modules.sort((a, b) => b.n - a.n);
  const sum = summarize([...Array(now - from + 1).keys()].flatMap((i) => [...(buckets.get(from + i)?.values() ?? [])]));
  return { minutes, from: from * 60000, to: now * 60000, total, totals: { ...sum, rpm: Math.round((sum.n / Math.max(1, minutes)) * 10) / 10, errRate: sum.n ? Math.round((sum.e5 / sum.n) * 1000) / 10 : 0 }, modules };
}

/** Counts for a window that ended before the current (incomplete) minute. */
export function recentCompleted(minutes: number) {
  const end = minuteOf() - 1;
  const from = end - minutes + 1;
  const cells: Cell[] = [];
  const perModule = new Map<string, Cell[]>();
  for (let m = from; m <= end; m++)
    for (const [name, c] of buckets.get(m) ?? []) {
      cells.push(c);
      perModule.set(name, [...(perModule.get(name) ?? []), c]);
    }
  return { all: summarize(cells), perModule: [...perModule].map(([name, cs]) => ({ name, ...summarize(cs) })) };
}

// ---------- real-user vitals (reported by the browsers) ----------
type Vital = { t: number; v: number };
const vitals = new Map<string, Vital[]>(); // "page|metric"
const VITAL_METRICS = new Set(["lcp", "fcp", "ttfb", "cls", "inp"]);

export function recordVital(page: string, metric: string, value: number): boolean {
  if (!VITAL_METRICS.has(metric) || !Number.isFinite(value) || value < 0 || value > 600000) return false;
  const key = `${page.slice(0, 60)}|${metric}`;
  const list = vitals.get(key) ?? [];
  list.push({ t: Date.now(), v: value });
  if (list.length > 300) list.shift();
  vitals.set(key, list);
  if (vitals.size > 400) vitals.delete(vitals.keys().next().value as string);
  return true;
}

export function vitalsSnapshot(minutes: number) {
  const since = Date.now() - minutes * 60000;
  const out: { page: string; metric: string; n: number; p50: number; p75: number }[] = [];
  for (const [key, list] of vitals) {
    const v = list.filter((x) => x.t >= since).map((x) => x.v).sort((a, b) => a - b);
    if (!v.length) continue;
    const [page, metric] = key.split("|");
    out.push({ page, metric, n: v.length, p50: Math.round(pct(v, 50) * 100) / 100, p75: Math.round(pct(v, 75) * 100) / 100 });
  }
  return out.sort((a, b) => b.n - a.n);
}

// ---------- the server itself ----------
let lagMax = 0;
const lagLog: { t: number; ms: number }[] = [];
const dbLog: { t: number; ms: number; ok: boolean }[] = [];
let started = false;

export function startSampling(): void {
  if (started) return;
  started = true;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - 1000);
    last = now;
    lagMax = Math.max(lagMax, lag);
  }, 1000).unref();
  setInterval(() => {
    lagLog.push({ t: Date.now(), ms: lagMax });
    lagMax = 0;
    if (lagLog.length > 180) lagLog.shift();
  }, 60000).unref();
  const probe = async () => {
    const t0 = Date.now();
    let ok = true;
    try {
      const { error } = await supabaseAdmin().from("courses").select("code").limit(1);
      if (error) ok = false;
    } catch {
      ok = false;
    }
    dbLog.push({ t: Date.now(), ms: Date.now() - t0, ok });
    if (dbLog.length > 180) dbLog.shift();
  };
  void probe();
  setInterval(() => void probe(), 60000).unref();
}

export function systemSnapshot() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    lagMaxMs: lagLog.slice(-5).reduce((m, x) => Math.max(m, x.ms), lagMax),
    lag: lagLog.slice(-60),
    db: dbLog.slice(-60),
    node: process.version,
  };
}

export function lastDbProbes(n: number) {
  return dbLog.slice(-n);
}
