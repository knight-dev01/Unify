-- Lecturer's today-class card (design L07/L18): "Confirm class" and
-- "Running late". A week's class can now also be confirmed (students see
-- Confirmed) or running late (new start time, students see Running late).
ALTER TABLE slot_changes DROP CONSTRAINT IF EXISTS slot_changes_status_check;
ALTER TABLE slot_changes ADD CONSTRAINT slot_changes_status_check
  CHECK (status IN ('cancelled', 'moved', 'unconfirmed', 'confirmed', 'late'));
