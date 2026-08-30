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
| Speech-to-text | Browser-native (Web Speech API), free, no setup — the only STT provider (ElevenLabs was removed, issue #97). |
| Text-to-speech | Toggle between two providers at any time: browser-native (`SpeechSynthesis`) or Kokoro, a local Hugging Face model running in-browser (via `kokoro-js`/`transformers.js`, WASM/WebGPU — no server). |
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
- A third, narrow scope, `userinfo.email`, was added later (issue #45) purely so the app can
  remember the signed-in account's email as a `login_hint` for a faster *interactive* re-login —
  it mitigates friction from a known session-persistence limitation in the installed Android app
  (see CLAUDE.md's "Session persistence in an installed Android app" and `authStore.ts`'s own
  research summary); it's never used to read Gmail, contacts, or any other profile data.
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
  Tabs for the Codex, Card for entity entries, Command/Combobox where useful, a hand-rolled
  daisyUI-based toast — issue #95 — for toasts on validation errors). **Migrating to daisyUI**
  (issue #28) — shadcn/ui + Radix are still what most real pages render today; see "UI stack
  migration" immediately below for what's shipped so far and the plan for finishing the swap.
- **Google Identity Services** for auth; **Drive API v3** (`drive.file`) for folder/file
  management; **Sheets API v4** (`spreadsheets`) for all tabular reads/writes; a narrow
  `userinfo.email` scope (issue #45) purely to power a `login_hint` mitigation for a known
  session-persistence limitation in the installed Android app — see §2 and §12.
- **Zustand** (or plain context) for in-memory session state; Drive/Sheets are the source of
  truth, local state is a cache with optimistic writes reconciled against API responses.
- **PWA** (manifest, `public/manifest.webmanifest`) — installable on a phone, mic access works
  over HTTPS. The one service worker this app registers (`public/coi-serviceworker.js`, wired up
  via `src/lib/coiServiceWorker.ts`) exists for a narrower reason than offline support: it
  cross-origin-isolates the deployed GitHub Pages site so ONNX Runtime Web's WASM backend can run
  Kokoro TTS multi-threaded — see CLAUDE.md's Voice section. Offline/install support, if added
  later, should extend that same worker's fetch handler rather than register a second one.
- No build-time dependency on any AI vendor SDK in Phase 1 (manual bridge needs none). Phase 2
  adds a thin `fetch`-based client per provider, called directly from the browser with a
  user-supplied key stored only in `localStorage`.

### UI stack migration (issue #28): shadcn/Radix → daisyUI

The project owner decided to fully replace shadcn/ui + Radix with **daisyUI**, accepting that
daisyUI's components are plain Tailwind classes on native elements (or CSS-only interactivity via
`:checked`/`<dialog>`), not Radix's headless behavior primitives — this migration trades away
Radix's built-in focus trapping, roving keyboard nav, collision-aware popup positioning, and ARIA
wiring unless equivalently rebuilt per component. The reason: daisyUI's theme system (CSS custom
properties + a `data-theme` attribute, switchable at runtime) is the foundation issue #28's real
goal — scene-driven, multi-theme support (Phase 3, still unimplemented) — needs. See issue #28 for
the full phased plan and the scoping discussion that led here.

**Phase 1 (this PR) is additive and isolated: no real page's markup, styling, or behavior
changed.** It added the daisyUI Tailwind v4 plugin to `src/index.css` (`@plugin "daisyui"` with
`themes: false`, then two `@plugin "daisyui/theme"` blocks — `adventure-light`/`adventure-dark` —
hand-derived from this file's existing `:root`/`.dark` shadcn palette a few lines up, not any of
daisyUI's built-in presets) and a new, separate Storybook review surface,
`src/components/daisyui-preview/DaisyPreview.tsx` + `.stories.tsx` — plain daisyUI-classed mocks
(button, card, select, input, badge, dropdown, dialog) rather than real `src/components/ui/*`
components, so the project owner can visually review the theming approach before any real
component migrates. It deliberately lives outside `src/components/ui/` so it's never mistaken for
one of the real primitives every page still actually uses.

**`data-theme` vs. the existing `.dark`/`.light` class toggle — the coexistence decision.**
Real app pages keep using shadcn/Radix's `.dark`/`.light` class + `--background`/`--foreground`-
style custom properties, completely unchanged; daisyUI's theme tokens (`--color-base-100`, etc.)
are a parallel, non-overlapping namespace, switched via `data-theme` rather than a class. Both
mechanisms are wired into the same `src/index.css` build and proven inert with respect to each
other (Phase 1's PR description has the verification: pixel-identical before/after screenshots of
Dashboard/Play/Settings, and an interaction test asserting toggling one never touches the other's
attribute/class). This is deliberately a **coexist-for-now, replace-in-Phase-2** decision, not a
permanent dual-system: once every `src/components/ui/*` primitive has migrated to daisyUI classes
in Phase 2, `App.tsx`'s theme toggle should switch from `classList.add('dark'/'light')` to
`setAttribute('data-theme', name)` on `<html>`, and this file's shadcn `:root`/`.dark` blocks (and
the `@theme inline` mappings that expose them as Tailwind tokens) should be deleted outright —
running both indefinitely isn't the goal, and `data-theme` is also the mechanism Phase 3's
scene-driven theming needs (it can hold any number of named themes and change per scene/turn,
where a two-state class toggle only ever had "light" and "dark"). A partially-migrated Phase 2
(some primitives on daisyUI, some still shadcn) can safely run both mechanisms at once in the
interim, since Phase 1 already proved they don't interact.

**Proposed Phase 2 migration order**, safest/most-mechanical first, riskiest last (see issue #28
for why each interactive component needs its own explicit keyboard/focus/ARIA check, not just a
visual diff):

1. **DONE (issue #91). `badge`, `separator`, `label`** — pure presentational wrappers over native
   elements, no Radix dependency at all today. A closest-to-1:1 class swap (`.badge`, a
   `<hr>`/divider, `.label`).
   - **`label` really was cosmetic-only**, confirmed by reading `@radix-ui/react-label`'s own
     source rather than assuming: it renders nothing but a plain native `<label>` plus one small
     UX behavior (suppress text-selection on a double-click, skipped when the click lands on a
     nested control) — ported by hand. The click-to-focus-the-named-control behavior every real
     `htmlFor` call site actually depends on was never a Radix behavior at all; it's the browser's
     native `<label for="...">` association, which a plain `<label>` gets for free. Verified with a
     real Storybook interaction test (`label.stories.tsx`'s `ClickToFocus`), not just "it renders."
   - **Not every "form-control label class" daisyUI offers was actually a fit.** daisyUI's own
     `.label` class bakes in `color: color-mix(in oklab, currentcolor 60%, transparent)` — a
     permanent 60%-opacity mute. Real call sites don't want that: every one renders full-strength
     text today, and two (Settings.tsx's "Run on" rows) already layer their own
     `text-muted-foreground` on top of `Label`, which would either fight or double up with
     `.label`'s built-in muting depending on generated-CSS order, for no benefit either way. Kept
     the existing Tailwind classes (unchanged tokens, just no longer routed through Radix) instead
     of forcing a daisyUI class that didn't match this app's actual usage — worth remembering for
     later tiers: "use the daisyUI class" is a default, not an unconditional rule, when a real call
     site's own behavior says otherwise.
   - **A real, previously-undiscovered CSS bug, found by verifying dark mode rather than assuming
     it "just worked" via the CSS custom property cascade**: daisyUI's own per-theme tokens
     (`--color-primary`, etc.) are scoped to `[data-theme=...]`/OS `prefers-color-scheme` only —
     none of which this app's actual `.dark`/`.light` toggle (or its system-preference fallback,
     the only one actually wired up pre-toggle) drives. Fixed with a new bridge block in
     `src/index.css` that aliases daisyUI's tokens onto this app's own already-theme-aware
     variables (`--color-base-100: var(--background)`, etc.) — not a new palette, the same mapping
     the Phase 1 theme blocks' own comments already documented, just made reachable through the
     toggle the app actually has. Verified empirically (a headless-browser probe of computed custom
     properties across all four light/dark × explicit-class/system-preference combinations), not
     assumed from reading the CSS.
   - **A second, more serious bug the above verification surfaced**: `--border` is declared by
     *both* systems under the identical bare name for two unrelated things — daisyUI's own theme
     blocks use it as a border-**width** (`1px`), while this app's shadcn palette already used the
     same name for a border-**color** (an oklch value). Since custom properties inherit and
     shadcn's declaration wins the "which ancestor wins" cascade at `:root`, every daisyUI-classed
     element's inherited `--border` silently resolved to a color, and every daisyUI rule computing
     with it as a length (`.badge`'s `padding-inline: calc(var(--size)/2 - var(--border))`, its
     `border: var(--border) solid ...`) went invalid and got dropped — real badges rendered
     clipped to a few pixels wide with a `0px` padding-inline. Not visible in Phase 1's own
     `daisyui-preview`, which never got scrutinized at this level of detail; only caught here by
     actually inspecting a real, migrated component's computed style, not trusting a screenshot at
     a glance. Fixed by re-declaring `--border: 1px` scoped to `.badge` specifically (not globally
     — that would have broken shadcn's *own*, correct, unrelated use of `--border` as a color
     everywhere else). **Later tiers reusing any daisyUI class that reads `--border` as a length
     (`.btn`, `.card`, `.input`, `.select`, ...) will hit the exact same bug and need adding to that
     scoped-override list** — see `src/index.css`'s comment for the full mechanism. This is the
     single most important thing for later tiers to know going in.
2. **DONE (issue #93). `button`, `card`, `input`, `textarea`, `progress`** — also no Radix, but used
   at far more call sites across every page and dialog than (1); migrated right after (1) so later,
   harder components (Select, Dialog) can be rebuilt on an already-daisyUI Button/Input rather than
   mixing a still-shadcn Button inside a half-migrated Dialog.
   - **`--border` collision extended, exactly as (1) predicted**: re-checked the installed
     package's compiled CSS rather than assuming — `.btn`, `.input`, and `.textarea` all read
     `--border` as a length the same way `.badge` did, so all three were added to
     `src/index.css`'s scoped `--border: 1px` override list. `.card` turned out NOT to need an
     entry: its plain class never references `--border` at all — only its unused `.card-border`/
     `.card-dash` *modifier* classes do, and `card.tsx` deliberately doesn't use either (kept this
     app's existing `ring-1 ring-foreground/10` border treatment — see that file's own comment).
     `.progress` doesn't reference `--border` either.
   - **The dark-mode theme-token bridge from (1) needed no changes** — verified, not assumed:
     button/card/input touch more of daisyUI's token surface (focus-ring tokens, `--btn-color`/
     `--btn-fg`, `--input-color`) than badge/separator/label did, but every one of those resolves
     through `--color-primary`/`--color-base-*`/etc., which (1)'s bridge already aliases onto this
     app's `.dark`/`.light`-tracking variables. No new bridging was needed for this tier.
   - **New risk this tier introduced, checked explicitly and confirmed safe**: `button.tsx` is used
     far more widely than tier 1's components, including composed inside still-Radix `Dialog`'s
     close button and `Header.tsx`'s `DropdownMenuTrigger asChild` (the app's primary nav menu) —
     both via React's `asChild`/`Slot` cloning, which only requires the child to render one real DOM
     element accepting merged props/ref, not any particular class names. Since `Button`'s own
     `asChild`/`Slot.Root` structure was left untouched (only its `className` content changed), this
     composition was never actually at risk — confirmed empirically anyway with real Playwright
     clicks through both interactions (the dialog's close button closes it; the header's hamburger
     button opens the menu), not just by reasoning about it.
   - **`progress.tsx` dropped Radix's `Progress` primitive entirely**, not just its styling — it was
     already just `role="progressbar"` + ARIA value attributes on a `div`, no keyboard/focus
     behavior. A native `<progress value max>` element gets equivalent (arguably more standard)
     accessibility for free, and is what daisyUI's `.progress` is actually built to style (its
     compiled CSS targets `::-webkit-progress-bar`/`::-moz-progress-bar` pseudo-elements, not a
     div+div composition) — first tier-2 case of "the Radix wrapper wasn't earning its keep," worth
     the same explicit check on every remaining Radix-wrapped component in tiers 3+.
   - **A real bug caught by the required regression-test discipline, not just a screenshot**: the
     first pass at `button.tsx` kept shadcn's old base `border-transparent`/`text-sm` utility
     classes alongside daisyUI's `.btn` — both same-specificity same-layer collisions where the
     later-declared utility silently won, making every button's border invisible (including
     `outline`, whose entire point is a visible border) and flattening every size's distinct
     `--fontsize` to one value. Caught with a computed-style probe, not a glance; fixed by dropping
     both base classes and letting `.btn`'s own CSS variables drive border-color/font-size per
     variant/size instead. A new Storybook story (`button.stories.tsx`'s `OutlineHasVisibleBorder`)
     regression-guards this specific failure mode going forward.
3. **DONE (issue #95). `collapsible`** — dropped Radix's `Collapsible` primitive entirely rather
   than reaching for native `<details>`/daisyUI's `.collapse`, the same call tier 2 made for
   `Progress`: `CollapsibleSettingsCard` (the sole call site) already owned its `open` boolean and
   hand-rolled its own visual trigger, and a repo-wide grep found no CSS anywhere keyed to Radix's
   `data-state`/height-animation machinery for it, so there was nothing behavioral left to
   preserve through a wrapper. Replaced with a plain `<button aria-expanded aria-controls>` and a
   genuine conditional render (`{open && <CardContent id={...}>...}`) — content unmounts while
   closed, matching both Radix's prior behavior and `CollapsibleSettingsCard.stories.tsx`'s
   existing `not.toBeInTheDocument()` expectations. No daisyUI class introduced, so no `--border`
   collision risk here.
4. **DONE (issue #95). `scroll-area`** — dropped Radix's `ScrollArea` entirely for a plain
   `overflow-y-auto` div (two nested divs, actually, mirroring Root/Viewport, so a `border`+
   `rounded-lg` container still clips scrolled content to its corners the way the Radix version
   did) — it was purely custom scrollbar chrome over native scrolling at every real call site
   (Codex's 8 tab panels, Settings' 2 model-catalog lists), no keyboard/focus model beyond what
   native scrolling already provides. Kept the native scrollbar visible everywhere (no
   `scrollbar-none`) rather than the swipe-container treatment those call sites don't need: unlike
   `TurnPager`'s snap-scroll pager or Codex's tab strip (which have their own visible navigation
   affordances), none of these lists has any other cue that more content sits below the fold, so
   hiding the browser's native scrollbar there would make content harder to discover, not
   tidier — applied consistently, not decided per file. `data-slot="scroll-area-viewport"` was kept
   on the actual scrolling element so `scroll-area.stories.tsx`'s existing
   `OverflowsAndScrolls` interaction test kept working unmodified. The old `viewportRef` prop was
   dropped — verified via repo-wide grep that no real call site ever passed it, only the primitive
   itself defined it.
5. **DONE (issue #95). `sonner`** — replaced with a hand-rolled toast on daisyUI's `.toast`
   (positioning container) + `.alert` (per-toast styling), per the project owner's explicit
   decision (this was never a Radix wrapper, so "migrate" wasn't a foregone conclusion — see the
   entry this replaced, above). Public surface is deliberately narrow —
   `toast.success(message)`/`toast.error(message)` only, matching every real call site (a
   repo-wide grep found no dynamic variants, promise toasts, custom durations, or action buttons in
   use) — a module-level subscriber store (`src/components/ui/toast.tsx`) holds the current toast
   list, a plain unconditional `setTimeout` per toast drives auto-dismiss (`TOAST_DURATION_MS`,
   4s), and `<Toaster/>` (mounted once at the app root, same as before) subscribes and renders.
   Renamed sonner's `data-sonner-toaster`/`data-sonner-toast` to `data-toast-viewport`/`data-toast`
   across every reference (`tests/helpers.ts`, `tests/voice-kokoro.spec.ts`,
   `tests/voice-elevenlabs.spec.ts` at the time (since deleted outright, issue #97),
   `tests/media-session.spec.ts`) — a deliberate rename since this is no longer sonner, not a
   drift. `next-themes` (previously imported only to feed sonner's
   own `theme` prop) is removed from `package.json`: this app's real dark/light state is the
   `.dark`/`.light` class toggle, which `.alert-success`/`.alert-error` already track for free
   through tier 1's dark-mode bridge (`src/index.css`) — verified against that bridge's existing
   `--color-success`/`--color-error`/`*-content` aliases, no new bridging needed. `--border`
   collision check: the installed daisyUI package's compiled `alert.css` reads `--border` as a
   length (`border-width:var(--border)`), so `.alert` joined `.badge`/`.btn`/`.input`/`.textarea`
   in `src/index.css`'s scoped override list; `toast.css` never references `--border`, so `.toast`
   needed no entry.

   **New problem shape this tier introduced that tiers 1–2 didn't have: hand-rolling
   stacking/auto-dismiss state, not just markup/styling.** A stateless class-swap (tiers 1–2's
   whole story) has no way to leak between renders; a small piece of *module-level* state, on the
   other hand, outlives any one component instance — and that bit it every isolated-component test
   this same PR added. `toast.stories.tsx` initially failed intermittently with "found multiple
   elements with text: Turn applied." because `Toaster` reads its initial list straight from the
   shared module-level array on mount (`useState<ToastItem[]>(toasts)`); a still-pending toast
   (and its still-running dismiss timer) from a *previous* Storybook story leaked straight into the
   next story's freshly-mounted `Toaster`, since nothing had ever cleared it. The real app never
   hits this — there's exactly one `Toaster`, mounted once for the app's entire lifetime, so
   nothing else is around to seed stale state from — but an isolated-component test harness that
   mounts a fresh instance per story doesn't get that guarantee for free. Fixed with a
   `resetToastStore()` (clears the array and cancels every pending `dismiss` timer) called once
   whenever a `Toaster` mounts: a no-op in the real single-mount app, a clean slate for every
   Storybook story. General lesson for anything **later** that reaches for module-level/singleton
   state outside a component (as opposed to `useState`/context scoped to a mount): isolated
   per-story component tests don't tear that down automatically just because the component
   unmounted — clear it explicitly on (re)mount, or a previous test's leftovers can silently
   corrupt the next one's assertions.
6. **`tabs`** — wraps Radix Tabs: real roving-tabindex keyboard nav and `aria-selected`/
   `aria-controls` wiring to reproduce, but no floating/portal positioning. daisyUI's `.tab`/`.tabs`
   are visual-only, so `role="tablist"` semantics and arrow-key handling need to be added by hand.
7. **`dialog`** — wraps Radix Dialog: focus trap, `aria-modal`, return-focus-on-close, Escape-to-
   close, scroll lock. Sounds like the most behavior to reimplement, but daisyUI's own `.modal` is
   built on the **native `<dialog>` element** (confirmed building this PR's own DaisyPreview mock —
   `showModal()`/`<form method="dialog">`), and native `<dialog>` already provides focus trapping,
   Escape-to-close, and top-layer rendering for free, browser-native — likely *less* custom
   behavior to hand-build than Select/DropdownMenu's floating-positioning problem below, despite
   sounding scarier on paper. Worth sequencing before them for that reason.
8. **`dropdown-menu`** — wraps Radix DropdownMenu: floating/collision-aware positioning + roving
   keyboard nav + typeahead + return-focus behavior. Also this app's primary nav surface today
   (`Header.tsx`'s hamburger menu) with the most existing test coverage to keep green
   (`tests/mobile-layout.spec.ts`, `Header.stories.tsx`) — a strong regression net, but also the
   most exposed surface if something regresses.
9. **`select`** — wraps Radix Select: the same floating-positioning + keyboard-nav + typeahead
   problem as DropdownMenu, and the component whose real shadcn-drift bugs (viewport overflow, no
   collision avoidance, missing internal padding — PR #81's independent review) triggered this
   whole migration decision in the first place. Do this one last, once a floating-positioning
   approach has already been proven once on DropdownMenu.

This repo currently has no `popover.tsx` (issue #28's abstract description names Popover as an
example risky component, but nothing here implements one yet) — if one is added before Phase 2, it
belongs alongside DropdownMenu/Select in the riskiest group, for the same floating-positioning
reason.

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
      settings.md               # per-campaign frontmatter — as of issue #77, only
                                #   summarizationCadence (a narrative-pacing choice tied to this
                                #   particular story). AI mode, model choices, STT/TTS provider,
                                #   and voice IDs used to live here too, but the project owner's
                                #   call was that there's no real per-campaign/global difference
                                #   for a device/provider preference — they're global now,
                                #   localStorage-only (see "Settings" under §10 and §11's Direct AI
                                #   mode / Voice architecture notes). An older client's settings.md
                                #   may still have those fields sitting in it — harmlessly ignored
                                #   on read, no longer written back.
      world/
        lore/
          <slug>.md              # one file per long-form lore entry (a location history, a
                                 #   faction writeup, ...) — linked from the Lore sheet tab by
                                 #   filename; short entries just live in the sheet, no file.
                                 #   (Currently a dead stub: the Lore tab's detail_file column
                                 #   exists but nothing reads/writes an actual file here yet —
                                 #   see the npcs/ folder below for the real version of this
                                 #   mechanism, built for NPCs.)
        npcs/
          <slug>.md               # one file per NPC with enough history to need it — append-only,
                                 #   turn-numbered entries written deterministically by the app
                                 #   whenever a turn's state_delta carries new notable NPC detail
                                 #   (npc_updates[].notes_add), not a separate AI call. Linked from
                                 #   the NPCs sheet tab's detail_file column. Only pulled into a
                                 #   turn's prompt when the player's action names that NPC (a
                                 #   simple case-insensitive substring check, the same trick
                                 #   NovelAI/AI Dungeon's "World Info" uses) — every NPC's short
                                 #   `notes` column is sent every turn regardless, cheap since the
                                 #   whole snapshot already is.
      story/
        log/
          0001.md ... NNNN.md    # raw transcript, chunked ~50 turns per file (keeps files small
                                 #   and reads cheap)
        summary/
          rolling.md             # current condensed summary fed to the AI each turn — plain
                                 #   prose, overwritten in place
          checkpoints/            # archived rolling.md snapshots at re-summarization points
      "<campaign-name> — Data" (Google Sheet, one file, one tab per entity type):
        Character      # single-row-ish key/value: name, description, stats (free columns),
                        #   level/XP if used, status effects (comma list) — the AI also maintains
                        #   evolving descriptive keys here (Personality, Current goal, Notable
                        #   relationships, ...) the same way it maintains numeric stats, so the
                        #   player's own profile keeps evolving from play, not just campaign setup.
        Inventory      # id, name, qty, description, tags, acquired_turn, active(bool)
        Skills         # id, name, rank/level, description
        NPCs           # id, name, description, relationship, status, last_seen_turn, voice,
                        #   secrets, notes, detail_file.
                        #   voice: a spoken-style descriptor ("gravelly, clipped sentences") —
                        #     reserved for real TTS voice-switching in a later ticket, not wired
                        #     to playback yet.
                        #   secrets: GM-only ground truth — never rendered anywhere the player can
                        #     see (Play narrative/options, Codex); exists purely so future turns
                        #     don't contradict a fact the player hasn't discovered yet.
                        #   notes: a condensed running summary, rewritten in place on each update
                        #     — same pattern as story/summary/rolling.md, scoped per-NPC.
                        #   detail_file: optional pointer at world/npcs/<slug>.md, once one exists.
                        #   All four, plus NPCAttributes below, are populated only for NPCs with
                        #   real interaction this turn (dialogue, an ongoing role in the scene) —
                        #   a background character mentioned in passing stays name+description
                        #   only, per the Lazy-GM principle of not over-investing in throwaway
                        #   characters (see §5's NPC profile-depth gate).
        NPCAttributes  # npcId, key, value — free-form genre-specific facts about one NPC (a clan
                        #   allegiance in fantasy, cybernetic augments in a heist story, an alibi
                        #   in a mystery), same open-ended key/value shape as Character, just
                        #   scoped per-NPC so new fact types never need a schema migration.
        Monsters       # id, name, description, threat_notes, status, last_encountered_turn
        Timeline       # turn, title, summary, tags
        Quests         # id, title, status, description, updated_turn
        Threads        # id, title, description, status(dormant/active/resolved), revealed(bool),
                        #   progress, progressMax, createdTurn, updatedTurn — GM-only foreshadowed
                        #   threads and ticking threats (issue #83), the story-level equivalent of
                        #   the NPCs tab's `secrets` field: a planted detail/mystery/threat that
                        #   isn't tied to one NPC and can advance/escalate turn to turn, including
                        #   off-screen while the player isn't engaging it directly (the "fronts/
                        #   clocks" pattern from Blades in the Dark / Apocalypse World, plus
                        #   Chekhov's-gun foreshadowing discipline — see §5 and #83's research).
                        #   Distinct from Quests (always player-visible, no hidden state, no
                        #   clock) and Timeline (a log of what already happened, not a live thread
                        #   with momentum of its own). `description` is GM-only ground truth that
                        #   must never appear in the narrative/options/Codex while `revealed` is
                        #   false — same discipline as NPCs.secrets. `progress`/`progressMax` are
                        #   an optional numeric clock (0 means "not using one, just a status");
                        #   the size isn't fixed to any one convention (a 4-clock, 6-clock,
                        #   8-clock are all valid), keeping this genre-agnostic. No Codex/player-
                        #   facing UI exists for this tab — deliberately GM-only, mirroring
                        #   secrets having no dedicated UI either; see #83's PR for the scoping
                        #   rationale.
        Map            # id, name, type, state(discovered/rumored/unexplored), connects_to,
                        #   description, x, y (coords optional — layout can also be force-directed)
        Lore           # id, type, name, summary, tags, discovered(bool), detail_file (optional,
                        #   points at world/lore/<slug>.md for the long version — see the dead-stub
                        #   note on world/lore/ above)
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
   Spoken dialogue can also be wrapped in an invisible `{{v:Name}}...{{/v}}` token pair (`Name`
   matching an NPC's `name` exactly as `npc_updates`/`new_npcs` use it, or the player character's
   own name) — stripped before anything is shown or read aloud, so it never changes what the
   player sees. This is issue #96's speaker-attribution groundwork for epic #36 (multi-voice
   narration): `src/lib/ai/turnBlocks.ts`'s `buildSpokenSegments` splits a turn's spoken text into
   `{text, speaker}` segments at these token boundaries (tolerantly — an unclosed tag ends at the
   next paragraph break, a stray closer is dropped, nesting is treated as a speaker change), and
   `attributeSpeakersHeuristically` offers a separate, opt-in fallback that guesses a speaker for
   quoted dialogue by nearest preceding name when a reply has no real tokens at all (a weaker
   local model, or a manual-mode paste). Nothing consumes the per-speaker split for playback yet —
   every provider still reads `buildSpokenScript`'s single flattened string, byte-identical to
   before this shipped whenever no tokens are present.
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
    "npc_updates": [{
      "name": "Old Maren",
      "voice": "gravelly, clipped sentences",
      "secrets": "she sold the key to the cult, not the other way around",
      "attributes": {"Occupation": "chapel caretaker"},
      "notes_add": "Admitted she's been paid to keep strangers out of the crypt."
    }],
    "new_locations": [{"name": "The Sunken Chapel", "connects_to": "Market Square"}],
    "events": [{"title": "Found the Rusted Key", "summary": "..."}],
    "new_threads": [{
      "title": "The cult beneath the chapel",
      "description": "A cult is quietly preparing a ritual in the crypt below the chapel.",
      "status": "dormant",
      "revealed": false,
      "progress": 0,
      "progressMax": 6
    }],
    "thread_updates": [{"title": "The cult beneath the chapel", "status": "active", "progress": 2}]
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
- **`npc_updates`/`new_npcs` also carry optional profile fields** — `voice`, `secrets`,
  `attributes` (a free-form key/value map), and `notes_add` (new detail worth recording
  permanently) — informed by tabletop-GM and LLM-agent-memory practice (see the research cited in
  [issue #30](https://github.com/typerling/adventure/issues/30)'s scoping discussion: Mike Shea's
  *Lazy GM*, Justin Alexander's *Universal NPC Roleplaying Template*, Stanford/Google's
  *Generative Agents*, and MemGPT's small-bounded-blocks-always-in-context pattern). The AI only
  populates these for an NPC with real interaction this turn (dialogue, an ongoing role in the
  scene) — a background character mentioned in passing stays name+description only, matching the
  Lazy-GM principle of not over-investing in throwaway characters. `secrets` is GM-only ground
  truth (a hidden motive, a lie told) that must never appear in the *narrative*, *options*, or
  Codex — it exists so future turns don't contradict a fact the player hasn't discovered yet, and
  reaching the model on later turns is the whole point, so it's included in the prompt like any
  other documented state. That means it's visible in manual mode's copy/paste textarea (the whole
  built prompt is shown there so you can inspect/paste it — nothing in it can be hidden from
  whoever's relaying it by hand); that's a pre-existing property of manual mode, not a leak this
  introduces. `notes_add` does double duty: the app deterministically (no
  extra AI call) overwrites that NPC's condensed `notes` column with it *and* appends it as a
  turn-numbered entry to `world/npcs/<slug>.md` (creating the file on first use) — same
  summary-plus-detail-file pattern as `LoreEntry`'s `summary`/`detail_file` (see §4), applied for
  real here. The player's own `Character` profile evolves the same way: the contract instructs
  the model to set evolving descriptive keys (`Personality`, `Current goal`, `Notable
  relationships`, ...) via the existing `stat_changes` mechanism (which already sets a
  non-numeric key directly rather than as a delta), so the player's profile keeps developing from
  play instead of staying frozen at campaign setup — no schema change needed for this half.
- **`new_threads`/`thread_updates` (issue #83)** — GM-only foreshadowed threads and ticking
  threats, the story-level equivalent of `npc_updates`/`new_npcs`'s `secrets` field: a planted
  detail, mystery clue, or looming threat that isn't tied to one NPC. Research: TTRPG design has
  two established, related techniques this mirrors — **Chekhov's gun / foreshadowing**, the
  discipline that anything the GM deliberately plants should be assumed to matter later (see
  [Campaign Mastery, "Chekhov's Gun and RPGs"](https://www.campaignmastery.com/blog/chekhovs-gun-and-rpgs/)),
  and **fronts/clocks** (*Blades in the Dark*, *Apocalypse World*), where a looming threat is
  tracked as an explicit countdown that can advance off-screen, giving the world momentum
  independent of the player's current scene rather than a static "quest active" flag (see
  [Gnome Stew, "The GM's Agenda and Principles"](https://gnomestew.com/the-gms-agenda-and-principles/)
  and [Troy Press, "GM Principles & Moves"](https://troypress.com/gm-principles-moves/)). Stored
  in a new `Threads` sheet tab rather than extending `Quests`/`Timeline` (see §4): `Quests` is
  always player-visible with no hidden state or clock, and `Timeline` is a log of what already
  happened, not a live thing that can advance on its own — neither can support "planted but not
  yet shown to the player" or "escalating turn to turn independent of player engagement" without
  overloading their existing, simpler meaning. `thread_updates` is matched by `title` (same
  upsert-by-name pattern `quest_updates` uses) so a thread can be created via `new_threads` in one
  turn and advanced — or flipped from unrevealed to revealed, or resolved — any later turn,
  including one where the player's action has nothing to do with it (the DM is explicitly
  instructed to do this — see `contract.ts`'s "Story threads" section — since that off-screen
  momentum is the entire point of the mechanic per the fronts/clocks research above). `revealed`
  gates player-visibility exactly like `secrets` gates NPC ground truth: while false, a thread's
  `title`/`description` must never appear in the narrative, `options`, or Codex — only in the
  prompt fed back to the model (`renderSnapshot`'s "Story threads" section, filtered to
  `status !== 'resolved'` so paid-off threads don't keep consuming context forever, mirroring
  "Active quests" only showing `status === 'active'`). `progress`/`progressMax` model an optional
  numeric clock (`progressMax: 0` means "not using one, just a status") — sizes aren't fixed to
  any one convention, since different TTRPG clocks use different segment counts and this app
  doesn't mandate one, keeping it genre-agnostic like everything else in the data model. There is
  no Codex/player-facing UI for this tab, a deliberate scoping choice (issue #83's Definition of
  Done explicitly allows it): it's GM-only tracking, and the app already has no dedicated UI for
  NPC `secrets` either — the same reasoning applies here.
- The **system prompt** sent every turn (built by the app, shown in full in manual mode so
  you can inspect/edit it before pasting) includes: DM persona + tone, a short set of
  genre-agnostic standing narrative-craft principles (world/NPC agency — established NPCs pursue
  their own goals rather than just reacting to the player; scene-framing discipline — a few
  concrete, sensory-varied focal points rather than cataloguing a room; pacing variety between
  tense and quieter beats within a scene; and pushing back on repetitive/stock phrasing across
  turns — see [issue #82](https://github.com/typerling/adventure/issues/82)'s research grounding
  in TTRPG-GM and AI-DM-prompting practice), the difficulty rules (§7, which now also carries a
  pacing note per tier — e.g. Standard alternates tense and quiet beats, Brutal stays taut
  throughout), the world/character setup from `campaign.md`, a fresh `batchGet` snapshot of the
  Character/Inventory/NPCs/NPCAttributes/Monsters/Map/Quests/Threads tabs (every known NPC's condensed
  `notes`, `secrets`, and attributes included unconditionally — cheap, the whole snapshot is
  already loaded), the rolling summary from `rolling.md`, the last ~6 raw turns, and a fixed
  instruction block requiring the `state` JSON contract and telling the model to **only** report
  changes that are consistent with the supplied state (no inventing items you already have, no
  NPCs dying twice, etc.) — this is the "review against documented information" the brief asked
  for, folded into generation rather than a separate pass, since a separate AI review pass would
  double the copy/paste burden in manual mode. If the player's action text names a known NPC
  who has a `detail_file` on record, that NPC's full history is pulled in too, under a "Recalled
  history" section — a simple case-insensitive substring match against the action text, the same
  trick NovelAI/AI Dungeon's "World Info" system uses (no embeddings, no new retrieval
  infrastructure).
- **Campaign-arc pacing (issue #88), a different axis from the per-scene pacing bullet above.**
  Left alone, an AI DM tends to just accumulate content over a long campaign — new quests, new
  threads, new NPCs — without ever building toward or reaching a resolution. The standing
  principles add one instruction reading turn count and the current `Quests`/`Threads` snapshot as
  where the story sits in its arc: early on, establish premise and stakes rather than rushing to
  resolve what was just introduced; as the campaign progresses, escalate rather than accumulate —
  active quests/threads should interconnect and deepen (a minor threat growing, a thread's clock
  filling) instead of piling on unrelated new content at the same weight every turn; and when
  several are converging, or a clock is nearly full, build toward a real climax and let it land —
  resolve it (mark the quest completed, the thread resolved) rather than stalling indefinitely.
  Deliberately **prompt-only, no new schema**: `turnNumber`, `Quests`, and `Threads` (added by
  #83) already reach every prompt via `renderSnapshot`, so this is qualitative guidance on reading
  that existing data as a shape over time, not a literal act/phase state machine — TTRPG-arc
  research warns against scripting a rigid structure onto player-driven fiction, and this app's
  own persona already promises not to railroad toward a fixed outcome (see the bullet above).
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
- `huggingface-local` TTS: Kokoro, a small distilled model run fully client-side via
  `kokoro-js`/`transformers.js`. Free, private, no key — but a multi-hundred-MB model download on
  first use and noticeably slower/lower quality on a phone than a hosted API would be. This is the
  app's only non-browser voice provider: ElevenLabs STT/TTS was removed (issue #97) as part of the
  multi-voice narration initiative (epic #36), so there is one voice stack to grow per-speaker
  voices on rather than two to maintain in parallel — see CLAUDE.md's "Removing ElevenLabs" note
  for the backward-compatibility work that took (a legacy `sttProvider`/`ttsProvider: elevenlabs`
  value, wherever it's still sitting, is coerced onto a supported provider rather than silently
  resolving to a dead `null` provider).

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
5. **Settings** — Drive folder picker, account. AI mode (manual/API + key), STT/TTS provider +
   key/voice assignments are global to the device (issue #77 — see §4), not per screen visit;
   summarization cadence is the one setting that stays scoped to whichever campaign is open.

---

## 11. Build phases

1. **Phase 1 (MVP):** Drive auth + folder bootstrap, campaign setup wizard, play screen in
   manual-bridge mode, deterministic state validator, Codex panels, rolling summary. No voice,
   no map yet — get the core loop and data model solid first.
2. **Phase 2:** Voice (browser STT/TTS first, then ElevenLabs + local HF toggles — ElevenLabs was
   later removed entirely, issue #97, leaving browser + local HF/Kokoro), world map view.
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
- Google sign-in on the app installed to an Android home screen doesn't reliably survive a
  reopen — silent token restore appears to fail specifically in that installed-standalone context
  (issue #45; full cited research in `authStore.ts`'s module doc comment). Not fully fixable
  without a backend this app deliberately doesn't have; a `login_hint` mitigation (the third scope
  above) reduces the forced re-login to a single tap, and an in-app note explains the limitation
  rather than hiding it. Unverified against a real device as of this writing — no adb/emulator
  reachable from the implementing/reviewing environments.
- `transformers.js` local TTS model choice/size is still to be pinned down in Phase 2 — will
  benchmark a couple of small models for phone feasibility before committing to one.
- Manual-bridge UX (copy prompt → paste reply) is inherently more friction than a live API
  call; Phase 1 should validate that friction is acceptable before Phase 3 work is prioritized.
