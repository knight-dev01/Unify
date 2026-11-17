-- Scheduled reminders (17 Nov): nudges at set times so people come back to the
-- app on ordinary days, not only when something new lands.
-- 1. Personal reminders (Me > Settings > Notifications). On by default.
--    reminder_times: "HH:MM" Lagos times; NULL means the defaults picked from
--    the person's study time (see src/lib/reminders.ts).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reminders_on BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reminder_times TEXT[];

-- 2. Reminders for everyone, kept by admins (Admin > Reminders).
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'students', 'lecturers', 'staff')),
  send_at TEXT NOT NULL,
  days INT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_on DATE,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE scheduled_reminders ENABLE ROW LEVEL SECURITY;

-- 3. Which personal reminder went to whom today (one send per slot per day).
CREATE TABLE IF NOT EXISTS reminder_sends (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  sent_on DATE NOT NULL,
  PRIMARY KEY (user_id, slot, sent_on)
);
CREATE INDEX IF NOT EXISTS reminder_sends_day_idx ON reminder_sends (sent_on);
ALTER TABLE reminder_sends ENABLE ROW LEVEL SECURITY;

-- One reminder for everyone to start with: plan the week on Sunday evening.
INSERT INTO scheduled_reminders (title, body, link, audience, send_at, days)
SELECT 'Plan your week', 'A new week starts tomorrow. Check your timetable and pick what to read first.', '/timetable', 'all', '18:00', '{0}'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_reminders);
