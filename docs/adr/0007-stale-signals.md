# 0007 Stale signals from real usage

**Status:** Proposed, 2026-10-12. Default thresholds are calibrated with the read-only profiles (DC-029) before this is accepted. Amends 0004 (filters, inactive owners) and INTENT ("owner last sign-in" as a signal).

## Context
The real-org profile (`docs/research/real-org-profile.md`) broke prototype D's rules:
- **"Days since last use" is reset by bulk access.** Scripts, crawlers and admin tools touch 15 to 20 services on the same day. One sweep makes everything look recently used.
- **A size floor removes almost everything** in a normal org (53 of 61 services were under 10 MB). (See the 2026-10-15 amendment: a size minimum is now a default, because the aim is saving credits.)
- **Hosted views have no storage of their own,** so they can't be scored on size the way their source layer is.
- **The credit rate was 100× too low.** It is 2.4 credits per 10 MB per month, and hosted views are excluded (DC-027, confirmed on doc.arcgis.com, "Understand credits").

The user's feedback on D (`FEEDBACK.md`):
- An owner's last sign-in is irrelevant, because a popular item can belong to someone who rarely signs in.
- "Quiet" was confusing. Use terms an ArcGIS Online admin already knows.

## Decision
A service is stale when **all** of these visible, editable conditions hold:

| Condition | Default (Balanced) | Words in the UI |
|---|---|---|
| **Days used** in the last N days, with org-wide sweeps excluded | ≤ K days in the last 90 (TBC) | "Used on 1 day in the last 90 days" |
| **Last updated** | ≥ M days ago (TBC) | "Last updated 14 months ago" |
| **Used by** maps and apps | ≤ D (TBC) | "Used by 1 map" |

- **Org-wide sweeps:** a day when at least S% of the org's services are used (TBC, flag default 25%) doesn't count as a day used. A filter toggle can count those days again. The info page says sweeps usually come from scripts, backups or crawlers.
- **Size is impact, not a gate.** Storage and credits per month sort the list and drive the totals ("potential credits saved"). Small stale items are still listed. Credits = size MB / 10 × 2.4 per month.
- **Hosted views are grouped under their source layer.** A source plus its views form one family. The family's days used are the union of all its members' days. A family is stale only when the whole family is stale. Views show 0 credits and the label "shares storage with its source".
- **Owner sign-in is not a signal.** It is removed from scoring, filters, the Sankey (no hollow blocks) and the default ticks. One exception at send time: if an owner's account is **disabled**, the row shows "Account disabled: the email may not reach them", and the admin decides.
- **Presets** (Gentle / Balanced / Strict) only fill these thresholds. Each preset is described in one plain sentence built from the thresholds.
- **Vocabulary:** "days used", "last updated", "used by N maps and apps", "storage", "credits per month". Never "quiet", "usage calls" or "requests".

## Consequences
- The scan needs **daily** usage for the window (whole org, about 3 calls per year). It already gets this, and it never queries the services themselves.
- Dependencies stay the slowest signal. Rows show "still checking" until the scan has looked at them, and a service can't be called stale on dependencies alone before then.
- The mock data generator must produce daily usage with sweep days, hosted-view families, and realistic sizes (median under 1 MB, a long tail). Prototype D's model is rewritten to match.
- The scoring and cooldown module (DC-014) is written test-first against these rules.

