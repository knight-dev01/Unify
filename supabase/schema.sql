-- Unify backend schema (Supabase Postgres).
-- Run in Supabase Dashboard > SQL Editor.
-- The backend uses service_role (bypasses RLS). RLS is enabled with NO
-- public policies, so direct client access is denied by default.

create table if not exists universities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  short_name text,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key, -- = auth.users.id (Supabase Auth)
  first_name text,
  email text,
  university text,
  faculty text,
  department text,
  level text,
  university_id uuid references universities(id),
  grad_target numeric,
  role text not null default 'student',
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists courses (
  code text primary key,
  title text not null,
  created_at timestamptz not null default now()
);

create table if not exists course_levels (
  course text not null references courses(code) on delete cascade,
  level text not null,
  primary key (course, level)
);
create index if not exists course_levels_level_idx on course_levels (level);
alter table course_levels enable row level security;

create table if not exists weeks (
  course text not null references courses(code) on delete cascade,
  week int not null,
  title text not null default '',
  subtitle text not null default '',
  note_json jsonb not null default '{}'::jsonb,
  author_id uuid,
  created_at timestamptz not null default now(),
  primary key (course, week)
);
create index if not exists weeks_author_idx on weeks (author_id);

create table if not exists topic_progress (
  user_id uuid not null,
  course text not null,
  week int not null,
  topic int not null,
  done boolean not null default true,
  completed_at timestamptz,
  primary key (user_id, course, week, topic)
);

create table if not exists xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  amount int not null,
  reason text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists xp_events_user_created_idx on xp_events (user_id, created_at desc);

alter table universities enable row level security;
alter table profiles enable row level security;
alter table courses enable row level security;
alter table weeks enable row level security;
alter table topic_progress enable row level security;
alter table xp_events enable row level security;

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
alter table quiz_attempts enable row level security;

create table if not exists ai_models (
  model text primary key,
  failures int not null default 0,
  last_ok timestamptz,
  updated_at timestamptz not null default now()
);
alter table ai_models enable row level security;
