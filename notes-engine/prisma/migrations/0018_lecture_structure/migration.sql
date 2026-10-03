-- Lecture 1/2/3 structure inside a week (BUG-009): a week holds up to
-- three lectures as separate parts, each its own page. Existing rows are
-- lecture 1, so nothing already published moves.
alter table topic_notes add column if not exists lecture_no int not null default 1;
alter table topic_notes drop constraint if exists topic_notes_course_week_topic_version_key;
alter table topic_notes add constraint topic_notes_course_week_lecture_topic_version_key unique (course, week, lecture_no, topic, version);
create index if not exists topic_notes_lecture_idx on topic_notes (course, week, lecture_no, topic);

-- Progress is per lecture too (Lecture 1 Topic 1 done must not complete
-- Lecture 2 Topic 1). Primary key extended; old rows stay lecture 1.
alter table topic_progress add column if not exists lecture_no int not null default 1;
alter table topic_progress drop constraint if exists topic_progress_pkey;
alter table topic_progress add primary key (user_id, course, week, topic, lecture_no);

-- Resume remembers the lecture for exact restore.
alter table resume_state add column if not exists lecture_no int not null default 1;
