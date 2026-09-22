import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import type { AuthedRequest } from "./requireAuth";

const AUTHOR_ROLES = ["lecturer", "collaborator"];

// Authoring module gate: lecturers + collaborators only. Students get 403.
// NOTE (testing phase): users self-select their role at sign-in, so this is
// a UX gate, not a security boundary. Before public launch, move role
// assignment behind an admin approval flow.
export async function requireAuthor(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as AuthedRequest).userId;
  if (!userId) {
    res.status(401).json({ error: "Missing session" });
    return;
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();
    const role = (data as { role?: string } | null)?.role;
    if (error || !role || !AUTHOR_ROLES.includes(role)) {
      res.status(403).json({ error: "Lecturer or collaborator role required" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Lecturer or collaborator role required" });
  }
}
