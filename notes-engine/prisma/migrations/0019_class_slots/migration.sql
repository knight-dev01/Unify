-- Lecturer timetable + class management: recurring weekly slots per course
-- (day 0=Sunday..6=Saturday, times HH:MM 24h). Lecturers who teach the
-- course (or admins) manage slots; every signed-in user reads them.
create table if not exists class_slots (
  id uuid primary key default gen_random_uuid(),
  course text not null,
  lecturer_id uuid not null references profiles(id) on delete cascade,
  day int not null check (day between 0 and 6),
  start_time text not null,
  end_time text not null,
  venue text not null default '',
  created_at timestamptz not null default now(),
  unique (course, day, start_time)
);
create index if not exists class_slots_course_idx on class_slots (course, day, start_time);
create index if not exists class_slots_lecturer_idx on class_slots (lecturer_id);
