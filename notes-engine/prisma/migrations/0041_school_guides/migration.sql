-- S44 Guide: a step-by-step guide per school (course registration, fees,
-- course form...). The school's admin keeps it current; students read it
-- from Me and see it in the Home carousel when it changes.
CREATE TABLE IF NOT EXISTS school_guides (
  institution TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Course registration',
  intro TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ "title": "", "body": "", "where": "" }]
  published BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE school_guides ENABLE ROW LEVEL SECURITY;

INSERT INTO school_guides (institution, title, intro, steps) VALUES (
  'LASU',
  'Course registration',
  'Five steps, in this order. Start early: the portal gets busy in the last week.',
  '[
    {"title": "Pay your school fees", "body": "Keep the receipt. The portal won''t open course registration without it.", "where": "Online · LASU portal"},
    {"title": "Pick your courses on the portal", "body": "Add every carryover first, then this semester''s courses.", "where": "Online · LASU portal"},
    {"title": "Print the course form", "body": "Two copies. One is yours to keep.", "where": "Anywhere with a printer"},
    {"title": "Get it signed", "body": "Your level adviser signs first, then the Head of Department.", "where": "Your department office"},
    {"title": "Submit it", "body": "Hand one copy to the faculty officer and ask for the stamp.", "where": "Faculty office"}
  ]'::jsonb
) ON CONFLICT (institution) DO NOTHING;
