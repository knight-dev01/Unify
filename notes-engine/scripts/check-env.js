// Preflight: fail fast with a clear message when required env vars are missing.
// Runs in the Render build BEFORE prisma (which otherwise fails cryptically,
// e.g. P1012 "Environment variable not found: DIRECT_URL").
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

if (missing.length) {
  console.error("Missing required environment variables:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("Set them in Render Dashboard > Service > Environment, then redeploy.");
  process.exit(1);
}
console.log("env check passed");
