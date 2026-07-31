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
  runtime), pulled in via dynamic `import()` so it's a separate chunk fetched only when a player
  actually uses local mode, not part of the main app bundle.
- `npm run lint` — oxlint (config in `.oxlintrc.json`)
- `npm run preview` — preview the production build locally
- `npm run test:e2e` — Playwright end-to-end tests (`playwright.config.ts`, specs in `tests/`).
  Starts its own dev server on port 5183 with a dummy `VITE_GOOGLE_CLIENT_ID`; every Drive/Sheets
  API call is intercepted by `tests/mocks/googleApi.ts` (an in-memory fake backend) and a fake
  session is seeded into `localStorage` before each test, so no real Google account or network
  access is needed. Run a single file with `npx playwright test tests/new-campaign.spec.ts`, or
  `--headed`/`--debug` while writing new specs.

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
  equivalent for running a model locally. It's **dynamically imported** inside `loadModel()`, not
  statically at the top of the file, so its ~500KB JS chunk and the ONNX WebAssembly runtime it
  pulls in only ever load for players who actually pick local mode. `isLocalModelSupported()`
  checks `navigator.gpu` — note this is *feature detection only*: modern Chromium reports
  `navigator.gpu` as present even where a real GPU adapter can't be obtained (verified while
  writing tests for this — see `tests/ai-local-mode.spec.ts`), so genuine failures (no adapter,
  model download failure, OOM on a low-end phone) surface at generation time via the same
  try/catch as the API path, not via this check. Model loading state (`loadPromise`/`isReady`/
  download progress/listeners) is keyed per model ID in a module-level `Map`, not one shared
  singleton — several models can each have their own in-flight load or cached download at once,
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

`src/App.tsx` wires `react-router-dom` routes, each backed by one page in `src/pages/`:
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
