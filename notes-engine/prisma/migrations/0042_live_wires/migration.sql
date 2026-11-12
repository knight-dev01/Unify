-- Live wire: an urgent message with a countdown, shown at the top of Home
-- for the students it's meant for until its time runs out.
-- scope: all (Unify admins), faculty (deans), department (HODs),
--        class = department + level (class reps, level admins),
--        course (lecturers and contributors who teach it).
CREATE TABLE IF NOT EXISTS live_wires (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution TEXT NOT NULL DEFAULT 'LASU',
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL CHECK (scope IN ('all', 'faculty', 'department', 'class', 'course')),
  faculty TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  countdown_label TEXT NOT NULL DEFAULT 'ends' CHECK (countdown_label IN ('starts', 'deadline', 'ends')),
  ends_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS live_wires_active_idx ON live_wires (ends_at DESC) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS live_wires_author_idx ON live_wires (author_id, created_at DESC);
ALTER TABLE live_wires ENABLE ROW LEVEL SECURITY;
