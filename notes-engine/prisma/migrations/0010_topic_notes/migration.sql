-- Topic-level versioned notes. Publishing a topic always inserts a new
-- version row (v1, v2, v3...) so authors never overwrite each other or
-- themselves. The weeks table keeps only the week shell
-- (title/subtitle/eoq); topics assemble from the latest version per topic.
create table if not exists topic_notes (
  id uuid primary key default gen_random_uuid(),
  course text not null references courses(code) on delete cascade,
  week int not null,
  topic int not null,
  version int not null default 1,
  title text not null default '',
  note_json jsonb not null default '{}'::jsonb,
  author_id uuid,
  created_at timestamptz not null default now(),
  unique (course, week, topic, version)
);
create index if not exists topic_notes_lookup_idx on topic_notes (course, week, topic, version desc);
create index if not exists topic_notes_author_idx on topic_notes (author_id);
alter table topic_notes enable row level security;
