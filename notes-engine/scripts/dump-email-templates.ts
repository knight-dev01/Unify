// Generates static HTML snapshots of every email template for pasting
// into Supabase Dashboard > Authentication > Email Templates, and for
// previewing in a browser. Single source of truth stays in
// src/lib/email-templates.ts — regenerate after any template change:
//   npx tsx scripts/dump-email-templates.ts
const fs = require("fs");
const path = require("path");
const { SUPABASE_TEMPLATES, newNoteEmail, welcomeEmail } = require("../src/lib/email-templates");

export {};

const outDir = path.join(__dirname, "..", "emails");
fs.mkdirSync(outDir, { recursive: true });

const files = [
  ...SUPABASE_TEMPLATES,
  {
    name: "new-note-published",
    ...newNoteEmail({
      firstName: "Ada",
      course: "CVE 214",
      week: 1,
      topics: [
        { topic: 1, version: 2 },
        { topic: 2, version: 1 },
      ],
      url: "https://unify-virid.vercel.app/learn/CVE%20214/week/1",
    }),
  },
  {
    name: "welcome",
    ...welcomeEmail({ firstName: "Ada", url: "https://unify-virid.vercel.app/dashboard" }),
  },
];

for (const f of files) {
  const doc = [
    "<!-- subject: " + f.subject + " -->",
    "<!-- Unify Learn template — Regenerate with: npx tsx scripts/dump-email-templates.ts -->",
    f.html,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, f.name + ".html"), doc, "utf8");
  console.log("wrote emails/" + f.name + ".html");
}
