-- Students show their own QR pass and the HOC or lecturer scans it.
-- How each student was marked: 'scan' (pass scanned), 'typed' (matric typed in
-- by the HOC or lecturer, for a dead phone) or 'code' (online class code).
-- Existing rows came from the old code check-in.
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'code';
