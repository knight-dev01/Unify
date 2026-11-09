# Changelog

All notable changes to Unify Learn.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-11-09

### Added
- **Attendance that works** (replaces the demo scaffolds): a lecturer opens a session for a course they teach and gets a 6-digit code valid for 5-60 minutes; enrolled students enter it on **Mark attendance**; the lecturer watches the register fill live and ends the session. One record per student per session. Students see attended vs held per course on **My attendance**. Check-in is rate-limited (6-digit codes)
- **Class board / HOC**: students read posts for their department + level; the Head of Class (and admins) post announcements, tips and questions and delete their own; announcements notify the class. Students can request HOC (admins are notified); admins grant or remove it from the board page
- **Classroom hub** (`/lecturer`): today's classes for the courses you teach, one-tap Take attendance, My classes, Studio, Browse; lecturers get a Classroom tab
- Backend: `src/routes/classroom.ts` (`/v1/hoc/*`, `/v1/attendance/*`), migration `0028_attendance_sessions`, test lecturer/contributor seeded with teaching enrolments
- Timetable page links Mark attendance, My attendance and Class board

### Changed
- Online class page is honest ("coming") instead of showing fake check-ins; the demo crypto scanner is gone

### Security
- Migration 0028 enables row-level security on the 0027 tables (`device_keys`, `attendance_records`, `hoc_posts`, `lecturer_materials`, `online_class_sessions`, `online_checkins`), which were readable through the public anon key. The API uses the service role, so nothing in the app changes

## [2.2.0] - 2026-11-09

### Added
- **Test accounts via deploy**: `ensureTestUsers()` in `notes-engine/src/lib/seed.ts` creates one confirmed account per role (`student@`, `hoc@`, `lecturer@`, `contributor@`, `admin@test.unify`, password `Test@1234` or `SEED_TEST_PASSWORD`) through the Supabase Auth admin API, enrols the student in three 200-level courses, and runs on boot **only when `SEED_TEST_USERS=1`**. Idempotent; never resets an existing password
- **Desktop sidebar pills** (>=1024px, all roles): the bottom tab bar turned vertical, same icon-over-label pills and lit green active pill; the bottom bar is hidden at that width

### Changed
- Desktop no longer uses the phone column: `--shell` opens to 1040px (the old 720px desktop width never applied because `tokens.css` overrode it)
- Welcome Skip now goes to the sign-up tab
- Post-sign-in onboarding header is the flat brand-green band with Box Boy and black step bars (was an amber-to-emerald gradient); wizard capped at a readable width on desktop
- All remaining emerald `#059669` accents are tokens; white-on-amber text fixed to black; amber-to-green gradients replaced by brand green

## [2.1.0] - 2026-11-09

### Added
- **Friendly error handling**: new `lib/errors.ts` (`isBenignError`, `describeError`, `errorToast`) maps Postgres/PostgREST codes, HTTP statuses, Supabase auth messages and network failures to plain sentences; aborts and offline blips no longer toast
- Profile (email change, verification resend, save, avatar) and storage uploads no longer show raw library messages

### Changed
- **Legacy colour variables now alias the redesign tokens** (`--bg`, `--surface`, `--border`, `--text*`, `--green*`, `--brand*` -> `--u-*`), so unmigrated screens follow the redesign and dark mode automatically; page background is now warm paper
- Shared components (Drop, ZoomBar, MiniCheck, TopicSlice, ShareModal, ConfirmModal, ErrorState, InstallBar, ReadAloud, VisualEquation) use tokens instead of hard-coded emerald/red hex; text on amber buttons is now black with the amber shadow edge
- Dark-mode values added for `--u-good`, `--u-good-2`, `--u-good-ink`, `--u-warn-ink`

### Added (routes)
- **Routes renamed to the redesign tabs**: `/home`, `/timetable`, `/class`, `/me`, plus `/courses`, `/courses/:code`, `/my-classes`, `/lecturer`; route files renamed to match (`home.tsx`, `me.tsx`, `courses.tsx`, `course-detail.tsx`, `class.tsx`, `my-classes.tsx`)
- Old paths (`/dashboard`, `/profile`, `/course`, `/course/:code`, `/explore`, `/classes`, `/lecturer/redesign`) redirect permanently, keeping params and query; the backend still writes them into notification and push links
- **New Timetable page** (`/timetable`): this week's classes across enrolled courses, day chips with counts, Now/Next markers
- **New `/screens` index**: every route grouped by area with role tags (shown on Me for admins and in dev)
- `lib/routes.ts` is the single source of truth for paths
- Lecturer stub replaced by the redesigned lecturer home

