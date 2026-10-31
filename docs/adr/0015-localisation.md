# 0015: Localisation (i18n) with a small typed catalogue

## Status
Accepted (phase 1 of a phased migration).

## Context
All user-facing text is English and hard-coded. The app is browser-only, ships as a static site and has a strict CSP, so
anything we add must be small, same-origin and not need a backend.

## Decision
- `src/i18n/` holds a typed message catalogue (`en.ts` is the source of truth, `es.ts` the pilot language) and `t()`, `tn()` (plurals via
  `Intl.PluralRules`) and `Intl`-based number/date helpers. No new dependency.
- English is bundled; other languages are lazy, same-origin chunks. A missing key or a failed chunk falls back to English.
- The language is the saved choice (`decluttering:locale`), else the browser's, else English. `<html lang>` follows it. A picker in the header changes it.
- Messages are whole sentences with `{placeholders}`, never fragments glued together; plural messages use plural forms.
- Domain logic (UTC day arithmetic, rule thresholds, placeholder keys in email templates) does not change with the language.

## Migration
Phase 1: infrastructure and the steps indicator. Later phases move the rest of the UI, then formats and email templates, then tests and docs.
To add a language or new text, follow `CONTRIBUTING.md` ("Translating the app"): catalogues are split per area (`src/i18n/<code>/<area>.ts`),
and every language has a glossary in `docs/i18n/` and a fluent reviewer.

## Amendment 2026-10-31
Merged into the private repo on branch `i18n-es` (Aitor Calero's three commits kept as authored; conflicts resolved in the merge).
Renumbered from 0014 to 0015, as 0014 is the console look.

Where the language is chosen (replaces "a picker in the header"; W3C guidance "Guiding users to translated pages",
https://www.w3.org/International/questions/qa-site-conneg): most people never change it, so it is not in the header.
- Order: the saved explicit choice, else (once signed in) the ArcGIS Online user's `culture`, else the org's `culture`
  (both from `portals/self`), else the browser's language, else English. Only supported languages count; the profile
  value is applied, never saved, so a later profile change still takes effect.
- The control is a "Language" row in the account menu (demo too), names written in their own language with `lang`, no flags.
  Signed out, the landing page shows a quiet link to the other language(s). Neither appears when only one language exists. Strings added since (GH-2 content status) are translated, with
the Spanish marked `TODO(es-review)`.
