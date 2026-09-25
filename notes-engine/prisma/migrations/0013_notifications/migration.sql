-- In-app notifications (bell badge + list). Rows are written by publish
-- hooks, onboarding welcome, and admin announcements; read via API only.
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type text not null default 'new_note',
  title text not null default '',
  body text not null default '',
  course text,
  week int,
  topic int,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
alter table notifications enable row level security;
