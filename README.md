# AI Adventure

A solo, audiobook-style AI-narrated adventure game. See [DESIGN.md](./DESIGN.md) for the full
architecture, data model, and rationale. This is a client-only React + TypeScript SPA — all game
state lives in a Google Drive folder you own (Markdown files for prose, Google Sheets for
everything tabular), with no server or database of its own.

## Status

Phase 1 (MVP) is implemented: campaign setup wizard, the manual copy/paste DM turn loop, the
deterministic state validator, and the Codex/Dashboard screens. Voice (STT/TTS) and the map graph
view are stubbed for Phase 2; a direct AI API mode is stubbed for Phase 3 (see DESIGN.md §11).

## Setup

1. `npm install`
2. Create a Google Cloud project, enable the **Drive API** and **Sheets API**, and create an
   OAuth **Client ID** (Web application type). Add `http://localhost:5173` (and your deployed
   origin, if any) to Authorized JavaScript origins. See DESIGN.md §12 for the scope tradeoffs.
3. Copy `.env.example` to `.env` and set `VITE_GOOGLE_CLIENT_ID` to that Client ID.
4. `npm run dev`

Without step 2/3, the app boots to a "Google Drive isn't configured yet" screen rather than
crashing — everything else is wired up and ready as soon as credentials are added.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — typecheck + production build
- `npm run lint` — oxlint
- `npm run preview` — preview the production build locally
