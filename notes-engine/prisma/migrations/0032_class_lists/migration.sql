-- Class lists: the HOC uploads names + matric numbers for their class
-- (institution + department + level). Students claim their entry once
-- (by matric, or verified by their LASU student email). Attendance attaches
-- to the entry, so a student typed in before they joined Unify keeps it.
-- Tables carry `institution` (LASU for now) so other universities slot in later.

CREATE TABLE IF NOT EXISTS class_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution TEXT NOT NULL DEFAULT 'LASU',
  department TEXT NOT NULL,
  level TEXT NOT NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS class_lists_class_key ON class_lists (institution, department, level);

CREATE TABLE IF NOT EXISTS class_list_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES class_lists(id) ON DELETE CASCADE,
  institution TEXT NOT NULL DEFAULT 'LASU',
  matric TEXT NOT NULL,
  full_name TEXT NOT NULL,
  student_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  claim_method TEXT, -- matric | email | hoc | auto
  verified_email TEXT,
  removed_at TIMESTAMPTZ,
  added_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS class_list_entries_matric_key ON class_list_entries (list_id, matric);
CREATE INDEX IF NOT EXISTS class_list_entries_student_idx ON class_list_entries (student_id) WHERE student_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS class_list_entries_matric_idx ON class_list_entries (institution, matric);

-- Every change to a list, for the HOC's "what changed" view.
CREATE TABLE IF NOT EXISTS class_list_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES class_lists(id) ON DELETE CASCADE,
  entry_id UUID REFERENCES class_list_entries(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL, -- upload | add | edit | remove | restore | claim | unclaim | approve | reject
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS class_list_log_list_idx ON class_list_log (list_id, created_at DESC);

-- Claim problems land in the HOC's inbox.
CREATE TABLE IF NOT EXISTS class_list_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES class_lists(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  matric TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL, -- not_on_list | already_claimed
  verified_email TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- open | approved | rejected
  resolved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS class_list_claims_open_idx ON class_list_claims (list_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS class_list_claims_one_open ON class_list_claims (student_id) WHERE status = 'open';

-- One-time codes for "verify with my LASU email" (optional for now).
CREATE TABLE IF NOT EXISTS class_claim_codes (
  student_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  matric TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Attendance attaches to the class-list entry. A student typed in by matric
-- before they have an account has no student_id yet; it is filled when they claim.
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS entry_id UUID REFERENCES class_list_entries(id) ON DELETE SET NULL;
ALTER TABLE attendance_records ALTER COLUMN student_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_one_entry_per_session
  ON attendance_records (entry_id, session_id) WHERE entry_id IS NOT NULL AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_records_entry_idx ON attendance_records (entry_id) WHERE entry_id IS NOT NULL;

ALTER TABLE class_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_list_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_list_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_list_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_claim_codes ENABLE ROW LEVEL SECURITY;
