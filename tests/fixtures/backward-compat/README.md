# Backward-compatibility fixtures

This directory holds literal, older-shaped Drive/Sheets data — not synthetic "current shape minus
a field" stand-ins where it's avoidable, but the actual byte content this app's own earlier
versions genuinely wrote (verified against git history, see each fixture file's doc comment for
the commit it's pinned to). The suite that reads them (`tests/backward-compat-*.spec.ts`) asserts
the *current* app code still loads this data correctly — see issue #49 and DESIGN.md/CLAUDE.md's
"Google Drive/Sheets as the only backend" section for why this matters: a user's Drive is the only
copy of their data, there's no central database to migrate, so every schema change has to keep
working against whatever's already sitting there from before that change shipped.

## Layout

- `legacySettingsMd.ts` / `legacyCampaignMd.ts` — literal older `settings.md` / `campaign.md`
  frontmatter (parsed by `src/lib/markdown/frontmatter.ts`, typed by `src/types/campaign.ts`).
- `legacyNpcRows.ts` — literal older Sheets row data (typed/decoded by
  `src/lib/google/sheetSchema.ts`, `src/types/sheets.ts`).
- `seedLegacyCampaign.ts` — builds a full campaign folder (campaign.md, settings.md,
  story/summary/rolling.md, and a spreadsheet with every `SHEET_TABS` tab) directly in the fake
  Drive store (`tests/mocks/googleApi.ts`'s `FakeDriveStore`) from a fixture's literal content,
  bypassing the app's own setup wizard entirely — the wizard only ever writes *today's* shape, so
  it can't be used to produce older-shaped data. Row-shape and frontmatter-field fixtures use this;
  the sheet-tab-*presence* fixtures don't need it and just use `createRandomCampaign` +
  `FakeDriveStore.removeSheetTab` (see `tests/backward-compat-sheet-tabs.spec.ts`), since deleting
  a tab from an otherwise-normal campaign is simpler and just as real.

## Why fixtures don't need updating as the schema keeps growing

Every fixture here is pinned to one specific *historical* shape (e.g. "settings.md exactly as
Phase 1 wrote it, before `claudeModel`/`localModelId`/`kokoroVoiceId` existed"), not "today's shape
minus whatever the most recent PR added." That's deliberate: a fixture frozen at an old shape
automatically keeps exercising "does today's reader still handle N versions of drift" for any
value of N, including changes that haven't happened yet, with zero fixture maintenance. Concretely:
if a future PR adds a *fifth* `CampaignSettings` field, the existing Phase-1 `settings.md` fixture
here — already missing three fields — doesn't need touching to also prove the new field defaults
correctly; `loadSettings`'s `{ ...DEFAULT_SETTINGS, ...parsed }` merge either keeps working for
every missing field or it doesn't, and this fixture already forces that question either way.

**What this can't catch, and why that's a CLAUDE.md rule instead of a fixture:** a column
*reordered* (not appended) inside an existing tab, or an existing field's *meaning* repurposed.
`rowCodecs[...].fromRow` reads columns positionally — a short row degrades safely to defaults
(the case these fixtures cover), but a reordered column silently reads a later real value into the
wrong field, and no historical fixture can predict a reorder that hasn't happened yet the way it
can passively keep covering "another field got appended." `tests/backward-compat-row-shapes.spec.ts`
has one test that deliberately demonstrates this gap (not "proves it's safe" — it proves it
*isn't*), so the limitation is asserted rather than just described in a comment someone can miss.
This is why CLAUDE.md's rule for schema changes also requires a human judgment call — "did I only
append, or did I reorder/repurpose an existing column" — that no amount of fixture coverage
substitutes for. See CLAUDE.md's "Google Drive/Sheets as the only backend" section for the actual
rule text.

## Adding a new fixture

When you change one of the schema surfaces this covers (`SHEET_TABS`/`TAB_HEADERS`/`rowCodecs` in
`src/lib/google/sheetSchema.ts` + `src/types/sheets.ts`, `CampaignSettings`/`CampaignMeta` in
`src/types/campaign.ts`, or the frontmatter shape in `src/lib/markdown/frontmatter.ts`), add a
fixture that captures the shape *immediately before* your change (copy the previous header row /
frontmatter block verbatim — don't hand-simplify it) and a test in the matching
`tests/backward-compat-*.spec.ts` file asserting the current app still loads it. If your change is
a pure append (new optional/defaultable field, new tab), the existing older fixtures already give
you some of this for free per the section above — add a fresh one anyway if it's the first fixture
to model that shape, so the *specific* thing you changed has a fixture pinned to right before it,
not just an incidental side effect of an older one.
