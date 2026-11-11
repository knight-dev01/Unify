-- Scoped roles given to an existing account (nobody picks a role):
--   level_admin: approves class reps for one department + level
--   hod:         head of department, sees attendance counts for the department
--   dean:        sees attendance counts for the faculty
-- Reports are counts only, never names (review p.11).
CREATE TABLE IF NOT EXISTS role_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('level_admin', 'hod', 'dean')),
  institution TEXT NOT NULL DEFAULT 'LASU',
  faculty TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  granted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS role_grants_unique ON role_grants (user_id, role, institution, faculty, department, level);
CREATE INDEX IF NOT EXISTS role_grants_scope_idx ON role_grants (role, institution, department, level);

-- Class rep requests, so the level admin (or a Unify admin) has a queue to answer.
CREATE TABLE IF NOT EXISTS hoc_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  institution TEXT NOT NULL DEFAULT 'LASU',
  department TEXT NOT NULL,
  level TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS hoc_requests_one_pending ON hoc_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS hoc_requests_scope_idx ON hoc_requests (status, department, level);

ALTER TABLE role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hoc_requests ENABLE ROW LEVEL SECURITY;
