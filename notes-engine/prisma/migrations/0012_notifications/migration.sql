-- Per-student email notification preferences + confirmation tracking.
-- notify_new_notes drives "new note published" emails (opt-out).
-- email/email_confirmed are backfilled from Supabase Auth on /me.
alter table profiles add column if not exists notify_new_notes boolean not null default true;
alter table profiles add column if not exists email_confirmed boolean not null default false;
