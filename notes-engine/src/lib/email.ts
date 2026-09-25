import { supabaseAdmin } from "./supabase";

// New-note email notifications (Duolingo-style nudges, event-driven).
// Provider: Resend over HTTPS (no extra deps). Without RESEND_API_KEY the
// sender logs what it WOULD send and reports skipped — safe in dev and
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
  const list = (opts.recipients || []).filter((r) => r.email).slice(0, 200);
  if (!list.length) return { sent: 0, skipped: 0 };
  const key = process.env.RESEND_API_KEY || "";
  const from = process.env.EMAIL_FROM || "Unify Learn <notes@unify.learn>";
  if (!key) {
    console.info(`[email] RESEND_API_KEY unset — would notify ${list.length} about ${opts.course} week ${opts.week}`);
    return { sent: 0, skipped: list.length };
  }
  const url = `${appBaseUrl().replace(/\/$/, "")}/learn/${encodeURIComponent(opts.course)}/week/${opts.week}`;
  const subject = `New in ${opts.course}: Week ${opts.week} is live`;
  let sent = 0;
  // chunks of 10 concurrent posts (Resend free tier is rate-limited)
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const results = await Promise.allSettled(
      chunk.map((r) =>
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from,
            to: [r.email],
            subject,
            html: noteHtml({
              firstName: r.firstName || "",
              course: opts.course,
              week: opts.week,
              topics: opts.topics,
              url,
            }),
          }),
        }).then((res) => {
          if (!res.ok) throw new Error(`resend ${res.status}`);
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled") sent += 1;
      else console.warn("[email] send failed", r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }
  return { sent, skipped: list.length - sent };
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
    const { data: enrolled } = await sb
      .from("enrollments")
      .select("user_id")
      .eq("course", course)
      .eq("kind", "taking")
      .limit(1000);
    const ids = [...new Set(((enrolled ?? []) as { user_id: string }[]).map((r) => r.user_id))];
    if (!ids.length) return { sent: 0, skipped: 0 };
    const { data: profs } = await sb
      .from("profiles")
      .select("first_name,email,notify_new_notes,email_confirmed")
      .in("id", ids.slice(0, 1000));
    const recipients = ((profs ?? []) as {
      first_name?: string;
      email?: string;
      notify_new_notes?: boolean;
      email_confirmed?: boolean;
    }[])
      .filter((p) => p.email && p.email_confirmed && p.notify_new_notes !== false)
      .map((p) => ({ email: p.email as string, firstName: p.first_name }));
    const res = await sendNewNoteEmails({ course, week, topics, recipients });
    console.info(`[email] ${course} w${week}: sent ${res.sent}, skipped ${res.skipped}`);
    return res;
  } catch (e) {
    console.warn("[email] notify failed", e instanceof Error ? e.message : e);
    return { sent: 0, skipped: 0 };
  }
}
