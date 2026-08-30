import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { TurnContent } from './TurnContent'
import {
  attributeSpeakersHeuristically,
  blockToSpokenText,
  buildSpokenSegments,
  splitNarrativeIntoBlocks,
  stripMarkdownToPlainText,
} from '@/lib/ai/turnBlocks'
import { namesFromSnapshot, playerNameFromSnapshot, type SheetSnapshot } from '@/lib/ai/promptBuilder'
import type { TurnBlock } from '@/types/turn'

/**
 * Coverage for issue #96's invisible `{{v:Name}}...{{/v}}` speaker-attribution token — the
 * parsing/segmentation logic in `turnBlocks.ts`, plus the DOM-stripping half in `TurnContent.tsx`.
 * `tests/speaker-attribution.spec.ts` covers the same feature wired into the real turn loop
 * end to end; these stories exercise the pure functions directly (still via a real rendered
 * `TurnContent` for the DOM-leak assertions, since that's this project's established way to run
 * plain-function assertions through `npm run test:stories` — see e.g.
 * `TurnContent.stories.tsx`'s `DuplicateTokenNoLeakMobile`) so each edge case can assert exactly
 * what `buildSpokenSegments` produced, not just eyeball it.
 */

const meta = {
  title: 'App/TurnContent/Speaker tokens',
  component: TurnContent,
  tags: ['autodocs'],
  globals: { viewport: { value: 'mobile' } },
} satisfies Meta<typeof TurnContent>

export default meta
type Story = StoryObj<typeof meta>

function prose(markdown: string): TurnBlock[] {
  return splitNarrativeIntoBlocks(markdown, [])
}

/** The single prose block's raw markdown, for calling turnBlocks.ts functions directly against
 * exactly what buildSpokenSegments itself would see. */
function proseMarkdown(blocks: TurnBlock[]): string {
  const block = blocks.find((b) => b.type === 'prose')
  if (!block || block.type !== 'prose') throw new Error('expected a prose block')
  return block.markdown
}

// ---------------------------------------------------------------------------------------------
// 1. A token never reaches the rendered DOM.
// ---------------------------------------------------------------------------------------------

const TOKEN_NARRATIVE =
  'Old Maren looks up as you enter. {{v:Old Maren}}"Keys like that one don\'t come free," she says.{{/v}} She sets down her cup.'

