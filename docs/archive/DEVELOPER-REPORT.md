# Unify Learn — Developer Report (updated 21 October 2026)

Current version: **v1.26.15**

## Summary

All 14 bugs from the 1 October 2026 test list (7 critical P0, 7 important P1) are **fixed and verified**. 
Every change was verified with `tsc --noEmit` both sides plus a production `vite build` before commit.

**For detailed version history**, see [`CHANGELOG.md`](../CHANGELOG.md).

## Left + verification log

1. **Render redeploy — VERIFIED 4 Oct 2026.** Migrations `0016`–`0020` applied
   live; new endpoints (aliases search, lecture paths, timetable, roster,
   error log, support config) confirmed working in production.
2. **Google sign-in live test — VERIFIED 4 Oct 2026.** Real Google account in
   through onboarding to dashboard after the console enablement.
3. **Lecturer walkthrough — VERIFIED 4 Oct 2026.** Teaching account: courses
   assigned in admin, slots set, roster visible, student-side class-times card
   correct.
4. **Phone pass — VERIFIED 4 Oct 2026.** Student + contributor sides on real
   phones.
5. **Persistence retest — VERIFIED 4 Oct 2026.** Resume (with lecture),
   streaks, and offline queue flush confirmed on device.
6. **Proposed, not built:** per-university allowed-email-domains policy (the actual gate
   for multi-school expansion — works with both email and Google paths), and a
   link-Google-to-existing-account action (same address via both methods can mint two
   identities).
7. **Open product decisions (need a ruling, not testing):** per-lecture EOQ banks
   vs the single week bank after the final lecture; removing Explore into the
   dashboard per BUG-012's ideal vs keeping it as the add-courses path.

## Brand direction: why the generated kit can't hold as law

The `docs/Unify-Brand-Kit/` (posted 2 October 2026) was single-pass AI output
(Claude): no user testing behind it, no ratification, and it contradicts decisions
that were already tested and shipped. A generated draft is an input to a brand
decision — it is not the decision. What follows is the recorded reasoning so the
next reader doesn't re-litigate it from a chatbot's authority.

**1. The kit contradicts the product's own retention thesis.**
The master PRD's core loop is Duolingo mechanics (streaks, XP, badges, tactile
progression) applied to university study. The kit's headline rule — "it should never
look like a game" — outlaws the very psychology the product is built on. Tested
reality agrees with the PRD: residents and students shown the Duolingo-style revamp
(Classic) preferred it. Playfair editorial (Story) was added as a second theme to
keep the serif direction alive, not to replace a validated winner.

**2. The kit contradicts tested user requests.**
It mandates one-column course cards; real testing (BUG-012) asked for a card grid.
It bans Save PDF; the XP-gated PDF is a shipped retention incentive users
understand. It bans the mascot from the dashboard; the greeting mascot is part of
the daily habit loop. In each case the tested artifact wins over the generated rule —
the kit's own social guideline concedes this precedent (the shipped lighter post
template "is now the standard" over the earlier generated one).

**3. The case for the Duolingo style (Classic, the default).**
Duolingo (~100M+ MAU), Quizlet and Khan Academy converge on the same findings for
young mass-market learners: chunky 44px-grade touch targets (cheap Androids, touch
imprecision), high-contrast CTA colour (sunlight legibility), rounded friendly type
(Nunito stays legible at 12px where thin-serif Playfair strokes break on low-end
screens), and celebration moments (XP bursts, streaks) that create the return habit
the PRD demands. Serif-editorial is the right voice for lecturers, certificates and
campaigns — not for a first-year student revising on a bus.

**4. Why the theme switch stays.**
Two validated tastes exist and they split by role and age: students motivate on
Classic; lecturers, collaborators and formal surfaces read premium on Story. Forcing
one face loses one audience. Both themes persist, per-device, with usage measured —
a future default follows data, not taste. Proposed instrumentation: log the active
design with existing analytics events so the split is evidence, not anecdote.

**5. The Unify ecosystem brand (adopted).**
Classic ("Play") and Story ("Editorial") are co-equal official themes, not a main
and a fallback. From the kit we adopt what is genuinely good regardless of theme:
plain-spoken button labels, zero hype register, visible focus states (accessibility
fix queued), the social-post template structure, and Story's token set for the
editorial theme. From the kit we reject: the Playfair-only rule, the gradient ban
where gradients carry meaning (progress, earned states), the PDF ban, the mascot
confinement, and the one-column-cards rule. Future brand proposals arrive as diffs
against this section with test evidence attached — never as generated doctrine.
