# Production readiness: honest grade

Assessed at v2.13.x. "Production" here means real students relying on it daily, including **100 people using it at the same moment** (a lecture hall opening the app, or a class scanning attendance).

## Verdict

**About 6.5 out of 10. Ready for a supervised pilot of around 100 students; not yet ready to be left alone at scale.**

The application logic handles 100 simultaneous students comfortably in testing. What stands between this and a confident public launch is mostly operations: hosting tier, backups, automated tests, and a few verifications that need your real accounts.

## Scorecard

| Area | Score | Why |
|---|---|---|
| Features and UX | 8 | Complete student, lecturer, contributor and admin journeys; offline reader; self-updating PWA; consistent loading, buttons and motion. |
| Frontend performance | 7 | First load about 124 KB gzipped (main app bundle 61 KB after moving KaTeX to on-demand). Under a harsh test (Slow 4G, 4x slower CPU) the first paint is 2 to 3 s and main content 5 to 8 s. Fine on normal phones and networks; long startup tasks of 1 to 1.3 s under throttle remain. |
| API capacity at 100 users | 8 (code), 5 (on Render free) | See the load test below. Hosting, not code, is the limit on the free plan. |
| Security | 6.5 | Roles enforced on the server, row-level security locked, service key only on the backend, sessions checked with Auth, per-session rate limits, strict input validation, selfies in a private bucket with expiring links. Gaps: no automated security review or dependency audit in CI, the seed admin password must be rotated, a revoked session lives up to 60 s, no CSP header on the web app. |
| Privacy | 5 | Selfies are private and deleted when the session ends (only names stay in the register), but there is no in-repo privacy notice or consent record. Needs your lawful-basis decision (Nigeria Data Protection Act). |
| Reliability and monitoring | 6.5 | Per-minute metrics, Web Vitals and alert emails exist. Unverified until `BREVO_API_KEY` and `ADMIN_EMAILS` are set and the test alert is sent. Metrics are in memory (restart clears them). One API instance, so one crash is a short outage. |
| Data safety | 4 | Supabase free tier has no point-in-time recovery and there is no tested restore. Highest-risk gap for "production". |
| Testing and release | 4.5 | Strong manual and scripted browser checks were run, but the Puppeteer suites live outside the repo and nothing runs in CI. No staging environment. |

## The 100-user test

Method: the real API server, pointed at a fake Supabase that answers with 60 to 80 ms of latency per call (`notes-engine/scripts/loadtest/`). 100 simulated students, each with their own session, opening Home (profile, updates, timetable), then attendance history and materials, with think time between actions.

| | Result |
|---|---|
| Requests | 3,440 in 36 s (about 97 per second) |
| Errors / rate-limited | 0 / 0 |
| Calls to the Auth server | 301 (3,440 without the new 60 s session cache) |
| Typical response (p50) | 18 ms (cached updates) to 299 ms (profile, several database reads) |
| Slow responses (p95) | 176 ms to 1.8 s, worst for the profile call during the first-second burst |

At **300** simulated students the single process starts to saturate on this machine (multi-second responses and some dropped connections). That test shares one laptop between the API, the fake database and the driver, so treat it as a rough ceiling, not a number for Render.

What the test does not cover: the real Supabase (its own limits and latency), Render's network, a free instance's reduced CPU, Brevo and push delivery.

## Problems found and fixed during this assessment

1. **Rate limit would have locked out a lecture hall.** The whole `/v1` API allowed 200 requests per 15 minutes **per IP**. Students on one campus network share an IP, so roughly 13 requests a minute for everyone combined. Now 240 a minute per signed-in session (120 per IP when anonymous).
2. **Every request called the Auth server.** A busy session now makes one call a minute (cached, never past the token's expiry).
3. **No response compression.** JSON and text are now gzipped (about 5x smaller for notes and lists).
4. **50 MB request body limit.** Lowered to 12 MB.
5. **Selfie storage would fill the free tier** (about 450 MB a month if photos were kept). Photos are now deleted as soon as the session ends, so storage stays near zero.

## Punch list before an unsupervised launch

Must do:

1. **Move the API off the free instance.** Render free sleeps after about 15 minutes idle (30 to 60 s cold start) and has a fraction of a CPU. A starter always-on instance fixes both.
2. **Backups.** Paid Supabase plan with point-in-time recovery, or scheduled dumps, and **do one test restore**.
3. **Set `BREVO_API_KEY` and `ADMIN_EMAILS`, then press "Send test alert"** in Admin, Live performance.
4. **Remove `SEED_TEST_USERS`**, delete the `*.test.unify` accounts, and rotate the default admin password.
5. **Decide and publish the privacy notice** for selfies and profile data.
6. **Real-device pass**: a QR scan with a phone, a push notification on Android and on an iPhone installed to the Home Screen, a real alert email.

Should do:

7. Move the browser test suites into the repo and run them in CI on every push (also run the load test against a **staging** Supabase project, never production).
8. Add a Content-Security-Policy header on the web app and run a dependency audit in CI.
9. Parallelise the profile endpoint's database reads (it makes about five sequential calls, the slowest endpoint under load).
10. Persist metrics (or ship them to a hosted service) so a restart does not erase the history.
11. Add a second API instance behind Render's load balancer once traffic justifies it (the caches are per-instance and safe to duplicate).

Nice to have: an in-app way to report a problem with a screenshot, an uptime monitor hitting `/healthz` from outside, and feature flags for risky releases.
