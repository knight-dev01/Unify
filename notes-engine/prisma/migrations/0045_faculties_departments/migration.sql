-- Faculties and departments, managed by admins (Admin › Faculties & departments)
-- instead of a list copied into five screens. Names stay the join key that
-- profiles, class lists, class board posts, class rep requests, live wires and
-- role grants already store; renaming here carries the new name to all of them
-- (server). Retiring hides a department from pickers; existing people keep it.
-- status: open = students and staff can pick it; soon = shown as coming soon;
-- later = listed as not open yet.
CREATE TABLE IF NOT EXISTS faculties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  university TEXT NOT NULL DEFAULT 'Lagos State University',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'soon', 'later')),
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL DEFAULT '',          -- short form shown in pickers, e.g. ECE
  active BOOLEAN NOT NULL DEFAULT TRUE,   -- false = retired (hidden from pickers)
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS departments_faculty_idx ON departments (faculty_id, sort);
ALTER TABLE faculties ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

-- Seed with what the app used until now (nothing changes for anyone).
INSERT INTO faculties (name, status, sort) VALUES
  ('Faculty of Engineering', 'open', 0),
  ('Faculty of Environmental Sciences', 'soon', 1),
  ('School of Agriculture', 'soon', 2),
  ('Faculty of Arts', 'later', 3),
  ('Faculty of Communication and Media Studies', 'later', 4),
  ('Faculty of Education', 'later', 5),
  ('Faculty of Law', 'later', 6),
  ('Faculty of Management Sciences', 'later', 7),
  ('Faculty of Science', 'later', 8),
  ('Faculty of Social Sciences', 'later', 9),
  ('Faculty of Transport', 'later', 10),
  ('College of Medicine', 'later', 11)
ON CONFLICT (name) DO NOTHING;

INSERT INTO departments (faculty_id, name, code, sort)
SELECT f.id, d.name, d.code, d.sort
FROM faculties f
JOIN (VALUES
  ('Electronic & Computer Engineering', 'ECE', 0),
  ('Mechanical Engineering', 'MEE', 1),
  ('Industrial & Petroleum Engineering', 'IPE', 2),
  ('Chemical & Polymer Engineering', 'CPE', 3),
  ('Civil Engineering', 'CVE', 4),
  ('Aerospace Engineering', 'ASE', 5)
) AS d(name, code, sort) ON TRUE
WHERE f.name = 'Faculty of Engineering'
ON CONFLICT (name) DO NOTHING;
