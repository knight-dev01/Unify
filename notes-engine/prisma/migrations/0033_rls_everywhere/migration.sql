-- Row-level security on every table, and storage writes narrowed to what the
-- browser actually does.
--
-- The app never reads or writes tables from the browser: every query goes
-- through the API with the service-role key, which bypasses RLS. So turning
-- RLS on with no policies closes the public anon/authenticated keys off from
-- the data without changing anything in the app. Some tables already had it
-- (0001, 0010-0015, 0028, 0029, 0032); this covers the rest, including any
-- added by hand in the dashboard.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- Storage. The browser uploads only Studio diagrams; avatars go through the API
-- (service role) and audio is never uploaded from the browser. Before this, any
-- signed-in student could upload to, overwrite or delete from all three buckets.
-- Public read stays (the buckets serve public URLs).

-- Is the signed-in user an author (lecturer, contributor, admin)? SECURITY DEFINER
-- so the policy can read profiles, which RLS hides from the user's own role.
CREATE OR REPLACE FUNCTION public.is_author() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND (is_admin OR role IN ('lecturer', 'contributor', 'admin'))
  );
$$;
REVOKE ALL ON FUNCTION public.is_author() FROM public;
GRANT EXECUTE ON FUNCTION public.is_author() TO authenticated;

-- Each step skips with a notice (never fails the deploy) if this database role
-- isn't allowed to change storage policies; the table RLS above still applies.
DO $$
DECLARE p text;
BEGIN
  FOREACH p IN ARRAY ARRAY[
    'Signed-in upload avatars', 'Signed-in manage avatars', 'Signed-in delete avatars',
    'Signed-in upload audio', 'Signed-in manage audio', 'Signed-in delete audio',
    'Signed-in upload diagrams', 'Signed-in manage diagrams', 'Signed-in delete diagrams'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p);
  END LOOP;

  BEGIN
    CREATE POLICY "Authors upload diagrams" ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'diagrams' AND auth.role() = 'authenticated' AND public.is_author());
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    CREATE POLICY "Authors manage own diagrams" ON storage.objects FOR UPDATE
      USING (bucket_id = 'diagrams' AND owner = auth.uid());
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    CREATE POLICY "Authors delete own diagrams" ON storage.objects FOR DELETE
      USING (bucket_id = 'diagrams' AND owner = auth.uid());
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
EXCEPTION WHEN insufficient_privilege OR undefined_table OR undefined_column OR undefined_function THEN
  RAISE NOTICE 'storage policies left unchanged: %', SQLERRM;
END $$;
