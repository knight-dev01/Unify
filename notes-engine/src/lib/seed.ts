import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";

// Starter content: honest placeholder notes (not fake lectures) so every
// seeded course opens with something readable. Lecturers publish real
// topics over these; versions stack, nothing is wiped.
function starterShell(code: string) {
  return {
    course: code,
    week: 1,
    title: "Week 1",
    subtitle: "Starter note",
    learningOutcome: `Settle into ${code}: read the starter topic and mark it complete.`,
    metaChips: [code, "Week 1"],
    tags: [],
    topics: [],
    eoq: { questions: [] },
  };
}

function starterTopic(code: string, title: string) {
  const abbr = code.split(" ")[0] || code;
  const named = title && title !== code ? ` (${title})` : "";
  return {
    number: 1,
    title: `${code} — Getting started`,
    abbr,
    subtopics: [
      {
        number: "1.1",
        abbr,
        title: `Welcome to ${code}`,
        content: [
          {
            type: "paragraph",
            text: `This starter note holds the place for ${code}${named} while your lecturer publishes full weekly topics. Everything you do here counts: complete topics for XP and grow your streak.`,
          },
          {
            type: "bullets",
            items: [
              "New topics land here under Week 1, 2, 3… as your lecturer publishes them.",
              "Tap Mark Topic Complete under any topic to earn 10 XP.",
              "End-of-week quizzes appear once your lecturer publishes question sets.",
            ],
          },
        ],
        miniCheck: {
          questions: [
            {
              type: "mcq",
              question: `A new ${code} topic appears under Week 2. What do you do?`,
              options: ["Ignore it", "Read it and mark it complete", "Delete it"],
              correctIndex: 1,
            },
          ],
        },
      },
    ],
  };
}

// Idempotent reference seed (LASU + per-level catalog + starter notes).
// Safe to run on every boot/deploy: inserts never duplicate, never touch
// user data, and never overwrite admin-customized titles.
export async function ensureSeeded(): Promise<void> {
  const sb = supabaseAdmin();
  // Fault isolation: one bad row/file must never abort the whole seed
  // (that failure mode leaves the app with zero weeks). Errors are logged
  // with context and the run continues; a summary lands in the logs.
  const stats = { courses: 0, shells: 0, topics: 0, eoqFilled: 0, titlesUpgraded: 0, errors: [] as string[] };
  const fail = (where: string, e: unknown) => {
    const msg = `${where}: ${e instanceof Error ? e.message : String(e)}`;
    stats.errors.push(msg);
    console.warn(`[seed] ${msg}`);
  };
  const { error: uErr } = await sb
    .from("universities")
    .upsert({ name: "Lagos State University", short_name: "LASU" }, { onConflict: "name" });
  if (uErr) throw uErr;
  // Admin-owned active semester (students see only this semester's courses).
  // Insert-only: reboots must never revert an admin's semester switch.
  const { data: semRow } = await sb.from("app_settings").select("key").eq("key", "current_semester").single();
  if (!semRow) {
    const { error: semErr } = await sb
      .from("app_settings")
      .insert({ key: "current_semester", value: "First Semester" });
    if (semErr) throw semErr;
  }
  // Course catalog, seeded per level so each level only sees its own
  // courses (codes match level by numbering convention). Insert-only:
  // never overwrites titles an admin customized via Admin → Courses.
  // 100 Level starters are standard first-year engineering generals —
  // correct them in Admin → Courses if your faculty numbering differs.
  const catalog: { code: string; title: string; level: string; semester: string }[] = [
    { code: "GNS 101", title: "Use of English I", level: "100 Level", semester: "First Semester" },
    { code: "MTH 101", title: "Elementary Mathematics I", level: "100 Level", semester: "First Semester" },
    { code: "PHY 101", title: "General Physics I", level: "100 Level", semester: "First Semester" },
    { code: "CHM 101", title: "General Chemistry I", level: "100 Level", semester: "First Semester" },
    { code: "GNS 102", title: "Use of English II", level: "100 Level", semester: "Second Semester" },
    { code: "MTH 102", title: "Elementary Mathematics II", level: "100 Level", semester: "Second Semester" },
    { code: "PHY 102", title: "General Physics II", level: "100 Level", semester: "Second Semester" },
    { code: "CHM 102", title: "General Chemistry II", level: "100 Level", semester: "Second Semester" },
    { code: "CVE 214", title: "CVE 214", level: "200 Level", semester: "First Semester" },
    { code: "ECE 202", title: "ECE 202", level: "200 Level", semester: "First Semester" },
    { code: "ECE 210", title: "ECE 210", level: "200 Level", semester: "First Semester" },
    { code: "ECE 220", title: "ECE 220", level: "200 Level", semester: "First Semester" },
    { code: "IPE 212", title: "IPE 212", level: "200 Level", semester: "First Semester" },
    { code: "MEE 202", title: "MEE 202", level: "200 Level", semester: "First Semester" },
    { code: "MEE 212", title: "MEE 212", level: "200 Level", semester: "First Semester" },
    { code: "MEE 352", title: "MEE 352", level: "300 Level", semester: "First Semester" },
  ];
  for (const c of catalog) {
    try {
      const { data: exists } = await sb.from("courses").select("code").eq("code", c.code).single();
      if (!exists) {
        const { error: ccErr } = await sb.from("courses").insert({ code: c.code, title: c.title });
        if (ccErr) throw ccErr;
      }
      const { error: lErr } = await sb
        .from("course_levels")
        .upsert({ course: c.code, level: c.level, semester: c.semester }, { onConflict: "course,level" });
      if (lErr) throw lErr;
      stats.courses += 1;
    } catch (e) {
      fail(`catalog ${c.code}`, e);
    }
  }
  // Real legacy content (seed-content/*.json, built by
  // scripts/import-legacy.mjs from the archived Coursecontents).
  // Insert-only and runs BEFORE the backfill + starters so real weeks,
  // quizzes and course titles always win over placeholders.
  await seedLegacyContent(sb, stats, fail);
  // seed-content dir: works both under tsx (src/lib) and tsc (dist/src/lib).
function findSeedDir(): string | null {
  const candidates = [
    join(__dirname, "..", "..", "seed-content"),
    join(__dirname, "..", "..", "..", "seed-content"),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && existsSync(join(c, "_report.json"))) return c;
    } catch {
      // next candidate
    }
  }
  // Fallback: any dir with week JSON in it (lets the importer rename freely).
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // next candidate
    }
  }
  return null;
}

