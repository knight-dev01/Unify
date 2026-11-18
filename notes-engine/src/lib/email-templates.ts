// Unify Learn email design (brand kit): warm off-white page, white card,
// near-black header with the "Unify Learn." wordmark (green dot) and Box Boy
// in his green ring, Playfair-style serif headline, green call to action,
// quiet footer with the tagline. Every app email goes through brandEmail().
//
// Email-client rules: tables + inline styles only, web fonts fall back to
// Georgia / Arial, Box Boy is a hosted PNG (SVG and WebP are stripped by
// Gmail and Outlook), source is ASCII with HTML entities.

const APP_URL = "https://unify-virid.vercel.app";
export function emailBase(): string {
  const fromEnv = (process.env.CORS_ORIGIN || "").split(",")[0].trim();
  return (fromEnv || APP_URL).replace(/\/$/, "");
}

const C = {
  page: "#f5f4f0",
  card: "#ffffff",
  ink: "#0a0a0a",
  text2: "#555555",
  text3: "#999999",
  border: "#e0deda",
  green: "#4ade80",
  greenDeep: "#16a34a",
  greenTint: "#ecfdf3",
  amber: "#fbbf24",
};
const SERIF = "font-family:'Playfair Display',Georgia,'Times New Roman',serif;";
const SANS = "font-family:'DM Sans',Arial,Helvetica,sans-serif;";

// Escape text that came from people (names, titles, messages).
export function escHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Plain text with line breaks, safe for an email body.
export function textHtml(s: string): string {
  return escHtml(s).replace(/\r?\n/g, "<br/>");
}

export type BoxBoyPose = "cheer" | "thumbs-up" | "reading-standing" | "teaching" | "phone-out" | "peeking" | "wave-phone" | "arms-crossed";

export function brandEmail(opts: {
  eyebrow: string; // short line above the headline, e.g. "NEW NOTES"
  title: string; // the headline (plain text)
  body: string; // HTML (escape anything people typed with escHtml/textHtml)
  cta?: { url: string; label: string };
  note?: string; // why they got this (HTML)
  pose?: BoxBoyPose;
  base?: string; // app URL for images and links (Supabase templates pass the fixed one)
}): string {
  const base = (opts.base || emailBase()).replace(/\/$/, "");
  const boxBoy = `${base}/boxboy/${opts.pose || "cheer"}.png`;
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr><td style="border-radius:8px;background:${C.green};">` +
      `<a href="${opts.cta.url}" style="display:inline-block;padding:13px 26px;${SANS}font-size:15px;font-weight:700;color:${C.ink};text-decoration:none;border-radius:8px;">${opts.cta.label} &rarr;</a>` +
      `</td></tr></table>` +
      `<div style="${SANS}font-size:12px;color:${C.text3};margin-top:10px;">Button not working? Open <a href="${opts.cta.url}" style="color:${C.greenDeep};word-break:break-all;">${opts.cta.url}</a></div>`
    : "";
  return [
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">`,
    `<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">`,
    `<title>${escHtml(opts.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.page};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">`,
    // Header: near-black band, wordmark + eyebrow, Box Boy in his green ring.
    `<tr><td style="background:${C.ink};border-radius:12px 12px 0 0;padding:22px 24px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`,
    `<td style="vertical-align:middle;">`,
    `<div style="${SERIF}font-size:24px;font-weight:900;color:#f5f4f0;letter-spacing:-0.5px;">Unify Learn<span style="color:${C.green};">.</span></div>`,
    `<div style="${SANS}font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.green};margin-top:6px;">${escHtml(opts.eyebrow)}</div>`,
    `</td>`,
    `<td width="76" style="vertical-align:middle;text-align:right;">`,
    `<img src="${boxBoy}" width="68" height="68" alt="Box Boy" style="display:inline-block;width:68px;height:68px;border-radius:50%;border:2px solid rgba(74,222,128,0.35);background:#151515;object-fit:cover;">`,
    `</td></tr></table>`,
    `</td></tr>`,
    // Card body.
    `<tr><td style="background:${C.card};border:1px solid ${C.border};border-top:none;border-radius:0 0 12px 12px;padding:26px 24px 22px;">`,
    `<div style="${SERIF}font-size:24px;line-height:1.25;font-weight:700;color:${C.ink};letter-spacing:-0.3px;">${escHtml(opts.title)}</div>`,
    `<div style="${SANS}font-size:15px;line-height:1.6;color:${C.ink};margin-top:12px;">${opts.body}</div>`,
    cta,
    opts.note ? `<div style="${SANS}font-size:12px;line-height:1.5;color:${C.text2};margin-top:20px;padding-top:14px;border-top:1px solid ${C.border};">${opts.note}</div>` : "",
    `</td></tr>`,
    // Footer.
    `<tr><td style="padding:16px 8px 0;text-align:center;${SANS}font-size:12px;line-height:1.6;color:${C.text3};">`,
    `<div style="${SERIF}font-style:italic;font-size:13px;color:${C.text2};">Built for the ones who build.</div>`,
    `Unify Learn &middot; Faculty of Engineering, Lagos State University`,
    `</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

// A highlighted panel inside the body (a code, a key fact, a quoted message).
export function panel(inner: string, tone: "green" | "grey" = "green"): string {
  const bg = tone === "green" ? C.greenTint : C.page;
  const bd = tone === "green" ? "#bbf7d0" : C.border;
  return `<div style="margin:14px 0 4px;padding:14px 16px;border-radius:10px;background:${bg};border:1px solid ${bd};">${inner}</div>`;
}

export type TopicVersion = { topic: number; version: number };

export function newNoteEmail(opts: {
  firstName: string;
  course: string;
  week: number;
  topics: TopicVersion[];
  url: string;
}): { subject: string; html: string } {
  const topicLine = opts.topics.map((t) => `Topic ${t.topic}`).join(" &middot; ") || "Fresh notes";
  const subject = `${opts.course} Week ${opts.week} is live on Unify Learn`;
  const html = brandEmail({
    eyebrow: "New notes",
    title: `${opts.course} · Week ${opts.week} is live`,
    pose: "reading-standing",
    body:
      `<p style="margin:0 0 8px;">Hi${opts.firstName ? ` ${escHtml(opts.firstName)}` : ""},</p>` +
      `<p style="margin:0;">This week's notes are ready. Read them while the class is still fresh.</p>` +
      panel(`<div style="font-size:13px;font-weight:700;color:${C.greenDeep};">${escHtml(opts.course)} &middot; Week ${opts.week}</div><div style="font-size:14px;margin-top:4px;">${topicLine}</div>`),
    cta: { url: opts.url, label: "Open the notes" },
    note: "You get this because new-note emails are on in your Unify Learn settings. Turn them off there any time.",
  });
  return { subject, html };
}

