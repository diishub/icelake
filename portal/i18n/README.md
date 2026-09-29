# portal/i18n

Strings for the portal, one file per language, plus the runtime that swaps
them.

```
i18n/
  index.js   behaviour: detect, translate, swap, remember
  th.js      Thai strings
  en.js      English strings
```

The split is deliberate: `index.js` contains no wording and the language files
contain no logic, so a translator never has to read code and a change to the
switching behaviour never touches a sentence.

## How it loads

`index.html` loads the language files first and the runtime after, all with
`defer`. Deferred scripts run in document order, so the strings are always
registered before anything reads them. Keeping them as plain scripts rather
than fetched JSON keeps the first paint synchronous: the page is never briefly
in the wrong language, and a reader on a slow connection never sees the Thai
markup flash before the English arrives.

The markup itself still ships readable Thai. If these files fail to load the
page is a working Thai page, not a shell of empty elements.

## How a string reaches the screen

Text comes from the markup:

```html
<h2 data-i18n="stats.title">ตัวเลขจริง ไม่ใช่คำโฆษณา</h2>
```

Attributes a reader can see come from the same place:

```html
<input data-i18n-attr="placeholder:search.placeholder">
<nav data-i18n-attr="aria-label:nav.label">
```

Anything drawn from data rather than from markup asks for its string in
`app.js`:

```js
addFact(t("catalog.owner"), dataset.owner);
count.textContent = t("catalog.countAll", { total: datasets.length });
```

`{name}` placeholders are filled from the second argument. A key missing in the
active language falls back to Thai and warns in the console, because one Thai
line is a smaller failure for an English reader than the literal text
`catalog.owner`.

## Dataset names are not here

Titles and descriptions of datasets are data, not interface copy, so they live
in the database beside the Thai ones: `display_name_en` and `description_en` on
`ingest.source_table`. The publisher writes both into `data/catalog.json` and
the page picks one at render time. See
`config/platform/009-catalog-english.sql`.

## Adding a language

1. Copy `th.js`, rename it to the language code, translate the values, keep
   every key.
2. Add the code to `SUPPORTED` in `index.js`.
3. Add a `<script>` tag for it in `index.html`, before `i18n/index.js`.
4. Add the matching `_en`-style columns to the catalogue if dataset names
   should be translated too.
5. Run `scripts/test-portal-i18n.sh`.

That test fails when a key exists in one language and not another, in either
direction. A key that only exists in one language shows up as a single foreign
line in the middle of a page, which is exactly the kind of thing that survives
review.
