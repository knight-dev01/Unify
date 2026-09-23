import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import type { AuthedRequest } from "./requireAuth";

const AUTHOR_ROLES = ["lecturer", "collaborator"];

async function isPlatformAdmin(userId: string): Promise<boolean> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb.from("profiles").select("is_admin").eq("id", userId).single();
    if ((data as { is_admin?: boolean } | null)?.is_admin) return true;
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!adminEmails.length) return false;
    const uRes = await sb.auth.admin.getUserById(userId);
    const email = ((uRes.data as { user?: { email?: string } } | null)?.user?.email || "").toLowerCase();
    return Boolean(email) && adminEmails.includes(email);
  } catch {
    return false;
  }
}

// Authoring gate: lecturers + collaborators + platform admins. Admins pass
// even with a student role so the owner is never locked out of the studio.
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
    if (!error && role && AUTHOR_ROLES.includes(role)) {
      next();
      return;
    }
    if (await isPlatformAdmin(userId)) {
      next();
      return;
    }
    res.status(403).json({ error: "Lecturer or collaborator role required" });
  } catch {
    res.status(403).json({ error: "Lecturer or collaborator role required" });
  }
}
