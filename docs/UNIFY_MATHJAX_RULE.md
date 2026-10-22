# UNIFY LEARN — MATHEMATICS RENDERING RULE

## Rule: Always render math through the unified pipeline

All Unify Learn surfaces that contain mathematical equations, formulas,
derivations, or expressions **must render through the one pipeline**
(`Formula` / `MathText` / `MathPlain`) — never monospace, never raw text.

**Renderer (v1.26.11): KaTeX first, MathJax for complex — no fallbacks.**
Every formula goes through the same two stages: KaTeX (statically bundled,
instant, offline) renders what it can; TeX KaTeX rejects is handed to
MathJax (loaded on demand, service-worker cached), which accepts nearly
all valid TeX. There is NO glyph-fallback stage — the two renderers are
the pipeline. Preview and reader share the same component, so the
equation preview is exactly what readers see.

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

Math needs no network for the common case: KaTeX ships inside the app
bundle, so equations render instantly online AND offline. Complex TeX
loads MathJax from a CDN on demand; the service worker caches it on first
use, after which stage 2 also works offline. Only if MathJax is
unreachable AND never cached does the equation's source stay visible
(logged for diagnosis, never styled as fake math). Standalone HTML files
still load MathJax from a CDN. All Unify Learn HTML files are designed
for browser use.

---

## React App Implementation (v1.26.11+)

Two stages, one policy everywhere — no glyph fallback anywhere:

- `src/lib/mathjax.ts` — restored: `ensureMathJax()` loads
  `tex-mml-chtml` from jsDelivr once (preconnected in `index.html`);
  `typesetMath(el)` awaits startup, polls `typesetPromise`, runs under a
  hard 6s deadline with one clear-and-retry, and returns a boolean
  (false = CDN unreachable → the caller logs; it never hangs).
- `components/MathText.tsx` / `Formula.tsx` — **Stage 1:** KaTeX
  (statically imported) renders every segment/formula it can,
  synchronously (offline-proof). **Stage 2:** rejected TeX is left as
  `\(..\)` source and handed to MathJax — in `Formula` per box, in
  `MathText` as ONE pass over the subtree. `stripTex` canonicalizes
  delimiters and command spacing before stage 1. `Formula` exports
  `escHtml` (used by `MathPlain`).
- The glyph/beautify engine was **deleted** in v1.26.11 — it must never
  come back as a renderer.

**Rule:** any new surface that shows note math (review panes, previews,
share cards) must use `Formula`/`MathText` — never raw text, never a
glyph-style substitute.

