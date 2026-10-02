# Product UI and website

The product helps students find things: their courses, their progress, what to study next. The website uses the same shell so the app feels familiar the first time it opens. See the `AppShell` component.

## The shell

1. **Top bar.** `bg` ground, `wordmark` at 22px on the left, notifications and avatar on the right. On the website, the top bar carries the main links and a green CTA.
2. **Hero banner.** One `invert-bg` banner at the top of the dashboard and the website home: an `eyebrow` in `invert-accent`, an `h1` greeting or headline in `invert-text`, a line in `invert-muted`, and a progress bar or CTA. This is the loudest moment on the screen. One per page.
3. **Content.** `h2` section titles, then cards in a grid (two columns on phones for small stat cards, one column for course cards). Course cards use `surface`, `border`, `radius-xl`, `shadow-card`, and `shadow-hover` on hover. Card titles in `h3` (Playfair), details in `body` and `micro`.
4. **Bottom navigation** (app only). `surface` bar with a top `border`: Dashboard, Learn, Explore, Profile, labels in `sm`. The active item sits in a `green-tint` pill with `text`. It hides while a note is open (see Notes UI).

## Rules

- Big numbers (streak days, GPA, courses done) are Playfair 900 in `text`, labels under them in `micro` `text-muted`.
- One primary action per screen: `text` fill button in the app, `green` fill with `on-green` on the website and in empty states.
- Colour stays surgical: green for the active state, progress and one CTA. Everything else is black, warm white and grey.
- Box Boy appears in empty states and onboarding, never in the regular dashboard.
- The website hero may use `display` (40 to 80px) and a Box Boy cut-out on the right, echoing the social template.
