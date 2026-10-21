# UNIFY LEARN — MATHEMATICS RENDERING RULE

## Rule: Always Use MathJax for Mathematical Equations

All Unify Learn HTML files that contain mathematical equations, formulas, derivations, or expressions **must use MathJax** for rendering.

---

## How to Include MathJax

Add this single script tag inside the `<head>` of every HTML file that contains maths:

```html
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
```

---

## How to Write Equations

Use standard LaTeX syntax wrapped in delimiters:

**Display equations (centred, on their own line):**
```
\[ your equation here \]
```

**Inline equations (within a sentence):**
```
\( your equation here \)
```

**Canonical spacing:** always bind a command to its group with no space —
`\frac{a}{b}`, `\sqrt{x}`, never `\frac {a}` or `\sqrt {x}`. MathJax accepts
both, but every other consumer (exporters, plain-text fallback, search) is
simpler and safer with the canonical form. Prefer `\frac` over `\dfrac`/`\tfrac`.---

## Examples

| What you want | What you write |
|---|---|
| H₀ formula | `\[ H_0 = \frac{24}{\pi} I_{sc} \left[1 + 0.033\cos\!\left(\frac{360n}{365}\right)\right] \]` |
| Air density | `\[ \rho = \frac{P}{RT} \]` |
| Efficiency fraction | `\[ \eta_c = \frac{q_u}{H_b R_b} \]` |
| Inline symbol | `The solar constant \( I_{sc} = 1353 \text{ W/m}^2 \)` |
| Subscript | `\( T_{2'} \)` for primed actual temperatures |
| Superscript | `\( V^3 \)` for velocity cubed |
| Fraction | `\( \frac{a}{b} \)` |
| Square root | `\( \sqrt{9} = 3 \)` |
| Greek letters | `\( \delta, \phi, \omega_s, \eta, \rho, \gamma, \tau, \alpha, \epsilon \)` |
| Exponent | `\( e^{-x} \)` |

---

## Why This Rule Exists

Previous Unify Learn files (W1–W7) used monospace font for equations. This breaks down for:
- Nested fractions
- Greek symbols
- Subscripts and superscripts
- Multi-line derivations

MathJax renders proper mathematical notation — clean, consistently sized, readable on mobile — matching the quality of a printed textbook. W8–W11 were built with MathJax and the improvement is significant.

---

## Where to Put Equations in the HTML Structure

Inside `.formula-box` blocks:

```html
<div class="formula-box">
  <div class="f-label">Formula Name</div>
  <div class="f-eq">\[ your equation \]</div>
  <div class="f-note">Explanation of variables...</div>
</div>
```

Inside `.we-math` blocks (worked examples):

```html
<div class="we-math">\[ substituted equation here \]</div>
```

---

## Do NOT Do This

```html
<!-- Wrong — monospace, no rendering -->
<code>H0 = (24/pi) * Isc * [1 + 0.033*cos(360n/365)] * (...)</code>

<!-- Wrong — plain text -->
<p>H₀ = 24/π × Isc × ...</p>
```

---

## Platform Note

MathJax loads from a CDN, but rendering never depends on being online: every
successful typeset is saved per-equation (localStorage `unify.fx.v1`) and
re-injected instantly on later visits, and when neither the CDN nor a saved
render is available the equation shows readable glyphs (`a⁄b`, `√(x)`). Raw
TeX is never shown. An internet connection only upgrades glyph text to live
MathJax output. All Unify Learn HTML files are designed for browser use.

---

## React App Implementation (v1.25+)

The app does **not** include the script tag per file — one lazy-loaded MathJax
instance serves the whole SPA:

- `src/lib/mathjax.ts` — `ensureMathJax()` loads `tex-mml-chtml` from jsDelivr
  once (preconnected in `index.html`); `typesetMath(el)` awaits
  `startup.promise`, polls for `typesetPromise`, then typesets under a hard
  6s deadline with one clear-and-retry — and **returns a boolean**. False
  (missing CDN, rejected typeset on malformed TeX, hung font fetch) means the
  caller must show fallback text; it can never hang or silently leave raw TeX
  on screen (the old "preview doesn't render" bug).
- `components/Formula.tsx` — display math (formula boxes, worked-example math,
  **Studio review + editor previews**). Never-raw design: the card shows
  readable glyph math from first paint (`\frac{a}{b}` → `a⁄b` U+2044,
  `\sqrt{x}` → `√(x)`, spaced commands like `\frac {` normalized first) and
  only reveals an off-screen MathJax twin once a real typeset **or a saved
  render** (`localStorage unify.fx.v1`, capped at 80 entries) exists — so the
  preview works instantly offline and raw TeX is never displayed.
- `components/MathText.tsx` — HTML/plain text containing inline `\(…\)`
  (paragraphs, quiz questions, titles) via `MathText`/`MathPlain`. On a
  failed typeset the `\(...\)` segments are swapped for glyph math in place.

**Rule:** any new surface that shows note math (review panes, previews, share
cards) must use `Formula`/`MathText` — never raw text and never the
`beautifyMath` fallback as a primary renderer.

