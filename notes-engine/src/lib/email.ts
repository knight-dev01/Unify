import { supabaseAdmin } from "./supabase";
import { emailRoom, persistSoon, returnEmail, takeEmail, type EmailPriority } from "./emailBudget";
import { inChunks } from "./paging";
import { brandEmail, newNoteEmail } from "./email-templates";

// New-note email notifications (Duolingo-style nudges, event-driven).
// Provider: Brevo SMTP API over HTTPS (no extra deps). Without BREVO_API_KEY
// the sender logs what it WOULD send and reports skipped — safe in dev and
// harmless until the owner wires a key in Render.

type Recipient = { email: string; firstName?: string };

function appBaseUrl(): string {
  const fromEnv = (process.env.CORS_ORIGIN || "").split(",")[0].trim();
  return fromEnv || "https://unify-virid.vercel.app";
}

function parseSender(): { name: string; email: string } {
  const fromRaw = process.env.EMAIL_FROM || "Unify Learn <notes@unify.learn>";
  const m = fromRaw.match(/^(.*)<([^<>]+)>$/);
  if (m) return { name: m[1].trim() || "Unify Learn", email: m[2].trim() };
  return { name: "Unify Learn", email: fromRaw.trim() };
}

// One Brevo call with a 429/5xx retry (honours Retry-After). Returns Brevo's
// status + body verbatim — its body names the exact reason (unverified
// sender, daily limit reached, bad recipient), which is what used to vanish.
type BrevoResult = { ok: boolean; status: number; body: string };

