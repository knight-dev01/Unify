-- Add semester tracking for Week tracker (Home hero)
-- Tracks current week in 12-week semester, colors bars amber Week 8+, red Week 11+

ALTER TABLE profiles ADD COLUMN semester_start DATE;
ALTER TABLE profiles ADD COLUMN semester_weeks INTEGER DEFAULT 12;

-- CGPA tracking (for CGPA Planner S15-S18)
ALTER TABLE profiles ADD COLUMN cgpa_current NUMERIC(3,2);
ALTER TABLE profiles ADD COLUMN cgpa_target NUMERIC(3,2);
ALTER TABLE profiles ADD COLUMN hide_cgpa BOOLEAN DEFAULT FALSE;

-- Index for semester queries (future: week-based notifications)
CREATE INDEX idx_profiles_semester ON profiles(semester_start) WHERE semester_start IS NOT NULL;
