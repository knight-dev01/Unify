-- Courses span levels (shared model): level list per course.
-- Applied automatically by Render: `prisma migrate deploy` on every build.
create table if not exists course_levels (
  course text not null references courses(code) on delete cascade,
  level text not null,
  primary key (course, level)
);
create index if not exists course_levels_level_idx on course_levels (level);
