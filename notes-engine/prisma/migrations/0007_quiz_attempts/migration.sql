-- Quiz attempts feed stats (quizzes taken, average score).
-- Applied automatically by Render: `prisma migrate deploy` on every build.
create table if not exists quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  course text not null,
  week int not null,
  score int not null,
  total int not null,
  created_at timestamptz not null default now()
);
create index if not exists quiz_attempts_user_idx on quiz_attempts (user_id, created_at desc);
