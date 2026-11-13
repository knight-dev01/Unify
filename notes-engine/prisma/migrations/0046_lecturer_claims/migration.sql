-- Lecturer side, phase 2 (Review Round 2, design L01–L06 and S62).
-- 1. "Let students know you" (L05): title, short bio, contact email, links.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS title TEXT;          -- Dr., Prof., Engr., Mr., Mrs., Ms.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS links TEXT;          -- LinkedIn, X, website (free text)

-- 2. Courses a lecturer added themselves (L04). The course works straight
--    away (a teaching enrollment is created too), but each class taking it
--    confirms through its class rep: "Is this your lecturer?" (S62). Until
--    one does, the lecturer sees "Waiting for Head of Class", and posts and
--    PDFs only reach classes that said yes. Courses an admin assigned have
--    no claim row and count as confirmed.
CREATE TABLE IF NOT EXISTS lecturer_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lecturer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lecturer_id, course)
);
CREATE TABLE IF NOT EXISTS lecturer_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES lecturer_claims(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'declined')),
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (claim_id, department, level)
);
CREATE INDEX IF NOT EXISTS lecturer_claims_course_idx ON lecturer_claims (course);
ALTER TABLE lecturer_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE lecturer_confirmations ENABLE ROW LEVEL SECURITY;