## Amendment, 2026-10-15 (user decisions; DC-055, DC-056, DC-057)
- **Org-wide sweeps: removed.** The app can't prove a busy day was a script, and org-wide crawls are unusual (user, FB-11). Every day with any data request counts as a used day; there is no toggle. Decluttering itself never requests layer data (the scan guard blocks service URLs, with tests), so running it never counts as use. The info page says an item page's map preview does count. Supersedes the "Org-wide sweeps" bullet and the sweep-day part of the "Days used" row above.
- **Days are UTC and include today.** "In the last N days" means today and the previous N−1 UTC days, and the wording says so (FB-09; `docs/research/usage-days-accuracy.md`). Local-day counting was tested (hourly data, 7 days per call) and not adopted.
- **Size is now also a default gate.** The app's intent is saving credits, so each starting point hides services below a minimum: Strict 10 MB, Balanced 15 MB, Gentle 20 MB; Suggested picks 10, 15 or 20 MB from the data (never below 10). Lowering it asks first, with what it adds in services, owners and credits. Services whose size isn't measured yet (lazy sizing, DC-053) are never hidden by the size filter. Supersedes "Size is impact, not a gate" for the defaults; size still drives sorting and totals.
- **Status:** still Proposed until thresholds are calibrated on a larger org (DC-031, read-only via DC-058).

## Amendment, 2026-10-17 (FB-29, FB-34, FB-35; DC-080, DC-080b, DC-083)

- **Context:** "Used on at most 2 days in the last 90 days" confused people (FB-35), and the usage-only rule flagged a layer with ~10k requests a day after a merge bug hid its newest window (FB-29). The research is in `docs/research/usage-signals-deep-dive.md` and `docs/research/stale-signal-v2.md`.
- **Decision: the usage signal becomes "last used".** Last used = the newest of `lastViewed` (in the search rows, free; Esri: it moves when the item page is opened, the item data is read or the layer's feature service is accessed) and the last UTC day with data requests, across the source and its views. A family is stale when it was **last used more than N ago**, **last updated more than N ago**, is used by at most D maps and apps, and meets the size minimum.

  | | Gentle | Balanced | Strict |
  |---|---|---|---|
  | Last used and last updated more than | 1 year | 6 months | 3 months |
  | Used by maps and apps, at most | 0 | 1 | 2 |
  | Size at least | 20 MB | 15 MB | 10 MB |

- **Unknown is never flagged:** when a usage window failed and `lastViewed` is blank or older than N, the row says "Last used: unknown". Blank `lastViewed` plus no requests in the 365 days read reads "No use recorded since at least November 2022" (Esri's meaning of a blank value) and counts as unused.
- **Total views (`numViews`) is context, not a filter:** it is all-time and data requests do not raise it. It shows on rows and in the email, and can sort.
- **Known caveats:** opening a layer's item page (including our "Open in ArcGIS Online" link and the nudge email's links) marks it as used; scripts that touch every layer reset it for all. Whether our own scan's `content/items/{id}` and `relatedItems` calls move `lastViewed` is live check L1: an anonymous dev-org test started 2026-10-16 12:28 UTC, the signed-in check is still to do. If they do, sizing moves to owner listings only.
- **Replaces:** the days-used count and its window (`maxDaysUsed`, `windowDays`), the FB-11 sweep discussion, and the 2/1 year/6 month ages.

## Amendment, 2026-10-31 (DC-143; user decisions for DC-144 to DC-146)

Research: `docs/research/usage-representation.md`. Daily request counts from `portals/self/usage` are the figure Esri's item Usage tab shows for hosted feature layers, labelled "Requests" (https://doc.arcgis.com/en/arcgis-online/manage-data/monitor-item-usage.htm). They count data requests from any client (maps draw with many, scripts and crawlers count too), not people or uses.

- **Vocabulary:** "requests" is allowed on the usage charts only (the sparkline's tooltip and the click-through chart), because it is Esri's own label. The rule and everything else keep "last used". Dates on the charts are UTC.
- **Relative measure (DC-146):** request days in the last 12 months, with sweep touches set aside, shown as a percentile against all scanned layers, plus a "Fewest request days" sort. Request totals are never ranked, because they mostly reflect how clients fetch data. It is information only: it is never part of the rule and never appears in owner emails.
- **Sweep touches on the sparkline:** drawn lighter, with the tooltip saying so, so the bars agree with Last used without hiding what happened.
- **A usage window that failed is drawn as "not read"**, never as zero.