type SeedNote = {
  course: string;
  week: number;
  title?: string;
  subtitle?: string;
  courseTitle?: string;
  topics?: Record<string, unknown>[];
} & Record<string, unknown>;

type SeedStats = {
  courses: number;
  shells: number;
  topics: number;
  eoqFilled: number;
  titlesUpgraded: number;
  errors: string[];
};

// Loads converted legacy weeks: course rows (+ real titles over
// placeholders), week shells (+ quiz fill over empty), v1 topic rows.
// Everything is insert-only; authored content is never touched.
async function seedLegacyContent(
  sb: SupabaseClient,
  stats: SeedStats,
  fail: (where: string, e: unknown) => void
): Promise<void> {
  const dir = findSeedDir();
  if (!dir) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  } catch {
    return;
  }
  for (const f of files) {
    try {
    let note: SeedNote;
    try {
      note = JSON.parse(readFileSync(join(dir, f), "utf8")) as SeedNote;
    } catch {
      continue;
    }
    if (!note || typeof note.course !== "string" || !Number.isInteger(note.week)) continue;
    const code = note.course.toUpperCase();
    const week = note.week;
    const topics = Array.isArray(note.topics) ? note.topics : [];
    const { data: cRow } = await sb.from("courses").select("code,title").eq("code", code).single();
    if (!cRow) {
      const { error: cErr } = await sb.from("courses").insert({
        code,
        title: typeof note.courseTitle === "string" && note.courseTitle ? note.courseTitle : code,
      });
      if (cErr) throw cErr;
    } else if (
      (cRow as { title?: string }).title === code &&
      typeof note.courseTitle === "string" &&
      note.courseTitle
    ) {
      const { error: tErr } = await sb.from("courses").update({ title: note.courseTitle }).eq("code", code);
      if (tErr) throw tErr;
      stats.titlesUpgraded += 1;
    }
    const { courseTitle: _dropTitle, topics: _dropTopics, ...rest } = note;
    const shellJson = { ...rest, topics: [] as unknown[] };
    const { data: shell } = await sb
      .from("weeks")
      .select("title,subtitle,note_json")
      .eq("course", code)
      .eq("week", week)
      .single();
    if (!shell) {
      const { error: sErr } = await sb.from("weeks").insert({
        course: code,
        week,
        author_id: null,
        title: typeof note.title === "string" && note.title ? note.title : `Week ${week}`,
        subtitle: typeof note.subtitle === "string" ? note.subtitle : "",
        note_json: shellJson,
      });
      if (sErr) throw sErr;
      stats.shells += 1;
    } else {
      const s = shell as { title?: string; subtitle?: string; note_json?: Record<string, unknown> };
      const curEoq = (s.note_json as { eoq?: { questions?: unknown[] } } | undefined)?.eoq?.questions;
      const newEoq = (shellJson as { eoq?: { questions?: unknown[] } }).eoq?.questions;
      const patch: Record<string, unknown> = {};
      if (s.subtitle === "Starter note") {
        patch.title = typeof note.title === "string" && note.title ? note.title : `Week ${week}`;
        patch.subtitle = typeof note.subtitle === "string" ? note.subtitle : "";
        patch.note_json = shellJson;
      } else if ((!Array.isArray(curEoq) || curEoq.length === 0) && Array.isArray(newEoq) && newEoq.length > 0) {
        patch.note_json = { ...(s.note_json || {}), eoq: { questions: newEoq } };
      }
      if (Object.keys(patch).length) {
        const { error: uErr } = await sb.from("weeks").update(patch).eq("course", code).eq("week", week);
  if (uErr) throw uErr;
  // Hygiene: purge blank/orphan rows (empty codes break week lookups and
  // render as blank courses; they were never legitimate data). Cascades
  // clear their weeks/notes too — unreachable junk only.
  try {
    const { data: allCourses } = await sb.from("courses").select("code");
    const valid = new Set(((allCourses ?? []) as { code: string }[]).map((r) => r.code));
    for (const c of [...valid]) {
      if (!c || !c.trim()) {
        await sb.from("course_levels").delete().eq("course", c);
        await sb.from("courses").delete().eq("code", c);
        valid.delete(c);
      }
    }
    const { data: allEnr } = await sb.from("enrollments").select("user_id,course");
    const validUpper = new Set([...valid].map((c) => c.toUpperCase()));
    for (const r of ((allEnr ?? []) as { user_id: string; course: string }[])) {
      if (!r.course || !r.course.trim() || !validUpper.has(r.course.toUpperCase())) {
        await sb.from("enrollments").delete().eq("user_id", r.user_id).eq("course", r.course);
      }
    }
    await sb.from("resume_state").delete().eq("course", "");
    await sb.from("topic_progress").delete().eq("course", "");
    await sb.from("quiz_attempts").delete().eq("course", "");
  } catch (e) {
    fail("hygiene", e);
  }
        if (!("title" in patch)) stats.eoqFilled += 1;
      }
    }
    for (const t of topics) {
      const num = Number((t as { number?: unknown }).number);
      if (!Number.isInteger(num) || num < 1) continue;
      const { data: ex } = await sb
        .from("topic_notes")
        .select("id")
        .eq("course", code)
        .eq("week", week)
        .eq("topic", num)
        .limit(1);
      if ((ex as unknown[] | null)?.length) continue;
      const { error: iErr } = await sb.from("topic_notes").insert({
        course: code,
        week,
        topic: num,
        version: 1,
        title: typeof (t as { title?: unknown }).title === "string" ? ((t as { title?: string }).title as string) : "",
        note_json: t,
        author_id: null,
      });
      if (iErr) throw iErr;
        stats.topics += 1;
      }
    } catch (e) {
      fail(`seed-content ${f}`, e);
    }
  }
}

