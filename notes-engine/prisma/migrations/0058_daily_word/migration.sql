-- Term of the Day: one key term per course per day, guessed in up to 6 tries.
-- The first finished attempt counts; it feeds the streak and "N classmates
-- solved today".
CREATE TABLE IF NOT EXISTS daily_word_results (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course TEXT NOT NULL,
  day DATE NOT NULL,
  word TEXT NOT NULL,
  guesses INT NOT NULL CHECK (guesses BETWEEN 1 AND 6),
  solved BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, course, day)
);
CREATE INDEX IF NOT EXISTS daily_word_results_course_day_idx ON daily_word_results (course, day);
ALTER TABLE daily_word_results ENABLE ROW LEVEL SECURITY;
