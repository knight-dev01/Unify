import webpush from "web-push";
import { supabaseAdmin } from "./supabase";

// Web Push (browser push notifications) — the third leg next to the
// in-app bell and Brevo email. Needs VAPID keys on Render:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…)
// Without keys everything logs and skips — safe until wired.

type PushRow = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; url: string };

let configured: boolean | null = null;

function vapid(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY || "";
  const priv = process.env.VAPID_PRIVATE_KEY || "";
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:notes@unify.learn", pub, priv);
    configured = true;
  } catch {
    configured = false;
  }
  return configured;
}

async function subscriptionsFor(userIds: string[]): Promise<({ user_id: string } & PushRow)[]> {
  const uniq = [...new Set(userIds.filter(Boolean))].slice(0, 2000);
  if (!uniq.length) return [];
  const { data, error } = await supabaseAdmin()
    .from("push_subscriptions")
    .select("user_id,endpoint,p256dh,auth")
    .in("user_id", uniq)
    .limit(2000);
  if (error) throw error;
  return ((data ?? []) as ({ user_id: string } & PushRow)[]);
}

async function pruneDead(endpoints: string[]): Promise<void> {
  if (!endpoints.length) return;
  try {
    await supabaseAdmin().from("push_subscriptions").delete().in("endpoint", endpoints.slice(0, 200));
  } catch {
    // pruning is best-effort
  }
}

// Fire-and-forget fan-out to a set of users. Dead subscriptions (410/404
// from the push service) are pruned so the table never rots.
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!vapid()) {
    console.info(`[push] VAPID unset — would push "${payload.title}" to ${userIds.length} users`);
    return { sent: 0, pruned: 0 };
  }
  let subs: ({ user_id: string } & PushRow)[];
  try {
    subs = await subscriptionsFor(userIds);
  } catch (e) {
    console.warn("[push] subscription lookup failed", e instanceof Error ? e.message : e);
    return { sent: 0, pruned: 0 };
  }
  if (!subs.length) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead: string[] = [];
  // chunks of 20 concurrent posts (push services rate-limit)
  for (let i = 0; i < subs.length; i += 20) {
    const results = await Promise.allSettled(
      subs.slice(i, i + 20).map((s) =>
        webpush
          .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
          .then(() => {
            sent += 1;
          })
          .catch((err: unknown) => {
            const status = (err as { statusCode?: number })?.statusCode;
            if (status === 404 || status === 410) dead.push(s.endpoint);
            else console.warn("[push] send failed", status || (err instanceof Error ? err.message : err));
          })
      )
    );
    void results;
  }
  if (dead.length) await pruneDead(dead);
  console.info(`[push] "${payload.title}": sent ${sent}, pruned ${dead.length}`);
  return { sent, pruned: dead.length };
}

function appBaseUrl(): string {
  const fromEnv = (process.env.CORS_ORIGIN || "").split(",")[0].trim();
  return (fromEnv || "https://unify-virid.vercel.app").replace(/\/$/, "");
}

// New-note push twin: students taking the course get a lock-screen nudge.
export async function pushNewNote(course: string, week: number, topics: { topic: number; version: number }[]): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("enrollments").select("user_id").eq("course", course).eq("kind", "taking").limit(2000);
    const ids = [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id))];
    if (!ids.length) return;
    const topicLine = topics.map((t) => `Topic ${t.topic} (v${t.version})`).join(" · ") || "fresh content";
    await sendPushToUsers(ids, {
      title: `${course} · Week ${week} is live`,
      body: topicLine,
      url: `${appBaseUrl()}/learn/${encodeURIComponent(course)}/week/${week}`,
    });
  } catch (e) {
    console.warn("[push] new-note fan-out failed", e instanceof Error ? e.message : e);
  }
}

// Broadcast push twin for admin announcements.
export async function pushAnnounce(title: string, body: string, link?: string): Promise<void> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("profiles").select("id").limit(5000);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return;
    await sendPushToUsers(ids, { title, body, url: `${appBaseUrl()}${link || "/dashboard"}` });
  } catch (e) {
    console.warn("[push] announce fan-out failed", e instanceof Error ? e.message : e);
  }
}

// Single-user push (welcome, role changes).
export async function pushToUser(userId: string, payload: PushPayload): Promise<void> {
  await sendPushToUsers([userId], { ...payload, url: payload.url.startsWith("http") ? payload.url : `${appBaseUrl()}${payload.url}` });
}
