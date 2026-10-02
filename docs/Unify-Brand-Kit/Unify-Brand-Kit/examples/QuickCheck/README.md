A short multiple-choice or fill-in check placed once after each subtopic; a set of them forms the Pulse Check.

The consumer provides the question, options with one marked correct, and a one-line explanation shown after an answer.

- Container: `surface-2` panel, `radius-lg`, `space-5` padding. It sits between NoteSection cards, never inside a card and never with another card inside it.
- Eyebrow: "Quick check · N question(s)" in `eyebrow`, `text-muted`.
- Question: `note-panel-title` (Playfair Display 700, 17px). Options: `note-option` (DM Sans 15px), never Playfair.
- Options: full-width buttons on `surface`, 1px `border-strong`, `radius-md`, a letter key in a round chip.
- Correct: `green-tint` fill, `green-text` outline, key on `green`. Wrong: dashed `text` outline. Feedback text always says "Correct." or "Not quite." so colour is never the only signal.
- Fill-in answers use the same outlined input as options, never a browser-default input.
- Pulse Check: one heading and a flat list of questions. Never wrap each question in its own card.
