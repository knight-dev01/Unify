import { supabaseAdmin } from "./supabase";

const WEEK1_NOTE = {
  course: "MEE 352",
  week: 1,
  title: "Week 1",
  subtitle: "Getting started",
  learningOutcome: "",
  metaChips: [],
  tags: [],
  topics: [],
  eoq: { questions: [] },
};

// Idempotent reference seed (LASU + MEE 352 Week 1). Safe to run on every
// boot/deploy: upserts never duplicate, never touch user data.
export async function ensureSeeded(): Promise<void> {
  const sb = supabaseAdmin();
  const { error: uErr } = await sb
    .from("universities")
    .upsert({ name: "Lagos State University", short_name: "LASU" }, { onConflict: "name" });
  if (uErr) throw uErr;
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
    { code: "MEE 352", title: "Unify Learn", level: "300 Level", semester: "First Semester" },
  ];
  for (const c of catalog) {
    const { data: exists } = await sb.from("courses").select("code").eq("code", c.code).single();
    if (!exists) {
      const { error: ccErr } = await sb.from("courses").insert({ code: c.code, title: c.title });
      if (ccErr) throw ccErr;
    }
    const { error: lErr } = await sb
      .from("course_levels")
      .upsert({ course: c.code, level: c.level, semester: c.semester }, { onConflict: "course,level" });
    if (lErr) throw lErr;
  }
  // MEE 352 Week 1 shell: insert-only (never upsert) so reboots can't
  // wipe an authored title/subtitle/eoq once real content exists.
  const { data: w1 } = await sb.from("weeks").select("course").eq("course", "MEE 352").eq("week", 1).single();
  if (!w1) {
    const { error: wErr } = await sb.from("weeks").insert({
      course: "MEE 352",
      week: 1,
      title: "Week 1",
      subtitle: "Getting started",
      note_json: WEEK1_NOTE,
    });
    if (wErr) throw wErr;
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
  }
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
