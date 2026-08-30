# Adventure

A solo, audiobook-style AI-narrated adventure game. See [DESIGN.md](./DESIGN.md) for the full
architecture, data model, and rationale. This is a client-only React + TypeScript SPA — all game
state lives in a Google Drive folder you own (Markdown files for prose, Google Sheets for
everything tabular), with no server or database of its own.

## Status

Phase 1 (MVP) is implemented: campaign setup wizard, the manual copy/paste DM turn loop, the
deterministic state validator, and the Codex/Dashboard screens. Phase 2 is underway: voice is
implemented with a mic button on the Play screen plus a "read aloud" toggle that narrates new
turns (and a play/stop button on each turn to replay it), swappable in Settings — global to this
device (not per campaign) — speech-to-text via the browser (Web Speech API, zero config), and
text-to-speech via the browser or **Kokoro** (a small on-device model, no key and no server, and no
WebGPU needed). An ElevenLabs option existed briefly but was removed outright (issue #97) so
Kokoro is the app's only non-browser voice provider. The map graph view is the only remaining stub
(see DESIGN.md §11). Phase 3's direct AI mode is
implemented with two options (a global, device-scoped preference, same as voice — not per
campaign), both skipping the copy/paste step: **Claude** (needs an
API key, billed to you directly by Anthropic) and a **local on-device model** — pick from several
(see below), each needing a WebGPU-capable browser, no key, no server, running fully on your
device — noticeably weaker at following the reply format than Claude, more so for the smaller
choices. The original manual copy/paste flow keeps working alongside both as the no-setup
fallback.

## Setup

1. `npm install`
2. Create a Google Cloud project, enable the **Drive API** and **Sheets API**, and create an
   OAuth **Client ID** (Web application type). Add `http://localhost:5173` (and your deployed
   origin, if any) to Authorized JavaScript origins. See DESIGN.md §12 for the scope tradeoffs.
3. Copy `.env.example` to `.env` and set `VITE_GOOGLE_CLIENT_ID` to that Client ID.
4. `npm run dev`

Without step 2/3, the app boots to a "Google Drive isn't configured yet" screen rather than
crashing — everything else is wired up and ready as soon as credentials are added.

For Kokoro text-to-speech, no key or setup at all: pick "Kokoro (on-device, runs locally)" as the
text-to-speech provider in Settings (a global, device-scoped preference — same page whether or not
a campaign is open). The model downloads once on first use and then runs entirely
on your device; use "Download voice model now" under **Kokoro voice model** in Settings to fetch it
ahead of time, with a progress bar, and to remove it again later. One caveat: Kokoro relies on the
browser cache, which requires HTTPS or localhost — served over a plain-HTTP LAN address it still
works but re-downloads on each page load, and Settings says so inline. Kokoro runs on the CPU by
default (still no WebGPU needed), with an opt-in "Run on: GPU" toggle in that same Settings card
for a faster, larger download on devices where WebGPU is available — it falls back to the CPU
automatically if that turns out not to work.

Same pattern for Claude: add your API key in Settings (`localStorage`, never Drive), then
switch a campaign's AI mode to "Direct API key (Claude)" and pick a model (Sonnet 5 by default,
Opus 5 or Haiku 4.5 also available). Every turn generated this way is billed directly to that key
by Anthropic — there's no proxy or server in between.

For the local text model, no key or setup at all either: switch a campaign's AI mode to "Local
model (runs on this device)" and pick one from the dropdown — sizes range from ~490 MB (Qwen2.5
0.5B, smallest and weakest) up to ~3 GB (Gemma 4 E2B, largest and highest quality; loaded
text-only — its vision/audio components are skipped since this app never sends images or audio).
Bigger models are more capable but slower to download and more likely to crash the tab on
memory-constrained devices, so if one crashes, try a smaller one. Use the **Local AI models** card
in Settings to download any of them ahead of time (with a progress bar, resumable if interrupted),
and to remove a downloaded — or partially downloaded — model to free up space. Needs a browser
that supports WebGPU (Chrome/Edge on Android 12+, Safari 26+ on iOS/macOS/iPadOS) — on an
unsupported browser, or if a download fails, it surfaces a clear error rather than hanging.

## Deploying (GitHub Pages)

Pushing to `main` builds and publishes via `.github/workflows/deploy-pages.yml`. The site is served
from `https://<owner>.github.io/<repo>/`, and the build derives that base path from the repo name,
so a rename needs no code change. Deep links work through a `404.html` copy of `index.html`.

Three one-time setup steps live outside the repo:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables:** add `VITE_GOOGLE_CLIENT_ID`. Without
   it the deploy still succeeds but the live app is stuck on "Google Drive isn't configured yet".
3. **Google Cloud Console → your OAuth client → Authorized JavaScript origins:** add the deployed
   origin, e.g. `https://<owner>.github.io` (scheme + host only — no path, no trailing slash).
   Missing this makes sign-in fail with `origin_mismatch`.

The OAuth client ID is public by design — it ships in the browser bundle either way, and what
actually protects the project is the Authorized JavaScript origins list, not keeping the ID secret.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — typecheck + production build
- `npm run lint` — oxlint
- `npm run preview` — preview the production build locally
- `npm run test:e2e` — Playwright end-to-end tests (mocked Google Drive/Sheets backend, no real
  account needed — see `tests/`)
