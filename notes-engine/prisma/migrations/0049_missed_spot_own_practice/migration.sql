-- Design extras for the lecturer side (L09, L11, L16, L17).
-- 1. Most missed questions (L11): which quiz questions each attempt was asked
--    and got wrong, by position in the week's quiz. Older attempts have none.
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS asked JSONB;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS wrong JSONB;

-- 2. My own timetable (L09/L17): a lecturer's own entries (office hours,
--    other duties). Only they see them.
CREATE TABLE IF NOT EXISTS lecturer_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day INT NOT NULL CHECK (day BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  title TEXT NOT NULL,
  venue TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lecturer_slots_user_idx ON lecturer_slots (user_id, day);
ALTER TABLE lecturer_slots ENABLE ROW LEVEL SECURITY;

-- 3. Practice questions a lecturer adds (L11): multiple choice, shown to
--    students in the course's Practice tab.
CREATE TABLE IF NOT EXISTS practice_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course TEXT NOT NULL,
  week INT,
  question TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_index INT NOT NULL,
  explanation TEXT,
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS practice_questions_course_idx ON practice_questions (course, week);
ALTER TABLE practice_questions ENABLE ROW LEVEL SECURITY;
