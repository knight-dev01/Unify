-- Fresh seed for testing (LASU + per-level catalog + Week 1 shells).
-- Run after schema.sql. Starter topic notes are created by the API boot
-- seed (notes-engine ensureSeeded), which also backfills legacy content.

insert into universities (name, short_name)
values ('Lagos State University', 'LASU')
on conflict (name) do nothing;

insert into app_settings (key, value)
values ('current_semester', 'First Semester')
on conflict (key) do nothing;

insert into courses (code, title) values
  ('GNS 101', 'Use of English I'),
  ('MTH 101', 'Elementary Mathematics I'),
  ('PHY 101', 'General Physics I'),
  ('CHM 101', 'General Chemistry I'),
  ('GNS 102', 'Use of English II'),
  ('MTH 102', 'Elementary Mathematics II'),
  ('PHY 102', 'General Physics II'),
  ('CHM 102', 'General Chemistry II'),
  ('CVE 214', 'CVE 214'),
  ('ECE 202', 'ECE 202'),
  ('ECE 210', 'ECE 210'),
  ('ECE 220', 'ECE 220'),
  ('IPE 212', 'IPE 212'),
  ('MEE 202', 'MEE 202'),
  ('MEE 212', 'MEE 212'),
  ('MEE 352', 'MEE 352')
on conflict (code) do nothing;

insert into course_levels (course, level, semester) values
  ('GNS 101', '100 Level', 'First Semester'),
  ('MTH 101', '100 Level', 'First Semester'),
  ('PHY 101', '100 Level', 'First Semester'),
  ('CHM 101', '100 Level', 'First Semester'),
  ('GNS 102', '100 Level', 'Second Semester'),
  ('MTH 102', '100 Level', 'Second Semester'),
  ('PHY 102', '100 Level', 'Second Semester'),
  ('CHM 102', '100 Level', 'Second Semester'),
  ('CVE 214', '200 Level', 'First Semester'),
  ('ECE 202', '200 Level', 'First Semester'),
  ('ECE 210', '200 Level', 'First Semester'),
  ('ECE 220', '200 Level', 'First Semester'),
  ('IPE 212', '200 Level', 'First Semester'),
  ('MEE 202', '200 Level', 'First Semester'),
  ('MEE 212', '200 Level', 'First Semester'),
  ('MEE 352', '300 Level', 'First Semester')
on conflict (course, level) do nothing;

insert into weeks (course, week, title, subtitle, note_json)
select c.code, 1, 'Week 1', 'Starter note',
  jsonb_build_object('course', c.code, 'week', 1, 'title', 'Week 1', 'subtitle', 'Starter note', 'topics', '[]'::jsonb, 'eoq', jsonb_build_object('questions', '[]'::jsonb))
from courses c
on conflict (course, week) do nothing;

-- Default platform admin. Email: unify.admin@unify.learn / Password: unify.admin
-- CHANGE THE PASSWORD right after first login (Supabase > Auth > Users > ... > Send reset).
-- Idempotent: does nothing if the account already exists (never resets your password).
create extension if not exists pgcrypto;
do $$
declare
  admin_id uuid;
begin
  if not exists (select 1 from auth.users where email = 'unify.admin@unify.learn') then
    admin_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', admin_id, 'authenticated', 'authenticated', 'unify.admin@unify.learn', crypt('unify.admin', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), admin_id, admin_id, jsonb_build_object('sub', admin_id, 'email', 'unify.admin@unify.learn'), 'email', now(), now(), now());
    insert into public.profiles (id, first_name, email, role, is_admin)
    values (admin_id, 'Unify Admin', 'unify.admin@unify.learn', 'collaborator', true);
  end if;
end $$;
