# Unify UX Behaviors — Reader Controls, Dropdowns, Formulas, Uploads, Email, Delivery

Authoritative reference for how the app behaves after v1.26.0. Code comments
point here; change the behavior → update this file in the same commit.

---

## 1. Reader controls (Focus + Zoom)

**File:** `apps/web/src/components/ZoomBar.tsx` · store: `apps/web/src/lib/focus.ts`

- The floating bottom-right pill renders **only on note readers**
  (`/^\/learn\/[^/]+\/week\/\d+/`). Dashboard, browse, studio, auth — no pill,
  no focus, no zoom. Anywhere outside the notes section the app is always 100%.
- **Zoom is desktop-only (≥641px) and zoom-IN only**: 100% → 150% in steps of
  10 (persisted in `localStorage` key `unify.zoom.v1`). There is no zoom-out;
  the percentage button resets to 100%.
- **Zoom targets `#unify-content` only** — the `<main>` wrapping `<Outlet/>` in
  `_layout.tsx`. The sticky header and bottom tab bar keep their normal size.
- **The first zoom-in switches Focus mode ON.** Resetting to 100% switches it
  off. Focus can also be toggled on its own with the Focus button (every
  device, reader only).
- **Focus mode** hides the sticky header + bottom nav while reading
  (`_layout.tsx` reacts to the store). It always resets when the reader
  unmounts (`learn/week.tsx` cleanup) — the user can never get stranded with
  no chrome on other screens.
- Leaving a reader clears the applied content zoom, so the rest of the app
  never inherits a zoomed layout (the persisted value returns on the next
  reader visit).
- Mobile (<640px): no zoom controls at all — the pill is Focus-only.

## 2. Dropdowns (Drop)

**File:** `apps/web/src/components/Drop.tsx`

- Every selector in the app goes through `Drop` — never a native `<select>`
  for new UI. Props: `{ value, options, onChange, label, style }` (`label` is
  the aria-label; there is no `aria-label` prop).
- The panel is a **floating overlay** (absolute, `z-index: 130`) — it never
  pushes content or expands its frame. It flips upward near the viewport
  bottom, closes on outside-click/Escape.
- Spacing is global to the component: option rows `padding: 10px 12px`,
  `line-height: 1.4`, list `gap: 4`, `padding: 6`, `max-height: 220px`. Do not
  override row spacing at call sites.
- Call-site `style` only styles the trigger button. If a trigger sits in a
  tight flex row (e.g. the ReadAloud voice picker), give it a real
  `min-width` and let the row wrap — never `flex: 1; minWidth: 0`, which
  squeezes the button to a sliver.

## 3. Formula rendering (math is never code on screen)

**Files:** `apps/web/src/lib/mathjax.ts`, `components/Formula.tsx`,
`components/MathText.tsx`

- **One renderer for the whole app: MathJax v3** (`tex-mml-chtml` from
  jsDelivr, loaded on demand). `typesetMath()` awaits `startup.promise` and
  polls for `typesetPromise` before typesetting — the old race (raw `\sqrt`
  left on screen) is fixed; do not "optimize" that await away.
- `Formula` (display math, formula boxes, **Studio review/preview
  panes**) normalizes any equation string to `\(…\)` (bare builder output
  included) and typesets it. Offline/CDN-blocked, it falls back to
  `beautify()` glyph text (`\sqrt{x}` → `√(x)`) — readable, never blank, never
  raw delimiters.
- `MathText`/`MathPlain` render HTML/plain text containing `\(…\)` inline
  math (paragraphs, quiz questions, titles). Same renderer, per-element
  typeset.
- **Review shows real formulas**: the NoteBuilder "READER PREVIEW" panes and
  the expanded topic previews in Studio → Review use `<Formula>`/`MathText`
  (MathJax). `beautifyMath()` exists only as the offline fallback inside
  `Formula` — do not use it as a primary renderer in review surfaces.
- Offline glyph fallback tables (Greek, symbols, super/subscripts) live in
  `Formula.tsx` — extend them there, not per-call-site.

## 4. Profile picture upload (any size, any photo)

