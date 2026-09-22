-- Role selection at sign-in: student (default) vs lecturer/collaborator.
-- Only lecturers + collaborators may use the authoring module.
-- Applied automatically by Render: `prisma migrate deploy` on every build.
alter table profiles add column if not exists role text not null default 'student';
