# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A solo, audiobook-style AI-narrated adventure game. Client-only React + TypeScript SPA — **no
server, no database**. All game state lives in a Google Drive folder the user owns: Markdown
files for prose, one Google Sheet per campaign for everything tabular. See `DESIGN.md` for the
full architecture/data model/rationale and `README.md` for setup. Read `DESIGN.md` before making
any structural change — it's the source of truth for the data model and turn contract, and is
kept in sync with the implementation.

Phase 1 (MVP, implemented): campaign setup wizard, manual copy/paste DM turn loop, deterministic
state validator, Codex/Dashboard/Settings screens. Phase 2 is in progress: voice is implemented
for all three TTS providers (browser, ElevenLabs, and on-device Kokoro) and both STT providers
(browser, ElevenLabs); the map graph view is the only remaining stub. Phase 3's direct AI mode is
implemented with two options alongside manual copy/paste (which still works, as the no-setup
fallback): the Claude API, and a choice of several fully on-device models over WebGPU — see
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
  scrolls sideways at phone width. It hides the Sonner toast layer via `addInitScript`, because
  toasts pin to the bottom of the viewport and on a phone-width screen genuinely sit over Play's
  input row and intercept clicks meant for it.
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

### Direct AI mode (Phase 3: Claude API + local on-device models)

`CampaignSettings.aiMode` (`'manual' | 'api' | 'local'`) picks how stage 1's prompt reaches an
actual AI reply.

- **`'api'`** — `src/lib/ai/claudeProvider.ts`'s `generateClaudeReply(prompt, model)` calls
  `POST https://api.anthropic.com/v1/messages` with a plain `fetch` — no `@anthropic-ai/sdk`
  dependency, matching this repo's established thin-fetch-client convention (same as
  `driveApi.ts`/`sheetsApi.ts` and the ElevenLabs voice providers) and DESIGN.md §11's explicit "no
  build-time dependency on any AI vendor SDK" call. Calling the Messages API directly from a
  browser needs the `anthropic-dangerous-direct-browser-access: true` header (undocumented in
  Anthropic's official reference at time of writing; verified against the SDK's own source and
  community reporting) — without it the request is blocked as cross-origin. The API key
  (`src/lib/ai/claudeKey.ts`) is `localStorage`-only, same reasoning as `elevenLabsKey.ts`; the
  model choice (`CampaignSettings.claudeModel`, one of `CLAUDE_MODELS`, default `claude-sonnet-5`)
  is per-campaign like `elevenLabsVoiceId`.
- **`'local'`** — `src/lib/ai/localModel.ts`'s `generateLocalReply(modelId, prompt, opts)` runs one
  of several small instruction-tuned models entirely in-browser via `@huggingface/transformers`
  over WebGPU — no key, no server. `LOCAL_MODELS` is the catalog (Hugging Face repo ID → display
  label, approximate download size, and whether it needs a real multimodal `AutoProcessor`), picked
  per-campaign via `CampaignSettings.localModelId` (default `onnx-community/gemma-3-1b-it-ONNX`)
  and shown with sizes in Settings' model dropdown. They range from ~490MB (Qwen2.5 0.5B) to ~3GB
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
  every tab (Character, Inventory, Skills, NPCs, Monsters, Timeline, Quests, Map, Lore); adding a
  tab means updating `SHEET_TABS`, `TAB_HEADERS`, `rowCodecs`, and the `loadSheetSnapshot` /
  `SheetSnapshot` type together.
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
(the turn loop UI), `/codex/:campaignId` → Codex (read-only tabs over sheet data — Inventory,
Stats/Skills, NPCs, Monsters, Lore, Timeline/Quests), `/settings` and `/settings/:campaignId` →
Settings (global + per-campaign). `AuthGate` (`src/components/AuthGate.tsx`) wraps the whole app
shell and gates everything on Google sign-in state.

### Voice (Phase 2: browser, ElevenLabs, and on-device Kokoro)

