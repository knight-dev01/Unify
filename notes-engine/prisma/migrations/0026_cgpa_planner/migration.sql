-- CGPA Planner course status tracking (S16: Done/Priority/Not yet)
-- Students mark courses as completed, priority (compulsory), or not yet taken
-- Used to calculate remaining units and GPA needed per semester

CREATE TABLE course_status (
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  course_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'priority', 'not_yet')),
  units INTEGER DEFAULT 3, -- course credit units, typically 2-4
  grade NUMERIC(3,2), -- actual grade received (for 'done' courses)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  PRIMARY KEY (user_id, course_code)
);

-- Index for CGPA calculations (fetch all user's course statuses)
CREATE INDEX idx_course_status_user ON course_status(user_id);

-- Index for priority courses (pre-tick compulsory in UI)
CREATE INDEX idx_course_status_priority ON course_status(user_id, status) WHERE status = 'priority';
