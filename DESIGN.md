# AI Adventure — Design Doc (v0.2)

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
| Backend / storage | **No server, no database.** Google Drive is the only backend. You pick a Drive folder in Settings; the app bootstraps it. **Markdown files** hold prose (campaign setup, story transcript, rolling summary, long lore write-ups). **Google Sheets** hold everything tabular/list-like (inventory, stats, skills, NPCs, monsters, timeline, quests, map nodes) — one spreadsheet per campaign, one tab per entity type, read/written via the Sheets API. |
| UI stack | React + TypeScript + **Tailwind CSS** + **shadcn/ui** components. |
| Hosting | Static single-page app (Vite + React + TypeScript), deployable anywhere static (or run locally). Installable as a PWA so it behaves like an app on your phone. |
| Process | Design doc (this doc) first → sign-off → build in phases. |

---

## 2. Why Google-Drive-only is workable

Two Google APIs, both called directly from the browser, nothing passing through a third-party
server:

- **Drive API v3** — folder picking/creation, creating the Markdown files and the campaign
  spreadsheet, listing campaigns. Scope: `drive.file` (the app only ever sees files/folders it
  created or that you explicitly picked via the Drive file picker — never your whole Drive).
- **Sheets API v4** — reading/writing cell ranges inside each campaign's spreadsheet. This
  needs the broader `spreadsheets` scope, because the Sheets API's own authorization doesn't
  recognize `drive.file` grants the way the Drive API does. That's the one real scope
  trade-off of this design: the OAuth consent screen will ask for "see, edit, create, and
  delete your Google Sheets spreadsheets," not just "files this app creates." Worth flagging
  since it's broader than the Drive-only version of this design — happy to revisit if that's
  a dealbreaker, but there's no narrower official scope that still allows cell-range
  read/write.
- Every full-state read is a single `spreadsheets.values.batchGet` call across all tabs
  (Character, Inventory, NPCs, Monsters, Timeline, Quests, Map, ...) — one HTTP round trip
  regardless of how many tabs exist. Writes from a turn's `state_delta` are batched the same
  way with `batchUpdate` / `values.append`.

The tradeoff of having no server-side database: no complex cross-file queries, and Sheets
enforces some latency per API call. The data model is designed so a given screen needs at most
one Sheets batch call plus one Drive file read — never an open-ended search.

---

## 3. Tech stack

- **Vite + React + TypeScript** — client-only SPA, no backend to operate.
- **Tailwind CSS + shadcn/ui** for styling/components (Dialog/Stepper for the setup wizard,
  Tabs for the Codex, Card for entity entries, Command/Combobox where useful, Sonner for
  toasts on validation errors).
- **Google Identity Services** for auth; **Drive API v3** (`drive.file`) for folder/file
  management; **Sheets API v4** (`spreadsheets`) for all tabular reads/writes.
- **Zustand** (or plain context) for in-memory session state; Drive/Sheets are the source of
  truth, local state is a cache with optimistic writes reconciled against API responses.
- **PWA** (manifest + service worker) — installable on a phone, mic access works over HTTPS.
- No build-time dependency on any AI vendor SDK in Phase 1 (manual bridge needs none). Phase 2
  adds a thin `fetch`-based client per provider, called directly from the browser with a
  user-supplied key stored only in `localStorage`.

---

## 4. Data model & Google Drive folder structure

One root folder (you choose it in Settings — call it "AI Adventure"), one subfolder per
**campaign** (a campaign = one character + one world + one continuous story). Structure is
deliberately genre-agnostic — sheet columns and stat fields are free-form, not fixed D&D
fields, so the same schema works for a cyberpunk heist, a cozy fantasy village, or a horror
survival game. **Prose lives in Markdown, everything list-shaped lives in one Google Sheet.**

