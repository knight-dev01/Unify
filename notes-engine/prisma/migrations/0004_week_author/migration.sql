-- Track which author published each week (lecturer dashboard lists own notes).
-- Applied automatically by Render: `prisma migrate deploy` on every build.
alter table weeks add column if not exists author_id uuid;
create index if not exists weeks_author_idx on weeks (author_id);
