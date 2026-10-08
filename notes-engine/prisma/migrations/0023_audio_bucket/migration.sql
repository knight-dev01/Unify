-- Narrator audio bucket (public read, signed-in write). Nigerian-voice
-- MP3s attached per topic in Studio; the reader plays them with speed
-- control, device TTS stays the fallback.
insert into storage.buckets (id, name, public)
values ('audio', 'audio', true)
on conflict (id) do nothing;

do $$ begin
  create policy "Public read audio"
    on storage.objects for select using (bucket_id = 'audio');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in upload audio"
    on storage.objects for insert
    with check (bucket_id = 'audio' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in manage audio"
    on storage.objects for update using (bucket_id = 'audio' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "Signed-in delete audio"
    on storage.objects for delete using (bucket_id = 'audio' and auth.role() = 'authenticated');
exception when duplicate_object then null;
end $$;
