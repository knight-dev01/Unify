-- In-person attendance by session code: a lecturer opens a session (short
-- code, closes after N minutes); enrolled students enter the code to be
-- marked present. One record per student per session.
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_code TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  week INT,
  opens_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closes_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS attendance_sessions_open_code_idx ON attendance_sessions (code) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS attendance_sessions_course_idx ON attendance_sessions (course_code, opens_at DESC);

ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES attendance_sessions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_one_per_session
  ON attendance_records (student_id, session_id) WHERE session_id IS NOT NULL;

-- The 0027 tables shipped without RLS, which leaves them readable through the
-- public anon key. The API uses the service role (bypasses RLS), so enabling
-- RLS with no policies closes direct access without affecting the app.
ALTER TABLE device_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hoc_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lecturer_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_checkins ENABLE ROW LEVEL SECURITY;
