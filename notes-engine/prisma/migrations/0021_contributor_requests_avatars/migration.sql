-- Contributor rename: the role value moves from 'collaborator' to
-- 'contributor' everywhere (code + UI already renamed). Existing rows move.
update profiles set role = 'contributor' where role = 'collaborator';

-- Staff role requests: lecturers/contributors apply during onboarding and
-- an admin approves. Until approval the account stays a student — nobody
-- can self-grant staff powers by picking a role in a form.
create table if not exists role_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null check (role in ('lecturer', 'contributor')),
  level text not null default '',
  courses text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists role_requests_status_idx on role_requests (status, created_at desc);
create index if not exists role_requests_user_idx on role_requests (user_id);

-- Profile pictures: uploaded avatar URL (Gravatar by email is the
-- automatic fallback, computed at read time — no column needed for it).
alter table profiles add column if not exists avatar_url text not null default '';

-- Avatars bucket (public read, signed-in write).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

do $$ begin
  create policy "Public read avatars"
    on storage.objects for select using (bucket_id = 'avatars');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in upload avatars"
    on storage.objects for insert
    with check (bucket_id = 'avatars' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in manage avatars"
    on storage.objects for update using (bucket_id = 'avatars' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in delete avatars"
    on storage.objects for delete using (bucket_id = 'avatars' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;
