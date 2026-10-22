# UNIFY LEARN — MATHEMATICS RENDERING RULE

## Rule: Always render math through the unified pipeline

All Unify Learn surfaces that contain mathematical equations, formulas,
derivations, or expressions **must render through the one pipeline**
(`Formula` / `MathText` / `MathPlain`) — never monospace, never raw text.

**Renderer as of v1.26.10: KaTeX, bundled in the app.** The React app
statically imports KaTeX — it ships inside the main bundle (no CDN, no
code-split fetch, no typeset race, works offline by construction).
Unsupported TeX falls back to readable glyphs, never raw source. MathJax
was removed from the app in v1.26.10 (the renderer from before MathJax,
restored at the user's request).

---

## How to Include MathJax (standalone HTML files only)

The React app needs no script tag — KaTeX is bundled. Standalone HTML
artifacts keep this single tag inside `<head>`:

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
`\frac{a}{b}`, `\sqrt{x}`, never `\frac {a}` or `\sqrt {x}`. KaTeX accepts
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

Math is fully local in the React app: KaTeX ships inside the main bundle,
so equations render instantly online AND offline with no CDN at all — the
same service-worker cache that serves the app shell carries it. If KaTeX
can't parse an equation, the app shows readable glyphs (`a⁄b`, `√(x)`)
instead of raw source. Standalone HTML files still load MathJax from a CDN
and need an internet connection the first time. All Unify Learn HTML files
are designed for browser use.

---

## React App Implementation (v1.26.10+)

KaTeX is statically imported — no loader, no async typeset, no race:

- `components/Formula.tsx` — formula boxes (notes, worked examples, Studio
  review + editor previews). `katex.renderToString(tex, …)` runs
  synchronously; `stripTex` accepts bare TeX, `\(…\)`, `\[…\]`, `$$…$$`
  (always inline layout to keep the compact card rhythm). On a parse error
  it swaps in glyph math (`\frac{a}{b}` → `a⁄b` U+2044, `\sqrt{x}` →
  `√(x)`, spaced `\frac {`/`\sqrt {` normalized first) so raw TeX never
  stays on screen. Exports `escHtml`; `beautify`/`beautifyMath` live here.
- `components/MathText.tsx` — HTML/plain text containing inline `\(…\)`
  (paragraphs, quiz questions, titles) via `MathText`/`MathPlain`. Each
  math segment renders through KaTeX synchronously (display `\[…\]`
  honoured, entities decoded, markup-looking segments left alone); failed
  segments are glyph-ified and escaped.
- `src/lib/mathjax.ts` was **deleted** in v1.26.10; `index.html` no longer
  preconnects to jsdelivr. The service worker's now-inert MathJax cache
  rule is harmless (nothing requests that origin anymore).

**Rule:** any new surface that shows note math (review panes, previews,
share cards) must use `Formula`/`MathText` — never raw text and never the
`beautifyMath` fallback as a primary renderer.

