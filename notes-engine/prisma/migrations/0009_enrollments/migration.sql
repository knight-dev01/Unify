-- Enrollments: courses each user takes (students) or teaches (lecturers),
-- scoped by level + semester. Applied automatically by Render.
alter table course_levels add column if not exists semester text not null default 'First Semester';

alter table profiles add column if not exists semester text;

create table if not exists enrollments (
  user_id uuid not null,
  course text not null references courses(code) on delete cascade,
  kind text not null default 'taking',
  created_at timestamptz not null default now(),
  primary key (user_id, course)
);
create index if not exists enrollments_user_idx on enrollments (user_id);
