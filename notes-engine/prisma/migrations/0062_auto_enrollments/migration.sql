-- Courses the app enrolled a student in from their class's course sheet
-- (lib/classCourses). Only these are swapped when the class or semester
-- changes; courses a student added themselves are never touched.
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false;
