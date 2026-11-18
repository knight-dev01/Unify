# Unify Learn: API

Express 4 + TypeScript. Serves the app API under `/v1/*`, authoring under `/api/*`, and share-link previews. Deploys to Render from `knight-dev01/Unify` (`render.yaml` at the repo root). Prisma owns the database schema and applies migrations on every Render build.

## Run it

```bash
npm install
cp .env.example .env     # fill SUPABASE_*, DATABASE_URL, DIRECT_URL, CORS_ORIGIN
npm run dev              # tsx watch server.ts
npm run build && npm start
```

Health: `GET /healthz`. Environment is validated at build by `scripts/check-env.js`.

## Layout

```
server.ts                 app wiring: compression, CORS, body limit (12 MB), logging, metrics, routers, error handler
src/routes/v1.ts          profiles, onboarding, courses, weeks, notes, progress, publish, admin, announcements, Home updates
src/routes/classroom.ts   timetable, class board, attendance sessions, pass scanning, register + CSV, online code check-in, CGPA planner, materials
src/routes/roles.ts       level admins (class rep requests), HOD/Dean attendance reports (counts only), admin role grants
src/routes/teaching.ts    content reports (report a problem / review a week), lecturer posts, counts-only course report, attendance per student, lecturer profile
src/lib/calendar.ts       semester calendar (Week 1 start + weeks) from app_settings
src/routes/classlist.ts   class lists: HOC upload/parse/review, edits and history, student claims, LASU email codes, HOC inbox
src/lib/classlist.ts      claiming entries, attaching attendance, which lists a course's register uses
src/lib/classlistParse.ts reads CSV, .xlsx, .docx, PDF (unpdf) and pasted text into name + matric rows
src/routes/ops.ts         /admin/metrics, /admin/alerts/test, /metrics/vitals
src/routes/courseLecturers.ts  course intro and lecturers with their weeks (class rep sets them)
src/routes/classRep.ts    Confirm today, class rules (confirm reminders, lecturer cancel cut-off), the confirm tick
src/routes/games.ts       game scores, leaderboards (held in the app), Term of the Day results
src/routes/livewire.ts    live wires: send, end, fan-out (bell, push, email backup)
src/routes/lecturers.ts   lecturer claims, class rep checks, everyone's own timetable entries
src/routes/reminders.ts   my reminder times, late-night opt-in, admin reminders for everyone
src/middleware/           requireAuth (60 s session cache), limits (per-session rate limits), requireAdmin, logger
src/lib/                  supabase clients, metrics, alert (email watchdog), push, ai (provider adapter)
src/lib/paging.ts         pageAll / inChunks / takersOf / repsAmong: never trust one request past 1,000 rows
src/lib/catalog.ts        course levels, weeks and the notes index, paged and cached 60 s
src/lib/reminders.ts      the 1-minute tick: personal reminders, admin reminders, confirm and digest ticks
src/lib/email.ts          Brevo sending, the email check, emailWithoutPush (email backup for push)
src/lib/email-templates.ts  brandEmail(): the one Unify Learn email layout; Supabase auth templates
src/lib/emailBudget.ts    the daily email budget by priority (Brevo free plan: 300 a day)
src/lib/digest.ts         the weekly summary email
emails/                   generated HTML of the auth and new-note emails (npx tsx scripts/dump-email-templates.ts)
prisma/                   schema + migrations (0001 to 0059)
scripts/                  check-env, copy-js, test_paging, dump-email-templates, loadtest/
```

## Things that matter for running it

- **Auth.** Every `/v1` request carries a Supabase access token. `requireAuth` confirms it with the Auth server and remembers the answer for up to 60 seconds (never past the token's expiry), so a busy session makes one Auth call a minute. A revoked session can therefore linger for up to a minute.
- **Rate limits.** `/v1`: 240 requests a minute per signed-in session, 120 per IP when anonymous. Per session, not per IP, because a lecture hall shares one public IP. Attendance check-in: 20 per 10 minutes per student. CGPA: 1500 per 15 minutes per session. Vitals: 90 a minute.
- **Attendance.** One shared open session per course. In class, `GET /v1/attendance/pass` gives the student a signed pass (`UP1.<id>.<window>.<hmac>`, 30 s windows, one either side accepted) and the HOC or lecturer posts it to `POST /v1/attendance/sessions/:id/scan`, or a matric number for a dead phone (`method` = `scan` or `typed`). Online classes use a rotating 6-digit code (10 min windows) typed at `POST /v1/attendance/checkin` (`method` = `code`). No photos; leftover selfies from before 2.19 are swept from the private `attendance-selfies` bucket.
- **Home updates.** `GET /v1/updates` (everyone), `GET`/`PUT /v1/admin/updates` (admin). Stored as one JSON value in `app_settings` under `home_updates`, cached 30 s in memory. Links must start with `/` or `https://`.
- **CGPA.** Current and target are numbers from 0 to 5 (target from 0.5) with at most two decimals; anything else is a 400, never rounded.
- **Metrics and alerts.** In-memory per-minute buckets for 3 hours (a restart clears them). The watchdog emails admins on crashes, error spikes, slow responses, database trouble, high memory, event-loop stalls and bursts of browser errors. Needs `BREVO_API_KEY` and `ADMIN_EMAILS`.
- **The 1,000-row rule.** Supabase's API returns at most 1,000 rows per request, whatever `.limit()` says. Anything that must reach everyone (a course's students, every push subscription, a whole class) goes through `lib/paging.ts`. `npm run test:paging` checks the helpers. See `docs/SCALABILITY.md`.
- **Email.** Every email goes through `brevoSend`, which takes room from the daily budget (`lib/emailBudget.ts`): critical (codes, alerts, role changes), urgent (class cancelled or moved, live wires), update (answers, board posts, announcements, new notes), digest (weekly summary). Each priority stops at its own ceiling, and about a fifth is kept for Supabase's sign-in emails. `emailWithoutPush()` emails only people with no push subscription. All bodies use `brandEmail()`; escape anything people typed with `escHtml` / `textHtml`.
- **Reminder tick.** Every minute (`lib/reminders.ts`): personal reminders (one at each chosen time if not studied today, one follow-up 105 minutes later, at most 3 a day, none 22:00 to 06:00 without `late_night_nudges`), admin reminders, class rep confirm reminders (`routes/classRep.ts`) and the weekly summary at 17:00 (`lib/digest.ts`). Each send is claimed in `reminder_sends` first, so a second tick never repeats it.
- **Class board.** `hoc_posts` holds announcements, polls (`poll_options`, `closes_at`, votes in `hoc_poll_votes`) and questions (`asked_by_student`, `answer`; "same question" in `hoc_question_same`). A question waiting for an answer is only visible to its asker and the class reps.

## Environment

See `SETUP.md` for the full table. Notable: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL` (pooler), `DIRECT_URL`, `CORS_ORIGIN`, `ADMIN_EMAILS`, `BREVO_API_KEY` (a Brevo **API** key, `xkeysib-…`, not the SMTP key) + `EMAIL_FROM` (a sender verified in Brevo), `BREVO_DAILY_LIMIT` (optional, default 300), `VAPID_*`, `GEMINI_API_KEY`, `SENTRY_DSN`.

## Load testing

`scripts/loadtest/` holds a fake Supabase (Auth + REST with realistic latency) and a 100-student simulator, so the real API can be exercised without touching production data. See the README there.
