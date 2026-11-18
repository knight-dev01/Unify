import type { Request, Response, NextFunction } from "express";
import { supabaseAnon } from "../lib/supabase";
import { verifyLocally } from "../lib/jwt";

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
// Tokens checked locally (lib/jwt) are still confirmed with Supabase Auth in
// the background at most every 5 minutes; one Auth rejects (signed out,
// banned, deleted) is refused from then on.
const CONFIRM_MS = 5 * 60 * 1000;
const confirmedAt = new Map<string, number>();
const revoked = new Set<string>();
function confirmLater(token: string): void {
  const now = Date.now();
  if (now - (confirmedAt.get(token) || 0) < CONFIRM_MS) return;
  if (confirmedAt.size >= MAX_ENTRIES) confirmedAt.clear();
  confirmedAt.set(token, now);
  supabaseAnon().auth.getUser(token).then(({ data, error }) => {
    // Only a real rejection from Auth (4xx) revokes. A timeout or Auth outage
    // must never sign a student out.
    if (error && !isRejection(error)) {
      confirmedAt.delete(token);
      return;
    }
    if (error || !data.user) {
      if (revoked.size >= MAX_ENTRIES) revoked.clear();
      revoked.add(token);
      seen.delete(token);
    }
  }).catch(() => { confirmedAt.delete(token); /* network blip: try again next time */ });
}

// Auth said no (bad, expired or revoked token) vs Auth couldn't answer.
function isRejection(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}
const unavailable = (res: Response) =>
  res.status(503).json({ error: "Sign-in check is briefly unavailable. Try again in a moment." });

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
  if (revoked.has(token)) {
    res.status(401).json({ error: "Invalid session" });
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
  // Fast path: the token's signature checks out against the project's public
  // keys, so no round trip to Supabase Auth is needed for this request.
  const local = await verifyLocally(token);
  if (local) {
    const until = Math.min(now + TTL_MS, local.exp);
    if (seen.size >= MAX_ENTRIES) seen.clear();
    seen.set(token, { userId: local.userId, until });
    confirmLater(token);
    (req as AuthedRequest).userId = local.userId;
    next();
    return;
  }
  try {
    const { data, error } = await supabaseAnon().auth.getUser(token);
    if (error && !isRejection(error)) {
      unavailable(res);
      return;
    }
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
    // Network failure reaching Auth: not the student's fault, keep them signed in.
    unavailable(res);
  }
}
