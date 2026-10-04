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

## Left + verification log

1. **Render redeploy — VERIFIED 4 Oct 2026.** Migrations `0016`–`0020` applied
   live; new endpoints (aliases search, lecture paths, timetable, roster,
   error log, support config) confirmed working in production.
2. **Google sign-in live test — VERIFIED 4 Oct 2026.** Real Google account in
   through onboarding to dashboard after the console enablement.
3. **Lecturer walkthrough — VERIFIED 4 Oct 2026.** Teaching account: courses
   assigned in admin, slots set, roster visible, student-side class-times card
   correct.
4. **Phone pass — VERIFIED 4 Oct 2026.** Student + contributor sides on real
   phones.
5. **Persistence retest — VERIFIED 4 Oct 2026.** Resume (with lecture),
   streaks, and offline queue flush confirmed on device.
6. **Proposed, not built:** per-university allowed-email-domains policy (the actual gate
   for multi-school expansion — works with both email and Google paths), and a
   link-Google-to-existing-account action (same address via both methods can mint two
   identities).
7. **Open product decisions (need a ruling, not testing):** per-lecture EOQ banks
   vs the single week bank after the final lecture; removing Explore into the
   dashboard per BUG-012's ideal vs keeping it as the add-courses path.

## Brand direction: why the generated kit can't hold as law

The `docs/Unify-Brand-Kit/` (posted 2 October 2026) was single-pass AI output
(Claude): no user testing behind it, no ratification, and it contradicts decisions
that were already tested and shipped. A generated draft is an input to a brand
decision — it is not the decision. What follows is the recorded reasoning so the
next reader doesn't re-litigate it from a chatbot's authority.

**1. The kit contradicts the product's own retention thesis.**
The master PRD's core loop is Duolingo mechanics (streaks, XP, badges, tactile
progression) applied to university study. The kit's headline rule — "it should never
look like a game" — outlaws the very psychology the product is built on. Tested
reality agrees with the PRD: residents and students shown the Duolingo-style revamp
(Classic) preferred it. Playfair editorial (Story) was added as a second theme to
keep the serif direction alive, not to replace a validated winner.

**2. The kit contradicts tested user requests.**
It mandates one-column course cards; real testing (BUG-012) asked for a card grid.
It bans Save PDF; the XP-gated PDF is a shipped retention incentive users
understand. It bans the mascot from the dashboard; the greeting mascot is part of
the daily habit loop. In each case the tested artifact wins over the generated rule —
the kit's own social guideline concedes this precedent (the shipped lighter post
template "is now the standard" over the earlier generated one).

**3. The case for the Duolingo style (Classic, the default).**
Duolingo (~100M+ MAU), Quizlet and Khan Academy converge on the same findings for
young mass-market learners: chunky 44px-grade touch targets (cheap Androids, touch
imprecision), high-contrast CTA colour (sunlight legibility), rounded friendly type
(Nunito stays legible at 12px where thin-serif Playfair strokes break on low-end
screens), and celebration moments (XP bursts, streaks) that create the return habit
the PRD demands. Serif-editorial is the right voice for lecturers, certificates and
campaigns — not for a first-year student revising on a bus.

**4. Why the theme switch stays.**
Two validated tastes exist and they split by role and age: students motivate on
Classic; lecturers, collaborators and formal surfaces read premium on Story. Forcing
one face loses one audience. Both themes persist, per-device, with usage measured —
a future default follows data, not taste. Proposed instrumentation: log the active
design with existing analytics events so the split is evidence, not anecdote.

**5. The Unify ecosystem brand (adopted).**
Classic ("Play") and Story ("Editorial") are co-equal official themes, not a main
and a fallback. From the kit we adopt what is genuinely good regardless of theme:
plain-spoken button labels, zero hype register, visible focus states (accessibility
fix queued), the social-post template structure, and Story's token set for the
editorial theme. From the kit we reject: the Playfair-only rule, the gradient ban
where gradients carry meaning (progress, earned states), the PDF ban, the mascot
confinement, and the one-column-cards rule. Future brand proposals arrive as diffs
against this section with test evidence attached — never as generated doctrine.
