-- Review 3: personal study reminders between 22:00 and 06:00 only go out when
-- the student said yes to late-night nudges (asked when they pick Late night).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS late_night_nudges BOOLEAN NOT NULL DEFAULT FALSE;
