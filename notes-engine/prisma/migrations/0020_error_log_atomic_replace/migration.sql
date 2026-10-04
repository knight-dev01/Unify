-- Client error log (works with or without Sentry): the app POSTs render
-- crashes and failed actions here; admins read the latest in the panel.
create table if not exists client_errors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  kind text not null default 'client',
  message text not null default '',
  stack text not null default '',
  url text not null default '',
  app_version text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists client_errors_created_idx on client_errors (created_at desc);

-- Atomic week publish-replace: old topic rows + student progress for the
-- week are deleted and the fresh rows inserted inside ONE transaction, so
-- two authors publishing the same week in the same second can never leave
-- a half-deleted week (last writer still wins, but always wins whole).
create or replace function replace_week_topics(p_course text, p_week int, p_author uuid, p_rows jsonb)
returns jsonb
language plpgsql
as $$
declare
  r jsonb;
  ids jsonb := '[]'::jsonb;
  nid uuid;
begin
  delete from topic_notes where course = p_course and week = p_week;
  delete from topic_progress where course = p_course and week = p_week;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into topic_notes (course, week, topic, lecture_no, version, title, note_json, author_id)
    values (
      p_course,
      p_week,
      (r ->> 'topic')::int,
      coalesce((r ->> 'lecture')::int, 1),
      coalesce((r ->> 'version')::int, 1),
      coalesce(r ->> 'title', ''),
      r -> 'noteJson',
      p_author
    )
    returning id into nid;
    ids := ids || jsonb_build_object(
      'topic', (r ->> 'topic')::int,
      'lecture', coalesce((r ->> 'lecture')::int, 1),
      'version', coalesce((r ->> 'version')::int, 1),
      'id', nid
    );
  end loop;
  return ids;
end;
$$;
