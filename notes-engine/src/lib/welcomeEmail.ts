import { supabaseAdmin } from "./supabase";
import { sendSimpleEmail } from "./email";
import { brandEmail, emailBase, escHtml, panel } from "./email-templates";

// The welcome email: sent once, when a student finishes onboarding for the
// first time. Their name, the courses the app assigned them (lib/classCourses)
// and a link straight into Week 1. Counts against the day's email budget at
// "update" priority; test accounts never get one. Never throws: onboarding
// must not fail because an email didn't go.
const FAKE = /@(test\.unify|unify\.learn)$/i;

export async function sendWelcomeEmail(userId: string, firstName: string | null | undefined): Promise<void> {
  try {
    const sb = supabaseAdmin();
    // The sign-in address from Auth, never the editable profile copy.
    const { data: authUser } = await sb.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (!email || FAKE.test(email)) return;

    const { data: enrolled } = await sb.from("enrollments").select("course").eq("user_id", userId).eq("kind", "taking").order("course");
    const codes = ((enrolled ?? []) as { course: string }[]).map((r) => r.course);
    const { data: titled } = codes.length ? await sb.from("courses").select("code,title").in("code", codes) : { data: [] };
    const titleOf = new Map(((titled ?? []) as { code: string; title: string }[]).map((c) => [c.code, c.title]));

    const base = emailBase();
    const first = (firstName || "").trim().split(/\s+/)[0];
    const list = codes
      .map((c) => `<div style="padding:4px 0;"><strong>${escHtml(c)}</strong>${titleOf.get(c) ? ` &middot; ${escHtml(titleOf.get(c)!)}` : ""}</div>`)
      .join("");
    const body =
      `<p style="margin:0 0 4px;">Hi${first ? ` ${escHtml(first)}` : ""}, you're all set.</p>` +
      (codes.length
        ? `<p style="margin:0 0 4px;">Your courses for this semester are already on your account:</p>` + panel(list) +
          `<p style="margin:12px 0 0;">Start with Week 1 of ${escHtml(codes[0])}. A few minutes is enough, and it starts your streak.</p>`
        : `<p style="margin:0;">Your department's courses for this semester aren't on Unify Learn yet. Open Find courses in the app to add yours.</p>`);
    await sendSimpleEmail({
      to: [{ email, name: first || undefined }],
      subject: "Welcome to Unify Learn",
      html: brandEmail({
        eyebrow: "Welcome",
        title: codes.length ? "Your courses are ready" : "Welcome to Unify Learn",
        pose: "cheer",
        body,
        cta: codes.length
          ? { url: `${base}/learn/${encodeURIComponent(codes[0])}/week/1`, label: `Open ${codes[0]} Week 1` }
          : { url: `${base}/home`, label: "Open Unify Learn" },
        note: "You get this once, when you finish setting up your Unify Learn account.",
      }),
      priority: "update",
    });
  } catch (e) {
    console.warn("[welcome-email]", e);
  }
}
