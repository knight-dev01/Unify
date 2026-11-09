-- How long the student's course is (4, 5 or 6 years). Drives the CGPA path and unit defaults.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS degree_years SMALLINT CHECK (degree_years BETWEEN 3 AND 7);
