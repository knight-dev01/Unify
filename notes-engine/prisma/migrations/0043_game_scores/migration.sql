-- Course games (Keywords, Crossword): each student's best result per game
-- per course week. Feeds the leaderboards, the "key terms mastered" count
-- and a one-off XP award the first time a week's game is completed.
CREATE TABLE IF NOT EXISTS game_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  game TEXT NOT NULL CHECK (game IN ('keywords', 'crossword')),
  course TEXT NOT NULL,
  week INT NOT NULL,
  score INT NOT NULL DEFAULT 0,
  terms INT NOT NULL DEFAULT 0,      -- key terms solved in the best run
  hints INT NOT NULL DEFAULT 0,      -- hints used in the best run
  seconds INT NOT NULL DEFAULT 0,    -- time taken in the best run
  plays INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS game_scores_one_per_week ON game_scores (user_id, game, course, week);
CREATE INDEX IF NOT EXISTS game_scores_board_idx ON game_scores (course, week, game, score DESC);
ALTER TABLE game_scores ENABLE ROW LEVEL SECURITY;
