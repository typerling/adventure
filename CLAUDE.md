# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A solo, audiobook-style AI-narrated adventure game. Client-only React + TypeScript SPA — **no
server, no database**. All game state lives in a Google Drive folder the user owns: Markdown
files for prose, one Google Sheet per campaign for everything tabular. See `DESIGN.md` for the
full architecture/data model/rationale and `README.md` for setup. Read `DESIGN.md` before making
any structural change — it's the source of truth for the data model and turn contract, and is
kept in sync with the implementation.

**Possible future direction, not yet scoped:** the project owner is considering multiplayer
support, which the current Drive-only/single-owner model doesn't support — see DESIGN.md §2's
"Possible future direction: a hosted backend for multiplayer" note for what that would likely
require (a proper hosted database in place of Sheets/Drive, a hosted Kokoro instance in place of
the in-browser `kokoro-js` setup). Nothing to act on yet; noted so it's on record.

Phase 1 (MVP, implemented): campaign setup wizard, manual copy/paste DM turn loop, deterministic
state validator, Codex/Dashboard/Settings screens. Phase 2 is in progress: voice is implemented
for both TTS providers (browser and on-device Kokoro) and the one STT provider (browser) — an
ElevenLabs TTS/STT option existed briefly but was removed outright (issue #97), as part of the
multi-voice narration initiative (epic #36), so there is one voice stack to grow per-speaker
voices on rather than two to maintain in parallel; the map graph view is the only remaining stub.
Phase 3's direct AI mode is implemented with two options alongside manual copy/paste (which still
works, as the no-setup fallback): the Claude API, and a choice of several fully on-device models
over WebGPU — see
"Direct AI mode" below. OpenAI was not requested and isn't implemented.

## Commands

- `npm run dev` — start the dev server (Vite)
- `npm run build` — typecheck (`tsc -b`) + production build; **this is the only typecheck
  command** (no separate `typecheck` script). `dist/` will contain a multi-MB ONNX Runtime
  WebAssembly file — that's `@huggingface/transformers` (local AI mode's on-device inference
  runtime). It is imported only by `localModel.worker.ts`, so it lands in that worker's own chunk,
  fetched when a player actually uses local mode and never part of the main app bundle.
- `npm run lint` — oxlint (config in `.oxlintrc.json`)
- `npm run preview` — preview the production build locally
- `npm run test:e2e` — Playwright end-to-end tests (`playwright.config.ts`, specs in `tests/`).
  Starts its own dev server on port 5183 with a dummy `VITE_GOOGLE_CLIENT_ID`; every Drive/Sheets
  API call is intercepted by `tests/mocks/googleApi.ts` (an in-memory fake backend) and a fake
  session is seeded into `localStorage` before each test, so no real Google account or network
  access is needed. Run a single file with `npx playwright test tests/new-campaign.spec.ts`, or
  `--headed`/`--debug` while writing new specs. `tests/mobile-layout.spec.ts` holds the
  **page-level** responsive coverage (component-level lives in Storybook, below): it drives
  Play/Codex/Settings at 390×844 and 1280×900 via `test.use({ viewport })`, asserting the single
  hamburger-menu nav pattern (`src/components/Header.tsx`) works identically at both widths — the
  trigger opens a real menu with the right items for whether a campaign is open, selecting an item
  navigates and closes the menu, and it closes on outside click/Escape too — plus that no page
  scrolls sideways at phone width. It hides the toast layer via `addInitScript`, because toasts
  pin to the bottom of the viewport and on a phone-width screen genuinely sit over Play's input
  row and intercept clicks meant for it.
- `npm run storybook` — Storybook dev server on port 6006, for viewing/developing
  `src/components/**/*.stories.tsx` in isolation (every `src/components/ui/*` primitive, plus
  `Header`). `npm run build-storybook` produces a static `storybook-static/` build (not
  deployed anywhere — dev/review tool only). Config lives in `.storybook/` (`main.ts`/
  `preview.tsx`, the latter importing `src/index.css` so components render with the app's real
  Tailwind theme/fonts, plus a toolbar light/dark toggle mirroring the `.dark`/`.light` classes
  `src/index.css` already supports).
- `npm run test:stories` — runs each story's `play` function (interaction tests written with
  `storybook/test`'s `userEvent`/`expect`/`within`) via `@storybook/addon-vitest`, which executes
  them in a real Chromium instance through Vitest's Playwright-provider browser mode (`vitest
  --project=storybook run`, configured in `vite.config.ts`'s `test.projects`) — not jsdom, so
  these exercise real layout/CSS/focus behavior the same way the Playwright e2e suite does, just
  scoped to one component instead of a full page. Run a single file with `npm run test:stories --
  src/components/ui/dialog.stories.tsx`. Three non-obvious things learned writing these:
  - Radix's open/close animations (`data-open:animate-in ...`) start at `opacity: 0`, so a bare
    `expect(el).toBeVisible()` right after a `userEvent.click()` that opens a Dialog/DropdownMenu
    can catch the first animation frame and fail — wrap in `waitFor(() => expect(...).toBeVisible())`.
  - **Responsive behavior is testable, and viewport is per-story.** `preview.tsx` defines two
    viewports named after this app's only layout breakpoint (Tailwind `md`, 768px) rather than
    after devices — `mobile` (390×844) and `desktop` (1200×900) — selected per story with
    `globals: { viewport: { value: 'mobile' } }`. These are **real** viewport resizes:
    `@storybook/addon-vitest` feeds the resolved size to Vitest browser-mode's `page.viewport()`,
    so `md:` variants genuinely apply or don't, and a story can assert mobile-only/desktop-only
    layout. Two things not to confuse it with: `parameters.viewport.defaultViewport` was **removed
    in Storybook 10** — the Storybook UI ignores it (logging a deprecation) and only the Vitest
    addon still honours it as a fallback, so a story using it renders at the wrong width in the
    browser while passing in CI; and `vite.config.ts`'s `test.browser.instances[].viewport` is
    Vitest's own knob, which this addon overrides per story — setting it there does nothing
    (verified). A story that sets neither gets the addon's 1200×900 default.
  - Anything hidden at the current viewport is hidden *for real*, including from the
    accessibility tree — a Radix `DropdownMenuContent` isn't just visually hidden while closed,
    it's unmounted, so a story that opens `Header`'s hamburger menu without first setting a
    viewport it can actually see and click within will find no `menuitem`s at all. If a
    `getByRole` query mysteriously finds nothing, check the component isn't `display: none` (or,
    for Radix content, simply not open yet) at the story's viewport before assuming a timing
    problem.

Google Drive integration requires `VITE_GOOGLE_CLIENT_ID` in `.env` (copy from `.env.example`).
Without it the app boots to an "unconfigured" screen instead of crashing — see
`src/lib/google/config.ts` / `authStore.ts`'s `unconfigured` status. You can develop most UI
without real credentials, but anything touching Drive/Sheets needs a working OAuth Client ID.

## Deployment (GitHub Pages)

`.github/workflows/deploy-pages.yml` builds and publishes `dist/` on every push to `main`.

- **Base path.** A project site is served from `https://<owner>.github.io/<repo>/`, so the build
  sets `VITE_BASE=/<repo>/` (derived from `github.event.repository.name`). Nothing hardcodes the
  repo name: `vite.config.ts` reads `VITE_BASE`, `index.html` uses Vite's `%BASE_URL%` placeholder,
  and `src/App.tsx` passes `import.meta.env.BASE_URL` to `BrowserRouter`'s `basename`. Local dev
  and `npm run build` leave it at `/`, which is why the Playwright suite is unaffected.
- **SPA fallback.** The workflow copies `dist/index.html` to `dist/404.html`. Pages serves static
  files only, so without this a deep link like `/<repo>/play/<id>` would 404 instead of reaching
  the client-side router. This is also why `index.html` uses absolute `%BASE_URL%`-prefixed asset
  paths rather than relative ones — relative paths would resolve against `/<repo>/play/`.
