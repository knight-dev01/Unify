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
  const { error: cErr } = await sb
    .from("courses")
    .upsert({ code: "MEE 352", title: "Unify Learn" }, { onConflict: "code" });
  if (cErr) throw cErr;
  // Catalog test data (legacy course codes; levels by numbering convention).
  const catalog: { code: string; level: string }[] = [
    { code: "CVE 214", level: "200 Level" },
    { code: "ECE 202", level: "200 Level" },
    { code: "ECE 210", level: "200 Level" },
    { code: "ECE 220", level: "200 Level" },
    { code: "IPE 212", level: "200 Level" },
    { code: "MEE 202", level: "200 Level" },
    { code: "MEE 212", level: "200 Level" },
  ];
  for (const c of catalog) {
    const { error: ccErr } = await sb.from("courses").upsert({ code: c.code, title: c.code }, { onConflict: "code" });
    if (ccErr) throw ccErr;
    const { error: lErr } = await sb
      .from("course_levels")
      .upsert({ course: c.code, level: c.level, semester: "First Semester" }, { onConflict: "course,level" });
    if (lErr) throw lErr;
  }
  const { error: meeLevelErr } = await sb
    .from("course_levels")
    .upsert({ course: "MEE 352", level: "300 Level", semester: "First Semester" }, { onConflict: "course,level" });
  if (meeLevelErr) throw meeLevelErr;
  const { error: wErr } = await sb.from("weeks").upsert(
    {
      course: "MEE 352",
      week: 1,
      title: "Week 1",
      subtitle: "Getting started",
      note_json: WEEK1_NOTE,
    },
    { onConflict: "course,week" }
  );
  if (wErr) throw wErr;
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