```
AI Adventure/
  campaigns/
    <campaign-name>/
      campaign.md              # YAML frontmatter (name, genre/theme, difficulty, created date,
                                #   current turn, current location, house rules) + prose body:
                                #   world/scenario setup and your stated expectations, written
                                #   at campaign creation and human-readable/editable anytime.
      settings.md               # per-campaign voice provider choices, narration style (frontmatter)
      world/
        lore/
          <slug>.md              # one file per long-form lore entry (a location history, a
                                 #   faction writeup, ...) — linked from the Lore sheet tab by
                                 #   filename; short entries just live in the sheet, no file.
      story/
        log/
          0001.md ... NNNN.md    # raw transcript, chunked ~50 turns per file (keeps files small
                                 #   and reads cheap)
        summary/
          rolling.md             # current condensed summary fed to the AI each turn — plain
                                 #   prose, overwritten in place
          checkpoints/            # archived rolling.md snapshots at re-summarization points
      "<campaign-name> — Data" (Google Sheet, one file, one tab per entity type):
        Character    # single-row-ish key/value: name, description, stats (free columns),
                      #   level/XP if used, status effects (comma list)
        Inventory    # id, name, qty, description, tags, acquired_turn, active(bool)
        Skills       # id, name, rank/level, description
        NPCs         # id, name, description, relationship, status, last_seen_turn
        Monsters     # id, name, description, threat_notes, status, last_encountered_turn
        Timeline     # turn, title, summary, tags
        Quests       # id, title, status, description, updated_turn
        Map          # id, name, type, state(discovered/rumored/unexplored), connects_to,
                      #   description, x, y (coords optional — layout can also be force-directed)
        Lore         # id, type, name, summary, tags, discovered(bool), detail_file (optional,
                      #   points at world/lore/<slug>.md for the long version)
```

Every screen maps 1:1 to either one Markdown file or one Sheets tab (Inventory panel ↔
`Inventory` tab, Codex ↔ `NPCs`/`Monsters`/`Lore` tabs + linked lore `.md` files, Map ↔ `Map`
tab, Timeline ↔ `Timeline`/`Quests` tabs). This is the "efficient structuring" the brief asked
for: nothing is hard-coded to D&D fields, tabular data is easy to skim/edit by hand directly in
Sheets between sessions, and prose stays prose instead of being awkwardly stuffed into cells.

---

## 5. The turn loop & AI contract

Every AI reply — whether pasted in manually or returned by an API call — must follow one
contract so the app can parse it. **Two-part output:**

