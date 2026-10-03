-- Author-uploaded note diagrams (BUG-003): public-read bucket; only
-- signed-in users can write. Served by the app + share pages as <img>.
insert into storage.buckets (id, name, public)
values ('diagrams', 'diagrams', true)
on conflict (id) do nothing;

do $$ begin
  create policy "Public read diagrams"
    on storage.objects for select using (bucket_id = 'diagrams');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in upload diagrams"
    on storage.objects for insert
    with check (bucket_id = 'diagrams' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in manage diagrams"
    on storage.objects for update using (bucket_id = 'diagrams' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in delete diagrams"
    on storage.objects for delete using (bucket_id = 'diagrams' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;
