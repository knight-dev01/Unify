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
