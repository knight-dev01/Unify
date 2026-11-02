One subtopic of a Unify Learn note: a card holding the heading, explanation and any formula or definition panel.

The consumer provides the subtopic number (1.1, 1.2), the heading, the explanation paragraphs with key terms in bold, and optional panels. The Note Engine renders formulas with MathJax inside the panel.

- Card: `surface`, 1px `border`, `radius-lg`, `shadow-card`, `space-5` padding, `space-4` between blocks.
- Eyebrow above the heading: `eyebrow` in `text-muted`.
- Number chip: `green-tint` fill, `green-text`, `radius-pill`.
- Heading: `note-heading` (Playfair Display 700, 22px).
- Explanation: `note-body` (DM Sans 16px, 28px line height), at most 68 characters a line, paragraphs of at most five lines. Bold only key terms.
- Panel: `surface-2`, `radius-lg`, no border and no shadow. A panel title in `note-panel-title` and a closing note in `text-muted`.

Never put a card inside a panel or a card inside a card. Leave `space-8` between consecutive NoteSections.
