The reading shell for a note: a slim top bar, one dark topic header, then a single column of subtopic cards. Compare with `AppShell` to see where the product ends and the notes begin.

The consumer provides the course, week and topic position for the eyebrow, the topic title, topic tags, progress through the topic, and the subtopic content from the Note Engine.

- Top bar: `bg` with a bottom `border`. Back on the left, a thin `green` progress track in the middle, "Download for offline" on the right. The bottom navigation is hidden while reading.
- Topic header: full-width `invert-bg` band, `eyebrow` in `invert-accent`, `note-title` in `invert-text`, tags outlined in `invert-border` with `invert-muted` text. The only loud moment in a note.
- Column: max 680px, `space-4` side gutter, `space-8` between cards.
- Subtopic cards and panels follow `NoteSection`.

Keep Playfair to `note-title`, `note-heading` and `note-panel-title`. Every paragraph is `note-body` in DM Sans.
