# Scalability review (v2.30.0)

How each part of the API grows with the number of students (S), courses (C) and notes (N), using DSA basics: count the database round trips per request, look for work done per row (loops with a query inside), whole-table reads, and lookups with no index.

## The rule that matters most here

**Supabase returns at most 1,000 rows per request**, whatever `.limit()` asks for. Code that writes `.limit(5000)` and expects everything gets the first 1,000 and silently drops the rest. Use `lib/paging.ts`:

| Helper | Use it for |
|---|---|
| `pageAll(build)` | Every row of a query. `build(from, to)` must add a stable `.order()` and `.range(from, to)`. |
| `inChunks(ids, build)` | A long `.in()` list: 200 ids per request, each request paged. |
| `takersOf(courses)` | Everyone taking these courses (any spelling of the code). |
| `repsAmong(ids)` | The class reps among these users. |

`scripts/test_paging.ts` (`npm run test:paging`) checks the helpers against a fake table capped at 1,000 rows. The number of requests grows in a straight line: 10,000 rows take 11 requests.

## Fixed in v2.30.0

| Module | Problem | Effect before | Now |
|---|---|---|---|
| Push (`lib/push.ts`) | Subscriptions read for at most 2,000 users in one request | Past about 1,000 devices, the rest got no push | Chunks of 200 users, paged |
| Announcements (`pushAnnounce`, admin announce) | `profiles` read with `.limit(5000)` | Past 1,000 users, no bell or push for the rest | Paged |
| Personal reminders (`lib/reminders.ts`) | `push_subscriptions` read once; xp events per 300 people in one request | Past 1,000 devices, nobody else got reminders; busy days counted people as "not studied" | Paged and chunked |
| Class rep confirm reminders (`confirmTick`, every minute) | One query per rule, per class and per rep | Round trips grew as courses × classes × reps | A fixed handful of queries, one upsert for all claims |
| Live wire, online class, slot changes, lecturer claims | "Everyone taking this course" read with `.limit(2000–5000)`; `.in()` with every taker in one URL | Big shared courses cut off at 1,000 | `takersOf` / `repsAmong` |
| Course lists, search, studio, contributor stats (`v1.ts`) | `weeks`, `course_levels` and `topic_notes` read whole on every request | Later courses lost their week counts past 1,000 rows; every request read the whole catalogue | Paged, cached 60 s (`lib/catalog.ts`), cleared on note and course writes |
| Indexes (migration 0055) | No index for lookups by course (`enrollments`, `topic_progress`, `quiz_attempts`), by attendance session, or by department + level | Each lookup read the whole table: O(n) per request | Indexed: O(log n) |

## Still to do (same pattern, lower risk)

These are mostly stats screens. Past 1,000 rows they show numbers that are too low, but nobody misses a notification. Fix them with `pageAll` or `inChunks`, or better, move the counting into a SQL view or RPC so the database returns totals instead of rows.

| Module | Where | What |
|---|---|---|
| Lecturer course stats | `routes/teaching.ts` 269, 270, 326, 483, 486, 501, 579 | Progress, quiz attempts and attendance per course (`.limit(50000)`) |
| Dean and department stats | `routes/roles.ts` 235, 267, 346 | Departments, attendance per entry, active players |
| Admin growth charts | `routes/v1.ts` 3080–3082 | Sign-ups, notes, xp in a period |
| Classmates and course activity | `routes/school.ts` 95, 109 | Classmates in a class, notes per course |
| Games leaderboard | `routes/games.ts` 83 | All scores for a course (sort and limit in SQL instead) |
| Course progress | `routes/v1.ts` 2801, 2802, 2373, 2374 | Progress and quiz rows for a class |
| Attendance history | `lib/classlist.ts` 129, `routes/classroom.ts` 1130 | Sessions a student attended; records per session |
| Class list | `routes/classlist.ts` 384 | Entries on one list (fine until a list passes 1,000 students) |
| Seeding | `lib/seed.ts` | Queries in loops; admin-only and run rarely |

## Load testing

`scripts/loadtest/` runs the real API against a fake Supabase (see its README). The fake returns empty results, so it measures the API process and auth caching, not how queries grow with data. To test data growth, seed 100, 1,000 and 10,000 students into a **separate** Supabase project (never production) and time the hot endpoints at each size. If doubling the data roughly doubles the time or less, that's fine. If the time jumps by much more, look for a query inside a loop.
