import { supabaseAdmin } from "./supabase";

// Lecturer course claims (migration 0046). A lecturer adds a course they
// teach; each class taking it confirms through its class rep ("Is this your
// lecturer?"). Admin-assigned courses have no claim row and count as confirmed.
const variants = (c: string) => [...new Set([c, c.replace(/\s/g, "")])];
export const classKey = (department: string | null | undefined, level: string | null | undefined) => `${department || ""}|${level || ""}`;

export type ClaimStatus = { course: string; claimed: boolean; confirmed: string[]; declined: string[] };

// For each course the lecturer teaches: claimed by them (vs assigned), and
// which classes (department|level) said yes or no.
export async function claimStatuses(lecturerId: string, courses: string[]): Promise<ClaimStatus[]> {
  if (!courses.length) return [];
  const sb = supabaseAdmin();
  const { data: claims } = await sb.from("lecturer_claims").select("id,course").eq("lecturer_id", lecturerId).in("course", courses.flatMap(variants));
  const rows = (claims ?? []) as { id: string; course: string }[];
  const { data: conf } = rows.length
    ? await sb.from("lecturer_confirmations").select("claim_id,department,level,status").in("claim_id", rows.map((r) => r.id))
    : { data: [] };
  const decisions = (conf ?? []) as { claim_id: string; department: string; level: string; status: string }[];
  return courses.map((course) => {
    const claim = rows.find((r) => variants(course).includes(r.course));
    if (!claim) return { course, claimed: false, confirmed: [], declined: [] };
    const mine = decisions.filter((d) => d.claim_id === claim.id);
    return {
      course,
      claimed: true,
      confirmed: mine.filter((d) => d.status === "confirmed").map((d) => classKey(d.department, d.level)),
      declined: mine.filter((d) => d.status === "declined").map((d) => classKey(d.department, d.level)),
    };
  });
}

// Who a lecturer's post or PDF for this course may reach. Admin-assigned
// course: everyone taking it. Claimed course: only classes whose rep said
// yes; none yet means nobody (the lecturer is told to wait for the class rep).
export async function postAudience(lecturerId: string, course: string, takers: string[]): Promise<{ ok: boolean; ids: string[]; waiting: boolean }> {
  const [st] = await claimStatuses(lecturerId, [course]);
  if (!st || !st.claimed) return { ok: true, ids: takers, waiting: false };
  if (!st.confirmed.length) return { ok: false, ids: [], waiting: true };
  const allowed = new Set(st.confirmed);
  const ids: string[] = [];
  for (let i = 0; i < takers.length; i += 500) {
    const { data } = await supabaseAdmin().from("profiles").select("id,department,level").in("id", takers.slice(i, i + 500));
    for (const p of (data ?? []) as { id: string; department: string | null; level: string | null }[]) {
      if (allowed.has(classKey(p.department, p.level))) ids.push(p.id);
    }
  }
  return { ok: true, ids, waiting: false };
}
