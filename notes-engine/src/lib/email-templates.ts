// Branded email templates (Box Boy + Unify Learn identity).
// All special chars are HTML entities (pure ASCII source). Email clients
// get table layout + inline styles only. The mascot is inline SVG: clients
// that render it (Apple Mail, Thunderbird, Samsung) show Box Boy; clients
// that strip SVG (Outlook, some Gmail) fall back gracefully to the U-badge
// header, which always renders.
const FONT = "font-family:Arial,Helvetica,sans-serif;";

export const MASCOT_SVG = [
  '<svg width="96" height="110" viewBox="0 0 200 230" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Box Boy">',
  '<ellipse cx="100" cy="218" rx="52" ry="9" fill="#000000" opacity="0.08"/>',
  '<rect x="36" y="134" width="17" height="46" rx="8.5" fill="#1F2937"/>',
  '<circle cx="44" cy="182" r="8" fill="#F2C894"/>',
  '<rect x="26" y="148" width="26" height="32" rx="5" fill="#ffffff" stroke="#E5E5E5" stroke-width="1.5"/>',
  '<rect x="26" y="159" width="26" height="10" fill="#10b981"/>',
  '<rect x="23" y="141" width="32" height="9" rx="4.5" fill="#E5E5E5"/>',
  '<rect x="147" y="134" width="17" height="46" rx="8.5" fill="#1F2937"/>',
  '<circle cx="156" cy="182" r="8" fill="#F2C894"/>',
  '<rect x="58" y="108" width="84" height="106" rx="24" fill="#1F2937"/>',
  '<ellipse cx="100" cy="124" rx="21" ry="9" fill="#111827"/>',
  '<line x1="89" y1="132" x2="87" y2="158" stroke="#9CA3AF" stroke-width="3" stroke-linecap="round"/>',
  '<line x1="111" y1="132" x2="113" y2="158" stroke="#9CA3AF" stroke-width="3" stroke-linecap="round"/>',
  '<circle cx="87" cy="160" r="3" fill="#9CA3AF"/>',
  '<circle cx="113" cy="160" r="3" fill="#9CA3AF"/>',
  '<rect x="73" y="170" width="54" height="32" rx="10" fill="#374151"/>',
  '<circle cx="126" cy="152" r="11" fill="#10b981"/>',
  '<text x="126" y="157" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="13" fill="#ffffff">U</text>',
  '<line x1="136" y1="28" x2="149" y2="9" stroke="#B97F1F" stroke-width="5" stroke-linecap="round"/>',
  '<circle cx="149" cy="9" r="7" fill="#10b981"/>',
  '<rect x="54" y="26" width="92" height="84" rx="12" fill="#E9B44C"/>',
  '<line x1="131" y1="58" x2="131" y2="78" stroke="#B97F1F" stroke-width="3" stroke-linecap="round"/>',
  '<line x1="138" y1="58" x2="138" y2="78" stroke="#B97F1F" stroke-width="3" stroke-linecap="round"/>',
  '<rect x="66" y="94" width="28" height="8" rx="4" fill="#B97F1F"/>',
  '<text x="99" y="84" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="46" fill="#047857">U</text>',
  "</svg>",
].join("");

function header(subtitle: string): string {
  return [
    `<table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#10b981,#059669);border-radius:12px 12px 0 0;"><tr>`,
    `<td style="padding:24px 24px 20px;color:#ffffff;${FONT}">`,
    `<div style="font-weight:800;font-size:20px;">Unify Learn</div>`,
    `<div style="font-size:13px;opacity:0.92;margin-top:4px;">${subtitle}</div>`,
    `</td>`,
    `<td width="96" style="padding:12px 16px 8px 0;text-align:right;vertical-align:bottom;">`,
    `<span style="display:inline-block;width:40px;height:40px;border-radius:10px;background:#ffffff;color:#059669;font-weight:800;font-size:22px;line-height:40px;text-align:center;">U</span>`,
    `</td></tr></table>`,
  ].join("");
}

function footer(note: string): string {
  return [
    `<div style="font-size:12px;color:#777777;margin-top:16px;">${note}</div>`,
    `<div style="font-size:12px;color:#aaaaaa;margin-top:12px;padding-top:12px;border-top:1px solid #eeeeee;">`,
    `Unify Learn &middot; Faculty of Engineering, Lagos State University<br/>`,
    `You are getting this because of your Unify Learn account activity.`,
    `</div>`,
  ].join("");
}

function button(url: string, label: string): string {
  return `<p><a href="${url}" style="display:inline-block;padding:12px 28px;background:#10b981;color:#ffffff;border-radius:9999px;text-decoration:none;font-weight:800;">${label}</a></p>`;
}

