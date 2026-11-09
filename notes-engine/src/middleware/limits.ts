import { createHash } from "node:crypto";
import rateLimit from "express-rate-limit";
import type { Request } from "express";

// Who is asking, for rate limiting.
//
// A whole lecture hall (or a mobile carrier) shares one public IP, so limiting
// by IP alone locks honest students out the moment a class opens the app at
// once. Signed-in requests are counted per session token instead; only
// requests with no token fall back to the IP.
export function clientKey(req: Request): string {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ") && h.length > 20) {
    return "t:" + createHash("sha1").update(h.slice(7)).digest("base64url").slice(0, 16);
  }
  return "ip:" + (req.ip || "unknown");
}

/** Everything under /v1: 240 requests a minute per signed-in session (a normal user makes about 20), 120 per IP when anonymous. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => (req.headers.authorization ? 240 : 120),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  skip: (req) => req.method === "OPTIONS" || req.path === "/ping",
  message: { error: "You're going a bit fast. Wait a few seconds and try again." },
});