### Added (entry flow)
- **Welcome slides** (`/welcome`, S02-S05): four intro slides with Box Boy on the brand-green band, shown once per device before sign-up; `/auth` sends first-time visitors there, Skip and the last slide hand off to `/auth?tab=signin|signup`
- Splash (S01) is now full brand green with black ink

### Changed (brand green)
- **One brand green everywhere**: `--u-green` (`#50ff90` light, `#4ade80` dark). `--u-green-accent` is now an alias; hard-coded `#4ade80`/`#50ff90`, the dark-green auth gradient and the emerald avatar gradients all use the token
- Auth hero is the flat green band with black ink (Wordmark gained `onGreen`)

### Changed (buttons)
- **Duolingo depth on every button variant**: `.btn--*` share one edge-and-press system; legacy `.btn-primary`, modal and EOQ buttons are amber with the same edge; inline buttons that carry a bottom edge get the press-down
- Amber buttons use black text and the `#c69a1a` edge everywhere (21 leftover white-on-amber / green-edge buttons fixed)
- Screen copy follows the new names (Home, Class, Me)

### Fixed
- **Dark mode**: page background was a fixed light grey (redesign `ui.css`), Flash/offline banners and ~50 pale hex backgrounds were light blocks on dark; all now use tokens
- Home no longer crashes if the stats response omits `courses`
- Service worker cache bumped to `unify-app-v11`
- `/class` route crashed at runtime: the lazy `ExploreRoute` import had been dropped
- Profile footer and crash reports showed v1.26.15 (`APP_VERSION` had not followed the 2.x bumps)

### Removed
- Classic/Story design switch leftovers: `useDesign` hook, `bootDesign()`, unused `DesktopShell`, Story variable blocks

## [2.0.1] - 2026-11-04

### Changed
- Box Boy replaces the SVG Mascot across onboarding, course, explore, course detail, learn/week, EoqQuiz and classes; mobile-first sizing
- Mascot component and ConfirmModal mascot branch removed

## [2.0.0] - 2026-11-03

### Added
- **Redesign foundation**: `--u-*` design tokens, amber primary CTA (`.btn--amber`), dark mode, Box Boy assets and personas, persona carousel, HomeHero, CGPA planner
- **Attendance system**: setup, crypto-signed attendance pass (ECDSA P-256 scaffold), scanner, my attendance
- **HOC role**: HOC request route and dashboard; online classes; lecturer redesign
- Migration 0027 (attendance, HOC, online class tables)
- Service worker cache bumped to `unify-app-v10`; desktop sidebar at >=1024px

### Changed
- Tabs renamed, Save PDF removed, weekly lectures flattened; `/explore` replaced by `/class`

## [1.26.15] - 2026-10-21

### Fixed
- **Formula boxes use true display math**: standalone equation boxes, NoteBuilder previews and visual-builder preview now render in display layout (centered, larger type) instead of cramped inline mode
- **One dropdown metric everywhere**: `Drop` component unified to 44px control with consistent padding, panel radius, and item spacing across all screens
- **Chunk-load failures self-heal**: lazy routes retry import once then silently reload to pick up new chunk map, preventing "Failed to fetch dynamically imported module" errors after deploys

### Changed
- `Drop` dropdown now clamps panel width to available viewport space, long labels get ellipsis + tooltip instead of running off-screen

## [1.26.14] - 2026-10-20

### Fixed
- **Studio review headers render math**: week titles, subtitles, learning outcomes and topic-row titles now render LaTeX through inline `MathPlain` component
- Reader hero, outcome line and print view also use inline math renderer

## [1.26.13] - 2026-10-20

### Fixed
- **Bare LaTeX renders everywhere**: `MathText` now finds and renders undelimited TeX commands (`\frac`, `\sqrt`, `\sum`, Greek symbols) in paragraphs, titles, bullets and quiz text
- Added `$$...$$` display math support
- 12-case node sweep ensures fractions, roots, sums, AI-spaced commands, and prose boundaries all render correctly
- Code spans (`<code>`) excluded from math processing

## [1.26.12] - 2026-10-20

### Fixed
- **Email delivery batching**: announcements now send 5 concurrent Brevo calls with 429/5xx retry (honoring `Retry-After`)
- Recipient walk no longer stops early on emailless rows
- Announce response reports count of confirmed inboxes queued
- Admin > Announce gained **Email check** tool that sends test email and prints Brevo's exact status + body

### Changed
- `Drop` component applies form-field styles to trigger instead of wrapper, course picker now matches Week input height
- Panel widened to show full course titles without truncation

## [1.26.11] - 2026-10-20

