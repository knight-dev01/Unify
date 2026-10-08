import { supabaseAdmin } from "./supabase";
import { newNoteEmail } from "./email-templates";

// New-note email notifications (Duolingo-style nudges, event-driven).
// Provider: Brevo SMTP API over HTTPS (no extra deps). Without BREVO_API_KEY
// the sender logs what it WOULD send and reports skipped — safe in dev and
// harmless until the owner wires a key in Render.

type Recipient = { email: string; firstName?: string };

function appBaseUrl(): string {
  const fromEnv = (process.env.CORS_ORIGIN || "").split(",")[0].trim();
  return fromEnv || "https://unify-virid.vercel.app";
}

function noteHtml(opts: {
  firstName: string;
  course: string;
  week: number;
  topics: { topic: number; version: number }[];
  url: string;
}): string {
  const topicLine = opts.topics.map((t) => `Topic ${t.topic} (v${t.version})`).join(" · ") || "fresh content";
  const name = opts.firstName ? ` ${opts.firstName}` : "";
  return [
    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">`,
    `<div style="background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:20px;border-radius:12px 12px 0 0;">`,
    `<div style="font-weight:800;font-size:20px;">Unify Learn</div>`,
    `</div>`,
    `<div style="padding:20px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;">`,
    `<p>Hi${name},</p>`,
    `<p><strong>${opts.course} &middot; Week ${opts.week}</strong> just got ${topicLine}.</p>`,
    `<p><a href="${opts.url}" style="display:inline-block;padding:12px 24px;background:#10b981;color:#fff;border-radius:9999px;text-decoration:none;font-weight:800;">Open it now</a></p>`,
    `<p style="font-size:12px;color:#777;">You get this because new-note emails are on in your Unify profile. Turn them off there any time.</p>`,
    `</div></div>`,
  ].join("");
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
  const fromRaw = process.env.EMAIL_FROM || "Unify Learn <notes@unify.learn>";
  const sender = (() => {
    const m = fromRaw.match(/^(.*)<([^<>]+)>$/);
    if (m) return { name: (m[1].trim() || "Unify Learn"), email: m[2].trim() };
    return { name: "Unify Learn", email: fromRaw.trim() };
  })();
  if (!key) {
    console.info(`[email] BREVO_API_KEY unset — would notify ${list.length} about ${opts.course} week ${opts.week}`);
    return { sent: 0, skipped: list.length };
  }
  const url = `${appBaseUrl().replace(/\/$/, "")}/learn/${encodeURIComponent(opts.course)}/week/${opts.week}`;
  let sent = 0;
  // chunks of 10 concurrent posts (Brevo free tier is rate-limited)
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const results = await Promise.allSettled(
      chunk.map((r) => {
        const built = newNoteEmail({
          firstName: r.firstName || "",
          course: opts.course,
          week: opts.week,
          topics: opts.topics,
          url,
        });
        return fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            sender,
            to: [{ email: r.email, name: r.firstName || undefined }],
            subject: built.subject,
            htmlContent: built.html,
          }),
        }).then((res) => {
          if (!res.ok) throw new Error(`brevo ${res.status}`);
        });
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") sent += 1;
      else console.warn("[email] send failed", r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }
  return { sent, skipped: list.length - sent };
}

// Generic one-off email (admin alerts, request decisions). Same Brevo
// transport, same log-and-skip without a key.
export async function sendSimpleEmail(opts: {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
}): Promise<number> {
  const list = (opts.to || []).filter((r) => r.email).slice(0, 50);
  if (!list.length) return 0;
  const key = process.env.BREVO_API_KEY || "";
  const fromRaw = process.env.EMAIL_FROM || "Unify Learn <notes@unify.learn>";
  const sender = (() => {
    const m = fromRaw.match(/^(.*)<([^<>]+)>$/);
    if (m) return { name: (m[1].trim() || "Unify Learn"), email: m[2].trim() };
    return { name: "Unify Learn", email: fromRaw.trim() };
  })();
  if (!key) {
    console.info(`[email] BREVO_API_KEY unset — would send "${opts.subject}" to ${list.length}`);
    return 0;
  }
  let sent = 0;
  const results = await Promise.allSettled(
    list.map((r) =>
      fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sender,
          to: [{ email: r.email, name: r.name || undefined }],
          subject: opts.subject,
          htmlContent: opts.html,
        }),
      }).then((res) => {
        if (!res.ok) throw new Error(`brevo ${res.status}`);
      })
    )
  );
  for (const r of results) {
    if (r.status === "fulfilled") sent += 1;
    else console.warn("[email] send failed", r.reason instanceof Error ? r.reason.message : r.reason);
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