// Every app email passes here, so this is where the daily budget is kept
// (lib/emailBudget: Brevo's free plan is 300 a day). Over budget, the email
// is skipped and reported, never sent.
async function brevoSend(key: string, payload: Record<string, unknown>, priority: EmailPriority = "critical"): Promise<BrevoResult> {
  if (!(await takeEmail(priority))) return { ok: false, status: 0, body: `daily email budget reached (${priority})` };
  const out = await brevoSendNow(key, payload);
  if (out.ok) persistSoon();
  else returnEmail();
  return out;
}
async function brevoSendNow(key: string, payload: Record<string, unknown>): Promise<BrevoResult> {
  let last: BrevoResult = { ok: false, status: 0, body: "no attempt made" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text().catch(() => "");
    last = { ok: res.ok, status: res.status, body };
    if (res.ok) return last;
    // Only rate limits and server hiccups are retried; a rejection of the
    // sender/recipient never becomes success by repeating it.
    if (res.status !== 429 && res.status < 500) return last;
    const retryAfter = Number(res.headers.get("retry-after") || "0");
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1200 * (attempt + 1);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

// Admin self-test: send one email and hand Brevo's answer straight back to
// the UI, so "emails aren't arriving" is diagnosable without Render logs.
export async function probeEmail(to: string): Promise<
  BrevoResult & { sender: string; keySet: boolean; fromSet: boolean }
> {
  const key = process.env.BREVO_API_KEY || "";
  const sender = parseSender();
  const fromSet = Boolean(process.env.EMAIL_FROM);
  if (!key) {
    return {
      ok: false,
      status: 0,
      body: "BREVO_API_KEY is not set on the server — no email can be sent.",
      sender: sender.email,
      keySet: false,
      fromSet,
    };
  }
  const res = await brevoSend(key, {
    sender,
    to: [{ email: to }],
    subject: "Unify Learn email test",
    htmlContent: brandEmail({
      eyebrow: "Email check",
      title: "Your emails work",
      pose: "thumbs-up",
      body: `<p style="margin:0;">This is a test from the Unify Learn admin panel. If you can read this, the Brevo key, the sender and delivery all work.</p>`,
      note: "Sent from Admin, Email check.",
    }),
  });
  return { ...res, sender: sender.email, keySet: true, fromSet };
}


export async function sendNewNoteEmails(opts: {
  course: string;
  week: number;
  topics: { topic: number; version: number }[];
  recipients: Recipient[];
}): Promise<{ sent: number; skipped: number }> {
  const list = (opts.recipients || []).filter((r) => r.email);
  if (!list.length) return { sent: 0, skipped: 0 };
  const key = process.env.BREVO_API_KEY || "";
  const sender = parseSender();
  if (!key) {
    console.info(`[email] BREVO_API_KEY unset — would notify ${list.length} about ${opts.course} week ${opts.week}`);
    return { sent: 0, skipped: list.length };
  }
  const url = `${appBaseUrl().replace(/\/$/, "")}/learn/${encodeURIComponent(opts.course)}/week/${opts.week}`;
  console.info(
    `[email] ${list.length} recipient(s) for ${opts.course} w${opts.week} via sender ${sender.email}` +
      (process.env.EMAIL_FROM ? "" : " (DEFAULT — set EMAIL_FROM on Render to your verified Brevo sender)")
  );
  let sent = 0;
  let limited = false;
  // chunks of 10 concurrent posts (Brevo free tier is rate-limited)
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const results = await Promise.all(
      chunk.map((r) => {
        const built = newNoteEmail({
          firstName: r.firstName || "",
          course: opts.course,
          week: opts.week,
          topics: opts.topics,
          url,
        });
        return brevoSend(key, {
          sender,
          to: [{ email: r.email, name: r.firstName || undefined }],
          subject: built.subject,
          htmlContent: built.html,
        }, "update");
      })
    );
    let failed = false;
    results.forEach((res, idx) => {
      if (res.ok) sent += 1;
      else {
        failed = true;
        if (res.status === 429) limited = true;
        console.warn(
          `[email] send failed (${opts.course} w${opts.week}) — brevo ${res.status} from=${sender.email} to=${chunk[idx].email}: ${res.body.slice(0, 400) || "no response body"}`
        );
      }
    });
    if (failed) {
      console.warn(
        process.env.EMAIL_FROM
          ? `[email] sender configured via EMAIL_FROM (${sender.email}) — if Brevo's message above mentions the from address, verify it in Brevo → Senders.`
          : `[email] EMAIL_FROM is NOT set on Render — using default ${sender.email}, which is likely unverified in Brevo. Set EMAIL_FROM to your verified Brevo sender.`
      );
    }
    // A 429 means we are over Brevo's quota: pacing the rest slowly beats
    // hammering the API and burning the daily allowance on rejections.
    if (limited) await new Promise((r) => setTimeout(r, 1000));
  }
  return { sent, skipped: list.length - sent };
}

// Generic one-off email (admin alerts, request decisions, announcements).
// Same Brevo transport, same log-and-skip without a key. Sends in small
// batches: bursts of 50 concurrent calls trip Brevo's rate limit (429) and
// the printed reason used to be thrown away.
export async function sendSimpleEmail(opts: {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  priority?: EmailPriority;
}): Promise<number> {
  const list = (opts.to || []).filter((r) => r.email).slice(0, 50);
  if (!list.length) return 0;
  const key = process.env.BREVO_API_KEY || "";
  const sender = parseSender();
  if (!key) {
    console.info(`[email] BREVO_API_KEY unset — would send "${opts.subject}" to ${list.length}`);
    return 0;
  }
  let sent = 0;
  let failed = false;
  let limited = false;
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const results = await Promise.all(
      chunk.map((r) =>
        brevoSend(key, {
          sender,
          to: [{ email: r.email, name: r.name || undefined }],
          subject: opts.subject,
          htmlContent: opts.html,
        }, opts.priority || "critical")
      )
    );
    results.forEach((res, idx) => {
      if (res.ok) sent += 1;
      else {
        failed = true;
        if (res.status === 429) limited = true;
        console.warn(
          `[email] send failed ("${opts.subject}") — brevo ${res.status} from=${sender.email} to=${chunk[idx].email}: ${res.body.slice(0, 400) || "no response body"}`
        );
      }
    });
    if (limited) await new Promise((r) => setTimeout(r, 1000));
  }
  if (failed) {
    console.warn(
      process.env.EMAIL_FROM
        ? `[email] sender configured via EMAIL_FROM (${sender.email}) — if Brevo's message above mentions the from address, verify it in Brevo → Senders.`
        : `[email] EMAIL_FROM is NOT set on Render — using default ${sender.email}, which is likely unverified in Brevo. Set EMAIL_FROM to your verified Brevo sender.`
    );
  }
  return sent;
}

