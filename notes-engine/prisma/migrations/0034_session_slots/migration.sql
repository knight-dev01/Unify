-- Attendance from the course page: each class on the timetable gets its own
-- register (slot_id), and "Extra class" covers classes not on the timetable.
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS slot_id UUID REFERENCES class_slots(id) ON DELETE SET NULL;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS attendance_sessions_course_week_idx ON attendance_sessions (course_code, week);
