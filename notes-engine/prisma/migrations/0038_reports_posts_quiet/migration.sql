-- S27 "Report a problem" (students) and L13 "Review this week" (lecturers):
-- one queue the week's authors and admins read.
CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  course TEXT NOT NULL,
  week INT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'problem' CHECK (kind IN ('problem', 'review')),
  reason TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS content_reports_course_idx ON content_reports (course, status, created_at DESC);

-- L15 "Post to students": a lecturer's post to everyone taking a course.
CREATE TABLE IF NOT EXISTS course_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  course TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'announcement' CHECK (type IN ('announcement', 'tip', 'reminder')),
  title TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS course_posts_course_idx ON course_posts (course, created_at DESC);

-- S49 notification settings: quiet hours (Lagos time, "HH:MM"); no push in between.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS quiet_start TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS quiet_end TEXT;

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_posts ENABLE ROW LEVEL SECURITY;
