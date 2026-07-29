# AI Adventure — Design Doc (v0.1)

A solo, audiobook-like RPG web app. An AI plays the Dungeon Master and every NPC/creature.
You play a character you define yourself, in a world/scenario you define yourself, under rules
that are "DnD-like" but not DnD. Every turn you can pick a suggested action, speak, or type
anything. The full story is transcribed, continuously summarized, and everything that matters
mechanically (inventory, stats, skills, NPCs, monsters, events, lore, map) is tracked as
structured data — stored entirely in a Google Drive folder you own.

This doc captures the decisions made so far and is meant to be signed off on before Phase 1
implementation starts.

---

## 1. Decisions locked in

| Area | Decision |
|---|---|
| AI backend | **Hybrid.** Phase 1 ships a "manual bridge": the app builds the full DM prompt, you copy it into claude.ai/chatgpt.com yourself, paste the reply back in. The AI call itself sits behind one `AIProvider` interface so a `claude-api` / `openai-api` provider (your own key) can be dropped in later with zero changes to the rest of the app. |
| Speech-to-text | Default: browser-native (Web Speech API), free, no setup. Toggle to ElevenLabs (Scribe) STT if you add a key. |
| Text-to-speech | Toggle between three providers at any time: browser-native (`SpeechSynthesis`), ElevenLabs, or a local Hugging Face model running in-browser (via `transformers.js`, WASM/WebGPU — no server). |
| Backend / storage | **No server, no database.** Google Drive is the only backend. All game state (character, inventory, world, story log, summaries, map) lives as structured JSON/Markdown files in a Drive folder, read and written directly by the browser via the Drive API. |
| Hosting | Static single-page app (Vite + React + TypeScript), deployable anywhere static (or run locally). Installable as a PWA so it behaves like an app on your phone. |
| Process | Design doc (this doc) first → sign-off → build in phases. |

---

## 2. Why Google-Drive-only is workable

The Drive API supports the `drive.file` OAuth scope: the app can only see/create files it
itself created (plus one folder you pick to hold everything), never your whole Drive. That
keeps the OAuth consent screen simple and keeps your Drive private from the app's perspective.
All reads/writes go directly from your browser to Google's API — nothing passes through a
third-party server.

The tradeoff: no server-side database means no complex queries. The data model below is
designed so that everything the app needs on a given screen is a **single small file read**,
not a query across many files — indexes are maintained as flat JSON files updated on write.

---

## 3. Tech stack

- **Vite + React + TypeScript** — client-only SPA, no backend to operate.
- **Google Identity Services + Drive API v3** (`drive.file` scope) for storage/auth.
- **Zustand** (or plain context) for in-memory session state; Drive is the source of truth,
  local state is a cache with optimistic writes.
- **PWA** (manifest + service worker) — installable on a phone, mic access works over HTTPS.
- No build-time dependency on any AI vendor SDK in Phase 1 (manual bridge needs none). Phase 2
  adds a thin `fetch`-based client per provider, called directly from the browser with a
  user-supplied key stored only in `localStorage`.

---

## 4. Data model & Google Drive folder structure

One root folder ("AI Adventure"), one subfolder per **campaign** (a campaign = one character +
one world + one continuous story). Structure is deliberately genre-agnostic — "stats", "items",
"entities" are free-form bags of properties, not fixed D&D fields, so the same schema works for
a cyberpunk heist, a cozy fantasy village, or a horror survival game.

```
AI Adventure/
  campaigns/
    <campaign-id>/
      campaign.json          # name, genre/theme, tone, created date, difficulty, house rules,
                              #   player's stated expectations, current turn number
      character.json         # name, description, stats (free-form key/value), skills,
                              #   level/XP (optional — only if the ruleset uses them),
                              #   status effects, inventory[]
      settings.json           # per-campaign voice provider choices, narration style
      world/
        lore.json             # world-bible entries: {id, type: location|faction|concept|item,
                              #   name, summary, tags, discovered: bool}
        map.json              # graph: nodes (locations, coords optional, discovered/rumored/
                              #   unexplored, description) + edges (routes between nodes)
      entities/
        npcs.json             # index of named characters met: {id, name, description,
                              #   relationship, status (alive/dead/unknown), last_seen_turn}
        monsters.json         # bestiary: {id, name, description, threat_notes, encounters[]}
      events/
        timeline.json         # major event log: {turn, title, summary, tags}
        quests.json           # active/completed quest/goal tracker
      story/
        log/
          0001.md ... NNNN.md   # raw transcript, chunked ~50 turns per file (keeps files small
                                 #   and Drive reads cheap; index below points into them)
          index.json             # {chunkFile, turnRange, byteOffset?} per chunk
        summary/
          rolling.json          # current condensed summary fed to the AI each turn
          checkpoints/          # archived summaries at major milestones (for the map/codex UI,
                                 #   not for prompting)
      state/
        current.json           # single canonical snapshot: location, active scene, party,
                                 #   turn number, difficulty — this + rolling summary + last
                                 #   ~6 raw turns is the entire context sent to the AI
```