function wrap(subtitle: string, body: string, foot: string): string {
  return [
    `<div style="${FONT}max-width:480px;margin:0 auto;color:#3c3c3c;">`,
    header(subtitle),
    `<div style="padding:20px 24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px;background:#ffffff;">`,
    body,
    foot,
    `</div></div>`,
  ].join("");
}

export type TopicVersion = { topic: number; version: number };

export function newNoteEmail(opts: {
  firstName: string;
  course: string;
  week: number;
  topics: TopicVersion[];
  url: string;
}): { subject: string; html: string } {
  const topicLine =
    opts.topics.map((t) => `Topic ${t.topic} (v${t.version})`).join(" &middot; ") || "fresh content";
  const name = opts.firstName ? ` ${opts.firstName}` : "";
  const subject = `New in ${opts.course}: Week ${opts.week} is live`;
  const body = [
    `<p>Hi${name},</p>`,
    `<p><strong>${opts.course} &middot; Week ${opts.week}</strong> just got ${topicLine}.</p>`,
    button(opts.url, "Open it now"),
  ].join("");
  const html = wrap(
    "Fresh notes just dropped",
    body,
    footer("You get this because new-note emails are on in your Unify profile. Turn them off there any time.")
  );
  return { subject, html };
}

export function welcomeEmail(opts: { firstName: string; url: string }): { subject: string; html: string } {
  const name = opts.firstName ? ` ${opts.firstName}` : "";
  return {
    subject: "Welcome to Unify Learn — let's build",
    html: wrap(
      "Your account is ready",
      [
        `<div style="text-align:center;">${MASCOT_SVG}</div>`,
        `<p>Hi${name}, and welcome aboard.</p>`,
        `<p>Pick your courses, open Week 1, and mark your first topic complete &mdash; your streak starts today.</p>`,
        button(opts.url, "Open my dashboard"),
      ].join(""),
      footer("Questions? Reply to this email and a human will answer.")
    ),
  };
}

// ---- Supabase Auth templates (paste into Dashboard > Authentication >
// Email Templates). Supabase fills {{ .ConfirmationURL }} etc. at send. ----
function authMail(subtitle: string, body: string): string {
  return wrap(
    subtitle,
    body,
    footer("Didn't ask for this? Ignore it &mdash; your account stays exactly as it is.")
  );
}

export const SUPABASE_TEMPLATES: { name: string; subject: string; html: string }[] = [
  {
    name: "confirm-signup",
    subject: "Confirm your Unify Learn account",
    html: authMail(
      "One tap and you're in",
      [
        `<div style="text-align:center;">${MASCOT_SVG}</div>`,
        `<p>Welcome! Confirm your email to activate your Unify Learn account:</p>`,
        button("{{ .ConfirmationURL }}", "Confirm my email"),
        `<p style="font-size:12px;color:#777777;">Button not working? Paste this link:<br/>{{ .ConfirmationURL }}</p>`,
      ].join("")
    ),
  },
  {
    name: "invite",
    subject: "You've been invited to Unify Learn",
    html: authMail(
      "Someone wants you on board",
      [
        `<div style="text-align:center;">${MASCOT_SVG}</div>`,
        `<p>You've been invited to join Unify Learn as a learning author. Accept below to set your password:</p>`,
        button("{{ .ConfirmationURL }}", "Accept invite"),
        `<p style="font-size:12px;color:#777777;">Button not working? Paste this link:<br/>{{ .ConfirmationURL }}</p>`,
      ].join("")
    ),
  },
  {
    name: "recovery",
    subject: "Reset your Unify Learn password",
    html: authMail(
      "Let's get you back in",
      [
        `<p>Someone (hopefully you) asked to reset the password for {{ .Email }}. This link works once and expires soon:</p>`,
        button("{{ .ConfirmationURL }}", "Reset my password"),
        `<p style="font-size:12px;color:#777777;">Button not working? Paste this link:<br/>{{ .ConfirmationURL }}</p>`,
      ].join("")
    ),
  },
  {
    name: "email-change",
    subject: "Confirm your new Unify Learn email",
    html: authMail(
      "Confirm the switch",
      [
        `<p>Tap below to confirm your new address. Your notes, XP and streaks move with you automatically:</p>`,
        button("{{ .ConfirmationURL }}", "Confirm new email"),
        `<p style="font-size:12px;color:#777777;">Button not working? Paste this link:<br/>{{ .ConfirmationURL }}</p>`,
      ].join("")
    ),
  },
  {
    name: "magic-link",
    subject: "Your Unify Learn sign-in link",
    html: authMail(
      "Password-free entry",
      [
        `<div style="text-align:center;">${MASCOT_SVG}</div>`,
        `<p>Tap below to sign in instantly. The link works once and expires soon:</p>`,
        button("{{ .ConfirmationURL }}", "Sign me in"),
        `<p style="font-size:12px;color:#777777;">Button not working? Paste this link:<br/>{{ .ConfirmationURL }}</p>`,
      ].join("")
    ),
  },
];
