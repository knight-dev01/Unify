-- Review 3 (C1, C10): a short introduction on each course page, and the
-- course's lecturers with the weeks each one teaches, set by the class rep.
-- A name matches a lecturer on Unify Learn (teaching the course) when they
-- join, so their profile replaces the name without anyone re-entering it.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS intro TEXT;

CREATE TABLE IF NOT EXISTS course_lecturer_weeks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course     TEXT NOT NULL,
  position   INT NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  week_from  INT NOT NULL CHECK (week_from BETWEEN 1 AND 20),
  week_to    INT NOT NULL CHECK (week_to BETWEEN 1 AND 20),
  set_by     UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (week_to >= week_from)
);
CREATE INDEX IF NOT EXISTS course_lecturer_weeks_course_idx ON course_lecturer_weeks (course);
ALTER TABLE course_lecturer_weeks ENABLE ROW LEVEL SECURITY;
