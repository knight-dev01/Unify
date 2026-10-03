-- Course aliases (BUG-006): alternate codes students actually type
-- ("ME 352" for "MEE 352"). Search matches code, title, or alias.
create table if not exists course_aliases (
  alias text primary key,
  course text not null references courses(code) on delete cascade
);
create index if not exists course_aliases_course_idx on course_aliases (course);

-- Known shorthand from testing. Conditional: on a fresh database the
-- catalog rows arrive later via boot seed, which carries the same alias
-- (see seed.ts ensureAliases) — so this never fails a migration.
do $$ begin
  if exists (select 1 from courses where code = 'MEE 352') then
    insert into course_aliases (alias, course)
    values ('ME 352', 'MEE 352')
    on conflict (alias) do nothing;
  end if;
end $$;
