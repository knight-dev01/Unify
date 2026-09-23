-- Platform admins (manage users, roles, content).
-- Applied automatically by Render: `prisma migrate deploy` on every build.
-- First admin: set ADMIN_EMAILS env (comma-separated) — requireAdmin honors
-- it until you flag profiles directly.
alter table profiles add column if not exists is_admin boolean not null default false;
