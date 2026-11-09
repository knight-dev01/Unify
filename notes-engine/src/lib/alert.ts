import { supabaseAdmin } from "./supabase";
import { sendSimpleEmail } from "./email";
import { recentCompleted, systemSnapshot, lastDbProbes } from "./metrics";

// When something is suddenly wrong, the admins hear about it by email.
//
// Triggers: crashes (uncaught errors), a spike of 5xx responses (overall or in
// one module), slow responses, an unreachable or slow database, high memory, a
// stalled event loop, and boot jobs that gave up. A watchdog checks the last
// five completed minutes every minute.
//
// Protection against flooding: the same problem emails at most once every 15
// minutes, and at most 12 alert emails go out per hour in total. Every alert is
// also kept in a short in-memory log shown in the admin panel, emailed or not.
// Without BREVO_API_KEY nothing can be sent: the log says so ("not emailed").

export type AlertRec = { at: string; signature: string; kind: string; message: string; emailed: boolean; note?: string };
const log: AlertRec[] = [];
const lastSent = new Map<string, number>();
let sentThisHour: number[] = [];
const COOLDOWN_MS = 15 * 60 * 1000;
const HOURLY_CAP = 12;

const FAKE_DOMAIN = /@(test\.unify|unify\.learn)$/i;
let recipientCache: { at: number; list: string[] } | null = null;

async function recipients(): Promise<string[]> {
  if (recipientCache && Date.now() - recipientCache.at < 5 * 60 * 1000) return recipientCache.list;
  const set = new Set<string>((process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  try {
    const { data } = await supabaseAdmin().from("profiles").select("email").or("is_admin.eq.true,role.eq.admin").limit(50);
    for (const r of (data ?? []) as { email: string | null }[]) if (r.email) set.add(r.email.toLowerCase());
  } catch {
    // ADMIN_EMAILS alone still works
  }
  const list = [...set].filter((e) => e.includes("@") && !FAKE_DOMAIN.test(e));
  recipientCache = { at: Date.now(), list };
  return list;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const appUrl = () => ((process.env.CORS_ORIGIN || "").split(",")[0].trim() || "https://unify-virid.vercel.app");

export function recentAlerts(): AlertRec[] {
  return [...log].reverse();
}

/** Raise an alert. `signature` groups repeats of the same problem. Never throws. */
export async function raise(signature: string, kind: string, message: string, detail?: string, opts: { force?: boolean } = {}): Promise<AlertRec> {
  const rec: AlertRec = { at: new Date().toISOString(), signature, kind, message, emailed: false };
  try {
    const now = Date.now();
    sentThisHour = sentThisHour.filter((t) => now - t < 3600000);
    const last = lastSent.get(signature) ?? 0;
    if (!opts.force && now - last < COOLDOWN_MS) {
      rec.note = "repeat within 15 minutes: not emailed again";
    } else if (!opts.force && sentThisHour.length >= HOURLY_CAP) {
      rec.note = "hourly email cap reached";
    } else {
      const to = await recipients();
      if (!to.length) rec.note = "no admin email on file (set ADMIN_EMAILS)";
      else if (!process.env.BREVO_API_KEY) rec.note = "BREVO_API_KEY is not set: email not sent";
      else {
        const html =
          `<div style="font-family:Arial,sans-serif;max-width:560px">` +
          `<h2 style="margin:0 0 8px">Unify alert: ${esc(kind)}</h2>` +
          `<p style="font-size:15px;line-height:1.5">${esc(message)}</p>` +
          (detail ? `<pre style="background:#f4f4f0;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:12px">${esc(detail.slice(0, 1500))}</pre>` : "") +
          `<p style="font-size:13px;color:#555">${new Date().toUTCString()}<br/>` +
          `See live performance: <a href="${appUrl()}/admin/performance">${appUrl()}/admin/performance</a></p></div>`;
        const sent = await sendSimpleEmail({ to: to.map((email) => ({ email })), subject: `[Unify ALERT] ${kind}`, html });
        rec.emailed = sent > 0;
        if (sent > 0) {
          lastSent.set(signature, now);
          sentThisHour.push(now);
        } else rec.note = "email provider did not accept it";
      }
    }
  } catch (e) {
    rec.note = `alerting failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  log.push(rec);
  if (log.length > 60) log.shift();
  console.error(`[alert] ${kind}: ${message}${rec.emailed ? " (emailed)" : rec.note ? ` (${rec.note})` : ""}`);
  return rec;
}

// ---------- watchdog ----------
let watching = false;

export function startWatchdog(): void {
  if (watching) return;
  watching = true;

  process.on("uncaughtException", (e) => {
    void raise("crash:" + String(e && e.message).slice(0, 80), "Server crash (uncaught error)", e && e.message ? e.message : String(e), e && e.stack);
  });
  process.on("unhandledRejection", (e) => {
    const err = e as { message?: string; stack?: string } | undefined;
    void raise("reject:" + String(err && err.message).slice(0, 80), "Unhandled error in the server", err && err.message ? err.message : String(e), err && err.stack);
  });

  const check = () => {
    try {
      const w = recentCompleted(5);
      if (w.all.n >= 10 && w.all.e5 / w.all.n >= 0.2)
        void raise("spike:all", "Error spike", `${w.all.e5} of ${w.all.n} requests failed with a server error in the last 5 minutes (${Math.round((w.all.e5 / w.all.n) * 100)}%).`);
      if (w.all.n >= 10 && w.all.p95 >= 4000)
        void raise("slow:all", "Slow responses", `95% of requests in the last 5 minutes finished within ${w.all.p95} ms or slower (slowest ${w.all.max} ms) across ${w.all.n} requests.`);
      for (const m of w.perModule)
        if (m.n >= 5 && m.e5 / m.n >= 0.5) void raise("spike:" + m.name, `Module failing: ${m.name}`, `${m.e5} of ${m.n} ${m.name} requests failed with a server error in the last 5 minutes.`);

      const db = lastDbProbes(3);
      if (db.length >= 2 && db.slice(-2).every((p) => !p.ok)) void raise("db:down", "Database unreachable", "The last two database checks (one per minute) failed.");
      else if (db.length >= 3 && db.every((p) => p.ms >= 2000)) void raise("db:slow", "Database slow", `The last three database checks took ${db.map((p) => p.ms + " ms").join(", ")}.`);

      const sys = systemSnapshot();
      if (sys.rssMb >= 450) void raise("mem", "High memory", `The server is using ${sys.rssMb} MB of memory (heap ${sys.heapMb} MB). A restart may be near.`);
      if (sys.lagMaxMs >= 1500) void raise("lag", "Server stalling", `The server stopped responding for up to ${sys.lagMaxMs} ms in the last 5 minutes.`);
    } catch {
      // the watchdog must never take the server down
    }
  };
  setInterval(check, 60000).unref();
}

// Browser-side crashes: one is noise, a burst is a real regression (a bad deploy).
const clientErrs: { t: number; message: string }[] = [];
export function noteClientError(message: string): void {
  const now = Date.now();
  clientErrs.push({ t: now, message });
  while (clientErrs.length && now - clientErrs[0].t > 5 * 60000) clientErrs.shift();
  if (clientErrs.length >= 8) {
    const top = clientErrs[clientErrs.length - 1].message;
    void raise("client:errors", "Browser errors piling up", `${clientErrs.length} errors were reported by users' browsers in the last 5 minutes. Latest: ${top.slice(0, 200)}`);
  }
}
