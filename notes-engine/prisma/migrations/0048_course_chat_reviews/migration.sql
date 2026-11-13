-- Lecturer side, phase 3 (Review Round 2 + design L10–L17).
-- 1. Lecturer <-> contributor messages, one thread per course. Everyone who
--    teaches the course (lecturers, contributors) and admins can read and post.
CREATE TABLE IF NOT EXISTS course_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course TEXT NOT NULL,
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS course_messages_course_idx ON course_messages (course, created_at DESC);
CREATE TABLE IF NOT EXISTS course_message_reads (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, course)
);
ALTER TABLE course_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_message_reads ENABLE ROW LEVEL SECURITY;

-- 2. The lecturer's check of a week's notes (L13): reviewed, or needs changes.
CREATE TABLE IF NOT EXISTS week_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course TEXT NOT NULL,
  week INT NOT NULL,
  lecturer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('reviewed', 'changes')),
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (course, week, lecturer_id)
);
ALTER TABLE week_reviews ENABLE ROW LEVEL SECURITY;

-- 3. Posts to students (L15): pick which class (null = every class taking the
--    course; else "department|level"), and the design's kinds.
ALTER TABLE course_posts ADD COLUMN IF NOT EXISTS audience TEXT;
ALTER TABLE course_posts DROP CONSTRAINT IF EXISTS course_posts_type_check;
ALTER TABLE course_posts ADD CONSTRAINT course_posts_type_check
  CHECK (type IN ('announcement', 'tip', 'reminder', 'test', 'assignment', 'exam', 'notice'));
