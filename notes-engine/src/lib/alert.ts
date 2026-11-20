import { supabaseAdmin } from "./supabase";
import { brandEmail, panel } from "./email-templates";
import { lastEmailFailure, sendSimpleEmail } from "./email";
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
// A failed send isn't retried every minute: the next try is 15 minutes later.
const lastFailed = new Map<string, { at: number; why: string }>();
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
const appUrl = () => ((process.env.CORS_ORIGIN || "").split(",")[0].trim() || "https://unifylearn.app");

export function recentAlerts(): AlertRec[] {
  return [...log].reverse();
}

/** Raise an alert. `signature` groups repeats of the same problem. Never throws. */
export async function raise(signature: string, kind: string, message: string, detail?: string, opts: { force?: boolean; logOnly?: string } = {}): Promise<AlertRec> {
  const rec: AlertRec = { at: new Date().toISOString(), signature, kind, message, emailed: false };
  try {
    const now = Date.now();
    sentThisHour = sentThisHour.filter((t) => now - t < 3600000);
    const last = lastSent.get(signature) ?? 0;
    const failed = lastFailed.get(signature);
    if (opts.logOnly) {
      rec.note = opts.logOnly;
    } else if (!opts.force && now - last < COOLDOWN_MS) {
      rec.note = "repeat within 15 minutes: not emailed again";
    } else if (!opts.force && failed && now - failed.at < COOLDOWN_MS) {
      rec.note = `email failed ${Math.round((now - failed.at) / 60000)} min ago (tries again after 15 minutes): ${failed.why}`;
    } else if (!opts.force && sentThisHour.length >= HOURLY_CAP) {
      rec.note = "hourly email cap reached";
    } else {
      const to = await recipients();
      if (!to.length) rec.note = "no admin email on file (set ADMIN_EMAILS)";
      else if (!process.env.BREVO_API_KEY) rec.note = "BREVO_API_KEY is not set: email not sent";
      else {
        const html = brandEmail({
          eyebrow: "System alert",
          title: kind,
          pose: "peeking",
          body:
            `<p style="margin:0;">${esc(message)}</p>` +
            (detail ? panel(`<pre style="margin:0;white-space:pre-wrap;font-size:12px;font-family:ui-monospace,Menlo,monospace;">${esc(detail.slice(0, 1500))}</pre>`, "grey") : "") +
            `<p style="margin:12px 0 0;font-size:13px;color:#555555;">${new Date().toUTCString()}</p>`,
          cta: { url: `${appUrl()}/admin/performance`, label: "See live performance" },
          note: "You get this because you're an admin on Unify Learn. The same problem emails at most once every 15 minutes.",
        });
        const sent = await sendSimpleEmail({ to: to.map((email) => ({ email })), subject: `[Unify Learn alert] ${kind}`, html });
        rec.emailed = sent > 0;
        if (sent > 0) {
          lastSent.set(signature, now);
          lastFailed.delete(signature);
          sentThisHour.push(now);
        } else {
          const why = lastEmailFailure() || "no reason given";
          lastFailed.set(signature, { at: now, why });
          rec.note = `email provider did not accept it: ${why}`;
        }
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
      // On the free plan the server sleeps after 15 minutes without traffic;
      // the first minutes after it wakes are slow by nature. Those are logged
      // (so the panel shows it) but not emailed.
      const waking = process.uptime() < 6 * 60;
      const WAKE_NOTE = "server was waking up (the free plan sleeps after 15 minutes without traffic): logged, not emailed";
      if (w.all.n >= 10 && w.all.p95 >= 4000) {
        const worst = [...w.perModule].sort((a, b) => b.max - a.max).slice(0, 3).map((m) => `${m.name} ${m.max} ms`).join(", ");
        void raise("slow:all", waking ? "Slow while waking up" : "Slow responses", `95% of requests in the last 5 minutes finished within ${w.all.p95} ms or slower (slowest ${w.all.max} ms) across ${w.all.n} requests. Slowest parts: ${worst}.`, undefined, waking ? { logOnly: WAKE_NOTE } : {});
      }
      for (const m of w.perModule)
        if (m.n >= 5 && m.e5 / m.n >= 0.5) void raise("spike:" + m.name, `Module failing: ${m.name}`, `${m.e5} of ${m.n} ${m.name} requests failed with a server error in the last 5 minutes.`);

      const db = lastDbProbes(3);
      if (db.length >= 2 && db.slice(-2).every((p) => !p.ok)) void raise("db:down", "Database unreachable", "The last two database checks (one per minute) failed.");
      else if (db.length >= 3 && db.every((p) => p.ms >= 2000)) void raise("db:slow", "Database slow", `The last three database checks took ${db.map((p) => p.ms + " ms").join(", ")}.`);

      const sys = systemSnapshot();
      if (sys.rssMb >= 450) void raise("mem", "High memory", `The server is using ${sys.rssMb} MB of memory (heap ${sys.heapMb} MB). A restart may be near.`);
      // Judge only the newest minute: the 5-minute peak repeats one pause in
      // five alerts in a row, and carries a start-up pause into "stalling".
      const newest = sys.lag[sys.lag.length - 1];
      const bootAt = Date.now() - process.uptime() * 1000;
      if (newest && Date.now() - newest.t < 90000 && newest.ms >= 1500) {
        const duringStart = newest.t - 60000 < bootAt + 6 * 60 * 1000;
        if (waking || duringStart) void raise("lag", "Server waking up", `The server started ${Math.round(process.uptime() / 60)} min ago and paused for up to ${newest.ms} ms while starting.`, undefined, { logOnly: WAKE_NOTE });
        else void raise("lag", "Server stalling", `The server stopped responding for up to ${newest.ms} ms in the last minute.`);
      }
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