export const TokenNeverReachesDom: Story = {
  args: { blocks: prose(TOKEN_NARRATIVE) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The dialogue itself renders...
    await expect(canvas.getByText(/Keys like that one don't come free/)).toBeVisible()
    await expect(canvas.getByText(/She sets down her cup/)).toBeVisible()
    // ...but the literal token markup never does.
    expect(canvasElement.textContent).not.toContain('{{v:')
    expect(canvasElement.textContent).not.toContain('{{/v}}')
  },
}

// ---------------------------------------------------------------------------------------------
// 2. Behavior-neutrality: zero tokens in ⇒ exactly one null-speaker segment out, matching
//    today's per-block spoken text exactly.
// ---------------------------------------------------------------------------------------------

const LEGACY_NARRATIVE =
  'Old Maren sets down her cup and studies you for a long moment.\n"You want the key," she says, "but keys like that one don\'t come free."'

export const NoTokensIsBehaviorNeutral: Story = {
  args: { blocks: prose(LEGACY_NARRATIVE) },
  play: async ({ args }) => {
    const segments = buildSpokenSegments(args.blocks)
    const proseBlock = args.blocks.find((b) => b.type === 'prose')
    if (!proseBlock || proseBlock.type !== 'prose') throw new Error('expected a prose block')

    // Exactly one segment, narration (speaker: null) — not split at the quotes at all, since
    // there are no real tokens telling it to split anywhere.
    expect(segments).toHaveLength(1)
    expect(segments[0].speaker).toBeNull()
    // ...and its text is byte-identical to today's blockToSpokenText for the same block — the
    // ticket changes zero observable output until a future ticket consumes per-speaker segments.
    expect(segments[0].text).toBe(blockToSpokenText(proseBlock))
    expect(segments[0].text).toBe(stripMarkdownToPlainText(proseBlock.markdown))
  },
}

// ---------------------------------------------------------------------------------------------
// 3. Tolerant parsing: unclosed tag ends at the paragraph break, not the end of the turn.
// ---------------------------------------------------------------------------------------------

const UNCLOSED_NARRATIVE =
  '{{v:Kael}}"Wait, don\'t go that way."\n\nThe corridor beyond is unlit and cold.'

export const UnclosedTagEndsAtParagraphBreak: Story = {
  args: { blocks: prose(UNCLOSED_NARRATIVE) },
  play: async ({ args }) => {
    const markdown = proseMarkdown(args.blocks)
    const segments = buildSpokenSegments(args.blocks)

    expect(segments).toHaveLength(2)
    expect(segments[0].speaker).toBe('Kael')
    expect(segments[0].text).toContain("Wait, don't go that way")
    // The never-closed tag does NOT bleed into the next paragraph — that stays narration.
    expect(segments[1].speaker).toBeNull()
    expect(segments[1].text).toContain('corridor beyond is unlit and cold')
    // No literal token markup survives anywhere, matched or not.
    expect(markdown).toContain('{{v:Kael}}') // sanity: the input really did have the token
    for (const s of segments) {
      expect(s.text).not.toContain('{{v:')
      expect(s.text).not.toContain('{{/v}}')
    }
  },
}

// ---------------------------------------------------------------------------------------------
// 4. Tolerant parsing: a stray closing tag with no opener is dropped, leaving no trace.
// ---------------------------------------------------------------------------------------------

const STRAY_CLOSER_NARRATIVE = 'The chamber falls silent.{{/v}} Something shifts in the dark.'

export const StrayClosingTagIsDropped: Story = {
  args: { blocks: prose(STRAY_CLOSER_NARRATIVE) },
  play: async ({ canvasElement, args }) => {
    const segments = buildSpokenSegments(args.blocks)

    // The stray closer leaves the two narration halves merged into one continuous segment — not
    // an error, not a visible artifact, and not a pointless extra split either.
    expect(segments).toHaveLength(1)
    expect(segments[0].speaker).toBeNull()
    expect(segments[0].text).toBe('The chamber falls silent. Something shifts in the dark.')

    const canvas = within(canvasElement)
    await expect(canvas.getByText(/The chamber falls silent/)).toBeVisible()
    expect(canvasElement.textContent).not.toContain('{{/v}}')
  },
}

// ---------------------------------------------------------------------------------------------
// 5. No nested tokens: an inner opener while one is already open is treated as a speaker change
//    (not as literal text) — the previous span implicitly closes, the new one starts.
// ---------------------------------------------------------------------------------------------

const NESTED_NARRATIVE = '{{v:A}}Hi {{v:B}}there{{/v}} friend{{/v}}'

export const NestedOpenerIsTreatedAsSpeakerChange: Story = {
  args: { blocks: prose(NESTED_NARRATIVE) },
  play: async ({ args }) => {
    const segments = buildSpokenSegments(args.blocks)

    // A implicitly closes the moment B opens; B's span implicitly closes at its explicit `{{/v}}`;
    // the final `{{/v}}` (which would have closed A under a stack-based model) is then just a
    // stray closer over already-narration text — dropped, per the rule above.
    expect(segments.map((s) => s.speaker)).toEqual(['A', 'B', null])
    expect(segments[0].text).toContain('Hi')
    expect(segments[1].text).toContain('there')
    expect(segments[2].text).toContain('friend')
    for (const s of segments) {
      expect(s.text).not.toContain('{{')
    }
  },
}

// ---------------------------------------------------------------------------------------------
// 6. A token landing mid-sentence splits the sentence rather than being dropped or merged away.
// ---------------------------------------------------------------------------------------------

const MID_SENTENCE_NARRATIVE =
  'The guard barely glances up, muttering {{v:Guard}}"move along"{{/v}} without looking twice.'

export const MidSentenceTokenSplitsTheSentence: Story = {
  args: { blocks: prose(MID_SENTENCE_NARRATIVE) },
  play: async ({ canvasElement, args }) => {
    const segments = buildSpokenSegments(args.blocks)

    expect(segments.map((s) => s.speaker)).toEqual([null, 'Guard', null])
    expect(segments[0].text).toContain('muttering')
    expect(segments[1].text).toContain('move along')
    expect(segments[2].text).toContain('without looking twice')
    // Nothing from the sentence was dropped — every word survives somewhere in order.
    const joined = segments.map((s) => s.text).join(' ')
    expect(joined).toContain('The guard barely glances up')
    expect(joined).toContain('move along')
    expect(joined).toContain('without looking twice')

    const canvas = within(canvasElement)
    await expect(canvas.getByText(/move along/)).toBeVisible()
    expect(canvasElement.textContent).not.toContain('{{v:')
  },
}

// ---------------------------------------------------------------------------------------------
// 7. Heuristic fallback: attributes a quote to the nearest preceding known name, even with two
//    named characters in the same paragraph.
// ---------------------------------------------------------------------------------------------

const AMBIGUOUS_TWO_NAMES =
  'Kael steps forward. Mira watches from the doorway. Kael says, "We should leave now."'

export const HeuristicAttributesNearestPrecedingName: Story = {
  args: { blocks: prose('placeholder') },
  play: async () => {
    const segments = buildSpokenSegments(prose(AMBIGUOUS_TWO_NAMES))
    // No real tokens, so the plain segmentation is just one narration block.
    expect(segments).toHaveLength(1)
    expect(segments[0].speaker).toBeNull()

    const attributed = attributeSpeakersHeuristically(segments, ['Kael', 'Mira'])
    const quoteSegment = attributed.find((s) => s.text.includes('We should leave now'))
    // "Kael" is the nearest preceding mention (right before the quote), not "Mira" (mentioned
    // earlier) — the heuristic doesn't just grab the first name in the paragraph.
    expect(quoteSegment?.speaker).toBe('Kael')
  },
}

// ---------------------------------------------------------------------------------------------
// 8. Heuristic fallback: a quote with no preceding known name at all degrades to narration
//    rather than guessing.
// ---------------------------------------------------------------------------------------------

const NO_PRECEDING_NAME = '"Where did that come from?" The room falls silent.'

export const HeuristicFallsBackToNarrationWithNoPrecedingName: Story = {
  args: { blocks: prose('placeholder') },
  play: async () => {
    const segments = buildSpokenSegments(prose(NO_PRECEDING_NAME))
    const attributed = attributeSpeakersHeuristically(segments, ['Kael', 'Mira'])
    const quoteSegment = attributed.find((s) => s.text.includes('Where did that come from'))
    // No known name appears anywhere before the quote — stays narration, not a confident guess.
    expect(quoteSegment?.speaker).toBeNull()
  },
}

// ---------------------------------------------------------------------------------------------
// 9. Heuristic fallback is a no-op whenever real tokens are already present — tokens always win.
// ---------------------------------------------------------------------------------------------

const REAL_TOKEN_NARRATIVE = '{{v:Kael}}"Get down!"{{/v}} A crossbow bolt splits the air.'

export const HeuristicIsNoOpWhenRealTokensArePresent: Story = {
  args: { blocks: prose('placeholder') },
  play: async () => {
    const segments = buildSpokenSegments(prose(REAL_TOKEN_NARRATIVE))
    // The real token already attributed a segment — attributeSpeakersHeuristically must leave
    // every segment exactly as it found it (it doesn't even scan for quotes to reattribute).
    const attributed = attributeSpeakersHeuristically(segments, ['Kael', 'Mira'])
    // Literally the same array reference — the function returns immediately without touching
    // anything once it sees a real speaker already present.
    expect(attributed).toBe(segments)
  },
}

// ---------------------------------------------------------------------------------------------
// 10. namesFromSnapshot / playerNameFromSnapshot: the player's name comes from the Character
//     tab's "Name" row, and namesFromSnapshot combines it with every known NPC's name — the set
//     of names a `{{v:Name}}` token or the heuristic fallback could plausibly refer to.
// ---------------------------------------------------------------------------------------------

function emptySnapshot(): SheetSnapshot {
  return {
    Character: [],
    Inventory: [],
    Skills: [],
    NPCs: [],
    NPCAttributes: [],
    Monsters: [],
    Timeline: [],
    Quests: [],
    Threads: [],
    Map: [],
    Lore: [],
  }
}

export const NamesFromSnapshotCombinesPlayerAndNpcs: Story = {
  args: { blocks: prose('placeholder') },
  play: async () => {
    const snapshot: SheetSnapshot = {
      ...emptySnapshot(),
      Character: [
        { key: 'Name', value: 'Kael' },
        { key: 'Class', value: 'Ranger' },
      ],
      NPCs: [
        {
          id: 'npc-1',
          name: 'Old Maren',
          description: 'Chapel caretaker',
          relationship: '',
          status: 'alive',
          lastSeenTurn: 1,
          voice: '',
          secrets: '',
          notes: '',
        },
      ],
    }

    expect(playerNameFromSnapshot(snapshot)).toBe('Kael')
    expect(namesFromSnapshot(snapshot)).toEqual(['Kael', 'Old Maren'])
  },
}

export const NamesFromSnapshotHandlesAMissingPlayerName: Story = {
  args: { blocks: prose('placeholder') },
  play: async () => {
    // A hand-edited or ultra-minimal Character tab with no "Name" row at all.
    const snapshot: SheetSnapshot = { ...emptySnapshot(), Character: [{ key: 'Class', value: 'Ranger' }] }

    expect(playerNameFromSnapshot(snapshot)).toBeNull()
    expect(namesFromSnapshot(snapshot)).toEqual([])
  },
}
