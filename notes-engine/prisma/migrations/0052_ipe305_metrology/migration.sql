-- IPE 305 confirmed as Metrology (18 Nov). The 2026/2027 sheet listed it twice;
-- 0051 left it out until confirmed. Insert only, like 0051.
INSERT INTO courses (code, title, lecturer_names) VALUES ('IPE 305', 'Metrology', 'Dr. V.D. Obasa')
ON CONFLICT (code) DO NOTHING;
UPDATE courses SET lecturer_names = 'Dr. V.D. Obasa' WHERE code = 'IPE 305' AND lecturer_names IS NULL;
INSERT INTO course_levels (course, level, semester) VALUES ('IPE 305', '300 Level', 'First Semester')
ON CONFLICT (course, level) DO NOTHING;
