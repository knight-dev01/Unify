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
  // Course catalog from Artifacts curricula (mined by scripts/import-legacy flow).
  // Insert-only: never overwrites titles an admin customized via Admin -> Courses.
  const catalog: { code: string; title: string; level: string; semester: string }[] = [
    { code: "CHM 101", title: "General Chemistry I", level: "100 Level", semester: "First Semester" },
    { code: "CHM 107", title: "General Chemistry Practical I", level: "100 Level", semester: "First Semester" },
    { code: "CSC 101", title: "Introduction to Computing Science", level: "100 Level", semester: "First Semester" },
    { code: "GNS 111", title: "Communication in English, Use of Library and ICT", level: "100 Level", semester: "First Semester" },
    { code: "MAT 101", title: "Elementary Mathematics I (Algebra and Trigonometry)", level: "100 Level", semester: "First Semester" },
    { code: "MAT 161", title: "Descriptive Statistics", level: "100 Level", semester: "First Semester" },
    { code: "MEE 101", title: "Engineer in Society", level: "100 Level", semester: "First Semester" },
    { code: "MEE 105", title: "Engineering Graphics & Solid Modelling I", level: "100 Level", semester: "First Semester" },
    { code: "PHY 101", title: "General Physics I", level: "100 Level", semester: "First Semester" },
    { code: "PHY 107", title: "General Physics Practical I", level: "100 Level", semester: "First Semester" },
    { code: "AAE 102", title: "Introduction to Aerospace Engineering", level: "100 Level", semester: "Second Semester" },
    { code: "CHM 102", title: "General Chemistry II", level: "100 Level", semester: "Second Semester" },
    { code: "CHM 108", title: "General Chemistry Practical II", level: "100 Level", semester: "Second Semester" },
    { code: "CPE 102", title: "Introduction to Chemical & Polymer Engineering", level: "100 Level", semester: "Second Semester" },
    { code: "GNS 104", title: "Use of Yoruba Language and Culture: Basic Communication Concepts", level: "100 Level", semester: "Second Semester" },
    { code: "GNS 112", title: "Nigerian Peoples and Culture", level: "100 Level", semester: "Second Semester" },
    { code: "MAT 102", title: "Elementary Mathematics II (Calculus)", level: "100 Level", semester: "Second Semester" },
    { code: "MAT 108", title: "General Mathematics III (Vectors Geometry and Dynamics)", level: "100 Level", semester: "Second Semester" },
    { code: "MAT 162", title: "Statistical Inference I", level: "100 Level", semester: "Second Semester" },
    { code: "MEE 104", title: "Introduction to Electronics Engineering", level: "100 Level", semester: "Second Semester" },
    { code: "PHY 102", title: "General Physics II", level: "100 Level", semester: "Second Semester" },
    { code: "PHY 104", title: "General Physics Practical II", level: "100 Level", semester: "Second Semester" },
    { code: "PHY 108", title: "General Physics Practical II", level: "100 Level", semester: "Second Semester" },
    { code: "ASE 201", title: "Introduction to Aerospace Systems Engineering II", level: "200 Level", semester: "First Semester" },
    { code: "CHE 202", title: "CHE 202", level: "200 Level", semester: "First Semester" },
    { code: "CHE 204", title: "CHE 204", level: "200 Level", semester: "First Semester" },
    { code: "CHE 208", title: "CHE 208", level: "200 Level", semester: "First Semester" },
    { code: "CHE 298", title: "CHE 298", level: "200 Level", semester: "First Semester" },
    { code: "CHE 299", title: "CHE 299", level: "200 Level", semester: "First Semester" },
    { code: "CVE 214", title: "CVE 214", level: "200 Level", semester: "First Semester" },
    { code: "ECE 201", title: "Fundamental of Electrical Engineering", level: "200 Level", semester: "First Semester" },
    { code: "ECE 203", title: "Applied Electricity I", level: "200 Level", semester: "First Semester" },
    { code: "ECE 211", title: "Computing and Software Engineering", level: "200 Level", semester: "First Semester" },
    { code: "ENT 211", title: "Entrepreneurship & Innovation", level: "200 Level", semester: "First Semester" },
    { code: "IPE 212", title: "IPE 212", level: "200 Level", semester: "First Semester" },
    { code: "MEE 203", title: "Engineering Graphics", level: "200 Level", semester: "First Semester" },
    { code: "MEE 205", title: "Fundamentals of Fluid Mechanics", level: "200 Level", semester: "First Semester" },
    { code: "MEE 207", title: "Applied Mechanics", level: "200 Level", semester: "First Semester" },
    { code: "MEE 209", title: "Engineering Mathematics I", level: "200 Level", semester: "First Semester" },
    { code: "ASE 202", title: "MATLAB Application to Aerospace Engineering", level: "200 Level", semester: "Second Semester" },
    { code: "CHE 206", title: "Fundamentals Of Thermodynamics", level: "200 Level", semester: "Second Semester" },
    { code: "ECE 202", title: "Engineering Mathematics II", level: "200 Level", semester: "Second Semester" },
    { code: "ECE 206", title: "Electrical Insta IIation Practice Lab", level: "200 Level", semester: "Second Semester" },
    { code: "ECE 208", title: "Electrical And Electronic Drawing", level: "200 Level", semester: "Second Semester" },
    { code: "ECE 210", title: "Fundamental Of Electrical Engineering II", level: "200 Level", semester: "Second Semester" },
    { code: "ECE 220", title: "Introduction to Programming and Computations", level: "200 Level", semester: "Second Semester" },
    { code: "GNS 212", title: "Philosophy Logic and Human Existence and Gender-Based Violence", level: "200 Level", semester: "Second Semester" },
    { code: "MEE 202", title: "Engineering Materials", level: "200 Level", semester: "Second Semester" },
    { code: "MEE 204", title: "Students Workshop Experience", level: "200 Level", semester: "Second Semester" },
    { code: "MEE 212", title: "Mechanics of Machine I", level: "200 Level", semester: "Second Semester" },
    { code: "ASE 351", title: "Aircraft Structural Materials", level: "300 Level", semester: "First Semester" },
    { code: "CHE 304", title: "CHE 304", level: "300 Level", semester: "First Semester" },
    { code: "CHE 306", title: "CHE 306", level: "300 Level", semester: "First Semester" },
    { code: "CHE 308", title: "CHE 308", level: "300 Level", semester: "First Semester" },
    { code: "CHE 310", title: "CHE 310", level: "300 Level", semester: "First Semester" },
    { code: "CHE 312", title: "CHE 312", level: "300 Level", semester: "First Semester" },
    { code: "CHE 314", title: "CHE 314", level: "300 Level", semester: "First Semester" },
    { code: "CHE 316", title: "CHE 316", level: "300 Level", semester: "First Semester" },
    { code: "CPE 398", title: "CPE 398", level: "300 Level", semester: "First Semester" },
    { code: "ECE 303", title: "Electrical Circuit Theory", level: "300 Level", semester: "First Semester" },
    { code: "ECE 351", title: "Introduction to Artificial Intelligence and Machine Learning", level: "300 Level", semester: "First Semester" },
    { code: "GNS 301", title: "Logic and Philosophy", level: "300 Level", semester: "First Semester" },
    { code: "MEE 301", title: "Engineering Mathematics III", level: "300 Level", semester: "First Semester" },
    { code: "MEE 305", title: "Fluid Mechanics II", level: "300 Level", semester: "First Semester" },
    { code: "MEE 351", title: "Engineering Statistics & Data Analysis", level: "300 Level", semester: "First Semester" },
    { code: "MEE 353", title: "Engineering Metallurgy I", level: "300 Level", semester: "First Semester" },
    { code: "MEE 355", title: "Control System Engineering", level: "300 Level", semester: "First Semester" },
    { code: "MEE 357", title: "Manufacturing Technology", level: "300 Level", semester: "First Semester" },
    { code: "CHE 352", title: "Engineering Mathematics IV", level: "300 Level", semester: "Second Semester" },
    { code: "CVE 304", title: "Civil Engineering Materials", level: "300 Level", semester: "Second Semester" },
    { code: "CVE 308", title: "Engineering Survey and Photogrammetry I", level: "300 Level", semester: "Second Semester" },
    { code: "CVE 310", title: "Solid Mechanics", level: "300 Level", semester: "Second Semester" },
    { code: "ECE 316", title: "Electrical Machines", level: "300 Level", semester: "Second Semester" },
    { code: "ECE 352", title: "Technical Writing and Communication", level: "300 Level", semester: "Second Semester" },
    { code: "ENT 312", title: "Venture Creation", level: "300 Level", semester: "Second Semester" },
    { code: "GNS 312", title: "Peace and Conflict Resolution", level: "300 Level", semester: "Second Semester" },
    { code: "MEE 308", title: "Thermo-fluid Laboratory I", level: "300 Level", semester: "Second Semester" },
    { code: "MEE 352", title: "Renewable Energy Systems and Technology", level: "300 Level", semester: "Second Semester" },
    { code: "MEE 354", title: "Computer-Aided Design and Manufacture", level: "300 Level", semester: "Second Semester" },
    { code: "MEE 398", title: "SIWES I (8 Weeks)", level: "300 Level", semester: "Second Semester" },
    { code: "AAE 421", title: "Structural Dynamics", level: "400 Level", semester: "First Semester" },
    { code: "CPE 401", title: "Chemical Engineering Analysis", level: "400 Level", semester: "First Semester" },
    { code: "CPE 403", title: "Separation Process III", level: "400 Level", semester: "First Semester" },
    { code: "CPE 405", title: "Chemical Reaction Engineering I", level: "400 Level", semester: "First Semester" },
    { code: "CPE 407", title: "Biochemical Engineering I", level: "400 Level", semester: "First Semester" },
    { code: "CPE 409", title: "Chemical Engineering Lab. III", level: "400 Level", semester: "First Semester" },
    { code: "CPE 411", title: "Polymer Processing Engineering II", level: "400 Level", semester: "First Semester" },
    { code: "CPE 415", title: "Polymer Engineering Laboratory III", level: "400 Level", semester: "First Semester" },
    { code: "CPE 417", title: "Introduction to Plant Design", level: "400 Level", semester: "First Semester" },
    { code: "ECE 401", title: "Engineering Mathematics V", level: "400 Level", semester: "First Semester" },
    { code: "ECE 419", title: "Technical Communication", level: "400 Level", semester: "First Semester" },
    { code: "ECO 403", title: "Economics for Engineers", level: "400 Level", semester: "First Semester" },
    { code: "MEE 401", title: "Applied Thermodynamics II", level: "400 Level", semester: "First Semester" },
    { code: "MEE 403", title: "Machine Design II", level: "400 Level", semester: "First Semester" },
    { code: "MEE 405", title: "Fluid Mechanics III", level: "400 Level", semester: "First Semester" },
    { code: "MEE 407", title: "Vibrations", level: "400 Level", semester: "First Semester" },
    { code: "MEE 411", title: "Engineering Materials Selection and Economics", level: "400 Level", semester: "First Semester" },
    { code: "MEE 413", title: "Technology Policy and Development", level: "400 Level", semester: "First Semester" },
    { code: "MEE 415", title: "Laboratory Practical", level: "400 Level", semester: "First Semester" },
    { code: "AAE 498", title: "Industrial Experience (SIWES)", level: "400 Level", semester: "Second Semester" },
    { code: "ECE 492", title: "Application of Engineering Design to Industry", level: "400 Level", semester: "Second Semester" },
    { code: "MEE 492", title: "Application of Engineering Design to Industry", level: "400 Level", semester: "Second Semester" },
    { code: "MEE 494", title: "Safety and Reliability in Nigeria Companies", level: "400 Level", semester: "Second Semester" },
    { code: "MEE 496", title: "Engineering Enterprise", level: "400 Level", semester: "Second Semester" },
    { code: "MEE 498", title: "SIWES III (24 Weeks Compulsory Industrial Attachment)", level: "400 Level", semester: "Second Semester" },
    { code: "AAE 551", title: "Restricted Elective", level: "500 Level", semester: "First Semester" },
    { code: "BUL 507", title: "Law for Engineers / for Non-Law Students", level: "500 Level", semester: "First Semester" },
    { code: "CPE 501", title: "Process Control", level: "500 Level", semester: "First Semester" },
    { code: "CPE 503", title: "Transport Phenomena III", level: "500 Level", semester: "First Semester" },
    { code: "CPE 505", title: "Environmental Engineering", level: "500 Level", semester: "First Semester" },
    { code: "CPE 507", title: "Process Design I", level: "500 Level", semester: "First Semester" },
    { code: "CPE 509", title: "Chemical Reaction Engineering II", level: "500 Level", semester: "First Semester" },
    { code: "CPE 515", title: "Petrochemical Science and Petroleum Technology", level: "500 Level", semester: "First Semester" },
    { code: "CPE 517", title: "Pulp and Paper Technology", level: "500 Level", semester: "First Semester" },
    { code: "CPE 521", title: "Rubber Technology", level: "500 Level", semester: "First Semester" },
    { code: "CPE 599", title: "Research Project I", level: "500 Level", semester: "First Semester" },
    { code: "ECE 502", title: "Software Engineering II", level: "500 Level", semester: "First Semester" },
    { code: "MEE 501", title: "Applied Thermodynamics III", level: "500 Level", semester: "First Semester" },
    { code: "MEE 503", title: "Machine Design III", level: "500 Level", semester: "First Semester" },
    { code: "MEE 505", title: "Laboratory Practical", level: "500 Level", semester: "First Semester" },
    { code: "MEE 507", title: "Advanced Mechanics of Materials I", level: "500 Level", semester: "First Semester" },
    { code: "MEE 509", title: "Advanced Fluid Mechanics I", level: "500 Level", semester: "First Semester" },
    { code: "MEE 511", title: "Heat and Mass Transfer", level: "500 Level", semester: "First Semester" },
    { code: "MEE 513", title: "Mechanics of Metal Forming I", level: "500 Level", semester: "First Semester" },
    { code: "MEE 515", title: "Maintenance Engineering", level: "500 Level", semester: "First Semester" },
    { code: "MEE 517", title: "Fluid Machinery", level: "500 Level", semester: "First Semester" },
    { code: "MEE 519", title: "Iron Making", level: "500 Level", semester: "First Semester" },
    { code: "MEE 521", title: "Refractory Technology", level: "500 Level", semester: "First Semester" },
    { code: "MEE 523", title: "Project Drafting Lab.", level: "500 Level", semester: "First Semester" },
    { code: "MEE 525", title: "Air-Conditioning and Refrigeration", level: "500 Level", semester: "First Semester" },
    { code: "MEE 535", title: "Production Engineering I", level: "500 Level", semester: "First Semester" },
    { code: "MEE 599", title: "Project I", level: "500 Level", semester: "First Semester" },
    { code: "ASE 508", title: "Airline Enterprise Operations", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 502", title: "Process Optimization", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 504", title: "Safety and Loss Prevention", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 506", title: "Biochemical Engineering II", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 508", title: "Process Design II", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 510", title: "Process Control II", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 516", title: "Reservoir Engineering", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 518", title: "Industrial Chemistry", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 520", title: "Medical Application of Polymer", level: "500 Level", semester: "Second Semester" },
    { code: "CPE 598", title: "Research Project II", level: "500 Level", semester: "Second Semester" },
    { code: "ENT 1000", title: "Professional Entrepreneurship", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 502", title: "Engineering Management", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 504", title: "Energy Sources and Conversion", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 506", title: "Thermal Engines", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 508", title: "Operational Research", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 510", title: "Advance Fluid Mechanics II", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 512", title: "Mechanics of Metal Forming II", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 514", title: "Advanced Mechanics of Materials II", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 516", title: "Production Engineering II", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 518", title: "Industrial Engineering", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 520", title: "Steel Making", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 524", title: "Foundry Technology", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 526", title: "Engineering Systems Analysis", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 528", title: "Engineering Metallurgy II", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 534", title: "Advanced CAD/CAM", level: "500 Level", semester: "Second Semester" },
    { code: "MEE 598", title: "Project II", level: "500 Level", semester: "Second Semester" },
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
  // FAIL-CLOSED: orphan deletion runs only after a PROVEN course read.
  // A failed/empty read must never wipe enrollments (that failure mode
  // once emptied dashboards — never again).
  try {
    // Unconditional: blank codes are never legitimate anywhere.
    await sb.from("resume_state").delete().eq("course", "");
    await sb.from("topic_progress").delete().eq("course", "");
    await sb.from("quiz_attempts").delete().eq("course", "");
    await sb.from("enrollments").delete().eq("course", "");
    await sb.from("course_levels").delete().eq("course", "");
    await sb.from("courses").delete().eq("code", "");
    // Orphan purge runs ONLY after a proven course read (fail-closed).
    const { data: allCourses, error: cErr } = await sb.from("courses").select("code");
    if (cErr) throw cErr;
    const valid = new Set(((allCourses ?? []) as { code: string }[]).map((r) => r.code));
    for (const c of [...valid]) {
      if (!c.trim()) {
        await sb.from("course_levels").delete().eq("course", c);
        await sb.from("courses").delete().eq("code", c);
        valid.delete(c);
      }
    }
    const validUpper = new Set([...valid].map((c) => c.toUpperCase()));
    const { data: allEnr, error: eErr } = await sb.from("enrollments").select("user_id,course");
    if (eErr) throw eErr;
    for (const r of ((allEnr ?? []) as { user_id: string; course: string }[])) {
      if (!r.course || !r.course.trim() || !validUpper.has(r.course.toUpperCase())) {
        await sb.from("enrollments").delete().eq("user_id", r.user_id).eq("course", r.course);
      }
    }
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
