# Unify Learn — Developer Report (4 October 2026)

Covers the 1 October 2026 test bug list (14 confirmed: 7 critical P0, 7 important P1),
everything fixed since, what is left, and what still needs live verification — and why.

Current version: **v1.11.1**. Every change below was verified with `tsc --noEmit`
both sides plus a production `vite build` before commit.

## P0 fixes (critical — blocked student testing)

- **BUG-001 Contributor sees all courses (v1.8.1).** Server gates (`requireCourseAccess`,
  403 for collaborators outside their teaching enrollments) on weeks, topics, notes and
  publish; Browse/Studio only list assigned courses; admin can assign courses per user.
- **BUG-002 Raw math text (v1.8.2).** One MathJax renderer app-wide (`lib/mathjax.ts` +
  `MathText`); KaTeX uninstalled; service worker caches MathJax + fonts offline.
- **BUG-003 Diagram placeholders (v1.8.3).** `diagrams` Storage bucket + policies,
  `lib/storage.ts` upload, numbered figure cards, Studio diagram tagging.
- **BUG-004 Generation fails on large input (v1.8.4/v1.8.5).** Auto-split into 20k-char
  parts, per-part retry, typed errors (`INPUT_TOO_LARGE`, `BAD_OUTPUT`…), async convert
  jobs (`202 + poll`) so long generations survive timeouts.
- **BUG-005 Quiz leaks answers (v1.8.5).** Submit-at-end EOQ: neutral picks, `Check score`
  only when all answered, verdicts/feedback/record on submit.
- **BUG-006 ME 352 not found (v1.8.6).** `course_aliases` table + boot seed,
  `GET /v1/courses/search` across code/title/alias, Explore debounced search spanning
  both semesters with badges.
- **BUG-007 Silent stacking publishes (v1.8.7).** Occupied week/topic returns 409
  (`WEEK_OCCUPIED`/`TOPIC_OCCUPIED`); Studio offers Replace / Add as new version / Cancel.
  Nothing overwrites or duplicates silently.

## P1 fixes (important — before the research test)

- **BUG-008 Old + new versions both listed (v1.8.7 batch).** Student lists and the author
  dashboard group by topic and show the latest version only (`older` count, history in reader).
- **BUG-009 No Lecture 1/2/3 structure (v1.9.0).** Weeks hold lectures with per-lecture
  topic numbering; reader switches via `?c=` with cross-lecture Back/Next; progress,
  versions, resume and publish are lecture-keyed (migration `0018`). Studio/NoteBuilder
  lecture pickers; AI prompt emits lecture groups. **Known deviation:** EOQ stays one week
  bank after the final lecture — per-lecture banks have no storage yet (decision pending).
- **BUG-010 Partial EOQ banks (v1.9.1).** A short bank triggers one automatic repair pass
  requesting a fresh 10-question bank (8 MCQ + 2 FITB); repair never fails the job.
- **BUG-011 Definitions/formulas blend in (v1.9.2).** Symbol cards render through MathJax
  (no raw `\alpha` overlapping titles), flex-clamped, wider card spacing.
- **BUG-012 Dashboard strip (v1.9.3).** 2-column course-card grid (title, lecturer,
  weeks, topics done), one-tap elective removal, lecturer names batched into the catalog.
  **Decision pending:** BUG-012 asks for no separate Explore page — Explore stays as the
  add-courses path until you confirm removal (it is the only discovery route).
- **BUG-013 Slow page changes (v1.9.3).** Idle-time warmup of enrolled week-lists kills the
  slow-blank feel. **Note:** no discussion panel exists in the app, so that half of the
  report had nothing to fix.
- **BUG-014 Quiz extra click + unstyled Check (v1.9.2).** `Check score`/`Try again` styled
  like primary buttons (the class had zero CSS); quiz tab opens directly.

## Post-list fixes

- **Explore crash (v1.9.4).** Search `useEffect` sat below the loading return → hook-count
  crash on load. All 14 routes audited; Explore was the sole offender.
- **Share live-links 404 (v1.11.1).** `GET /share/mine` was registered after
  `GET /share/:token`, so Express swallowed "mine" as a token. Route order fixed; create,
  resolve, revoke, WhatsApp unfurl re-verified by code path.
- **My Classes + offline-first (v1.10.0).** Recurring weekly timetable + live roster per
  taught course (`/classes`, migration `0019`); offline write queue (progress/quiz/resume
  flush on reconnect) + per-week Save offline into a version-proof cache (SW v6).
- **Google sign-in (v1.11.0).** OAuth on both auth tabs, onboarding prefill, no backend
  change (API is provider-agnostic).

## Left + why unverified

1. **Render redeploy outstanding (blocks most verification).** Migrations
   `0016` (diagrams) → `0019` (class slots) plus new endpoints only land on `migrate deploy`.
   Until then, fixes are code-verified (`tsc` + build) but not live-verified.
2. **Google sign-in needs console work + a live test.** Supabase provider enablement and
   `/auth` redirect URLs cannot be done in code; after that, one real Google round-trip
   (new user → onboarding → dashboard) is still untested.
3. **Lecturer side never tested** (per the original list) — including the new My Classes
   page, which needs a teaching-account walkthrough: assign courses in admin, set slots,
   check the roster and the student-side class-times card.
4. **Phone pass outstanding** for student + contributor sides (layouts are mobile-first
   480px by construction, but not device-tested).
5. **Progress/streak persistence retest** after the lecture + offline changes (resume now
   carries lecture; queue flush needs an offline→online cycle on a real device).
6. **Proposed, not built:** per-university allowed-email-domains policy (the actual gate
   for multi-school expansion — works with both email and Google paths), and a
   link-Google-to-existing-account action (same address via both methods can mint two
   identities).
