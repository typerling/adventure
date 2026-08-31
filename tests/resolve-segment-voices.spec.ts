import { test, expect } from '@playwright/test'
import { resolveSegmentVoices } from '../src/lib/voice/resolveSegmentVoices'
import { DEFAULT_VOICE, KOKORO_DIALOGUE_SPEED, KOKORO_NARRATION_SPEED } from '../src/lib/voice/kokoroConstants'
import type { Npc } from '../src/types/sheets'
import type { SpokenSegment } from '../src/types/turn'

/**
 * Unit coverage for issue #66's `resolveSegmentVoices` — the pure function that maps #96's
 * `SpokenSegment[]` (speaker: null | NPC name | the player's own name) to a concrete Kokoro
 * voice/speed per segment, run directly (no `page` fixture, mirroring `tests/voice-casting.spec.ts`'s
 * identical pattern for the deterministic-fallback pure functions it covers).
 */

function npc(overrides: Partial<Npc> & { name: string }): Npc {
  return {
    id: overrides.id ?? `npc-${overrides.name}`,
    name: overrides.name,
    description: '',
    relationship: '',
    status: 'alive',
    lastSeenTurn: 1,
    voice: '',
    secrets: '',
    notes: '',
    voiceId: '',
    voiceSpeed: 0,
    voiceLocked: false,
    ...overrides,
  }
}

test.describe('resolveSegmentVoices (#66)', () => {
  test('a narration segment (speaker: null) gets the narrator voice, at narration speed', () => {
    const segments: SpokenSegment[] = [{ text: 'The hallway is silent.', speaker: null }]
    const result = resolveSegmentVoices(segments, { narratorVoiceId: 'bm_george', npcs: [] })
    expect(result.narratorVoice).toBe('bm_george')
    expect(result.segments).toEqual([{ text: 'The hallway is silent.', voice: 'bm_george', speed: KOKORO_NARRATION_SPEED }])
  })

  test('an unset narrator voice falls back to Kokoro\'s own DEFAULT_VOICE, not an empty string', () => {
    const segments: SpokenSegment[] = [{ text: 'A door stands ajar.', speaker: null }]
    const result = resolveSegmentVoices(segments, { npcs: [] })
    expect(result.narratorVoice).toBe(DEFAULT_VOICE)
    expect(result.segments[0].voice).toBe(DEFAULT_VOICE)
  })

  test('the player character\'s own dialogue gets CampaignSettings.playerVoiceId, at dialogue speed', () => {
    const segments: SpokenSegment[] = [{ text: '"I am ready."', speaker: 'Kael' }]
    const result = resolveSegmentVoices(segments, {
      narratorVoiceId: 'af_heart',
      playerVoiceId: 'am_fenrir',
      playerName: 'Kael',
      npcs: [],
    })
    expect(result.segments).toEqual([{ text: '"I am ready."', voice: 'am_fenrir', speed: KOKORO_DIALOGUE_SPEED }])
  })

  test('an uncast player voice (playerVoiceId unset) degrades to the narrator\'s voice rather than an empty one', () => {
    const segments: SpokenSegment[] = [{ text: '"Wait."', speaker: 'Kael' }]
    const result = resolveSegmentVoices(segments, { narratorVoiceId: 'af_heart', playerName: 'Kael', npcs: [] })
    expect(result.segments[0].voice).toBe('af_heart')
  })

  test('an NPC\'s dialogue gets their own cast voiceId', () => {
    const segments: SpokenSegment[] = [{ text: '"State your business."', speaker: 'Harbormaster Voss' }]
    const result = resolveSegmentVoices(segments, {
      narratorVoiceId: 'af_heart',
      npcs: [npc({ name: 'Harbormaster Voss', voiceId: 'bm_george' })],
    })
    expect(result.segments[0].voice).toBe('bm_george')
    expect(result.segments[0].speed).toBe(KOKORO_DIALOGUE_SPEED)
  })

  test('an NPC\'s own explicit voiceSpeed (a positive value) overrides the default dialogue speed', () => {
    const segments: SpokenSegment[] = [{ text: '"Slowly now."', speaker: 'Old Maren' }]
    const result = resolveSegmentVoices(segments, {
      npcs: [npc({ name: 'Old Maren', voiceId: 'af_bella', voiceSpeed: 0.7 })],
    })
    expect(result.segments[0]).toEqual({ text: '"Slowly now."', voice: 'af_bella', speed: 0.7 })
  })

  test('NPC name matching is case/whitespace-insensitive, same as applyDelta.ts\'s sameName convention', () => {
    const segments: SpokenSegment[] = [{ text: '"Hello."', speaker: '  old maren ' }]
    const result = resolveSegmentVoices(segments, { npcs: [npc({ name: 'Old Maren', voiceId: 'af_bella' })] })
    expect(result.segments[0].voice).toBe('af_bella')
  })

  test('a speaker name matching no known NPC at all degrades to the narrator\'s voice, not dropped or thrown', () => {
    // Issue #105's caveat, called out explicitly in #66: an AI paraphrase (or the heuristic
    // fallback guessing at a name) can produce a speaker with no matching NPC row. The segment's
    // text must still come through, just spoken in the narrator's voice.
    const segments: SpokenSegment[] = [{ text: '"Who goes there?"', speaker: 'A Stranger In The Fog' }]
    const result = resolveSegmentVoices(segments, {
      narratorVoiceId: 'bf_emma',
      npcs: [npc({ name: 'Old Maren', voiceId: 'af_bella' })],
    })
    expect(result.segments).toEqual([{ text: '"Who goes there?"', voice: 'bf_emma', speed: KOKORO_DIALOGUE_SPEED }])
  })

  test('an NPC known to the sheet but never cast a voiceId (empty string) also degrades to the narrator\'s voice', () => {
    const segments: SpokenSegment[] = [{ text: '"..."', speaker: 'Uncast Npc' }]
    const result = resolveSegmentVoices(segments, {
      narratorVoiceId: 'bf_emma',
      npcs: [npc({ name: 'Uncast Npc', voiceId: '' })],
    })
    expect(result.segments[0].voice).toBe('bf_emma')
  })

  test('a mixed turn resolves each segment independently, in order', () => {
    const segments: SpokenSegment[] = [
      { text: 'The room falls quiet.', speaker: null },
      { text: '"Keys like that don\'t come free."', speaker: 'Old Maren' },
      { text: 'You step back.', speaker: null },
      { text: '"Fine."', speaker: 'Kael' },
    ]
    const result = resolveSegmentVoices(segments, {
      narratorVoiceId: 'af_heart',
      playerVoiceId: 'am_fenrir',
      playerName: 'Kael',
      npcs: [npc({ name: 'Old Maren', voiceId: 'bm_george' })],
    })
    expect(result.segments.map((s) => s.voice)).toEqual(['af_heart', 'bm_george', 'af_heart', 'am_fenrir'])
  })
})
