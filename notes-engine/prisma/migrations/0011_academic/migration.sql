-- Academic control + resume tracking.
-- app_settings.current_semester is admin-owned: students see only that
-- semester's courses (no student-side semester toggle).
-- resume_state tracks each student's live learning position for Resume.
create table if not exists app_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value) values ('current_semester', 'First Semester')
on conflict (key) do nothing;
alter table app_settings enable row level security;

create table if not exists resume_state (
  user_id uuid primary key,
  course text not null,
  week int not null,
  topic int not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists resume_state_user_idx on resume_state (user_id);
alter table resume_state enable row level security;
