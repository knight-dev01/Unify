-- One-off changes to a weekly class (S37-S41): this week's MEE 401 is cancelled,
-- moved to another time/room, or not confirmed yet. Keyed by slot + date; the
-- weekly slot itself is untouched.
CREATE TABLE IF NOT EXISTS slot_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES class_slots(id) ON DELETE CASCADE,
  class_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('cancelled', 'moved', 'unconfirmed')),
  new_start TEXT,
  new_end TEXT,
  new_venue TEXT,
  note TEXT NOT NULL DEFAULT '',
  changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS slot_changes_one_per_date ON slot_changes (slot_id, class_date);
ALTER TABLE slot_changes ENABLE ROW LEVEL SECURITY;
