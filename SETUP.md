# Unify Backend Setup (Supabase + Prisma + Render + Vercel)

Backend code is already in the repo (`notes-engine` combined server).
**Render runs Prisma on Supabase for you**: every Render build executes
`prisma generate && prisma migrate deploy && npm run build`, so the database
migrates itself on each deploy. You just supply the connection strings.

Supabase renamed its keys: **publishable** (= legacy anon) and **secret**
(= legacy service_role). The code accepts both namings; this guide uses the
new ones. (`SUPABASE_JWKS_URL` is not needed — the API verifies sessions via
the Auth server.)

## 1. Supabase (~8 min)

1. New project `unify`, save the DB password. Fill these four values
   (Project Settings → API):
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`, public)
   - `SUPABASE_SECRET_KEY` (`sb_secret_...`, backend only — never frontend)
2. **Settings → Database → Connection string** (replace `[YOUR-PASSWORD]`):
   - **Pooler** (port `6543`) → `DATABASE_URL` (app traffic)
   - **Direct** (port `5432`) → `DIRECT_URL` (`prisma migrate deploy` only)
3. **Authentication → Providers → Google → Enable** (OAuth client from Google
   Cloud, redirect `https://xyzcompany.supabase.co/auth/v1/callback`).
4. **Authentication → URL Configuration**: Site URL + Redirect URLs +=
   `https://unify-virid.vercel.app/**`.
5. **Schema — pick ONE path:**
   - **A (recommended, automatic):** do nothing. Render applies
     `notes-engine/prisma/migrations/0001_init` on first deploy. Then run
     `supabase/seed.sql` once in **SQL Editor** for LASU + MEE 352 Week 1.
   - **B (manual):** run `supabase/schema.sql` then `supabase/seed.sql` in SQL
     Editor, and baseline Prisma after the first deploy:
     `npx prisma migrate resolve --applied 0001_init`.

## 2. Render (~5 min) — Blueprint from YOUR fork

1. Dashboard → **New → Blueprint** → select **`knight-dev01/Unify`**
   (not DIBBLS — backend lives on the fork). `render.yaml` is auto-detected.
2. Confirm the service shows **Root Directory: `notes-engine`**, plan **free**,
   health check **`/healthz`**.
3. Fill env vars:
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
   - `DATABASE_URL`, `DIRECT_URL`
   - `CORS_ORIGIN` → `https://unify-virid.vercel.app` (exact, no trailing slash)
   - Skip `ANTHROPIC_API_KEY` unless using note authoring
4. **Deploy** (~3-5 min). Logs must show, in order: `npm install` →
   `prisma generate` → `prisma migrate deploy` (`0001_init` applied) →
   `tsc` build → `Unify Notes Creation Engine running`.
5. Verify: `<render-url>/healthz` → `{"ok":true,"service":"unify-api"}`.
   First hit after idle takes 30-60s (free tier sleeps) — normal.
6. Supabase → **Table Editor**: 6 tables exist. Run `seed.sql`, then check
   `<render-url>/v1/universities` returns LASU in the browser.

## 3. Vercel (~3 min) — partner repo, frontend only

Settings → Environment Variables (Production + Preview):

| Key | Value |
|---|---|
| `SUPABASE_URL` | step 1 |
| `SUPABASE_PUBLISHABLE_KEY` | step 1 (`sb_publishable_...`) |
| `API_URL` | Render URL from step 2, no trailing slash |
| `USE_BACKEND` | `1` |

(`VITE_`-prefixed equivalents work too — plain names preferred.)

**Redeploy** so env vars bake in.

## 4. First end-to-end test

1. Test users register fresh via Google (Firebase accounts don't carry over).
2. Sign in → onboarding (LASU guaranteed even unseeded) → dashboard →
   week content from `weeks.note_json` → complete a topic (XP/streak served).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Cold start slow/fails once, then works | Free-tier sleep. App retries; open `/healthz` once to wake. |
| `CORS error` | `CORS_ORIGIN` must exactly match the Vercel URL. |
| `401 Invalid session` | Google provider off, or user signed in pre-cutover — re-register. |
| Prisma `P1001 can't reach DB` | `DIRECT_URL` must be `:5432` direct with correct password. |
| Prisma re-creates existing tables | You used path B already — run the baseline command from 1.5. |
| `/v1/universities` returns `[]` | Seed not run yet — run `supabase/seed.sql`. |