### Changed
- **KaTeX + MathJax hand in hand**: unified two-stage pipeline everywhere (KaTeX first, MathJax for complex)
- `Formula` and `MathText` share same pipeline
- Equation editor RENDERED preview uses same component as reader
- Glyph fallback engine deleted completely

### Fixed
- Email failures now log Brevo's actual response body + sender/recipient context + `EMAIL_FROM`-not-set warning
- `Drop` dropdown spacing polished (row rhythm, optical alignment, panel offset)

## [1.26.10] - 2026-10-19

### Changed
- **Full KaTeX switch, MathJax removed**: KaTeX now statically imported (rides in main bundle)
- `MathText` renders inline math synchronously through KaTeX
- Removed `src/lib/mathjax.ts`, jsdelivr preconnect

### Fixed
- KaTeX no longer lazy-loaded, works offline by construction
- Paragraph inline math works reliably on flaky connections

## [1.26.9] - 2026-10-19

### Changed
- **KaTeX restored for formula boxes**: `Formula` now renders with KaTeX (npm-bundled, served from own origin)
- No CDN dependency, no typeset race, works offline by construction
- TeX KaTeX can't parse falls back to glyph text, never raw commands
- Paragraph inline math (`MathText`) stays on MathJax pipeline

## [1.26.8] - 2026-10-19

### Changed
- **Direct typesetting restored**: per user request, removed v1.26.4 glyph-first twin
- `Formula` typesets directly (raw TeX in, MathJax rewrites in place)
- Kept: boolean `typesetMath` with 6s deadline + retry, saved offline renders (`unify.fx.v1`), `MathText` failure swap, live RENDERED preview

## [1.26.6] - 2026-10-19

### Added
- **Save PDF**: XP-gated PDF button uses `window.print()` of rendered reader
- Print cleanup: merged duplicate `@media print` blocks, ZoomBar pill and InstallBar are `screen-only`
- `#unify-content` zoom forced to 100% in print so zoomed sessions never clip exported page

### Fixed
- PDFs contain only typeset math or glyphs, never TeX source

## [1.26.4] - 2026-10-19

### Fixed
- **Never-raw math + offline previews**: `typesetMath` now returns boolean with hard 6s deadline + one clear-and-retry
- `Formula` renders glyph math from first paint, reveals off-screen MathJax twin after real typeset or saved render from `localStorage unify.fx.v1`
- Raw TeX never displayed online or offline
- `MathText` swaps failed `\(...\)` segments for glyphs
- NoteBuilder equation field gained persistent live RENDERED preview box
- Offline preview shows saved typeset render or readable glyphs

## [1.26.3] - 2026-10-20

### Fixed
- **Reader controls**: Focus and zoom retained when switching notes
- Layout only hides chrome on reader routes, never leaks to dashboard/studio
- Floating bottom-right pill renders only on note readers
- Focus works on every device, zoom-in 100-150% desktop only
- First zoom-in switches Focus on, % button resets zoom and exits Focus
- Leaving reader clears applied zoom

## [1.26.1] - 2026-10-19

### Changed
- **Docs refresh**: README, apps/web/README, SETUP (BREVO/EMAIL_FROM env + no-mail troubleshooting)
- UNIFY_MATHJAX_RULE updated with React implementation details
- Versioning rule documented (bump `APP_VERSION` every push)

## [1.26.0] - 2026-10-18

### Added
- **Delivery speed**: route-level code-splitting (studio/admin/browse/share/classes/onboarding/notifications/explore are `React.lazy`)
- Main bundle reduced from 350→190 KB raw (89→52 KB gzip)
- jsDelivr preconnect for MathJax

### Changed
- **Dropdowns**: `Drop` overlay component replaced native selects app-wide
- Shared option spacing, outside-click/Escape dismiss, flip-up near viewport
- Read-aloud voice picker un-squeezed from flex row

### Fixed
- **Math rendering**: MathJax typeset race fixed (awaits `startup.promise` + polls `typesetPromise`)
- Studio review and NoteBuilder previews render real formulas through `<Formula>` again
- Offline/CDN-blocked fallback hardened: spaced AI LaTeX normalized before glyphing
- **Avatars**: any-size upload downscaled on-device to 256px JPEG
- Backend accepts png/jpe?g/webp/gif/avif/bmp data URLs, picks format from magic bytes
- `?v=` cache-bust + `unify:avatar` event keep header chip live
- `/me` backfills Google/Apple SSO profile pictures (hourly throttle)
- Server rejections surface verbatim in profile UI

## [1.25.0] - 2026-10-17

