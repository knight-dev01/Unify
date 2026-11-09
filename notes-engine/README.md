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
src/routes/classroom.ts   timetable, class board, attendance sessions + check-in (selfies), CGPA planner, materials
src/routes/ops.ts         /admin/metrics, /admin/alerts/test, /metrics/vitals
src/middleware/           requireAuth (60 s session cache), limits (per-session rate limits), requireAdmin, logger
src/lib/                  supabase clients, metrics, alert (email watchdog), push, email (Brevo), ai (provider adapter)
prisma/                   schema + migrations (0001 to 0029)
scripts/                  check-env, copy-js, loadtest/
```

## Things that matter for running it

- **Auth.** Every `/v1` request carries a Supabase access token. `requireAuth` confirms it with the Auth server and remembers the answer for up to 60 seconds (never past the token's expiry), so a busy session makes one Auth call a minute. A revoked session can therefore linger for up to a minute.
- **Rate limits.** `/v1`: 240 requests a minute per signed-in session, 120 per IP when anonymous. Per session, not per IP, because a lecture hall shares one public IP. Attendance check-in: 20 per 10 minutes per student. CGPA: 1500 per 15 minutes per session. Vitals: 90 a minute.
- **Attendance.** Rotating HMAC code (30 s windows, current and previous accepted). One shared open session per course. Check-in needs a selfie unless `ATTENDANCE_SELFIE=off`; it is saved to the private `attendance-selfies` bucket (created on first use) as `sessionId/studentId.jpg`, and the roster returns links that expire in 10 minutes. The photos are deleted when the session is closed (or within 5 minutes of it timing out); only names and times stay in the register.
- **Home updates.** `GET /v1/updates` (everyone), `GET`/`PUT /v1/admin/updates` (admin). Stored as one JSON value in `app_settings` under `home_updates`, cached 30 s in memory. Links must start with `/` or `https://`.
- **CGPA.** Current and target are numbers from 0 to 5 (target from 0.5) with at most two decimals; anything else is a 400, never rounded.
- **Metrics and alerts.** In-memory per-minute buckets for 3 hours (a restart clears them). The watchdog emails admins on crashes, error spikes, slow responses, database trouble, high memory, event-loop stalls and bursts of browser errors. Needs `BREVO_API_KEY` and `ADMIN_EMAILS`.

## Environment

See `SETUP.md` for the full table. Notable: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL` (pooler), `DIRECT_URL`, `CORS_ORIGIN`, `ADMIN_EMAILS`, `BREVO_API_KEY` + `EMAIL_FROM`, `VAPID_*`, `ATTENDANCE_SELFIE` (`on` by default), `GEMINI_API_KEY`, `SENTRY_DSN`.

## Load testing

`scripts/loadtest/` holds a fake Supabase (Auth + REST with realistic latency) and a 100-student simulator, so the real API can be exercised without touching production data. See the README there.
