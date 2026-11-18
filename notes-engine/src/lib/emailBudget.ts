import { supabaseAdmin } from "./supabase";

// Brevo's free plan sends 300 emails a day (resets at midnight UTC), shared
// with Supabase's sign-in emails when Supabase uses Brevo SMTP. The app keeps
// a daily count and spends it by priority, so the important emails always
// have room:
//   critical  codes, alerts, role changes, staff requests (1 person each)
//   urgent    class cancelled or moved, live wires
//   update    answers, announcements, polls, new notes
//   digest    the weekly summary
// Each priority may only take the day's count up to its own ceiling.
// Set BREVO_DAILY_LIMIT on Render after upgrading the Brevo plan.
export type EmailPriority = "critical" | "urgent" | "update" | "digest";

const LIMIT = () => Math.max(0, Number(process.env.BREVO_DAILY_LIMIT) || 300);
// Left for Supabase's sign-up and password-reset emails.
const AUTH_RESERVE = () => Math.min(60, Math.floor(LIMIT() * 0.2));
function ceiling(p: EmailPriority): number {
  const app = LIMIT() - AUTH_RESERVE();
  if (p === "critical") return LIMIT() - 10;
  if (p === "urgent") return app;
  if (p === "update") return app - Math.floor(app * 0.15); // keep room for urgent
  return app - Math.floor(app * 0.3); // digest uses what's left over
}

const utcDay = () => new Date().toISOString().slice(0, 10);
let state: { day: string; sent: number; loaded: boolean } = { day: "", sent: 0, loaded: false };
let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  const day = utcDay();
  if (state.loaded && state.day === day) return;
  if (!loading) {
    loading = (async () => {
      try {
        const { data } = await supabaseAdmin().from("email_budget").select("sent").eq("day", day).maybeSingle();
        state = { day, sent: Number((data as { sent?: number } | null)?.sent || 0), loaded: true };
      } catch {
        state = { day, sent: state.day === day ? state.sent : 0, loaded: true };
      } finally {
        loading = null;
      }
    })();
  }
  await loading;
}

// Take room for one email at this priority. false = over budget, skip it.
export async function takeEmail(p: EmailPriority): Promise<boolean> {
  await load();
  if (state.sent >= ceiling(p)) return false;
  state.sent += 1;
  return true;
}
// Give the room back when Brevo didn't send it after all.
export function returnEmail(): void {
  if (state.sent > 0) state.sent -= 1;
  void persist();
}
let persistTimer: NodeJS.Timeout | null = null;
async function persist(): Promise<void> {
  const { day, sent } = state;
  try {
    await supabaseAdmin().from("email_budget").upsert({ day, sent, updated_at: new Date().toISOString() }, { onConflict: "day" });
  } catch {
    // the in-memory count still protects this process
  }
}
// Saved a moment after a burst, not once per email.
export function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; void persist(); }, 2000);
}

// How many more emails this priority can send today.
export async function emailRoom(p: EmailPriority): Promise<number> {
  await load();
  return Math.max(0, ceiling(p) - state.sent);
}
export async function emailBudgetStatus(): Promise<{ day: string; sent: number; limit: number; appLimit: number }> {
  await load();
  return { day: state.day, sent: state.sent, limit: LIMIT(), appLimit: LIMIT() - AUTH_RESERVE() };
}
