-- One-time codes for "Delete my account": emailed to the account's address,
-- stored hashed, good for 15 minutes and 5 tries. Gone with the profile.
CREATE TABLE IF NOT EXISTS account_delete_codes (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE account_delete_codes ENABLE ROW LEVEL SECURITY;
