Unify is the academic platform for Nigerian university students, starting with LASU Faculty of Engineering. Everything carrying the name should feel like something a student would pay for: restrained, editorial, warm. It should never look like a game.

The system has one source of premium: **Playfair Display on the moments that land, DM Sans on everything read line by line, and a lot of near-black and warm off-white with green used surgically.** Every surface below keeps that. What changes between surfaces is density and loudness, never the brand.

## The four surfaces

| Surface | Its job | Loudness | Read |
| --- | --- | --- | --- |
| Product UI (dashboard, explore, profile, course lists) | Help students find things | Medium: dark banners, Playfair titles and numbers, card grids, green CTAs | Product UI section |
| Website | Show what Unify is and get people in | Medium to loud: the product UI with a larger hero | Product UI section |
| Notes UI (reading mode in Learn) | Help students learn | Quiet: one column, Playfair only on headings | Notes UI section |
| Social posts and flyers | Get attention in a feed | Loud: heavy sans headlines, one Playfair moment, fixed template | Social section |

The website and the product share one shell, so a student who has seen the site already knows the app.

## The Playfair rule

Playfair Display is what makes Unify look premium. It is a display face with thin strokes, so it is set at 16px and above, on text people glance at:

- Use it for the wordmark, the tagline, page and topic titles, subtopic headings, card titles, big numbers in the product, quiz and recall questions, and quotes.
- Never set a paragraph, an answer option, a button, a label or anything under 16px in Playfair.
- Removing Playfair from a surface removes the brand from it. Every screen and every post has at least one Playfair moment.

## Content fundamentals

Write like a brilliant older student who has been through it, talking to a friend. Direct, honest, grounded. Never hype, never corporate, never condescending.

- Say what is actually happening. "330+ students have used Unify this month."
- Lead with impact, not features. "Knowledge stops dying in the room" beats "12 weekly modules per course".
- Never claim what is not live.
- No emoji in headlines, posts or buttons. Emoji are fine in informal chat-style UI text.
- Banned register: "Supercharge your journey", "unlock your full potential", "innovative platform", "leverages cutting-edge technology".
- Approved lines: "Built for the ones who build." "The knowledge was always in there. Nobody gave you the key." "Knowledge stops dying in the room." "Miss a class. Not the content." "Own your academic journey."
- Buttons say exactly what happens: "Mark topic complete", "Download for offline", "Join the contributor team".

## Visual foundations

**Colour.** Black and warm white carry the system. Green is the accent, never a co-lead.
- Page: `bg` everywhere, social posts included. Never pure white as a page ground.
- Cards: `surface` with a `border`. Panels inside cards: `surface-2`.
- Text: `text` for content, `text-muted` for secondary. `text-subtle` only for timestamps and placeholders.
- Green fills use `green` with `on-green` on top. Green text uses `green-deep` at 24px and up, `green-text` below that. Never `green` as text on a light ground.
- `amber` for streaks and Past Questions only. `red` for destructive actions only, never for a wrong answer.
- Dark banners use `invert-bg`, `invert-text` and `invert-muted`. They flip to light in dark mode.

**Type.** Two fonts only: Playfair Display and DM Sans. Never Inter, Poppins, Helvetica or any other face. Headings follow `h1` to `h4`; running text follows `body-lg` and `body`; notes have their own `note-*` styles; posts have `poster-*` styles.

**Shape and depth.** Buttons and inputs `radius-md`, cards `radius-lg`, course cards `radius-xl`, tags `radius-pill`. Resting cards get `shadow-card` with a border; only hover and floating layers get `shadow-hover`, `shadow-drawer` or `shadow-toast`. No gradients, no glows.

**Layout.** Phone gutter `space-4`. Product sections `space-12` apart. Group with space before adding lines or boxes.

**Focus.** A solid 2px `text` outline with a 2px offset on every interactive element.

**Motion.** Small and purposeful: a progress bar filling, a checked option settling. No bouncing, no confetti.

## Wordmark and tagline

- The wordmark is **Unify.** in Playfair Display 900 (`wordmark`) with the full stop in `green`. Never stretch, skew, outline, shadow or retype it.
- The tagline **BUILT FOR THE ONES WHO BUILD.** is uppercase Playfair Display 600 (`tagline`), the same typeface as the wordmark. It sits directly under the wordmark, left-aligned to the U. Earlier posts set it in DM Sans; the serif is the correct treatment.
- Clear space on all sides equals the height of the U.
- On social posts the lockup sits top-left at `space-10` from both edges.

## Mascot: Box Boy

Box Boy wears a near-black hoodie and has a cardboard box for a head, marked with a green U. He has no face and no identity: he is every LASU engineering student. The knowledge was always in the box; Unify is the key.

- On social posts: a cut-out at the bottom-right, cropped at the waist, overlapping the green bar, about 40 to 45% of the canvas width. No ring, no frame. This replaces the April rule of a green ring with corner dots on a dark ground.
- In the product: only at meaningful moments (topic complete, empty states, onboarding, errors). Never on every screen, never in the middle of a note.
- Never recolour him, never put text over him, never full-body.

## Sections

The Product UI, Notes UI and Social sections set the rules for each surface. The Campaign asset group holds the reference posts.
