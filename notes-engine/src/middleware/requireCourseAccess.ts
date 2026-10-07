import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import type { AuthedRequest } from "./requireAuth";

// Course-access gate (BUG-001): contributors reach ONLY the courses they
// are assigned to (teaching enrollments). Everyone else passes:
// - lecturers teach broadly, students are gated client-side by enrollment,
// - platform admins (flag, role, or ADMIN_EMAILS) go everywhere.
// Reads the course from req.params.code, or from the note row for :id.
export async function requireCourseAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as AuthedRequest).userId;
  if (!userId) {
    res.status(401).json({ error: "Missing session" });
    return;
  }
  try {
    const sb = supabaseAdmin();
    const { data: prof } = await sb
      .from("profiles")
      .select("role,is_admin")
      .eq("id", userId)
      .single();
    const p = prof as { role?: string; is_admin?: boolean } | null;
    // Non-contributors pass here (lecturers teach broadly, students are
    // gated client-side by enrollment, admins of any kind go everywhere).
    if (!p || p.role !== "contributor" || p.is_admin) {
      next();
      return;
    }
    let course = (req.params.code ? decodeURIComponent(req.params.code) : "").trim().toUpperCase();
    // Single-note reads carry no course param — resolve via the note row.
    if (!course && req.params.id) {
      const { data: note } = await sb
        .from("topic_notes")
        .select("course")
        .eq("id", req.params.id)
        .single();
      course = ((note as { course?: string } | null)?.course || "").trim().toUpperCase();
    }
    // Request bodies (publish) carry the course too.
    if (!course && req.body && typeof req.body.course === "string") {
      course = String(req.body.course).trim().toUpperCase();
    }
    if (!course) {
      res.status(400).json({ error: "Invalid course" });
      return;
    }
    const variants = [...new Set([course, course.replace(/\s/g, "")])];
    const { data: rows } = await sb
      .from("enrollments")
      .select("course")
      .eq("user_id", userId)
      .eq("kind", "teaching")
      .in("course", variants)
      .limit(10);
    if (!rows || rows.length === 0) {
      res.status(403).json({ error: "This course is not assigned to you" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "This course is not assigned to you" });
  }
}
