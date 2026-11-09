-- Online class link on a weekly slot (Google Meet / Zoom / Teams): the
-- lecturer adds it once, students tap Join from the timetable.
ALTER TABLE class_slots ADD COLUMN IF NOT EXISTS meet_link TEXT NOT NULL DEFAULT '';
-- Lecturer materials are shared as links (Drive, OneDrive, ...): give them a label.
ALTER TABLE lecturer_materials ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

-- CGPA planner: the CGPA covers every semester so far, so the math needs the
-- units already completed and the degree total (the course list alone only
-- covers this semester). Also: course_status shipped without RLS, which
-- exposed every student's grades through the public key. The API (service
-- role) is the only reader/writer now.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cgpa_units_done INTEGER;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cgpa_units_total INTEGER;
ALTER TABLE course_status ENABLE ROW LEVEL SECURITY;
