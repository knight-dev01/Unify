// Preflight: fail fast with a clear message when env vars are missing or
// malformed. Runs in the Render build BEFORE prisma (which otherwise fails
// cryptically, e.g. P1012 missing var, P1013 bad URL).
const required = ["SUPABASE_URL", "DATABASE_URL", "DIRECT_URL", "CORS_ORIGIN"];
const eitherOr = [
  ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"],
  ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
];

const missing = required.filter((k) => !process.env[k]);
for (const pair of eitherOr) {
  if (!process.env[pair[0]] && !process.env[pair[1]]) {
    missing.push(`${pair[0]} (or legacy ${pair[1]})`);
  }
}

// Prisma needs full postgres URIs, not bare hostnames.
for (const k of ["DATABASE_URL", "DIRECT_URL"]) {
  const v = process.env[k] || "";
  if (v && !/^postgresql:\/\//.test(v)) {
    missing.push(
      `${k} is not a valid Postgres URL (must start with postgresql:// — copy the full URI from Supabase Settings > Database, don't assemble host/port by hand)`
    );
  }
}

if (missing.length) {
  console.error("Bad environment variables:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("Fix them in Render Dashboard > Service > Environment, then redeploy.");
  console.error(
    "Hint: if your DB password contains @ # / ? : characters, percent-encode them (e.g. @ -> %40) or reset it to letters+numbers."
  );
  process.exit(1);
}

// Non-fatal hints: pooler (:6543) for the app, direct (:5432) for migrations.
if (process.env.DATABASE_URL && !/:6543/.test(process.env.DATABASE_URL)) {
  console.warn("warning: DATABASE_URL usually points at the pooler (:6543).");
}
if (process.env.DIRECT_URL && !/:5432/.test(process.env.DIRECT_URL)) {
  console.warn("warning: DIRECT_URL usually points at the direct host (:5432) — migrations fail through the pooler.");
}
console.log("env check passed");
