# Social posts and flyers

The April kit described dark 9:16 posts with Box Boy in a green ring. The posts that went out since (the 221 Students impact post and the contributor flyer) settled on a different, lighter template, and that template is now the standard. See the `SocialPost` component and the Campaign asset group.

## The fixed template

Three elements appear on every post in the same place, so a post is recognisable before anyone reads it:

1. **Green bar.** A `green` bar on the right edge, 72px wide on a 1080px canvas, from the top to about 60% of the height.
2. **Lockup.** `wordmark` with `tagline` under it, top-left, `space-10` from the top and left edges.
3. **Footer.** Either a 52px `near-black` strip with one `poster-strip` line in `off-white`, or a row of social handles on the ground. Handles: Instagram @unifylearnn, LinkedIn Unify Learn, TikTok @unify.learn, X @UnifyLearnn.

Plus Box Boy as a cut-out at the bottom-right, overlapping the bar.

## Formats

- 1080 × 1080 for the feed.
- 1080 × 1350 (4:5) for flyers and feed posts that need more room.
- 1080 × 1920 (9:16) for Status and Stories: the same template with more space between the headline and the content.

## Type on posts

Posts are the one place a heavy sans leads, because it has to stop the scroll. The middle ground:

- Headlines and stats: `poster-stat`, `poster-headline`, `poster-sub` (DM Sans 800 and 700). Near-black with one word or line in `green-deep`; the big stat in `green`.
- One Playfair moment on every post besides the lockup: a `quote` in italic (second line in `green-deep`), or a Playfair sub-line. This is what keeps posts premium.
- Supporting copy: `poster-body`, with a smaller `text-muted` line under it.

## Colour on posts

- Ground: `off-white`. Not pure white (the impact post) and not a separate paper colour (the flyer): one warm white across the brand.
- Green: `green` for the bar, fills, check circles and the one huge number; `green-deep` for green words in headlines. The flyer's darker green (#00B048) is retired in favour of these two.
- Black: `near-black` for headlines, the footer strip and the dark checklist card.

## Building blocks

- **Checklist card.** `near-black`, `radius-xl`, a two-by-two grid of benefits with `green` check circles and `off-white` text, dividers in `invert-border`, and a `green` CTA bar inside with `on-green` text.
- **Steps panel.** A light rounded panel (`radius-poster`) with green uppercase step labels (Contribute, Refine, Build) and `poster-body` text, as on the contributor flyer.
- **Stamp.** Optional: a rotated circle outline in `green-deep` with a number and label, for impact moments.
- **CTA.** An outlined or green box with the action in uppercase: "Join the contributor team", "Finish strong with Unify Learn". No emoji.

## Don't

- Don't add a fourth colour.
- Don't move the bar, the lockup or the footer.
- Don't set the whole post in Playfair or the whole post in sans.
- Don't use emoji on a post.
