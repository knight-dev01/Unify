-- Model registry: what the Gemini key can call + per-model health.
-- Applied automatically by Render: `prisma migrate deploy` on every build.
create table if not exists ai_models (
  model text primary key,
  failures int not null default 0,
  last_ok timestamptz,
  updated_at timestamptz not null default now()
);