1. **Narrative prose** — what gets shown/read aloud, written in second person, present tense
   (audiobook feel). Real markdown (paragraphs, emphasis, lists, headers) is allowed and
   rendered client-side via `react-markdown`, restricted to the safe subset it produces by
   default — no `rehype-raw`/raw HTML, since this is unsanitized AI output rendered directly.
   The narrative includes the literal placeholder token `{{options}}` at the point the turn's
   options should render inline (usually near the end, but not hardcoded to always be last); if
   omitted, the client falls back to appending the options after the narrative automatically.
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
    {"label": "Search the altar for more clues"},
    {"label": "Ask Old Maren about the key"},
    {"label": "Leave the chapel and head back to the market", "manus": "Leave and head back to the market"}
  ]
}
```

- `options` (2–4 suggestions) are `{label, manus?}` objects: `label` is what renders as a button,
  `manus` is what a TTS provider reads aloud for it and defaults to `label` when omitted (most
  options don't need it — they're already short phrases that read fine as-is). The parser also
  accepts the legacy plain `string[]` shape and upconverts each string to `{label, manus}` with
  both equal to it, so a manual-mode paste from a chat UI that hasn't picked up this contract yet
  doesn't hard-fail. Options render inline in the narrative, at the `{{options}}` token's
  position (or appended at the end as a fallback) — a `TurnBlock` sequence
  (`{type: 'prose', markdown} | {type: 'options', items}`, `src/types/turn.ts`) is what the
  renderer (`src/components/TurnContent.tsx`) and the TTS spoken-script builder
  (`src/lib/ai/turnBlocks.ts`) both consume, via a small per-block-type mapping that a future
  block type (a dice-roll result, an item card, ...) can extend without restructuring either. A
  free-text box and a mic button are always present alongside the options regardless of what's
  suggested. This block-splitting is a pure render-time transform, not a persisted shape:
  `story/log/*.md` keeps storing the raw narrative string and plain option label strings, exactly
  as before this existed.
- The **system prompt** sent every turn (built by the app, shown in full in manual mode so
  you can inspect/edit it before pasting) includes: DM persona + tone, the difficulty rules
  (§7), the world/character setup from `campaign.md`, a fresh `batchGet` snapshot of the
  Character/Inventory/NPCs/Monsters/Map/Quests tabs, the rolling summary from `rolling.md`,
  the last ~6 raw turns, and a fixed instruction block requiring the `state` JSON contract and
  telling the model to **only** report changes that are consistent with the supplied state (no
  inventing items you already have, no NPCs dying twice, etc.) — this is the "review against
  documented information" the brief asked for, folded into generation rather than a separate
  pass, since a separate AI review pass would double the copy/paste burden in manual mode.
- **Deterministic validation always runs client-side** before any `state_delta` is written back
  to the sheet: can't remove an item not currently held, can't set HP below the ruleset's
  floor, can't revive a `dead` NPC without an explicit resurrection tag, etc. A failed
  validation doesn't silently drop the turn — it's shown to you with a one-click "regenerate
  with a correction note" action (in manual mode: an amended prompt to re-paste; in API mode:
  automatic retry). Once validated, the delta is applied as sheet writes: `values.append` for
  new Inventory/NPC/Monster/Timeline/Map rows, a targeted `values.update` for Character
  stat/status changes.
- **Phase 2, API mode only:** an optional second, cheap pass ("critic pass") that re-checks
  the drafted turn against the latest sheet snapshot before showing it to you, toggleable in
  settings since it costs an extra API call per turn.

---

## 6. Summarization strategy

- `summary_update` from every turn is folded into `story/summary/rolling.md` (cheap, no extra
  AI call — it's part of the same generation; the file is just overwritten with the new text).
- Every ~15 turns (configurable), the app prompts a **full re-summarization**: send the
  current rolling summary + the last 15 raw turns, ask for a single tightened paragraph that
  replaces it. Before overwriting, the previous version is copied into
  `story/summary/checkpoints/`. This keeps the rolling summary bounded (roughly constant size)
  instead of growing forever, which is what actually lets the "AI doesn't need a giant context"
  goal hold up over a 200-turn campaign.
- Raw transcript is never summarized away — it's archived in `story/log/*.md` purely for you
  to read back / for the map & codex UIs to backfill from if you edit the summary by hand.

---

## 7. Difficulty

A single setting per campaign (`campaign.md` frontmatter: `difficulty`), one of `Story / Easy / Standard /
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
  when relevant, instead of dumping the whole world bible every turn. → We do the same: the
  `Lore` sheet tab is tagged, and the prompt-builder only pulls entries tagged with the
  current location/active NPCs (plus their linked `.md` file if `detail_file` is set), not
  the whole tab.
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

1. **Campaign setup wizard** (shadcn Dialog/Stepper) — character (name/description/stats/
   skills), starting inventory, world & scenario prompt, tone/expectations free-text,
   difficulty picker. On finish: creates the campaign folder, `campaign.md`, and the
   `<campaign-name> — Data` spreadsheet with all tabs pre-headered.
2. **Play screen** (the core loop) — narration text (with a "read aloud" toggle driving the
   active TTS provider), option buttons, free-text box, mic button, and — in manual mode — a
   "Copy DM prompt" button plus a "Paste AI reply" box with inline validation errors.
3. **Codex** (shadcn Tabs) — Inventory, Stats/Skills, NPCs, Monsters, Lore, Timeline/Quests.
   Each tab is a thin read view over its corresponding sheet tab (Lore entries expand to their
   linked Markdown file when present).
4. **Map** — the discovered-location graph from the `Map` sheet tab, rendered as connected
   nodes that reveal as `new_locations` deltas land; undiscovered edges hinted but greyed out.
5. **Settings** — Drive folder picker, AI mode (manual/API + key), STT provider + key, TTS
   provider + key/voice assignments, summarization cadence.

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

- Both APIs need an OAuth **Client ID** registered in a Google Cloud project, with the Drive
  API and Sheets API enabled on it (free, few-minute setup, but you need to create it, add
  yourself as a test user, and hand me the Client ID — I can't provision Google Cloud
  resources on your behalf).
- The `spreadsheets` scope (§2) is broader than pure `drive.file` — it can see/edit any Sheet
  in your Drive, not just ones this app created. Practically the app only ever touches sheets
  it created itself, but Google's consent screen will still show the broader grant. Flagging
  in case that changes your storage preference before Phase 1 starts.
- Sheets API default quota is 300 read/write requests per minute per project — a non-issue for
  single-player use, but worth knowing if a turn ever needs unusually many calls.
- If you hand-edit a campaign's spreadsheet in the Drive UI while the app is mid-turn, last
  write wins — the app should be treated as the primary writer, with manual edits made between
  turns rather than concurrently.
- `transformers.js` local TTS model choice/size is still to be pinned down in Phase 2 — will
  benchmark a couple of small models for phone feasibility before committing to one.
- Manual-bridge UX (copy prompt → paste reply) is inherently more friction than a live API
  call; Phase 1 should validate that friction is acceptable before Phase 3 work is prioritized.