Every file is small, independently readable/writable, and mirrors one UI panel 1:1
(Inventory panel ↔ `character.json`, Codex ↔ `world/lore.json` + `entities/*.json`, Map ↔
`world/map.json`, Timeline ↔ `events/timeline.json`). This is the "efficient structuring" the
brief asked for: it scales to any theme because nothing is hard-coded to D&D fields, and the
app never has to load more than a few KB to render any given screen.

---

## 5. The turn loop & AI contract

Every AI reply — whether pasted in manually or returned by an API call — must follow one
contract so the app can parse it. **Two-part output:**

1. **Narrative prose** — what gets shown/read aloud. Clean text, no markup, written in second
   person, present tense (audiobook feel).
2. A single trailing fenced block, ` ```state ` … ` ``` `, containing structured JSON:

```json
{
  "state_delta": {
    "inventory_add": [{"name": "Rusted Key", "qty": 1, "note": "warm to the touch"}],
    "inventory_remove": [{"name": "Torch", "qty": 1}],
    "stat_changes": {"hp": -3},
    "status_add": ["Poisoned"],
    "status_remove": [],
    "new_npcs": [{"name": "Old Maren", "description": "..."}],
    "new_locations": [{"name": "The Sunken Chapel", "connects_to": "Market Square"}],
    "events": [{"title": "Found the Rusted Key", "summary": "..."}]
  },
  "summary_update": "one or two sentences to fold into the rolling summary",
  "options": [
    "Search the altar for more clues",
    "Ask Old Maren about the key",
    "Leave the chapel and head back to the market"
  ]
}
```

- `options` (2–4 suggestions) render as buttons; a free-text box and a mic button are always
  present alongside them regardless of what's suggested.
- The **system prompt** sent every turn (built by the app, shown in full in manual mode so
  you can inspect/edit it before pasting) includes: DM persona + tone, the difficulty rules
  (§7), the world/character setup from campaign creation, the current `state/current.json`,
  the rolling summary, the last ~6 raw turns, and a fixed instruction block requiring the
  `state` JSON contract and telling the model to **only** report changes that are consistent
  with the supplied state (no inventing items you already have, no NPCs dying twice, etc.) —
  this is the "review against documented information" the brief asked for, folded into
  generation rather than a separate pass, since a separate AI review pass would double the
  copy/paste burden in manual mode.
- **Deterministic validation always runs client-side** before any `state_delta` is applied:
  can't remove an item not currently held, can't set HP below the ruleset's floor, can't
  revive a `dead` NPC without an explicit resurrection tag, etc. A failed validation doesn't
  silently drop the turn — it's shown to you with a one-click "regenerate with a correction
  note" action (in manual mode: an amended prompt to re-paste; in API mode: automatic retry).
- **Phase 2, API mode only:** an optional second, cheap pass ("critic pass") that re-checks
  the drafted turn against `state/current.json` before showing it to you, toggleable in
  settings since it costs an extra API call per turn.

---

## 6. Summarization strategy

