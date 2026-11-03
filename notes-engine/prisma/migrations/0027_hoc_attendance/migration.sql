-- HOC role and attendance setup
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS attendance_full_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS attendance_matric TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_hoc BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hoc_approved_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hoc_approved_by UUID REFERENCES profiles(id);

CREATE TABLE IF NOT EXISTS device_keys (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  device_pubkey TEXT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_code TEXT NOT NULL,
  scanned_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  verified BOOLEAN DEFAULT FALSE,
  week INT
);

CREATE TABLE IF NOT EXISTS hoc_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('announcement','tip','question')),
  title TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lecturer_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_code TEXT NOT NULL,
  week_number INT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('slides','notes','past-paper')),
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_code TEXT NOT NULL,
  meet_link TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES online_class_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  checkin_1 TIMESTAMPTZ,
  checkin_2 TIMESTAMPTZ,
  checkin_3 TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, student_id)
);