`src/lib/voice/types.ts` defines the swappable `SttProvider`/`TtsProvider` interfaces from
DESIGN.md §8 — the same "drop in another implementation with zero changes to the rest of the app"
philosophy as the AI backend. Three implementations exist (Kokoro is TTS-only):

- **`browser`** (`browserStt.ts`, `browserTts.ts`) — Web Speech API, zero config. `SpeechRecognition`
  isn't in TypeScript's DOM lib (Safari-only-prefixed, non-standard enough that TS hasn't added
  it) — ambient-typed in `speech-recognition-types.d.ts`, same pattern as `gis-types.d.ts` for
  Google Identity Services. STT gives live interim results; recognition auto-ends after one
  utterance (`continuous = false`).
- **`elevenlabs`** (`elevenLabsStt.ts`, `elevenLabsTts.ts`) — needs an API key, stored via
  `elevenLabsKey.ts` in `localStorage` only (never written to Drive/settings.md — see the comment
  there for why this is `localStorage` and Google's OAuth token in `authStore.ts` is
  localStorage too, for a different reason — see that file). TTS is one `fetch` + `Audio` playback. STT is fundamentally different
  from browser STT: no live transcript, it records the whole utterance via `getUserMedia` +
  `MediaRecorder` and only transcribes (one HTTP upload) once `stop()` is called — so unlike
  browser STT, the user must click the mic button again to end recording. A campaign's voice
  (`CampaignSettings.elevenLabsVoiceId`) is optional and per-campaign (settings.md), separate from
  the API key (global, localStorage).
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
  playback of chunk 1 starts as soon as it's ready, while `kokoroTts.worker.ts` keeps generating
  chunks 2+ in the background — not (as originally shipped, issue #44) waiting for the whole turn to
  generate and stitching one continuous clip before any audio plays at all. The worker streams each
  chunk's *raw* PCM samples back the moment it's done (`speakStream`/`chunkAudio` in
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

`getProvider.ts` resolves a `CampaignSettings` provider choice to an implementation, plus
`isSttProviderAvailable`/`isTtsProviderAvailable` for gating UI before an API key is even needed
(missing-key errors surface later, as a toast, when actually used — not by hiding controls, since
the user picked that provider on purpose). Consumed from `Play.tsx`: a mic button feeds
`SttProvider.onResult` into the free-text box, and the header's "read aloud" toggle speaks each
newly-applied turn's narrative via `TtsProvider.speak`, tracked with a `spokenTurnRef` so resuming
a campaign never narrates history and turning the toggle on mid-session only narrates turns from
that point forward. Each turn also has its own play/stop button for replaying it on demand — note
that `Play.tsx` caches **one provider instance per provider kind** (`ttsProviderRef`) rather than
calling `getTtsProvider` per playback: ElevenLabs and Kokoro track their currently-playing `Audio`
per instance, so a fresh instance per call would leave `stop()` unable to reach audio an earlier
instance started.

Both kinds of on-device model (the local text models, Kokoro for voice) expose the same download-management
surface — `preload*`/`has*Downloaded*`/`remove*` plus a progress callback formatted through
`src/lib/modelDownloadProgress.ts` — which Settings renders as matching "download now" /
progress-bar / "remove downloaded model" cards.

### UI stack

Tailwind CSS v4 + shadcn/ui (`src/components/ui/*`, style `radix-nova`, see `components.json` for
aliases/config — regenerate/add components with the shadcn CLI rather than hand-rolling
primitives). Path alias `@/*` → `src/*` (configured in both `vite.config.ts` and
`tsconfig.app.json` — keep in sync if it ever changes). Sonner for toasts (validation errors
surface this way per `DESIGN.md` §5).

### Genre-agnostic by design

Nothing in the data model is hard-coded to D&D fields — Character stats are a free-form key/value
list, difficulty is a prompt-level instruction rather than a hidden dice engine, and the same
schema is meant to work for any genre/tone. Don't add fixed RPG-specific fields (HP, STR/DEX,
etc.) to types or sheet schemas; those belong in user-entered Character rows, not the type system.
