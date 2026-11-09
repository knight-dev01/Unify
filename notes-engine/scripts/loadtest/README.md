# Load testing the API without the real database

`fake-supabase.cjs` stands in for Supabase (Auth `getUser`, PostgREST reads, writes) and adds about 60 to 80 ms of latency per call, like a real database round trip. `load.cjs` simulates students: each has their own session token and loops through Home (me, updates, timetable), attendance history and materials with think time between actions.

```bash
# 1. the fake database
node scripts/loadtest/fake-supabase.cjs                 # listens on 54321

# 2. the real API pointed at it (second shell, from notes-engine/)
PORT=3099 SUPABASE_URL=http://localhost:54321 \
SUPABASE_PUBLISHABLE_KEY=x SUPABASE_SECRET_KEY=x \
CORS_ORIGIN=http://localhost:4173 \
DATABASE_URL=postgresql://x:y@localhost:5432/z DIRECT_URL=postgresql://x:y@localhost:5432/z \
npx tsx server.ts

# 3. 100 students for 30 seconds (third shell)
USERS=100 SECS=30 node scripts/loadtest/load.cjs
curl http://localhost:54321/__stats      # how many Auth and REST calls the API made
```

Options: `USERS`, `SECS`, `THINK` (ms between actions, default 1200), `BASE` (API URL), `LAT` for the fake's latency.

## What it tells you, and what it does not

It measures the API process itself: CPU per request, the effect of caching and rate limits, how errors and latency grow with users. It does **not** measure the real Supabase, Render's network, or a free-tier instance's reduced CPU. Run it on the same class of machine you deploy to before trusting absolute numbers, and repeat against a staging Supabase project (never production) before a big launch.

Reference run (developer laptop, API + fake database + driver all on one machine): 100 students, 3,440 requests in 36 s, no errors, none rate-limited, 301 Auth calls instead of 3,440. See `docs/PRODUCTION-READINESS.md`.