- `summary_update` from every turn is appended to `story/summary/rolling.json` (cheap, no
  extra AI call — it's part of the same generation).
- Every ~15 turns (configurable), the app prompts a **full re-summarization**: send the
  current rolling summary + the last 15 raw turns, ask for a single tightened paragraph that
  replaces it. This keeps the rolling summary bounded (roughly constant size) instead of
  growing forever, which is what actually lets the "AI doesn't need a giant context" goal
  hold up over a 200-turn campaign.
- Raw transcript is never summarized away — it's archived in `story/log/*.md` purely for you
  to read back / for the map & codex UIs to backfill from if you edit the summary by hand.

---

## 7. Difficulty

A single setting per campaign (`campaign.json: difficulty`), one of `Story / Easy / Standard /
Hard / Brutal` (or a numeric 1–5 if you'd rather), injected into the system prompt as concrete
DM instructions, e.g.:

- **Story**: conflict is rare, failure rarely costs resources, death effectively off.
- **Standard**: PbtA-style **fail-forward** — a failed roll/action moves the story forward
  with a complication rather than just "nothing happens" (see §9).
- **Hard/Brutal**: resource scarcity, permadeath on, harsher consequence weighting.

Difficulty is a prompt-level instruction, not a hidden dice engine — this app doesn't
mandate a specific resolution mechanic (no fixed d20/2d6), matching "rules are not strictly
D&D." If you want actual dice, that's a per-campaign house rule you write into your prompt at
setup and the DM instructions reference it consistently.

---

## 8. Voice architecture

Two small provider interfaces, swappable independently and per-function in Settings:

```ts
interface STTProvider { start(): void; stop(): void; onResult(cb: (text: string) => void): void; }
interface TTSProvider { speak(text: string, opts?: {voice?: string}): Promise<void>; stop(): void; }
```

- `browser` STT/TTS: `webkitSpeechRecognition` / `speechSynthesis` — zero config, works
  offline-ish, quality varies by OS/browser.
- `elevenlabs` STT/TTS: needs an API key (entered in Settings, stored only in
  `localStorage`, never written to Drive). TTS lets you assign different ElevenLabs voices to
  the narrator vs. recurring named NPCs for a real audiobook-cast feel.
- `huggingface-local` TTS: a small distilled model (e.g. an MMS-TTS or Kokoro-class model)
  run fully client-side via `transformers.js`. Free, private, no key — but multi-hundred-MB
  model download on first use and noticeably slower/lower quality on a phone; documented as
  the "no budget at all" fallback rather than the default.

---

## 9. Interactive-storytelling mechanics informing the AI instructions

Research into existing solo/AI-GM tools and TTRPG design:

- **NovelAI's Lorebook / "World Info"** — keyed lore entries only get injected into context
  when relevant, instead of dumping the whole world bible every turn. → We do the same:
  `world/lore.json` entries are tagged, and the prompt-builder only pulls entries tagged with
  the current location/active NPCs, not the whole file.
- **PbtA / Ironsworn "fail forward"** — failure should complicate, not stall, the story; a
  miss becomes a twist, not a dead end. → Baked into the Standard-and-below difficulty
  instructions (§7) as the default narrative posture, so a free-text action that "doesn't
  work" still produces forward motion instead of "nothing happens, try again."
- **Ironsworn / Mythic GM Emulator oracles** — solo play leans on random oracles to keep the
  AI-as-GM honest and surprising rather than railroading. → Optional: the DM system prompt can
  include an instruction to occasionally introduce an unplanned complication/twist on a
  weighted basis tied to difficulty, giving the same "the world doesn't just do what you
  expect" texture without a literal dice mechanic.
- **AI Dungeon's open-ended free text** and **Hidden Door's card/character continuity** —
  confirm the two features you already asked for: always-available free text alongside
  choices, and persistent named entities (NPCs/monsters/locations) that recur and are tracked
  rather than regenerated each time. Both are structural requirements in §4/§5, not
  afterthoughts.

Sources: [DriveThruRPG — PbtA introduction](https://pages.drivethrurpg.com/powered-by-the-apocalypse-pbta-introduction/), [Wikipedia — Powered by the Apocalypse](https://en.wikipedia.org/wiki/Powered_by_the_Apocalypse), [NovelAI Lorebook docs](https://docs.novelai.net/en/text/lorebook/), [Ironsworn (itch.io)](https://shawn-tomkin.itch.io/ironsworn)

---

## 10. UI/UX screens

1. **Campaign setup wizard** — character (name/description/stats/skills), starting
   inventory, world & scenario prompt, tone/expectations free-text, difficulty picker.
   Produces the initial `campaign.json` / `character.json` / `world/*` files.
2. **Play screen** (the core loop) — narration text (with a "read aloud" toggle driving the
   active TTS provider), option buttons, free-text box, mic button, and — in manual mode — a
   "Copy DM prompt" button plus a "Paste AI reply" box with inline validation errors.
3. **Codex** — tabs for Inventory, Stats/Skills, NPCs, Monsters, Lore, Timeline/Quests. Each
   tab is a thin read view over its corresponding Drive file.
4. **Map** — the discovered-location graph from `world/map.json`, rendered as connected nodes
   that reveal as `new_locations` deltas land; undiscovered edges hinted but greyed out.
5. **Settings** — AI mode (manual/API + key), STT provider + key, TTS provider + key/voice
   assignments, Drive folder picker, summarization cadence.

---

## 11. Build phases

1. **Phase 1 (MVP):** Drive auth + folder bootstrap, campaign setup wizard, play screen in
   manual-bridge mode, deterministic state validator, Codex panels, rolling summary. No voice,
   no map yet — get the core loop and data model solid first.
2. **Phase 2:** Voice (browser STT/TTS first, then ElevenLabs + local HF toggles), world map
   view.
3. **Phase 3:** Direct API provider (Claude/OpenAI key) as an `AIProvider` alongside manual
   bridge, optional critic/review pass, PWA install polish.

## 12. Open risks / things to confirm before or during Phase 1

- Drive API from a pure static SPA needs an OAuth **Client ID** registered in a Google Cloud
  project (free, but you need to create it and add yourself as a test user, or publish the
  consent screen). I'll need you to create this and hand me the Client ID — I can't provision
  Google Cloud resources on your behalf.
- `transformers.js` local TTS model choice/size is still to be pinned down in Phase 2 — will
  benchmark a couple of small models for phone feasibility before committing to one.
- Manual-bridge UX (copy prompt → paste reply) is inherently more friction than a live API
  call; Phase 1 should validate that friction is acceptable before Phase 3 work is prioritized.