// One-time backfill: legacy week-embedded topics -> topic_notes v1 rows.
// Idempotent: only weeks that still carry embedded topics are touched,
// and only topics with no version row yet. Embedded topics that migrate
// are stripped from the shell so the versioned rows become canonical.
  const { data: legacyWeeks } = await sb.from("weeks").select("course,week,author_id,note_json");
  for (const w of ((legacyWeeks ?? []) as {
    course: string;
    week: number;
    author_id: string | null;
    note_json: { topics?: unknown } & Record<string, unknown>;
  }[])) {
    try {
    const embedded = Array.isArray(w.note_json?.topics)
      ? (w.note_json.topics as Record<string, unknown>[])
      : [];
    const valid = embedded.filter((t) => Number.isInteger(Number(t.number)) && Number(t.number) >= 1);
    if (valid.length === 0) continue;
    for (const t of valid) {
      const num = Number(t.number);
      const { data: existing } = await sb
        .from("topic_notes")
        .select("id")
        .eq("course", w.course)
        .eq("week", w.week)
        .eq("topic", num)
        .limit(1);
      if ((existing as unknown[] | null)?.length) continue;
      const { error: bErr } = await sb.from("topic_notes").insert({
        course: w.course,
        week: w.week,
        topic: num,
        version: 1,
        title: typeof t.title === "string" ? t.title : "",
        note_json: t,
        author_id: w.author_id,
      });
      if (bErr) throw bErr;
    }
    const leftover = embedded.filter((t) => !Number.isInteger(Number(t.number)));
    const { error: sErr } = await sb
      .from("weeks")
      .update({ note_json: { ...w.note_json, topics: leftover } })
      .eq("course", w.course)
      .eq("week", w.week);
    if (sErr) throw sErr;
    } catch (e) {
      fail(`backfill ${w.course} w${w.week}`, e);
    }
  }
  // Starter content runs AFTER the backfill so real legacy topics always
  // win: every seeded course ends up with a Week 1 shell + one v1 starter
  // topic, meaning every level opens with at least one readable note.
  for (const c of catalog) {
    try {
    const { data: shell } = await sb.from("weeks").select("course").eq("course", c.code).eq("week", 1).single();
    if (!shell) {
      const { error: shErr } = await sb.from("weeks").insert({
        course: c.code,
        week: 1,
        author_id: null,
        title: "Week 1",
        subtitle: "Starter note",
        note_json: starterShell(c.code),
      });
      if (shErr) throw shErr;
      stats.shells += 1;
    }
    const { data: t1 } = await sb
      .from("topic_notes")
      .select("id")
      .eq("course", c.code)
      .eq("week", 1)
      .eq("topic", 1)
      .limit(1);
    if (!(t1 as unknown[] | null)?.length) {
      const { error: tErr } = await sb.from("topic_notes").insert({
        course: c.code,
        week: 1,
        topic: 1,
        version: 1,
        title: `${c.code} — Getting started`,
        note_json: starterTopic(c.code, c.title),
        author_id: null,
      });
      if (tErr) throw tErr;
      stats.topics += 1;
    }
    } catch (e) {
      fail(`starter ${c.code}`, e);
    }
  }
  // Cleanup of the old MEE 352 stub title — only when still the untouched stub.
  try {
    await sb.from("courses").update({ title: "MEE 352" }).eq("code", "MEE 352").eq("title", "Unify Learn");
  } catch (e) {
    fail("mee352 title cleanup", e);
  }
  console.info(
    `[seed] done: ${stats.courses} courses, ${stats.shells} shells, ${stats.topics} topics, ` +
      `eoq filled ${stats.eoqFilled}, titles upgraded ${stats.titlesUpgraded}, errors ${stats.errors.length}`
  );
}

