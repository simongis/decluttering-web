# Contributing to Decluttering

Thanks for helping. Bug reports, ideas, wording fixes and pull requests are all welcome on the **Issues** page. For anything bigger, open an issue first so we can talk it through.

## Before you start

- **Node 20+**, then `npm install`.
- `npm run dev` starts the app at http://localhost:5173. `#/demo` runs it on a made-up org, with no sign-in.
- A change is done when these all pass:

  ```
  npm run typecheck && npm run lint && npm test && npm run e2e
  ```

- The app never deletes, unshares or changes anyone's items. Changes that do will not be merged.
- Everything runs in the browser. There is no backend, and nothing leaves the admin's own ArcGIS Online org.

## Writing copy

All text follows one voice: kind, plain, a little light-hearted, and honest about numbers. The short version:

- **Nudge, never nag.** Say "tidy up", "review", "you might like to". Never "delete", "must", "overdue" or "urgent".
- **Plain words.** Use the exact ArcGIS Online terms: hosted feature layer, item, owner, group, credits.
- **Short.** One idea per line, about 25 words at most. Detail goes in an info popover.
- **No jokes** in errors, consent dialogs, sends, or anything about someone else's items.
- **Say exactly what will happen** before anything is sent.

## Translating the app

Localisation was contributed by Aitor Calero (Esri Spain). The design is in [`docs/adr/0015-localisation.md`](docs/adr/0015-localisation.md). English and Spanish (Español) are supported today.

### How it works

- Every piece of text is a **message key** in a typed catalogue, for example `'review.filter.lastUsed': 'Last used'`.
- **English is the source of truth.** It lives in `src/i18n/en/<area>.ts`, with one file per area: `core`, `shell`, `scan`, `review`, `emails` and `about`.
- **Each language mirrors English** in `src/i18n/<code>/<area>.ts`, with exactly the same keys. TypeScript and `src/i18n/i18n.test.ts` fail if a key is missing, extra, or drops a `{placeholder}`.
- **Components call** `t('key', { name: value })`. For counts they call `tn('key', count)`, which picks the right plural form for the language.
- **Numbers and dates** go through `formatNumber` and `formatDate` in `src/i18n/index.ts`.
- **Language choice:** the app uses, in order:
  1. a choice made in the app (the "Language" row in the account menu, or the link on the landing page)
  2. the ArcGIS Online user's language, then the org's
  3. the browser's language
  4. English

  A missing key or language always falls back to English, so the UI is never blank.
- **Owner emails** (the digest) are still English only.

### Adding text (any change)

1. **Add the key to the English file** for that area. Name it `area.component.purpose`, for example `review.sankey.clear`.
2. **Write whole sentences** with `{placeholders}`. Never glue fragments together, because word order differs between languages.
3. **Add the same key to every other language** in the same change. If you can't translate it, put in your best draft and mark it with a comment for a native speaker to check:

   ```ts
   // TODO(es-review): new in GH-2, machine translated
   'review.filter.status.heading': 'Estado del contenido',
   ```

4. **Run the checks:** `npm run typecheck && npm test`.

### Adding a new language

1. **Copy the folder.** Copy `src/i18n/es/` to `src/i18n/<code>/`, where `<code>` is the ISO 639-1 code, for example `fr`. Rename the exports (`esCore` becomes `frCore`, and so on).
2. **Translate every value.** Keep the keys and `{placeholders}` exactly as they are. For plurals, give the forms your language needs (`one`, `other`, and `few` or `many` where it uses them).
3. **Compose the catalogue.** Create `src/i18n/<code>.ts` the same way `src/i18n/es.ts` does.
4. **Register the language** in `src/i18n/index.ts`:
   - add the code to `LOCALES`
   - add its own name to `LOCALE_NAMES`, written in that language (for example `fr: 'Français'`)
   - add a loader to `loaders`
5. **Add a glossary** at `docs/i18n/glossary-<code>.md`. Use Esri's official terms for that language from the localised ArcGIS Online documentation.
6. **Run the checks.** Run all four commands above, then check the demo (`#/demo`) in both looks (standard and console) for text that overflows buttons or chips.
7. **Open a pull request.** Say who has reviewed the language (see below).

### Quality: who checks a translation

The maintainer can't read every language, so each one needs a reviewer:

- **A fluent speaker reviews every change** to a language before it's released. Ideally they know ArcGIS Online in that language. Name them in the pull request.
- **Use the glossary.** Use the terms in `docs/i18n/glossary-<code>.md`. If you change a term, update the glossary in the same pull request.
- **Release tracking.** Lines marked `TODO(es-review)` (or `TODO(<code>-review)`) are counted before each release. A language with open items still ships, falling back to the draft text, but the release notes say so.

## Pull requests

- Keep each pull request to one topic. Say what changed, how you checked it, and anything still open.
- Contributors keep authorship of their commits, and are credited in the release notes.
- By contributing, you agree your work is licensed under the Apache License 2.0 (see `LICENSE`).
