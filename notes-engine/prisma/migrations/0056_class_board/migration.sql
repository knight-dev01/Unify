-- Class board (Review 3, C3/C4): students ask their class rep questions, the
-- class rep answers; classmates add "same question"; the class rep posts polls.

ALTER TABLE hoc_posts DROP CONSTRAINT IF EXISTS hoc_posts_type_check;
ALTER TABLE hoc_posts ADD CONSTRAINT hoc_posts_type_check CHECK (type IN ('announcement', 'tip', 'question', 'poll'));

-- A question a student asked (only the asker and class reps see it until it's answered).
ALTER TABLE hoc_posts ADD COLUMN IF NOT EXISTS asked_by_student BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hoc_posts ADD COLUMN IF NOT EXISTS answer TEXT;
ALTER TABLE hoc_posts ADD COLUMN IF NOT EXISTS answered_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE hoc_posts ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ;
-- Polls: 2 to 4 options, optional closing time.
ALTER TABLE hoc_posts ADD COLUMN IF NOT EXISTS poll_options JSONB;
ALTER TABLE hoc_posts ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS hoc_posts_class_idx ON hoc_posts (department, level, created_at DESC);

CREATE TABLE IF NOT EXISTS hoc_poll_votes (
  post_id UUID NOT NULL REFERENCES hoc_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  choice INT NOT NULL CHECK (choice BETWEEN 0 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);
ALTER TABLE hoc_poll_votes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS hoc_question_same (
  post_id UUID NOT NULL REFERENCES hoc_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);
ALTER TABLE hoc_question_same ENABLE ROW LEVEL SECURITY;
