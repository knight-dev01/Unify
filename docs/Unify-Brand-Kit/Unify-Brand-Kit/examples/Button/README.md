Buttons for every action in the Unify apps.

Use `button` type (DM Sans 14px, weight 600), `space-3` vertical and `space-6` horizontal padding, `radius-md`. The consumer provides the label, which says exactly what happens ("Mark topic complete", "Download for offline").

- Primary: `text` background, `bg` text. One per view.
- Secondary: transparent, 1px `border-strong`, `text` label. Use `border-strong`, not `border`, so the outline reaches 3:1.
- Green call to action: `green` background, `on-green` label, weight 700. For the single main action on a marketing surface, not inside notes.
- Disabled: `surface-2` background, `text-muted` label.

Keyboard focus is a solid 2px `text` outline with a 2px offset. Never render a browser-default button. Never use white on green.
