import type { Request, Response, NextFunction } from "express";
import { supabaseAnon } from "../lib/supabase";

export interface AuthedRequest extends Request {
  userId?: string;
}

// A token that the Auth server has just confirmed is remembered for up to 60 s
// (never past its own expiry), so a busy session makes one Auth call a minute
// instead of one per request. That is what lets a few hundred students use the
// app at the same time without hammering Supabase Auth. A signed-out or revoked
// session can linger for at most that minute. Entries are bounded.
const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;
const seen = new Map<string, { userId: string; until: number }>();

function expiryOf(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Verifies the Supabase access-token JWT via the Auth server and attaches userId.
// Keeps Request in the signature (express 4 typings) and casts internally.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const now = Date.now();
  const hit = seen.get(token);
  if (hit && hit.until > now) {
    (req as AuthedRequest).userId = hit.userId;
    next();
    return;
  }
  if (hit) seen.delete(token);
  try {
    const { data, error } = await supabaseAnon().auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const exp = expiryOf(token);
    const until = Math.min(now + TTL_MS, exp || now + TTL_MS);
    if (until > now) {
      if (seen.size >= MAX_ENTRIES) seen.clear();
      seen.set(token, { userId: data.user.id, until });
    }
    (req as AuthedRequest).userId = data.user.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session" });
  }
}
