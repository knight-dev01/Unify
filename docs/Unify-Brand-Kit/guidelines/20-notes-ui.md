# Notes UI

Notes are the book inside the shop. The product can be loud; a note is a quiet reading mode that still reads as Unify. It opens with one product moment, the dark topic header, then gets out of the way. See the `ReadingMode`, `NoteSection`, `QuickCheck` and `RecallCard` components.

## Where the line sits

| | Product UI | Notes UI |
| --- | --- | --- |
| Job | Find | Learn |
| Width | Full width, card grids | One column, max 680px |
| Body text | `body` 14px, `body-lg` 15px | `note-body` 16px with 28px line height |
| Playfair | Titles, card titles, big numbers | Topic title, subtopic headings, panel titles, questions only |
| Dark banner | Hero on dashboard and website | Topic header only, once, at the top |
| Navigation | Bottom nav always visible | Bottom nav hidden; a slim top bar with Back, topic progress and Download for offline |
| Shadows | Card and hover shadows | `shadow-card` only, no hover effects |
| Green | Active states, one CTA | Progress, number chips, correct answers |
| Box Boy | Empty states, onboarding | Only on the topic-complete screen |

Shared by both: every token, both fonts, the wordmark, buttons, tags and the focus style.

## The Playfair rule in notes

The CTO is right that paragraphs in Playfair are tiring to read on a phone, and the founder is right that without Playfair the notes lose the brand. Both hold:

- Playfair: `note-title`, `note-heading`, `note-panel-title` (panel titles, quick-check and recall questions). All 17px and up.
- DM Sans: every paragraph (`note-body`), answer option (`note-option`), label and button.

## Layers

Three levels of depth, so the eye knows where to go first:

1. Page: `bg`.
2. One card per subtopic: `surface`, 1px `border`, `radius-lg`, `shadow-card`, `space-5` padding, `space-8` between cards.
3. Panel inside a card for the thing to remember (formula, definition, quick check): `surface-2`, `radius-lg`, no border, no shadow.

Inside a card: a number chip (`green-tint`, `green-text`, `radius-pill`), the `note-heading`, `note-body` paragraphs with key terms in bold, then panels.

## Block structure

| Block | Job | Look |
| --- | --- | --- |
| Topic header | Says where you are | `invert-bg` band: `eyebrow` in `invert-accent` (course and week), `note-title`, topic tags |
| Subtopic card | The reading | Card with number chip, `note-heading`, `note-body` |
| Formula or definition panel | Something to remember | `surface-2` panel, `note-panel-title`, formula centred |
| Quick Check | Confirms the subtopic landed | One per subtopic, `surface-2` panel after the subtopic card |
| Topic Active Recall | Recall after the topic | `RecallCard`, answer hidden until tapped |
| Pulse Check | Mixed practice at the end | A flat list of questions under one heading, never a card per question |

Rules the Note Engine must follow:
- One Quick Check per subtopic. No repeated questions across blocks.
- Never a card inside a card. A panel sits inside a card; nothing sits inside a panel.
- Recall answers stay hidden until the student taps Reveal.
- Every input, option and button uses the brand controls. Browser-default inputs are a bug.
- Nothing fixed may cover a heading.

## Leaving the app

No Save PDF. Offer "Download for offline": the note is saved inside the app, opens without data, and still opens in Unify.
