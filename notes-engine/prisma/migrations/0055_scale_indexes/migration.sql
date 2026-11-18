-- Scalability pass (v2.30.0): indexes for the lookups that run per course or
-- per session. Without them each lookup reads the whole table, so it gets
-- slower with every student who joins (O(n) per request instead of O(log n)).

-- "Who takes this course": push fan-out, live wires, class rep reminders,
-- course stats. The primary key is (user_id, course), which can't serve a
-- lookup by course.
CREATE INDEX IF NOT EXISTS enrollments_course_kind_idx ON enrollments (course, kind);

-- Attendance per session (registers, course stats). The existing unique
-- index starts with student_id.
CREATE INDEX IF NOT EXISTS attendance_records_session_idx ON attendance_records (session_id) WHERE session_id IS NOT NULL;

-- Course progress and quiz stats for lecturers (the primary key and the
-- existing index both start with user_id).
CREATE INDEX IF NOT EXISTS topic_progress_course_user_idx ON topic_progress (course, user_id);
CREATE INDEX IF NOT EXISTS quiz_attempts_course_week_idx ON quiz_attempts (course, week);

-- Class audiences (live wires, classmates): department + level.
CREATE INDEX IF NOT EXISTS profiles_class_idx ON profiles (department, level);
