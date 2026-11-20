-- True or False and Fill the gap join the course games.
ALTER TABLE game_scores DROP CONSTRAINT IF EXISTS game_scores_game_check;
ALTER TABLE game_scores ADD CONSTRAINT game_scores_game_check CHECK (game IN ('keywords', 'crossword', 'match', 'truefalse', 'gapfill'));
