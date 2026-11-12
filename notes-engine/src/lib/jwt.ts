import { createPublicKey, verify, type KeyObject } from "node:crypto";

// Local check of a Supabase access token against the project's published
// signing keys (ES256 / RS256 JWKS), so most requests skip the round trip to
// Supabase Auth. Returns the user id, or null when the token can't be checked
// locally (unknown key, legacy HS256 token, keys unreachable) — the caller then
// asks Supabase Auth as before. A bad signature, wrong issuer or audience, or
// an expired token is also null: Auth gives the final answer.
type Jwk = { kid?: string; kty?: string; alg?: string; crv?: string; x?: string; y?: string; n?: string; e?: string };

const KEYS_TTL_MS = 10 * 60 * 1000;
let keys: Map<string, { key: KeyObject; alg: string }> = new Map();
let keysAt = 0;
let loading: Promise<void> | null = null;

const base = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");

async function loadKeys(): Promise<void> {
  if (!base()) return;
  const res = await fetch(`${base()}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const next = new Map<string, { key: KeyObject; alg: string }>();
  for (const k of body.keys || []) {
    if (!k.kid || (k.alg !== "ES256" && k.alg !== "RS256")) continue;
    try {
      next.set(k.kid, { key: createPublicKey({ key: k as unknown as import("node:crypto").JsonWebKey, format: "jwk" }), alg: k.alg });
    } catch {
      // skip a key we can't read
    }
  }
  keys = next;
  keysAt = Date.now();
}

async function keyFor(kid: string): Promise<{ key: KeyObject; alg: string } | undefined> {
  const stale = Date.now() - keysAt > KEYS_TTL_MS;
  // Refresh when stale, or when a token names a key we haven't seen (rotation).
  if (stale || !keys.has(kid)) {
    if (!loading) loading = loadKeys().catch(() => {}).finally(() => { loading = null; });
    await loading;
  }
  return keys.get(kid);
}

const b64 = (s: string) => Buffer.from(s, "base64url");

export async function verifyLocally(token: string): Promise<{ userId: string; exp: number } | null> {
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return null;
    const header = JSON.parse(b64(h).toString("utf8")) as { alg?: string; kid?: string };
    if (!header.kid || (header.alg !== "ES256" && header.alg !== "RS256")) return null;
    const k = await keyFor(header.kid);
    if (!k || k.alg !== header.alg) return null;
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      header.alg === "ES256" ? { key: k.key, dsaEncoding: "ieee-p1363" } : k.key,
      b64(sig)
    );
    if (!ok) return null;
    const claims = JSON.parse(b64(p).toString("utf8")) as { sub?: string; exp?: number; iss?: string; aud?: string | string[]; role?: string };
    const now = Math.floor(Date.now() / 1000);
    if (!claims.sub || typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (claims.iss && base() && claims.iss !== `${base()}/auth/v1`) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes("authenticated")) return null;
    return { userId: claims.sub, exp: claims.exp * 1000 };
  } catch {
    return null;
  }
}
