-- Match-up (pair each key term with its definition) joins the course games.
-- Drop the old game-name check whatever Postgres named it, then add the new one.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'game_scores'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%keywords%crossword%'
  LOOP
    EXECUTE format('ALTER TABLE game_scores DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE game_scores ADD CONSTRAINT game_scores_game_check CHECK (game IN ('keywords', 'crossword', 'match'));
