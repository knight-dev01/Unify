# Operating Unify Learn

For whoever keeps the app running. First-time setup is in `SETUP.md`; how ready the app is for launch is in `PRODUCTION-READINESS.md`.

## Deploying

| Part | How | Notes |
|---|---|---|
| API | Push to `knight-dev01/Unify` `main`. Render builds (`render.yaml`): env check, Prisma migrate, `tsc`. | Migrations run on every build. A failed migration stops the deploy, so the old version keeps serving. |
| Web | After pushing, run `powershell -ExecutionPolicy Bypass -File scripts/Sync-Frontend.ps1`. It copies `apps/web`, `api/`, `vercel.json` and the README to `DIBBLS/Unify`; Vercel builds that. | Never merge `DIBBLS/Unify` back into the fork. |
| Users' devices | Nothing to do. Open copies of the app notice the new build (they check on open, on return, on reconnect and every 2 minutes), reload onto it and delete the old cache. | Hosting must serve `/sw.js` and `/version.json` with `no-cache`; both `vercel.json` files do. |

Bump the version in four places and add a changelog entry (see the root `README.md`). Check `https://<web>/version.json` after a deploy: the `build` value should change.

## Environment variables that change behaviour

| Variable | Effect |
|---|---|
| `ADMIN_EMAILS` | Comma-separated bootstrap admins. Also where alert emails go. |
| `BREVO_API_KEY`, `EMAIL_FROM` | Email (new-note mail, announcements, **alert emails**). `EMAIL_FROM` must be a sender verified in Brevo. Without the key, alerts still appear in Admin, marked "not emailed". |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. The public key must match the one in the web app. |
| `ATTENDANCE_SELFIE` | `on` (default) requires a selfie to mark attendance; `off` makes it optional. |
| `SELFIE_RETENTION_DAYS` | Days to keep attendance selfies before they are deleted (default 30). |
| `SEED_TEST_USERS` | `1` creates `*.test.unify` accounts for testing. **Remove after testing and delete those accounts.** |
| `CORS_ORIGIN` | Comma-separated web origins allowed to call the API. |
| `SENTRY_DSN` | Optional crash reporting. |

## Watching it

**Admin, Health, Live performance** shows requests per minute, server error rate, typical and slow (p95) response times, database round trip, memory and event-loop stalls, per minute for 15 minutes, 1 hour or 3 hours, per module. It also shows how pages feel to real users (Web Vitals) and recent alerts. Metrics are in memory: a restart clears them.

**Alert emails** go to `ADMIN_EMAILS` plus admin profile emails (fake domains are skipped) for: a crash, an error spike, slow responses, a failing module, the database being slow or unreachable, high memory, a stalled server, a startup job giving up, a burst of browser errors. Each distinct problem emails at most once every 15 minutes, with a cap of 12 emails an hour. After setting the environment, press **Send test alert** on the panel; that is the only real proof the email path works.

## Pictures and privacy

- **Profile pictures** go to the public `avatars` bucket, 320 px JPEG, normally under 60 KB, cached for a year (the URL carries a version stamp).
- **Attendance selfies** go to the **private** `attendance-selfies` bucket. Only the lecturer or class rep running that session sees them, through links that expire in 10 minutes. They are deleted automatically after `SELFIE_RETENTION_DAYS`. Tell students what the photo is for (the app says so on the selfie screen). If you operate under the Nigeria Data Protection Act, record the lawful basis and keep this retention period consistent with your privacy notice.

## Home slider updates

Admin, Announcements has a Home slider card: title, message, optional link (`/path` inside the app or `https://…`), button label, a Box Boy, and an optional end date. Up to 12 at a time. Everyone sees changes within about 30 seconds.

## Runbook

| Symptom | Check |
|---|---|
| Everything is slow, first request takes 30 to 60 s | Render free instances sleep after about 15 minutes idle. The web app warms `/healthz`; a paid always-on instance removes it. |
| Many users see "You're going a bit fast" | Rate limit is 240 requests a minute per signed-in session. A single user hitting it means a client bug (look for a loop in Admin, Errors). |
| Attendance "photo could not be saved" | The `attendance-selfies` bucket is created on first use with the service role; check Supabase Storage and the API logs. |
| Alerts say "not emailed" | `BREVO_API_KEY` or `ADMIN_EMAILS` missing, or the sender is not verified. |
| A user cannot sign in right after being removed | A signed-out or revoked session can stay valid for up to 60 seconds (auth cache). |
| Installed app shows an old icon or screen | It updates itself on next open while online. If stuck, remove and reinstall the PWA. |
| Out of Supabase storage | Lower `SELFIE_RETENTION_DAYS`; check the `avatars` and `diagrams` buckets. |

## Backups

Supabase's free tier has no point-in-time recovery. Before real use, either move to a plan with backups or schedule a regular `pg_dump` and test a restore at least once. Prisma migrations in `notes-engine/prisma/migrations` rebuild the schema; they do not restore data.
