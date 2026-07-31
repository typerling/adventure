# Adventure

A solo, audiobook-style AI-narrated adventure game. See [DESIGN.md](./DESIGN.md) for the full
architecture, data model, and rationale. This is a client-only React + TypeScript SPA — all game
state lives in a Google Drive folder you own (Markdown files for prose, Google Sheets for
everything tabular), with no server or database of its own.

## Status

Phase 1 (MVP) is implemented: campaign setup wizard, the manual copy/paste DM turn loop, the
deterministic state validator, and the Codex/Dashboard screens. Phase 2 is underway: voice is
implemented with a mic button on the Play screen plus a "read aloud" toggle that narrates new
turns (and a play/stop button on each turn to replay it), swappable per campaign — speech-to-text
via the browser (Web Speech API, zero config) or ElevenLabs, and text-to-speech via the browser,
ElevenLabs, or **Kokoro** (a small on-device model, no key and no server, and no WebGPU needed).
The map graph view is the only remaining stub (see DESIGN.md §11). Phase 3's direct AI mode is
implemented with two options per campaign, both skipping the copy/paste step: **Claude** (needs an
API key, billed to you directly by Anthropic) and a **local Gemma model** (needs a WebGPU-capable
browser, no key, no server, runs fully on your device — noticeably weaker at following the reply
format than Claude). The original manual copy/paste flow keeps working alongside both as the
no-setup fallback.

## Setup

1. `npm install`
2. Create a Google Cloud project, enable the **Drive API** and **Sheets API**, and create an
   OAuth **Client ID** (Web application type). Add `http://localhost:5173` (and your deployed
   origin, if any) to Authorized JavaScript origins. See DESIGN.md §12 for the scope tradeoffs.
3. Copy `.env.example` to `.env` and set `VITE_GOOGLE_CLIENT_ID` to that Client ID.
4. `npm run dev`

Without step 2/3, the app boots to a "Google Drive isn't configured yet" screen rather than
crashing — everything else is wired up and ready as soon as credentials are added.

To use ElevenLabs instead of the browser for voice, pick ElevenLabs as the STT/TTS provider in a
campaign's Settings; the API key field then appears on that page (it's hidden until something
actually needs it). The key is global rather than per-campaign, and stored only in this browser's
`localStorage`, never written to Drive.

For Kokoro text-to-speech, no key or setup at all: pick "Kokoro (on-device, runs locally)" as a
campaign's text-to-speech provider. The model downloads once on first use and then runs entirely
on your device; use "Download voice model now" under **Kokoro voice model** in Settings to fetch it
ahead of time, with a progress bar, and to remove it again later. One caveat: Kokoro relies on the
browser cache, which requires HTTPS or localhost — served over a plain-HTTP LAN address it still
works but re-downloads on each page load, and Settings says so inline.

Same pattern for Claude: add your API key in Settings (`localStorage`, never Drive), then
switch a campaign's AI mode to "Direct API key (Claude)" and pick a model (Sonnet 5 by default,
Opus 5 or Haiku 4.5 also available). Every turn generated this way is billed directly to that key
by Anthropic — there's no proxy or server in between.

For the local text model, no key or setup at all either: switch a campaign's AI mode to "Local
model (Gemma, runs on this device)". It downloads roughly 1 GB (a small Gemma model converted for
in-browser inference) and caches it; every turn after that runs on-device via WebGPU. Use
"Download model now" under **Local AI model** in Settings to fetch it ahead of time (with a
progress bar, resumable if interrupted) and to remove it again later. Needs a browser that
supports WebGPU (Chrome/Edge on Android 12+, Safari 26+ on iOS/macOS/iPadOS) — on an unsupported
browser, or if the download fails, it surfaces a clear error rather than hanging.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — typecheck + production build
- `npm run lint` — oxlint
- `npm run preview` — preview the production build locally
- `npm run test:e2e` — Playwright end-to-end tests (mocked Google Drive/Sheets backend, no real
  account needed — see `tests/`)
