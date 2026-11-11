-- Deleting an account (by the person, or by an admin) must not take the class's
-- shared records with it. Before this:
--   - deleting a class rep or lecturer deleted every attendance mark they had
--     scanned (attendance_records.scanned_by ON DELETE CASCADE) and every register
--     they had started (attendance_sessions.created_by ON DELETE CASCADE);
--   - deleting whoever added a class time removed it from the whole class's
--     timetable (class_slots.lecturer_id ON DELETE CASCADE);
--   - an admin who had approved a class rep couldn't be deleted at all
--     (profiles.hoc_approved_by had no ON DELETE action).
-- Now those links are cleared (SET NULL) and the records stay.
DO $$
DECLARE
  spec text[];
  specs text[][] := ARRAY[
    ARRAY['attendance_records', 'scanned_by'],
    ARRAY['attendance_sessions', 'created_by'],
    ARRAY['class_slots', 'lecturer_id'],
    ARRAY['profiles', 'hoc_approved_by']
  ];
  con text;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    FOR con IN
      SELECT c.conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND n.nspname = 'public' AND t.relname = spec[1] AND a.attname = spec[2]
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', spec[1], con);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', spec[1], spec[2]);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE SET NULL',
      spec[1], spec[1] || '_' || spec[2] || '_fkey', spec[2]);
  END LOOP;
END $$;