// ---- Supabase Auth templates (paste into Dashboard > Authentication >
// Email Templates; scripts/dump-email-templates.ts writes them out). Supabase
// fills {{ .ConfirmationURL }} and {{ .Email }} when it sends. ----
const AUTH_NOTE = "Didn't ask for this? Ignore it. Your account stays exactly as it is.";
export const SUPABASE_TEMPLATES: { name: string; subject: string; html: string }[] = [
  {
    name: "confirm-signup",
    subject: "Confirm your Unify Learn account",
    html: brandEmail({
      base: APP_URL,
      eyebrow: "Welcome",
      title: "One tap and you're in",
      pose: "cheer",
      body: `<p style="margin:0;">Confirm your email to start your Unify Learn account. Your courses, notes and timetable are waiting.</p>`,
      cta: { url: "{{ .ConfirmationURL }}", label: "Confirm my email" },
      note: AUTH_NOTE,
    }),
  },
  {
    name: "invite",
    subject: "You've been invited to Unify Learn",
    html: brandEmail({
      base: APP_URL,
      eyebrow: "Invitation",
      title: "You're invited to Unify Learn",
      pose: "thumbs-up",
      body: `<p style="margin:0;">You've been invited to join Unify Learn. Accept below and set your password.</p>`,
      cta: { url: "{{ .ConfirmationURL }}", label: "Accept invite" },
      note: AUTH_NOTE,
    }),
  },
  {
    name: "recovery",
    subject: "Reset your Unify Learn password",
    html: brandEmail({
      base: APP_URL,
      eyebrow: "Password reset",
      title: "Let's get you back in",
      pose: "wave-phone",
      body: `<p style="margin:0;">Someone (hopefully you) asked to reset the password for {{ .Email }}. This link works once and expires soon.</p>`,
      cta: { url: "{{ .ConfirmationURL }}", label: "Reset my password" },
      note: AUTH_NOTE,
    }),
  },
];
