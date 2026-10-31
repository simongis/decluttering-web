# ADR 0014: An optional console look

**Status:** Accepted, 2026-10-30; extended 2026-10-31.

## Context
The user wanted a playful alternative look for the app: a retro control-panel dashboard, off by default, with an easy
way back to the standard look. The standard look must not change.

## Decision
- **Original design.** A black background; flat colour bars with rounded ends and curved corners; a segmented colour
  rule under the header; pill buttons; warm accent colours; condensed capitals for headings. The heading face is Antonio
  (SIL Open Font License), loaded from Google Fonts only while the look is on.
- **The switch.** A light/console switch at the top right, beside About: a sun when off, a badge glyph when on. The
  glyph lives alone in `src/ui/skin/icons.ts`, so it can be changed in one place. The console look also swaps in a
  console version of the logo (`public/brand-mark-console.svg`): the same tile and glyph, framed by a curved bar.
- **CSS and one flag.**
  - `data-skin="console"` on `<html>` plus Calcite's dark mode; one override sheet, `src/styles/skin-console.css`.
  - Every console rule sits under `html[data-skin="console"]`, so the standard look is untouched.
  - Nothing reads the flag except the styling, the switch and the charts' palette. Data, scoring, sending, the guards,
    the nudge log and owner emails never change.
- **Per browser.** Stored as `decluttering:skin` in localStorage through `src/cache/settings.ts`. Blocked storage falls
  back to the standard look (a click still works until reload). "Clear saved data" resets it.
- **Charts.**
  - The dot map draws as a star chart while the look is on (`src/ui/scan/chart-palette.ts`): a near-black field, a
    dotted grid, corner brackets, condensed capitals, and stale dots that warm from peach to rust with a soft glow.
  - Positions, sizes and meaning are unchanged; the standard chart is exactly as before (tested).
  - The Sankey's bars become pills.
- **Panels.** No boxed cards. A section's title is a coloured bar with a rounded left end and black text, and its
  content sits on black. Plain cards get a flat top rule. Owners sit on alternating coloured bars. The steps (Scan,
  Review, Emails) are three joined pills. Scan stages show status pills that light up in turn as each finishes.
- **Emails.** The email preview stays white: it shows exactly what owners receive.
- **Icons.** The app's existing icons stay, so their meaning stays obvious. The headline figures show numbers and
  labels only.
- **Accessibility.** Text contrast at least 4.5:1 on black. axe is clean on About, Review and Emails in the console
  look. The one motion (a pulsing status pill) stops under prefers-reduced-motion.

## Consequences
- One stylesheet, two small modules and one switch: easy to change or remove.
- The switch adds a stop in the header's tab order, between About and the account menu.