### Added
- **Focus mode**: hides top bar + bottom tabs while reading (store `lib/focus.ts`, persisted per device)
- Both Focus and zoom retained when switching notes
- **Email verification**: profile shows email-verify chip with Resend action (`email_confirmed_at`)
- New-note + announcement emails send from Render's `EMAIL_FROM` via Brevo API

## [1.11.1] - 2026-10-15

### Fixed
- **Share live-links 404**: `GET /share/mine` moved before `GET /share/:token` so Express doesn't swallow "mine" as token
- Create, resolve, revoke, WhatsApp unfurl re-verified by code path

## [1.11.0] - 2026-10-14

### Added
- **Google sign-in**: OAuth on both auth tabs, onboarding prefill
- No backend change (API is provider-agnostic)

## [1.10.0] - 2026-10-13

### Added
- **My Classes**: recurring weekly timetable + live roster per taught course (`/classes`, migration `0019`)
- **Offline-first**: write queue (progress/quiz/resume flush on reconnect)
- Per-week Save offline into version-proof cache (SW v6)

## [1.9.4] - 2026-10-11

### Fixed
- **Explore crash**: search `useEffect` moved above loading return to prevent hook-count crash
- All 14 routes audited, Explore was sole offender

## [1.9.3] - 2026-10-10

### Fixed
- **BUG-012 Dashboard strip**: 2-column course-card grid (title, lecturer, weeks, topics done)
- One-tap elective removal, lecturer names batched into catalog
- **BUG-013 Slow page changes**: idle-time warmup of enrolled week-lists

## [1.9.2] - 2026-10-09

### Fixed
- **BUG-011 Definitions/formulas blend in**: symbol cards render through MathJax, flex-clamped, wider card spacing
- **BUG-014 Quiz extra click + unstyled Check**: `Check score`/`Try again` styled like primary buttons, quiz tab opens directly

## [1.9.1] - 2026-10-08

### Fixed
- **BUG-010 Partial EOQ banks**: short bank triggers one automatic repair pass requesting fresh 10-question bank (8 MCQ + 2 FITB)
- Repair never fails the job

## [1.9.0] - 2026-10-07

### Added
- **BUG-009 Lecture 1/2/3 structure**: weeks hold lectures with per-lecture topic numbering
- Reader switches via `?c=` with cross-lecture Back/Next
- Progress, versions, resume and publish are lecture-keyed (migration `0018`)
- Studio/NoteBuilder lecture pickers
- AI prompt emits lecture groups

### Known Issues
- EOQ stays one week bank after final lecture (per-lecture banks have no storage yet, decision pending)

## [1.8.7] - 2026-10-05

### Fixed
- **BUG-007 Silent stacking publishes**: occupied week/topic returns 409 (`WEEK_OCCUPIED`/`TOPIC_OCCUPIED`)
- Studio offers Replace / Add as new version / Cancel
- **BUG-008 Old + new versions both listed**: student lists and author dashboard group by topic, show latest version only (`older` count, history in reader)

## [1.8.6] - 2026-10-04

### Added
- **BUG-006 ME 352 not found**: `course_aliases` table + boot seed
- `GET /v1/courses/search` across code/title/alias
- Explore debounced search spanning both semesters with badges

## [1.8.5] - 2026-10-03

### Fixed
- **BUG-004 Generation fails on large input**: auto-split into 20k-char parts, per-part retry
- Typed errors (`INPUT_TOO_LARGE`, `BAD_OUTPUT`…)
- Async convert jobs (`202 + poll`) so long generations survive timeouts
- **BUG-005 Quiz leaks answers**: submit-at-end EOQ with neutral picks
- `Check score` only when all answered, verdicts/feedback/record on submit

## [1.8.4] - 2026-10-02

### Fixed
- **BUG-004 Generation fails on large input** (partial, completed in v1.8.5)

## [1.8.3] - 2026-10-01

### Added
- **BUG-003 Diagram placeholders**: `diagrams` Storage bucket + policies
- `lib/storage.ts` upload, numbered figure cards
- Studio diagram tagging

## [1.8.2] - 2026-09-30

### Fixed
- **BUG-002 Raw math text**: one MathJax renderer app-wide (`lib/mathjax.ts` + `MathText`)
- KaTeX uninstalled
- Service worker caches MathJax + fonts offline

## [1.8.1] - 2026-09-29

### Fixed
- **BUG-001 Contributor sees all courses**: server gates (`requireCourseAccess`, 403 for collaborators outside teaching enrollments)
- Browse/Studio only list assigned courses
- Admin can assign courses per user

---

## Archive

Per-version history for v1.12–v1.24 is in the git log (`feat:`/`fix:` commits carry the version).
For detailed technical context on the October 2026 batch, see `docs/DEVELOPER-REPORT.md`.