const DEFAULT_ADMIN_EMAIL = "unify.admin@unify.learn";
const DEFAULT_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "unify.admin";

// Creates the default platform admin, pre-confirmed (no email verification).
// Idempotent: does nothing when the account already exists, so it never
// resets a rotated password. Rotate via Supabase Auth dashboard after login.
export async function ensureDefaultAdmin(): Promise<void> {
  const sb = supabaseAdmin();
  const finish = async (id: string) => {
    const { error } = await sb.from("profiles").upsert(
      { id, first_name: "Unify Admin", email: DEFAULT_ADMIN_EMAIL, role: "collaborator", is_admin: true },
      { onConflict: "id" }
    );
    if (error) throw error;
  };
  const { data: existing } = await sb.from("profiles").select("id").eq("email", DEFAULT_ADMIN_EMAIL).single();
  if ((existing as { id?: string } | null)?.id) return;
  try {
    const { data, error } = await sb.auth.admin.createUser({
      email: DEFAULT_ADMIN_EMAIL,
      password: DEFAULT_ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Unify Admin" },
    });
    if (error) throw error;
    const newId = (data as { user?: { id?: string } } | null)?.user?.id;
    if (!newId) throw new Error("admin user not returned");
    await finish(newId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already/i.test(msg)) throw e;
    // Auth row exists but profile missing (partial state) -> adopt it.
    const { data: listed } = await sb.auth.admin.listUsers();
    const found = (
      (listed as { users?: { id?: string; email?: string }[] } | null)?.users || []
    ).find((u) => (u.email || "").toLowerCase() === DEFAULT_ADMIN_EMAIL);
    if (!found?.id) throw e;
    await finish(found.id);
  }
}
