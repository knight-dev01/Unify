-- Bug reports from inside the app (Me › Report a bug): what went wrong, in the
-- person's words, with the screen they came from, app version and device.
-- Admins read and resolve them under Admin › Bug reports. The reporter link
-- is cleared (not the report) if their account is deleted.
CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  what TEXT NOT NULL,            -- what went wrong
  doing TEXT,                    -- what they were doing (optional)
  page TEXT,                     -- the screen they came from
  app_version TEXT,
  device TEXT,                   -- browser / OS summary, screen size
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bug_reports_status_idx ON bug_reports (status, created_at DESC);
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
