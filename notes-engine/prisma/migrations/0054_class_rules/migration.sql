-- Review 3 (C11): the class rep sets when each class gets confirmed (the
-- evening before, 2 hours before or 1 hour before: they get a reminder then)
-- and the latest a lecturer can cancel through the app. One row per course.
CREATE TABLE IF NOT EXISTS class_rules (
  course       TEXT PRIMARY KEY,
  confirm_when TEXT NOT NULL DEFAULT 'evening' CHECK (confirm_when IN ('evening', '2h', '1h')),
  cancel_by    TEXT NOT NULL DEFAULT 'any' CHECK (cancel_by IN ('evening', '2h', '1h', 'any')),
  set_by       UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE class_rules ENABLE ROW LEVEL SECURITY;
