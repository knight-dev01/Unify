-- Email on Brevo's free plan (300 a day, shared with Supabase's sign-in
-- emails): a daily counter so the app stays under budget, and a per-student
-- switch for class-update and weekly-summary emails.
CREATE TABLE IF NOT EXISTS email_budget (
  day DATE PRIMARY KEY,
  sent INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE email_budget ENABLE ROW LEVEL SECURITY;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_updates BOOLEAN NOT NULL DEFAULT TRUE;