- **PWA icons.** The manifest must list **PNG** icons (192 + 512) or Chrome on Android won't offer
  "Install app" at all — an SVG-only manifest is not installable. It also needs `purpose:
  "maskable"` variants, padded so the artwork stays inside Android's centred 80%-diameter safe
  circle, or the icon gets clipped. Manifest paths are relative so they resolve against whatever
  base the site is served from.

Three things live outside the repo and are easy to miss:

1. Pages **source must be set to "GitHub Actions"** (the workflow has no `configure-pages` step).
2. A repo **variable** `VITE_GOOGLE_CLIENT_ID`. If it's missing the build still succeeds and
   silently deploys an app stuck on "Google Drive isn't configured yet".
3. The deployed origin (e.g. `https://<owner>.github.io`) must be added to **Authorized JavaScript
   origins** on the Google OAuth client, or sign-in fails with `origin_mismatch`. Origins are
   scheme+host only — no path, no trailing slash.

An OAuth **client ID is public by design** (it ships in the browser bundle); the security boundary
is that origins list, not secrecy of the ID.

## Architecture

### The turn loop (the core mechanic)

Every AI reply — pasted in manually, or returned by the Claude API or the local model — must
follow one contract so the app can parse it: narrative prose, then a single trailing ` ```state `
fenced JSON block (`state_delta`, `summary_update`, `options`). This flows through four stages,
each its own module under `src/lib/ai/`:

1. **`promptBuilder.ts`** (`buildTurnPrompt`) — assembles the full DM prompt: persona/tone,
   difficulty instructions (`difficultyInstructions.ts`), the campaign's world/character setup,
   a fresh sheet snapshot, the rolling summary, recent turns, the player's action, and the fixed
   contract instructions from `contract.ts` (`STATE_CONTRACT_INSTRUCTIONS`).
2. **`parseReply.ts`** (`parseTurnReply`) — extracts narrative + the `state` JSON block from the
   raw pasted reply.
3. **`validate.ts`** (`validateStateDelta`) — deterministic, client-side validation against the
   current sheet snapshot *before* anything is written back (can't remove an item not held,
   can't revive a dead NPC, etc.). Returns `ValidationIssue[]`; a failed validation blocks the
   write and is surfaced to the user rather than silently dropped.
4. **`applyDelta.ts`** (`src/lib/google/applyDelta.ts`, `applyStateDelta`) — once validated,
   applies the delta as Sheets writes (append new Inventory/NPC/Monster/Timeline/Map rows,
   targeted updates for Character stat/status changes).

`src/hooks/useCampaign.ts` is the orchestrator that wires these four stages together for one
campaign: it loads campaign/settings/sheet-snapshot/rolling-summary/recent-turns on mount, exposes
`buildPromptForAction` (stage 1) and `submitReply` (stages 2–4 plus persisting the updated
campaign meta, rolling summary, and turn log). Look here first when tracing "what happens when
the player submits a turn."

The narrative half of the contract also supports an invisible `{{v:Name}}...{{/v}}` speaker token
around a character's own dialogue (issue #96, epic #36's multi-voice-narration groundwork) —
stripped everywhere player-facing (`TurnContent.tsx`'s renderer, `turnBlocks.ts`'s
`stripMarkdownToPlainText`) so it never changes what's shown or read aloud today.
`turnBlocks.ts`'s `buildSpokenSegments` splits a turn's spoken text into `{text, speaker}`
segments at these tokens (tolerant of unclosed/stray/nested malformed tags — see its doc
comment), collapsing to exactly one `speaker: null` segment whenever a turn has none (every turn
logged before this shipped); `attributeSpeakersHeuristically` is a separate, opt-in fallback that
guesses a speaker for quoted dialogue by nearest preceding known name when no real tokens are
present. `buildSpokenScript` still hands a provider with no multi-voice capability (`browser`) one
flattened string; Kokoro is now the one provider that actually consumes the per-segment split — see
"Multi-voice playback" under the Voice section below (issue #66).

**Voice casting (issue #98, epic #36 continued).** `new_npcs`/`npc_updates` also carry optional
`voiceId`/`voiceSpeed` — a Kokoro voice id (e.g. `bm_george`) and delivery-speed multiplier, cast
by the AI under the same "real interaction" gate as `voice`/`secrets`/`attributes`, from a compact
catalog `promptBuilder.ts` renders every turn (`src/lib/voice/kokoroVoiceCatalog.ts`'s
`KOKORO_VOICE_CATALOG` — a static, checked-in mirror of kokoro-js's own 28-voice metadata, not a
live read, since reaching the real thing would mean statically importing `kokoro-js`'s
`@huggingface/transformers` dependency into the main bundle; kept in sync by
`tests/kokoro-voice-catalog.spec.ts`, which imports the real package in Node and diffs against it).
The same prompt section lists current casting — the narrator's (`GlobalSettings.kokoroVoiceId`),
the player's (`CampaignSettings.playerVoiceId`, new this ticket — per-campaign since a player
character is a property of the campaign, not the device, mirroring why `summarizationCadence`
stayed there post-#77), and every already-cast NPC — so the AI avoids duplicate casting within a
scene and never recasts an NPC whose `voiceLocked` is true (set via the Codex override, #100 below).
An unrecognized `voiceId`/out-of-range `voiceSpeed` is a coercing warning in `validate.ts`, never a
blocking error — a miscast voice must never cost the player their turn — and `applyDelta.ts`
discards it outright as defense-in-depth, the same "warn here, actually enforce in applyDelta"
split `new_threads`/`thread_updates`' progress-range checks already use. After every turn's NPC
writes land, `applyDelta.ts` also runs a deterministic fallback (`src/lib/voice/voiceCasting.ts`):
any known NPC who spoke this turn (`turnBlocks.ts`'s `extractSpeakingNames`, real tokens or the
heuristic fallback) but still has no `voiceId` gets one via a stable hash of their name, filtered by
gender when known (a free-form NPCAttributes "Gender" fact — no hard-coded field, per "Genre-
agnostic by design" below) and excluding the narrator's/player's voices, with a soft cap
(`VOICE_CAST_SOFT_CAP = 8`) reusing an already-cast voice once reached rather than growing the
download list unboundedly (~510KB per voice). This ticket shipped no playback change itself —
consuming a cast `voiceId` at playback time is issue #66, see "Multi-voice playback" below.

**Player voice override from the Codex (issue #100, epic #36's final piece).** The Codex
(`src/pages/Codex.tsx`) was read-only until this ticket — every other Sheets write in this app
flows through `applyDelta.ts`'s `applyStateDelta`, shaped around parsing/validating/merging a
whole AI-generated `state_delta`, not a single player-initiated field change made outside a turn.
Rather than shoehorning this into that pipeline, it's a small, dedicated write:
`campaignRepo.ts`'s `setNpcVoiceOverride(spreadsheetId, npcs, npcId, voiceId)` calls
`sheetsApi.ts`'s `updateRow` directly — the same primitive `applyStateDelta`'s own NPC-update code
already wraps (compute the row number, build a merged row object, call `updateRow`). Passing
`voiceId` a real catalog id sets it and locks it (`voiceLocked: true`); passing `null` clears the
lock (`voiceLocked: false`) and hands the character back to AI casting, deliberately leaving
whatever `voiceId` is already on the row untouched rather than blanking it, so the character keeps
sounding the same until the AI actually casts someone new. `useCampaign.ts`'s `setNpcVoice` wraps
this and reconciles the in-memory snapshot (and `campaignCache`) only *after* the write confirms —
per this file's "cache with optimistic writes reconciled against API responses" rule, nothing
renders a changed voice ahead of the write landing, so a failed write (surfaced as
`toast.error`, `src/components/ui/toast.tsx` — not Sonner, removed in issue #95) simply leaves the
snapshot untouched rather than needing a separate revert step. `src/components/NpcVoicePicker.tsx`
is the picker UI itself (its own Storybook stories cover both viewports and the failure path),
mounted once per NPC row in the Codex's NPCs tab; it lists `CASTABLE_KOKORO_VOICE_IDS` (issue
#107's quality-filtered pool — the same reasoning Settings' own narrator/player picker follows for
*not* applying that filter: this is casting-adjacent, being cast for an NPC the AI would otherwise
cast, not a human making an informed choice for their own narrator/player voice) built straight
from the static `KOKORO_VOICE_CATALOG` mirror rather than `listKokoroVoices()`, so opening the
dialog never forces a Kokoro model download — only clicking an individual voice's preview
(`generateKokoroPreview`, injectable on the component for tests/stories) does. A known, accepted
gap: no optimistic-concurrency check against a turn's `state_delta` writing the same NPC row at
the same instant — narrow enough in practice (different pages/interactions) that it's undocumented
risk, not a fixed one; see `setNpcVoiceOverride`'s own doc comment. Also known and NOT this
ticket's bug to fix (issue #105): `npc_updates` matches NPCs by exact name only, so an AI
paraphrase of a locked NPC's name can create a duplicate, unlocked row the override never touches
— locking protects the specific row a player locked, not every future row that might represent the
same character.

### Direct AI mode (Phase 3: Claude API + local on-device models)

`GlobalSettings.aiMode` (`'manual' | 'api' | 'local'`, `src/lib/settings/globalSettings.ts`) picks
how stage 1's prompt reaches an actual AI reply — global to the device (localStorage), not
per-campaign, since issue #77.

- **`'api'`** — `src/lib/ai/claudeProvider.ts`'s `generateClaudeReply(prompt, model)` calls
  `POST https://api.anthropic.com/v1/messages` with a plain `fetch` — no `@anthropic-ai/sdk`
  dependency, matching this repo's established thin-fetch-client convention (same as
  `driveApi.ts`/`sheetsApi.ts`) and DESIGN.md §11's explicit "no build-time dependency on any AI
  vendor SDK" call. Calling the Messages API directly from a browser needs the
  `anthropic-dangerous-direct-browser-access: true` header (undocumented in Anthropic's official
  reference at time of writing; verified against the SDK's own source and community reporting) —
  without it the request is blocked as cross-origin. The API key (`src/lib/ai/claudeKey.ts`) is
  `localStorage`-only; the model choice (`GlobalSettings.claudeModel`, one of `CLAUDE_MODELS`,
  default `claude-sonnet-5`) is global like `kokoroVoiceId` (issue #77 — previously per-campaign).
- **`'local'`** — `src/lib/ai/localModel.ts`'s `generateLocalReply(modelId, prompt, opts)` runs one
  of several small instruction-tuned models entirely in-browser via `@huggingface/transformers`
  over WebGPU — no key, no server. `LOCAL_MODELS` is the catalog (Hugging Face repo ID → display
  label, approximate download size, and whether it needs a real multimodal `AutoProcessor`), picked
  globally via `GlobalSettings.localModelId` (default `onnx-community/gemma-3-1b-it-ONNX`, issue
  #77 — previously per-campaign) and shown with sizes in Settings' model dropdown. They range from ~490MB (Qwen2.5 0.5B) to ~3GB
  (Gemma 4 E2B) — the catalog started as just the Gemma 4 E2B model, but that alone was crashing
  the tab (Chrome's "Aw, Snap") on memory-constrained devices at ~2GB downloaded, so smaller
  alternatives were added as an escape hatch rather than trying to make one model work everywhere.
  Every model loads via the generic `AutoModelForCausalLM` (resolved from each checkpoint's own
  `model_type`), **except** that Gemma 4 E2B's native checkpoint is `Gemma4ForConditionalGeneration`
  — genuinely multimodal (text decoder + embeddings + a vision encoder + an audio encoder) — and
  `AutoModelForCausalLM` resolving it to the sibling `Gemma4ForCausalLM` class instead triggers
  `@huggingface/transformers`' documented cross-architecture "text-only" loading path, which skips
  fetching/allocating the vision/audio sessions entirely (confirmed against the installed package's
  `resolveTypeConfig`/`MODEL_SESSION_CONFIG`, not assumed) — this app never sends images or audio,
  so that's free savings. That same override also throws off the library's own upfront download
  *size estimate* for Gemma 4 E2B specifically (it's computed independent of the text-only choice),
  which `localModel.ts`'s `stripUnusedComponents` corrects before the shared progress aggregator
  sees it. Every model except Gemma 4 E2B loads via a plain `AutoTokenizer` rather than
  `AutoProcessor` (which throws for a repo with no `preprocessor_config.json`) — `LOCAL_MODELS[id].
  usesProcessor` also decides whether chat history is built with `content` as a plain string
  (every `AutoTokenizer`-loaded model) or as a list of typed parts (Gemma 4 E2B's processor-based
  template). Unlike the fetch clients elsewhere, `@huggingface/transformers` genuinely is a vendor
  dependency here, and that's fine: DESIGN.md §11's "no AI vendor SDK" rule was about avoiding a
  *remote-API* client, not about the on-device inference runtime itself — there's no thin-fetch
  equivalent for running a model locally.

  **The model runs in a dedicated Web Worker** (`localModel.worker.ts`), as every official
  transformers.js WebGPU example does; `localModel.ts` is only the main-thread face of it — public
  API, per-model UI state (load status/progress/listeners), and the IndexedDB
  downloaded/partial/remove helpers — talking over the typed protocol in
  `localModelWorkerProtocol.ts`. Three things fall out of that split and are easy to trip over:
  the catalog lives in its own `localModelCatalog.ts` because the worker importing `localModel.ts`
  would recursively spawn workers; `navigator.storage.persist()` is Window-only so
  `requestPersistentStorage()` stays on the main thread; and `@huggingface/transformers` is now
  imported *only* by the worker, so its JS chunk and the ONNX WebAssembly runtime never touch the
  main bundle at all. Generation is a long unbroken stretch of work — on the main thread it froze
  the whole UI (including the streaming preview meant to show it was alive) for the entire turn.

  Loading also **warms up** with a throwaway one-token `generate` before reporting ready (what the
  reference workers do): WebGPU compiles shaders lazily, so without it the first turn paid for all
  of that *plus* a prefill over this app's multi-thousand-token DM prompt in one burst — measured
  at ~23.5s versus ~2.5s for a real generation right after — and a burst that long gets reset out
  from under the page by a mobile GPU driver ("Device is lost"). If a device *is* lost mid-reply
  the worker retries the turn once on the **CPU/WASM backend** rather than failing: note that's a
  different quantization (`LOCAL_MODEL_CPU_DTYPE` = `q8` → `model_quantized.onnx`, the library's
  own wasm default and the one variant present for every catalog model), so it re-downloads the
  model and runs in minutes rather than seconds. The backend is also **selectable per model** in
  Settings ("Run on: GPU / CPU"), since on a device whose GPU can't hold the model, waiting for the
  automatic fallback costs a wasted generation every time. Either way the choice is remembered per
  model in `localStorage` and reset by "Remove". Two things follow from the two backends being
  different *files*: `hasDownloadedLocalModel` asks about the build the selected backend needs
  (`LOCAL_MODEL_DTYPE_SUFFIX`), or a GPU-downloaded model would claim to be ready while the CPU one
  had yet to be fetched; and `isLocalModelSupported()` (WebGPU feature detection) is no longer the
  same question as `canRunLocalModel(modelId)`, which is what the load/generate paths gate on — a
  model pinned to the CPU runs on a browser with no WebGPU at all. `isLocalModelSupported()`
  checks `navigator.gpu` — note this is *feature detection only*: modern Chromium reports
  `navigator.gpu` as present even where a real GPU adapter can't be obtained (verified while
  writing tests for this — see `tests/ai-local-mode.spec.ts`), so genuine failures (no adapter,
  model download failure, OOM on a low-end phone) surface at generation time via the same
  try/catch as the API path, not via this check. Model loading state (`loadPromise`/`isReady`/
  download progress/listeners) is keyed per model ID in a module-level `Map` on the main thread
  (the worker keys its loaded models by model ID *and* backend, since the GPU and CPU builds are
  different files), not one shared singleton — several models can each have their own in-flight load or cached download at once,
  and each has its own `removeLocalModel(modelId)` to clear both its complete-file cache
  (`localModelCache.ts`) and any interrupted partial download (`localModelResumableFetch.ts`)
  without touching other models' data, surfaced in Settings as a per-model "Remove"/"Clear partial
  download" action. A failed load clears that model's cached state so retrying can actually retry.

`Play.tsx`'s `startTurn` branches on `aiMode`: for `'api'`/`'local'` (`isAutoMode`) it calls
`generateAndApply` instead of waiting for a manual paste, which calls the matching provider and
feeds the result straight into the *same* `submitReply` (parse → validate → apply) pipeline manual
mode uses — nothing downstream of "raw reply text" cares which path produced it. A validation
failure surfaces the same `ValidationIssue[]` either way; in both auto modes the dialog offers a
"Retry" button that re-sends a correction-augmented prompt (built once via `buildCorrectionPrompt`,
shared with manual mode's "Copy correction prompt" button) rather than DESIGN.md's
originally-envisioned fully-automatic retry — spending another generation always requires an
explicit click. Local mode additionally streams tokens as they generate (`onToken`) into a
read-only preview in the dialog, since on-device generation on a phone GPU can take a while and a
frozen "Generating…" spinner with no feedback reads as broken.

### Google Drive/Sheets as the only backend

Everything under `src/lib/google/` is the persistence layer — there is no other one:

- **`driveApi.ts` / `sheetsApi.ts` / `http.ts`** — thin wrappers over Drive API v3 and Sheets API
  v4, called directly from the browser with the OAuth access token from `authStore.ts`.
- **`authStore.ts`** — Zustand store for the Google Identity Services token lifecycle
  (`unconfigured → signed-out → signing-in → signed-in`/`error`), including silent-refresh vs.
  interactive-sign-in token acquisition (`getValidAccessToken`).
- **`sheetSchema.ts`** — the single place mapping typed row objects (`src/types/sheets.ts`) to/from
  raw Sheets rows (`rowCodecs`, `TAB_HEADERS`). Column order here **is** the sheet column order —
  keep both in sync when changing a tab's shape. `SHEET_TABS` in `src/types/sheets.ts` enumerates
  every tab (Character, Inventory, Skills, NPCs, NPCAttributes, Monsters, Timeline, Quests,
  Threads, Map, Lore); adding a tab means updating `SHEET_TABS`, `TAB_HEADERS`, `rowCodecs`, and the
  `loadSheetSnapshot` / `SheetSnapshot` type together — **and** addressing backward compatibility
  with data already in a user's Drive, see immediately below. The `NPCs` tab also carries
  `voiceId`/`voiceSpeed`/`voiceLocked` (issue #98, appended after `detailFile` — never reorder),
  the machine-resolvable counterpart to the pre-existing human-readable `voice` descriptor column;
  see the Voice section above for what populates them.
- **`campaignRepo.ts`** — the repository layer above raw Drive/Sheets calls: bootstrapping the
  root library folder, listing/creating campaigns, reading/writing `campaign.md` and
  `settings.md` frontmatter, reading/writing the rolling summary, and `loadSheetSnapshot` (one
  `batchGet` across every tab — the whole point of the Sheets-per-campaign design is that a full
  state read/write is O(1) API calls, not O(tabs)).
- **`storyLog.ts`** — append-only turn transcript, chunked into `story/log/*.md` files.
- Prose (`campaign.md`, `settings.md`, `story/summary/rolling.md`, `story/log/*.md`,
  `world/lore/*.md`) uses YAML frontmatter + body, parsed via `src/lib/markdown/frontmatter.ts`.
  Tabular data (Inventory, NPCs, Monsters, Timeline, Quests, Map, Lore, Character key/values) is
  one Google Sheet per campaign, one tab per entity type — see `DESIGN.md` §4 for the full Drive
  folder layout this code produces.

**Every schema change must keep working against data already sitting in a user's Drive.** There is
no database to migrate centrally and no way to bulk-update every user's existing files (see "What
this is" above) — a campaign's Drive folder *is* its only copy of that campaign, forever, unless
this code keeps reading it. This isn't hypothetical: issue #46 shipped `SHEET_TABS` gaining
`NPCAttributes` (#30/PR #37) with no migration for spreadsheets that predated it, and nothing in
the test suite caught it — every existing campaign became permanently unopenable until #47's fix.
So: any change to `SHEET_TABS`/`TAB_HEADERS`/`rowCodecs` (`sheetSchema.ts` + `src/types/sheets.ts`),
`CampaignSettings`/`CampaignMeta` (`src/types/campaign.ts`), or the frontmatter shape
(`src/lib/markdown/frontmatter.ts`) must:
1. **Keep reading pre-change data correctly** — either the existing coercion pattern already
   covers it for free (a genuinely *new, appended* column degrades safely via `sheetSchema.ts`'s
   `str`/`num`/`bool` helpers; a genuinely *new* `CampaignSettings`/`CampaignMeta` field defaults
   via `{ ...DEFAULT_SETTINGS, ...parsed }`/`String(data.x ?? '')`-style coercion) — or, if it
   isn't (a tab that can be *missing entirely*, the #46 case; any column *reordered* or repurposed
   in place, which `rowCodecs`' positional reads cannot detect or default around at all), write a
   real, tested migration/heal step the way `campaignRepo.ts`'s `loadSheetSnapshot` +
   `sheetsApi.ts`'s `addMissingTabs` do for a missing tab.
2. **Ship a fixture proving it**, in `tests/fixtures/backward-compat/` — literal older-shaped
   data (a spreadsheet missing your new tab, a row in the shape it had immediately before your
   column change, a `settings.md`/`campaign.md` predating your new field), asserted against by a
   test in one of the `tests/backward-compat-*.spec.ts` files (`-sheet-tabs`, `-row-shapes`,
   `-frontmatter` — add a new one only if none fits). See that directory's `README.md` for the
   fixture format/conventions and why these fixtures don't need updating as the schema keeps
   growing. This is not optional busywork: it's the only thing standing between "looks right in a
   fresh campaign created by today's code" and "still works for every campaign that already
   exists" — the exact gap #46 fell through. These tests run as part of the standard
   `npm run test:e2e` (no separate/opt-in check), so a schema change that breaks backward
   compatibility fails the same verification loop every PR already goes through.

**Session persistence in an installed Android app (issue #45).** This app has no backend, so
staying signed in across a reopen depends entirely on Google Identity Services' `prompt: ''`
silent token flow piggybacking on the browser's own Google session — no refresh_token grant is
possible for a pure client-side SPA. The project owner confirmed that the app installed to an
Android home screen (a real standalone WebAPK, `display: "standalone"`) forces an interactive
sign-in on *every* reopen, not just after long gaps — pointing at that silent flow failing
specifically in the installed-standalone context. `authStore.ts`'s own module doc comment has the
full, cited research summary (GIS's `prompt: ''` still opens a real popup even when "silent";
browsers gate `window.open()` behind a user gesture, which an automatic silent request never has;
an archived `google-api-javascript-client` issue documents the same gap producing no reliable
callback at all) — none of it verified against a real device, since this environment has no
adb/emulator (same constraint issue #39 documented). Two mitigations follow:
- `SILENT_REFRESH_TIMEOUT_MS` (8s) bounds how long a silent (`prompt: ''`) request will wait before
  treating a request that never calls back as failed, so it can't wedge `authStore.ts`'s
  single-request `tokenQueue` forever (GIS allows only one in-flight `requestAccessToken` per
  client) and block a later explicit "Sign in" click behind it. Known tradeoff, not eliminated: a
  real callback arriving just after the timeout is correctly no-op'd rather than corrupting state,
  but is also discarded — a legitimately slow-but-successful silent refresh can still end up
  showing an unnecessary "session expired" prompt. See the constant's own doc comment.
- `loginHint.ts` (new) captures the signed-in account's email as a `login_hint` for the next
  *interactive* sign-in, so a forced re-login is a single tap instead of a full account picker —
  a mitigation for the friction, not a fix for the underlying silent-restore failure. This needed
  adding `userinfo.email` to `GOOGLE_SCOPES` (`config.ts`), called out there explicitly as
  deliberate scope creep rather than added quietly; that same comment documents an unsettled
  migration edge case for a user with a pre-existing session minted under the old, narrower scopes
  (fails safe either way — see the comment for why).

`src/lib/platform.ts`'s `isInstalledAndroidApp()` (`display-mode: standalone` + an Android user
-agent check) scopes a short in-app note about this known limitation to `AuthGate.tsx`, shown only
in the context that actually has it — mirroring issue #39's precedent of documenting a real,
unfixable platform limitation in-app rather than pretending a partial mitigation is a full fix.

**Reopen: `login_hint` was missing from the automatic paths.** The first fix above (PR #64) didn't
hold up on the project owner's real device: a real, visible `accounts.google.com` account chooser
appeared automatically, before any app UI, listing all six stored accounts unnarrowed, then landed
on the in-app sign-in card. Root cause was a real gap, not the platform limitation itself:
`login_hint` had only ever been wired into the manual `signIn()` button, never into either
*automatic* silent-refresh call site (the startup reauth, `getValidAccessToken`'s refresh) — the
path the reported ordering pointed straight at. Both now source the same `getStoredLoginHint()`.
Also investigated (separately, since the report also described the chooser flickering/refreshing
twice): traced every caller of `requestToken`/`getValidAccessToken` and found no code path where
two silent requests can genuinely race *within one page load* — `AuthGate`'s `'restoring'` gate and
`getValidAccessToken`'s `inFlightRefresh` coalescing already prevent that (regression-tested in
`tests/google-login-hint.spec.ts`). The stronger lead, documented in `authStore.ts`'s module doc
comment rather than fixed here: `src/lib/coiServiceWorker.ts`'s isolation-registration reload and
`isPopupSeveredByIsolation`'s recovery reload can each independently restart this module and its
startup reauth *within one cold start*, and both reload guards are `sessionStorage`-scoped —
plausible to reset on an Android WebAPK's full close+reopen the same way `localStorage` is already
confirmed not to (see `SESSION_STORAGE_KEY`'s own comment for that exact lesson learned once
already). Not fixed here: making that durable across app closes (e.g. moving those keys to
`localStorage`) would permanently trade away Kokoro's multi-threaded speed the first time a popup
gets severed — a real product tradeoff needing its own scoped decision, not a mechanical bug fix.
The project owner still needs to confirm on their real installed app whether the extended
`login_hint` fix narrows the chooser and whether the flicker actually stops.

### State management

- **`src/store/libraryStore.ts`** (Zustand) — the campaign *library*: root folder bootstrap,
  campaign list, campaign creation. Global, one instance for the whole app.
- **`src/hooks/useCampaign.ts`** (plain `useState`/`useCallback`, not Zustand) — per-campaign
  session data (campaign file, settings, sheet snapshot, rolling summary, recent turns) plus the
  turn-submission flow. Scoped to whichever campaign is currently open; re-created whenever
  `folderId` changes.
- **`authStore.ts`** (Zustand) — Google auth/token state, read by anything calling Drive/Sheets.

Local state everywhere is a cache with optimistic writes reconciled against API responses — Drive
and Sheets are the actual source of truth, not the in-memory store.

### Routing / pages

`src/App.tsx` wires `react-router` routes, each backed by one page in `src/pages/`:
`/` → Dashboard (campaign list), `/new` → NewCampaign (setup wizard), `/play/:campaignId` → Play
(the turn loop UI), `/codex/:campaignId` → Codex (mostly read-only tabs over sheet data —
Inventory, Stats/Skills, NPCs, Monsters, Lore, Timeline/Quests; the NPCs tab's voice override,
issue #100 below, is the one write path), `/settings` and `/settings/:campaignId` →
Settings (AI mode/model/provider/voice settings are global — issue #77; `/settings/:campaignId`
only adds a small per-campaign summarization-cadence card on top). `AuthGate`
(`src/components/AuthGate.tsx`) wraps the whole app shell and gates everything on Google sign-in
state.

### Voice (Phase 2: browser and on-device Kokoro)

`src/lib/voice/types.ts` defines the swappable `SttProvider`/`TtsProvider` interfaces from
DESIGN.md §8 — the same "drop in another implementation with zero changes to the rest of the app"
philosophy as the AI backend. Two implementations exist (Kokoro is TTS-only); an ElevenLabs
STT/TTS implementation existed briefly but was removed outright (issue #97) rather than left as a
second TTS stack that could never grow per-speaker voices, per the multi-voice narration
initiative (epic #36) — see "Removing ElevenLabs" below for the backward-compatibility work that
took:

- **`browser`** (`browserStt.ts`, `browserTts.ts`) — Web Speech API, zero config. `SpeechRecognition`
  isn't in TypeScript's DOM lib (Safari-only-prefixed, non-standard enough that TS hasn't added
  it) — ambient-typed in `speech-recognition-types.d.ts`, same pattern as `gis-types.d.ts` for
  Google Identity Services. STT gives live interim results; recognition auto-ends after one
  utterance (`continuous = false`).
- **`huggingface-local`** (`kokoroTts.ts`) — TTS only, via `kokoro-js`: a small on-device model, no
  key and no server, run over **WASM rather than WebGPU**, so unlike the local text models
  there's no hard support gate. Dynamically imported (it bundles its own ONNX runtime). Read the
  caching caveat at the top of that file before touching it: `kokoro-js` depends on
  `@huggingface/transformers` **v3**, a different major than this app's v4, so npm installs two
  copies with two separate `env` objects — the IndexedDB cache and resumable fetch installed on
  *our* env (see `localModelCache.ts` / `localModelResumableFetch.ts`) do **not** apply to Kokoro,
  and `kokoro-js` exposes only `wasmPaths` from its copy's env, so it can't be redirected without a
  fragile deep import. Kokoro therefore uses Cache Storage, which needs a secure context: fine on
  HTTPS/localhost, but on a plain-HTTP LAN address it re-downloads per page load (it degrades
  rather than failing, because `useBrowserCache` computes to `false` when `caches` is absent).
  Settings surfaces that caveat inline instead of hiding it. **Never pass a whole turn's narrative
  to `KokoroTTS.generate()` directly**: it tokenizes with `truncation: true` against a 512-token
  context (510 usable phoneme tokens — the hardcoded `509` style-vector cap in its
  `generate_from_ids` is the same limit), so longer text is cut off mid-sentence with **no error at
  all**. `splitIntoSpeakableChunks` splits per sentence first (and word-splits any single sentence
  still over budget); `speak()` then generates one chunk ahead of playback so sentence boundaries
  don't stall. This also avoids `KokoroTTS.stream()`, which builds a `TextSplitterStream` but never
  `close()`s it, so its async iterator blocks forever.

  **Streaming playback (issue #62).** Real turn narration plays continuously as it generates:
  playback starts as soon as the first chunks are ready (originally chunk 1 alone; see issue #68
  below for why that became a small buffer), while `kokoroTts.worker.ts` keeps generating chunks
  beyond the buffer in the background — not (as originally shipped, issue #44) waiting for the
  whole turn to generate and stitching one continuous clip before any audio plays at all. The
  worker streams each chunk's *raw* PCM samples back the moment it's done (`speakStream`/`chunkAudio` in
  `kokoroWorkerProtocol.ts`); `kokoroTts.ts`'s playback engine schedules them on a Web Audio API
  `AudioContext` with `AudioBufferSourceNode`s timed back-to-back (sample-accurate, unlike
  sequential `<audio>` elements, which reliably gap) rather than waiting to build one `<audio>`-
  playable blob. `generateKokoroPreview()` (Settings' short, fixed voice-preview clip) still uses
  the original non-streaming `'speak'` request — nothing to gain from streaming one short clip.
  Because chunks can now be scheduled while more are still generating, `kokoroTts.ts`'s `speak()`
  tracks `nextExpectedChunkIndex` to drop a chunk resent by the WebGPU-fallback restart below if
  it's already been scheduled once — see that file's doc comment ("De-duplication after a
  WebGPU-fallback restart") for why a worker-side restart-from-0 is still safe against replaying
  audio the player already heard. See `kokoroTts.ts`'s and `kokoroTts.worker.ts`'s module doc
  comments for the full design, including what's verified in this sandbox (real Web Audio API
  playback, confirmed to work headlessly here despite no real audio hardware) versus what isn't
  (real-device audio-hardware gaplessness, and background-tab-freeze behavior).

  **Multi-voice playback (issue #66).** A turn genuinely switches Kokoro voices at dialogue
  boundaries now — narrator, player character, and each speaking NPC — closing out epic #36's
  multi-voice-narration initiative that #96 (speaker-attributed `{{v:Name}}` segments) and #98
  (a cast `voiceId` per character) laid the groundwork for. `kokoroWorkerProtocol.ts`'s
  `speak`/`speakStream` requests carry `chunks: KokoroWorkerChunk[]` — each with its own resolved
  `voice`/`speed` — instead of one job-wide voice; `kokoroTts.worker.ts`'s `generateChunks` resolves
  each chunk's own voice independently, so the WebGPU-fallback restart above (which resends the same
  `chunks` array unchanged) always regenerates a chunk with the exact voice/speed it had the first
  time — no extra bookkeeping needed, since the restart-reproducibility requirement falls out of
  chunk *identity* rather than anything voice-specific. `TtsProvider.speak` (`src/lib/voice/types.ts`)
  gained an additive `segments`/`narratorVoice` option (`TtsSpeakSegment[]`) alongside its original
  flat `text`/`voice` — the `browser` provider ignores both and keeps reading one flat string in one
  voice, exactly as before. `src/lib/voice/resolveSegmentVoices.ts` (pure, unit-tested directly) is
  where a `SpokenSegment[]` actually becomes concrete voices: `speaker: null` → the narrator's
  `GlobalSettings.kokoroVoiceId`; the player's own name → `CampaignSettings.playerVoiceId`; a known
  NPC's name → that NPC's `voiceId`; anything else (issue #105's caveat — an AI name paraphrase can
  leave a `{{v:Name}}` token with no matching NPC row) degrades to the narrator's voice rather than
  throwing or dropping that segment's audio. `Play.tsx` calls this from `speakText`, which now
  threads a turn's `SpokenSegment[]` (`turnBlocks.ts`'s `buildSpokenSegments`) through alongside the
  flat script every call site already built. Narration speaks at `KOKORO_NARRATION_SPEED` and
  dialogue at `KOKORO_DIALOGUE_SPEED` (`kokoroConstants.ts`, both close to Kokoro's own default of
  1 — deliberately a narrow band, unverified by ear in this sandbox, pending the project owner's real
  listen test); `kokoroTts.ts`'s `speak()` also inserts a pause (`KOKORO_ENTER_DIALOGUE_PAUSE_SEC`/
  `KOKORO_EXIT_DIALOGUE_PAUSE_SEC`, asymmetric per finding 8's "longer beat entering dialogue"
  suggestion) whenever a scheduled chunk's voice differs from the previous one — pure arithmetic on
  the existing `nextStartTime` playback cursor, no extra model call. `contract.ts` also gained a
  short punctuation-pacing note (em dashes/ellipses genuinely change Kokoro's delivery, verified
  against the installed package's phonemizer — a free lever needing no code). A first-use voice is a
  separate ~510KB download kokoro-js fetches lazily inside `generate_from_ids` — `doSpeakStream`
  now kicks off a best-effort `prefetchVoices` (warming the same `kokoro-voices` Cache Storage
  bucket kokoro-js's own fetch reads from) for every distinct voice a turn's `chunks` need, in
  parallel with the model load, reported through `describeKokoroVoicePrefetchProgress` via the same
  `voiceLoadMessage` status line the model-download/generation progress already use — narrowing,
  not eliminating, the "falling behind" stall risk a new character's first line introduces.

  **Startup playback buffer (issue #68, reconciled onto the multi-voice chunk model above).**
  Reported playback artifacts led to investigating "falling behind" more concretely: real (unfaked)
  Kokoro CPU inference (kokoro-js's Node build on `onnxruntime-node`'s `cpu` device — a documented
  conservative lower bound on real in-browser WASM cost, not literally WASM) found every generated
  chunk already has a clean, near-silent taper at both ends with no real discontinuity at a chunk
  boundary — ruling out an in-model boundary defect — while generation speed relative to each
  chunk's own playback duration measured inconsistently across three separate real-CPU-inference
  runs on three different (shared, noisy) sandboxes over this issue's history, two of the three
  landing clearly on the *slower*-than-real-time side (see `kokoroConstants.ts`'s
  `KOKORO_PLAYBACK_BUFFER_CHUNKS` doc comment for all three figures). `speak()` now buffers the
  first `KOKORO_PLAYBACK_BUFFER_CHUNKS` (2) generated-but-not-yet-scheduled chunks before starting
  playback, instead of scheduling chunk 0 the instant it arrives, so generation gets a real head
  start over playback before the race begins; a turn with fewer chunks than the buffer still plays
  as soon as it's fully ready (`bufferTarget = min(KOKORO_PLAYBACK_BUFFER_CHUNKS, chunks.length)` —
  `chunks.length` is known up front, so no message round trip is needed to learn a short turn will
  never fill the buffer), and a generation failure before the buffer ever fills still flushes and
  plays whatever chunks did complete rather than discarding them. This was originally written
  (PR #79) against a flat, single-voice chunk model that predates #66's per-chunk voice/pause
  model above, and was **not** ported onto the current architecture mechanically — three
  interactions were re-derived and verified directly (`tests/kokoro-streaming-playback.spec.ts`):
  de-duplication (`nextExpectedChunkIndex`) still happens strictly at chunk *arrival*, before any
  buffering decision, so a chunk still sitting unscheduled in the buffer when a WebGPU-fallback
  restart resends it is dropped exactly like an already-scheduled one, and the
  restart-reproducibility guarantee (a resent chunk regenerates with the same voice/speed) still
  comes from chunk *identity* in the resent array, unaffected by whether a chunk happened to be
  buffered; a voice change spanning the buffer (e.g. chunk 0 narrator, chunk 1 the first NPC line)
  still gets `pauseForVoiceChange`'s pause inserted correctly, because pause computation runs at
  *schedule* time (inside `scheduleChunk`, sequentially, when the buffer flushes) rather than at
  arrival time; and a voice-change pause between two buffered chunks only *adds* to generation's
  real-time margin before the chunk after them is needed, so buffering and pausing compound in the
  same helpful direction rather than working against each other. Also true, and worth stating
  plainly rather than glossing over: a device on which generation runs *chronically* slower than
  real-time (not just momentarily, on the zero-margin first chunk) still falls behind eventually no
  matter how large this buffer is — buffering narrows the exposure window, it doesn't change the
  underlying generation-vs-playback race for a device that genuinely can't keep up. What it
  reliably fixes is the zero-margin-on-chunk-0 case, which is strictly worse than any buffer ≥2
  regardless of a given device's steady-state ratio. Same caveat every other Kokoro audio-quality
  question in this file already carries: whether this actually resolves what a real listener hears
  needs the project owner's own device/ears to confirm.

  **Cross-origin isolation for multi-threaded WASM.** ONNX Runtime Web's WASM backend (what
  `kokoroTts.worker.ts` runs on) can use `SharedArrayBuffer` to run multi-threaded, which speeds up
  both session init and inference — but only when the page is cross-origin isolated (`COOP:
  same-origin` + `COEP: require-corp`/`credentialless`), which GitHub Pages can't set as response
  headers (static hosting only). `public/coi-serviceworker.js` + `src/lib/coiServiceWorker.ts`
  shim this client-side (the well-known `coi-serviceworker` pattern): the worker rewrites its own
  same-origin responses to add those headers, and `ensureCrossOriginIsolated()` (called once from
  `main.tsx`) registers it and reloads exactly once to pick that up, guarded by `sessionStorage` so
  an environment that can't achieve isolation degrades to "stays single-threaded" rather than
  reload-looping. This is the **only** service worker the app registers (see DESIGN.md's PWA line —
  offline/install support, if it's ever added, should extend this worker's fetch handler, not
  register a second one) and needs no server-side change: ONNX Runtime Web's own WASM env
  auto-detects `self.crossOriginIsolated` and switches thread count on its own (confirmed by
  reading the installed `kokoro-js`'s bundled `@huggingface/transformers` v3 source, not assumed —
  `env.wasmPaths` is the *only* thing that copy's exported `env` shim exposes, same limitation the
  paragraph above already documents, but thread-count detection doesn't go through that shim at
  all).

  Cross-origin isolation has a real, confirmed cost: `COOP: same-origin` breaks Google Identity
  Services' popup-based OAuth flow. Verified by reading GIS's own unminified `gsi/client.js` source
  (not assumed) and confirmed empirically in real Chromium with a synthetic two-origin
  popup+`postMessage` test: both interactive sign-in and background silent token refresh
  (`authStore.ts`) open a popup via `window.open()` whose *own* script relays the result back via
  `window.opener.postMessage(...)` — and `COOP: same-origin` sets that popup's `window.opener` to
  `null`, so the message never arrives. GIS's separate "was the popup closed before finishing"
  detection (unaffected by COOP — it only reads `.closed` on *our* reference to the popup, never
  the popup's own `opener`) then reports the ordinary-looking error `'popup_closed'`, indistinguishable
  from the user actually closing it. Swapping `COEP` to `credentialless` does **not** help — this is
  entirely a `COOP` effect, confirmed the same way. `authStore.ts`'s `isPopupSeveredByIsolation`
  recognizes this one error id specifically (`'popup_closed'` while `window.crossOriginIsolated`),
  at every popup call site (interactive `signIn`, `getValidAccessToken`'s silent refresh, and the
  startup silent-reauth), and calls `disableCrossOriginIsolationAndReload()` instead of surfacing
  an ordinary auth failure — unregistering the worker, marking isolation disabled for the rest of
  this tab session (`sessionStorage`, checked by `ensureCrossOriginIsolated()` on every later
  call so an ordinary reload or PWA relaunch after recovery doesn't immediately re-isolate and
  re-break the next popup — found missing, and fixed, in independent review), and reloading so
  sign-in can be retried unisolated instead of failing the same way forever within that session
  (this app's access tokens are short-lived, so leaving this undetected would eventually break
  every long play session's background token refresh, not just an explicit sign-in click). A
  fresh tab/session still retries isolation from scratch, so this is a bounded, per-session
  opt-out rather than a permanent one.

  For local testing, `vite.config.ts`'s dev/preview servers can set the same headers natively when
  `VITE_COI_HEADERS=1` is set (off by default, so the normal dev/test workflow matches today's
  non-isolated baseline) — this is a faithful stand-in for the deployed, worker-isolated site
  without the register-then-reload dance. `tests/coi-service-worker.spec.ts` covers both the
  worker's own register → isolate → still-usable-app flow (needs `serviceWorkers: 'allow'`, an
  override from this suite's default-`'block'` — see `playwright.config.ts`'s comment on why
  service workers are blocked everywhere else) and the sign-in recovery path.

  **Opt-in WebGPU backend.** Kokoro also has a selectable WebGPU backend now (issue #51),
  layered on top of the cross-origin-isolated multi-threaded WASM above rather than replacing it:
  default stays `wasm` (`kokoroConstants.ts`'s `KokoroDevice`), preserving the no-hard-gate
  guarantee this section opened with — WebGPU is a better-when-available opt-in, picked per device
  in Settings' "Kokoro voice model" card ("Run on: CPU / GPU"), mirroring the local text models'
  identical toggle (`localModel.ts`'s `getLocalModelDevice`/`setLocalModelDevice`) but as a single
  global preference rather than one keyed by model id — Kokoro is exactly one model, unlike the
  text-model catalog. `kokoroTts.worker.ts`'s `loadWithFallback`/`doSpeak` mirror
  `localModel.worker.ts`'s device-lost-mid-generation fallback: WebGPU failing to load at all (no
  adapter) or losing the device mid-turn both fall back to WASM once, restarting the *whole* turn's
  chunks there rather than resuming — the failed chunk is retried too, not skipped — and the
  fallback is remembered (`localStorage`, reset by "Remove") so a device that can't sustain WebGPU
  doesn't rediscover that the expensive way on every turn. `tests/kokoro-webgpu-backend.spec.ts`
  covers both fallback paths against a fake `kokoro-js` that can simulate either failure on demand
  (see `tests/mocks/kokoro.ts`'s `failWebgpuLoad`/`failWebgpuGenerate`).

  **Dtype-on-WebGPU finding.** `kokoro-js`'s README recommends `dtype: 'fp32'` for `device:
  'webgpu'` — 326 MB, versus the WASM path's 92.4 MB `q8` (`model_quantized.onnx`). Before
  accepting that 3.5x download increase at face value, the two smaller quantized candidates on
  `onnx-community/Kokoro-82M-v1.0-ONNX` were checked against the *installed* kokoro-js@1.2.1 (its
  own bundled `@huggingface/transformers` **v3.8.1**, a separate copy from this app's own v4 — see
  the caching-caveat paragraph above): `q8f16` (86 MB) is not a valid dtype **at all** in this
  version — its `DATA_TYPES` table (`utils/dtypes.js`) has no `q8f16` entry, and the shared
  `getSession()` every `from_pretrained()` call goes through (confirmed for
  `StyleTextToSpeech2Model`, kokoro-js's own model class, not assumed) throws `Invalid dtype:
  q8f16...` for anything not in that table — this rules it out by code inspection, not a quality
  judgment. `q4f16` (155 MB) *is* valid, and is exactly what this app's local text models already
  request for their own WebGPU path (`LOCAL_MODEL_GPU_DTYPE`) — a real precedent for this dtype on
  this onnxruntime-web/transformers stack, but for a text decoder's logits, not a vocoder's raw
  waveform — quantization artifacts are a different failure mode for audio, so that precedent
  doesn't settle whether `q4f16` *sounds* fine here. A real listen test was the plan, but this
  environment has no WebGPU available to run it: headless Chromium here reports `navigator.gpu` as
  `undefined` regardless of `--enable-unsafe-webgpu`, `--enable-unsafe-swiftshader`,
  `--use-angle=swiftshader`, `--ignore-gpu-blocklist`, or Vulkan-backend variants — the container
  has no `/dev/dri` GPU device nodes at all, confirmed by checking for them directly, one step
  further than the "headless Chromium crashes on large WASM/WebGPU payloads" limitation the
  cross-origin-isolation work above hit (there, a context existed to attempt generation in; here,
  no WebGPU context can be obtained in the first place). Given that — "don't just guess" — this
  ships `fp32` (`KOKORO_WEBGPU_DTYPE` in `kokoroConstants.ts`) as the safe default, deferring to
  kokoro-js's own tested README recommendation rather than shipping an unverified-for-audio
  quantization. `q4f16` is left documented as the next thing to verify on real WebGPU hardware —
  swap that one constant if a real listen test confirms it holds up; it would be a strict win
  (155 MB vs 326 MB, still faster than WASM).

`getProvider.ts` resolves a `GlobalSettings` provider choice to an implementation, plus
`isSttProviderAvailable`/`isTtsProviderAvailable` for gating UI before an API key is even needed
(missing-key errors surface later, as a toast, when actually used — not by hiding controls, since
the user picked that provider on purpose). Consumed from `Play.tsx`: a mic button feeds
`SttProvider.onResult` into the free-text box, and the header's "read aloud" toggle speaks each
newly-applied turn's narrative via `TtsProvider.speak`, tracked with a `spokenTurnRef` so resuming
a campaign never narrates history and turning the toggle on mid-session only narrates turns from
that point forward. Each turn also has its own play/stop button for replaying it on demand — note
that `Play.tsx` caches **one provider instance per provider kind** (`ttsProviderRef`) rather than
calling `getTtsProvider` per playback: Kokoro tracks its currently-playing `Audio` per instance, so
a fresh instance per call would leave `stop()` unable to reach audio an earlier instance started.

**Removing ElevenLabs (issue #97).** The project owner decided the app would not use ElevenLabs
going forward — part of the multi-voice narration initiative (epic #36), where Kokoro becomes the
only non-browser voice provider so there's one voice stack to grow per-speaker voices on, not two.
Deleted outright: `elevenLabsTts.ts`, `elevenLabsStt.ts`, `elevenLabsKey.ts`, `elevenLabsVoices.ts`,
the `'elevenlabs'` branches in `getProvider.ts`, `GlobalSettings.elevenLabsVoiceId`, and all of
Settings' API-key field/voice picker/provider options for it. The load-bearing part, per this
file's Google Drive/Sheets backward-compatibility rule above, is complicated by issue #77 landing
*before* this removal: `sttProvider`/`ttsProvider`/voice-ID choices no longer live in
`CampaignSettings`/`settings.md` at all, they live in the global, `localStorage`-backed
`GlobalSettings` (`src/lib/settings/globalSettings.ts`) — so removing an enum value already live in
a user's *stored data* means covering two distinct legacy shapes, not one:

- A `settings.md` from **before #77** can still have `sttProvider: elevenlabs`/
  `ttsProvider: elevenlabs`/`elevenLabsVoiceId` sitting in its frontmatter. This turns out to be
  safe for free: `globalSettings.ts`'s `pickLegacyGlobalFields` (the one-time migration
  `seedGlobalSettingsFromLegacyIfNeeded` runs against that frontmatter) validates every field with
  `isOneOf` against the CURRENT `STT_PROVIDERS`/`TTS_PROVIDERS` unions — an `'elevenlabs'` value
  simply fails that check and is skipped, exactly like any other unrecognized or missing value,
  and `DEFAULT_GLOBAL_SETTINGS` fills in (`'browser'` STT, `'browser'` TTS). No code change was
  needed here beyond narrowing the unions themselves; a stale `elevenLabsVoiceId` key in the old
  frontmatter is left alone — it isn't part of `GlobalSettings` any more, so it's just an inert
  extra property.
- A real `adventure:global-settings` `localStorage` blob written by a build **after #77 but before
  #97** is the gap #77 actually introduced: `getGlobalSettings()`'s
  `{ ...DEFAULT_GLOBAL_SETTINGS, ...parsed }` merge only fills in *missing* keys, so a *present*
  `sttProvider`/`ttsProvider: elevenlabs` in that blob survives the merge completely untouched —
  without a fix, such a player would open the app to `getSttProvider`/`getTtsProvider` silently
  resolving `null` forever (the mic button and read-aloud toggle just vanish). `globalSettings.ts`
  now runs a real coercion step (`coerceLegacyVoiceProviders`) at the end of `getGlobalSettings()`:
  any `sttProvider`/`ttsProvider` value outside the current unions falls back to
  `DEFAULT_GLOBAL_SETTINGS`' value for that field.

Covered by tests in `tests/backward-compat-frontmatter.spec.ts` (the pre-#77 settings.md case,
reusing `PRE_GLOBAL_SETTINGS_SETTINGS_MD` — already ElevenLabs-shaped since it predates issue #77
too) and `tests/global-settings.spec.ts` (the post-#77-pre-#97 stored-blob case, seeding
`localStorage` directly). The orphaned ElevenLabs API key already sitting in some players'
`localStorage` (from the now-deleted `elevenLabsKey.ts`) is left alone rather than purged —
simplest, and harmless, since nothing reads that storage key any more.

Both kinds of on-device model (the local text models, Kokoro for voice) expose the same download-management
surface — `preload*`/`has*Downloaded*`/`remove*` plus a progress callback formatted through
`src/lib/modelDownloadProgress.ts` — which Settings renders as matching "download now" /
progress-bar / "remove downloaded model" cards.

### UI stack

Tailwind CSS v4 + shadcn/ui (`src/components/ui/*`, style `radix-nova`, see `components.json` for
aliases/config — regenerate/add components with the shadcn CLI rather than hand-rolling
primitives). Path alias `@/*` → `src/*` (configured in both `vite.config.ts` and
`tsconfig.app.json` — keep in sync if it ever changes). `src/components/ui/toast.tsx`'s hand-rolled
`toast.success`/`toast.error` (issue #95, replacing the `sonner` npm package) for toasts
(validation errors surface this way per `DESIGN.md` §5).

**Migrating to daisyUI (issue #28).** Phase 1 (additive/isolated) added the daisyUI Tailwind v4
plugin to `src/index.css` (two custom themes, `adventure-light`/`adventure-dark`, hand-derived from
the existing shadcn palette) and a Storybook-only review surface, `src/components/daisyui-preview/`.
Phase 2 replaces real `src/components/ui/*` primitives one tier at a time; tier 1 (issue #91,
`badge`/`separator`/`label`), tier 2 (issue #93, `button`/`card`/`input`/`textarea`/`progress`), and
tier 3 (issue #95, `collapsible`/`scroll-area`/`sonner`) are done — every other primitive listed
above (Select, Dialog, DropdownMenu, Tabs) still renders shadcn/ui + Radix, unchanged. `src/index.css`
also carries the bridge making daisyUI's own color tokens track this app's real `.dark`/`.light`
toggle (not just `data-theme`, which nothing in the real app sets) and a scoped fix for a real
`--border` name collision between the two systems, now extended to `.btn`/`.input`/`.textarea`/
`.alert` alongside `.badge` (`.card`/`.progress`/`.toast` don't need it — see `src/index.css`'s
comment) — see DESIGN.md §3's tier entries for the full story before migrating any later tier that
touches a daisyUI class reading `--border` as a length. Tier 2 also confirmed `Button`'s
`asChild`/`Slot` composition inside still-Radix `Dialog`/`DropdownMenu` survives the class-only
rewrite unaffected (verified empirically, not just reasoned about) and dropped Radix's `Progress`
primitive entirely in favor of a native `<progress>` element, since it was never providing more
than ARIA plumbing a native element gets for free. Tier 3 dropped two more Radix primitives the
same way (`Collapsible`, `ScrollArea` — both were pure ARIA/visual plumbing over state/behavior the
app already owned or native scrolling already provides) and replaced `sonner` entirely with a
hand-rolled `toast.success`/`toast.error` on daisyUI's `.toast`/`.alert` classes
(`src/components/ui/toast.tsx`) — the first tier to hand-roll actual *state* (toast stacking/
auto-dismiss) rather than just markup, which introduced a real bug class tiers 1–2 never hit (see
DESIGN.md §3's tier 3 entry: module-level singleton state leaking between Storybook stories that
each mount a fresh component instance, fixed by resetting the store on every `Toaster` mount).
See DESIGN.md's "UI stack migration" section (§3) for the full data-theme-vs-`.dark`/`.light`
coexistence decision and the proposed Phase 2 component-by-component migration order.

### Genre-agnostic by design

Nothing in the data model is hard-coded to D&D fields — Character stats are a free-form key/value
list, difficulty is a prompt-level instruction rather than a hidden dice engine, and the same
schema is meant to work for any genre/tone. Don't add fixed RPG-specific fields (HP, STR/DEX,
etc.) to types or sheet schemas; those belong in user-entered Character rows, not the type system.