// In-app twin of the email above: bell-badge rows for every enrolled
// student (no confirmed-email requirement — it lives in the app).
export async function notifyInAppNewNote(
  course: string,
  week: number,
  topics: { topic: number; version: number }[]
): Promise<void> {
  try {
    const sb = supabaseAdmin();
    // Paginated: 10k-student courses must not silently lose the tail
    // past row 2000. Keyset over user_id, 1000 per page.
    const ids: string[] = [];
    let last = "";
    for (;;) {
      let q = sb
        .from("enrollments")
        .select("user_id")
        .eq("course", course)
        .eq("kind", "taking")
        .order("user_id")
        .limit(1000);
      if (last) q = q.gt("user_id", last);
      const { data, error } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as { user_id: string }[]);
      if (!rows.length) break;
      for (const r of rows) ids.push(r.user_id);
      last = rows[rows.length - 1].user_id;
      if (rows.length < 1000) break;
    }
    const uniq = [...new Set(ids)];
    if (!uniq.length) return;
    const topicLine = topics.map((t) => `Topic ${t.topic} (v${t.version})`).join(" · ") || "fresh content";
    const rows = ids.map((user_id) => ({
      user_id,
      type: "new_note",
      title: `${course} · Week ${week} is live`,
      body: topicLine,
      course,
      week,
      topic: topics[0]?.topic ?? null,
      link: `/learn/${encodeURIComponent(course)}/week/${week}`,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("notifications").insert(rows.slice(i, i + 200));
      if (error) throw error;
    }
    // Hygiene: read notifications older than 90 days are dead weight at
    // 10k-user scale. Unread rows are never touched (badge integrity).
    await sb.from("notifications").delete().eq("read", true).lt("created_at", new Date(Date.now() - 90 * 86400000).toISOString()).then(() => {}, () => {});
  } catch (e) {
    console.warn("[notify] in-app failed", e instanceof Error ? e.message : e);
  }
}
// Recipients: students taking this course with a confirmed email who did
// not opt out. Pure reads; safe to fire-and-forget from publish handlers.
export async function notifyCoursePublished(
  course: string,
  week: number,
  topics: { topic: number; version: number }[]
): Promise<{ sent: number; skipped: number }> {
  try {
    const sb = supabaseAdmin();
    const ids: string[] = [];
    let last = "";
    for (;;) {
      let q = sb
        .from("enrollments")
        .select("user_id")
        .eq("course", course)
        .eq("kind", "taking")
        .order("user_id")
        .limit(1000);
      if (last) q = q.gt("user_id", last);
      const { data: enrolled, error: eErr } = await q;
      if (eErr) throw eErr;
      const rows = ((enrolled ?? []) as { user_id: string }[]);
      if (!rows.length) break;
      for (const r of rows) ids.push(r.user_id);
      last = rows[rows.length - 1].user_id;
      if (rows.length < 1000) break;
    }
    const uniq = [...new Set(ids)];
    if (!uniq.length) return { sent: 0, skipped: 0 };
    const recipients: { email: string; firstName?: string }[] = [];
    for (let i = 0; i < uniq.length; i += 500) {
      const { data: profs } = await sb
        .from("profiles")
        .select("first_name,email,notify_new_notes,email_confirmed")
        .in("id", uniq.slice(i, i + 500));
      for (const p of ((profs ?? []) as {
        first_name?: string;
        email?: string;
        notify_new_notes?: boolean;
        email_confirmed?: boolean;
      }[])) {
        if (p.email && p.email_confirmed && p.notify_new_notes !== false) {
          recipients.push({ email: p.email, firstName: p.first_name });
        }
      }
    }
    const res = await sendNewNoteEmails({ course, week, topics, recipients });
    console.info(`[email] ${course} w${week}: sent ${res.sent}, skipped ${res.skipped}`);
    return res;
  } catch (e) {
    console.warn("[email] notify failed", e instanceof Error ? e.message : e);
    return { sent: 0, skipped: 0 };
  }
}


// Email as the backup for push (Review: "reminders and notifications should
// use email too"). Only people push can't reach get it: no push subscription
// on any device, a confirmed email, and class-update emails left on in
// Settings. Capped by the day's budget for the priority; returns how many
// went out. build() gets the person's first name.
export async function emailWithoutPush(
  ids: string[],
  build: (firstName: string) => { subject: string; html: string },
  priority: EmailPriority,
): Promise<number> {
  const key = process.env.BREVO_API_KEY || "";
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!key || !uniq.length) return 0;
  const sb = supabaseAdmin();
  const people = await inChunks<{ id: string; email: string | null; first_name: string | null }>(uniq, (c, from, to) =>
    sb.from("profiles").select("id,email,first_name").in("id", c).eq("email_confirmed", true).neq("email_updates", false).order("id").range(from, to));
  if (!people.length) return 0;
  const withPush = new Set((await inChunks<{ user_id: string }>(people.map((p) => p.id), (c, from, to) =>
    sb.from("push_subscriptions").select("user_id").in("user_id", c).order("user_id").range(from, to))).map((r) => r.user_id));
  const targets = people.filter((p) => p.email && !withPush.has(p.id) && !/@(test\.unify|unify\.learn)$/i.test(p.email));
  const room = await emailRoom(priority);
  const list = targets.slice(0, room);
  if (targets.length > list.length) console.info(`[email] budget: ${targets.length - list.length} ${priority} email(s) skipped today`);
  const sender = parseSender();
  let sent = 0;
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const results = await Promise.all(chunk.map((p) => {
      const built = build((p.first_name || "").trim().split(/\s+/)[0] || "");
      return brevoSend(key, { sender, to: [{ email: p.email!, name: p.first_name || undefined }], subject: built.subject, htmlContent: built.html }, priority);
    }));
    sent += results.filter((r) => r.ok).length;
  }
  return sent;
}
