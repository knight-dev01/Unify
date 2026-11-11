-- Onboarding S09/S10: what the student is working towards this semester, when
-- they read best and how long they can focus. Used to word and time nudges.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS study_goal TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS study_time TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS focus_minutes INT;