**Client:** `apps/web/src/routes/profile.tsx` · **API:** `notes-engine/src/routes/v1.ts` (`POST /v1/avatar`)

- The file input accepts `image/*`. A non-image MIME is rejected with a clear
  message; an **empty MIME is attempted** (some pickers report none for good
  photos) — the decode is the real test.
- Any input size: the browser downscales to a **256px JPEG on-device**
  (`canvas.toDataURL('image/jpeg', 0.82)`, ~20–40 KB), so camera originals
  upload fine and storage stays tiny.
- Backend accepts any `data:image/(png|jpe?g|webp|gif|avif|bmp)` and
  **sniffs magic bytes** to pick the stored format — the declared MIME is
  never trusted. ≤2 MB guard (the client payload is always far below).
- The stored path per user never changes (`{userId}.{ext}`, `upsert`) — the
  public URL gets `?v=Date.now()` so caches bust on every new picture.
- The client broadcasts `unify:avatar`; `_layout.tsx` listens and refreshes
  the header chip live.
- Errors surface verbatim from the API when the server rejects; local decode
  failures say to save as JPG/PNG (e.g. HEIC on Android).

## 5. Email notifications (Brevo)

**Files:** `notes-engine/src/lib/email.ts`, `notes-engine/src/lib/email-templates.ts`

- **Sender:** `EMAIL_FROM` env (Render) — default
  `Unify Learn <notes@unify.learn>` — via the **Brevo SMTP API**
  (`https://api.brevo.com/v3/smtp/email`) authenticated with `BREVO_API_KEY`.
  **The from-address must be a verified sender in the Brevo account** or every
  send fails with `brevo 400` (Render log line: `[email] send failed`).
- Without `BREVO_API_KEY`: sends are logged and reported as skipped (safe
  default). With an invalid key: Brevo returns 401 → warn log, nothing sent.
- **New-note emails** (`notifyCoursePublished`) go only to profiles that are
  **enrolled (`kind='taking'`) in that course** AND have
  `email && email_confirmed && notify_new_notes !== false`. Authors are not
  copied on their own publishes unless they are also enrolled.
- **Admin announcements** (`POST /admin/announce`) email every profile with
  `email_confirmed = true` (paginated), plus in-app bell rows for everyone
  and push fan-out.
- No mail received? Check in order: (1) Render logs for
  `[email] send failed brevo …`, (2) Brevo sender verification for the exact
  `EMAIL_FROM`, (3) your own `email_confirmed` flag, (4) enrollment/opt-out
  for new-note mail.

## 6. Content delivery speed

- `index.html`: preconnects for Google Fonts, the Render API, Supabase and
  **jsDelivr** (MathJax) — keep these when editing the head.
- `vercel.json`: `/assets/*` served `Cache-Control: immutable` (hashed
  filenames); HTML revalidated. Security headers on `/*`.
- **Route code-splitting** (`App.tsx`): Studio, admin (×2), browse, share,
  classes, onboarding, notifications, explore are `React.lazy` behind one
  `<Suspense fallback={<Loading/>}>`. Students' first load never downloads
  author/admin code. New heavy route? Lazy-load it the same way.
- Service worker (`public/sw.js`, versioned cache `unify-app-vN`): documents
  network-first (never a stale app), static assets cache-first, API GETs
  network-first with cache fallback, writes always bypass. Bump the cache
  version when shipping breaking shell changes.
- MathJax loads only when a note renders math — keep it out of the eager
  bundle.

## 6a. Further options (not yet implemented)

- Subset/self-host the three Google font families instead of the render-
  blocking `fonts.googleapis.com` stylesheet.
- Vercel Edge caching or a CDN replica in front of the API for cold-start
  latency (Render free tier sleeps).
- Image CDN sizing params for avatars (currently 256px, already tiny).

## 7. Versioning rule (mandatory)

- **Every push bumps `apps/web/src/lib/version.ts` → `APP_VERSION`**:
  MINOR for features, PATCH for fixes. The commit message carries the version
  (`fix: v1.26.0 …`). `package.json` versions stay `1.0.0` by convention.
- Backend-only pushes still bump PATCH so error reports (`/v1/errors`) carry
  an accurate `app_version`.
