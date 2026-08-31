/**
 * Maps a turn's #96 `SpokenSegment[]` to a concrete Kokoro voice/speed per segment (issue #66) —
 * the piece `kokoroTts.ts`'s own module doc comment ("Multi-voice playback") calls out as living
 * outside that file: kokoroTts.ts stays free of any Sheets/campaign-domain dependency, so *voice
 * resolution* (narrator/player/NPC lookup) is this module's job, called from `Play.tsx` (which
 * already holds the campaign snapshot and settings this needs) before handing the result to
 * `TtsProvider.speak`'s `segments` option. Pure functions only — no Drive/Sheets/Kokoro dependency
 * — same reasoning as `voiceCasting.ts`'s identical split, and just as cheap to unit-test directly.
 */

import type { Npc } from '@/types/sheets'
import type { SpokenSegment } from '@/types/turn'
import type { TtsSpeakSegment } from './types'
import { DEFAULT_VOICE, KOKORO_DIALOGUE_SPEED, KOKORO_NARRATION_SPEED } from './kokoroConstants'

export interface SegmentVoiceContext {
  /** `GlobalSettings.kokoroVoiceId` — the narrator's voice. Undefined means "use Kokoro's own
   * DEFAULT_VOICE," same convention as everywhere else this field is read. */
  narratorVoiceId?: string
  /** `CampaignSettings.playerVoiceId` — the player character's voice. Undefined means "no voice
   * has been cast for the player yet," which falls back to the narrator's voice (still a distinct,
   * intentional choice from silently dropping the player's lines — see resolveSegmentVoices' doc
   * comment below). */
  playerVoiceId?: string
  /** The player character's own name, as it appears in the Character tab (promptBuilder.ts's
   * playerNameFromSnapshot) — null if the campaign has no "Name" row at all. Used only to tell a
   * player-voiced segment apart from an NPC-voiced one; a null here just means every non-null
   * speaker is looked up against `npcs` instead. */
  playerName?: string | null
  /** The campaign's current NPCs sheet snapshot — matched by name (case/whitespace-insensitive,
   * same `sameName` convention `applyDelta.ts` already uses for this exact lookup). */
  npcs: readonly Npc[]
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Resolves every segment to a concrete `{text, voice, speed}` plus the narrator's own resolved
 * voice (so a caller can pass it through as `TtsProvider.speak`'s `narratorVoice` hint for
 * asymmetric pause lengths — see kokoroTts.ts's pauseForVoiceChange).
 *
 * Resolution order per segment:
 * 1. `speaker === null` (narration) → the narrator's voice, at `KOKORO_NARRATION_SPEED`.
 * 2. `speaker` matches the player character's own name → the player's cast voice (falling back to
 *    the narrator's own voice if the player hasn't been cast one — see `playerVoiceId`'s own doc
 *    comment), at `KOKORO_DIALOGUE_SPEED`.
 * 3. `speaker` matches a known NPC's name with a cast `voiceId` → that NPC's voice, at their own
 *    `voiceSpeed` if they have one set (a positive value — 0 is the sheet's "not set" sentinel, see
 *    `Npc.voiceSpeed`'s own doc comment), else `KOKORO_DIALOGUE_SPEED`.
 * 4. Anything else — a `speaker` that doesn't resolve to any known NPC at all (issue #105: an AI
 *    name paraphrase can create a duplicate, unlocked NPC row instead of matching the real one; or
 *    the heuristic fallback in `attributeSpeakersHeuristically` guessed at a name with no matching
 *    NPC anywhere) — degrades to the narrator's voice rather than throwing or silently dropping
 *    that segment's audio, per this ticket's explicit requirement. Still spoken at
 *    `KOKORO_DIALOGUE_SPEED`, since it's still dialogue content even though it ends up in the
 *    narrator's voice.
 */
export function resolveSegmentVoices(
  segments: readonly SpokenSegment[],
  ctx: SegmentVoiceContext,
): { segments: TtsSpeakSegment[]; narratorVoice: string } {
  const narratorVoice = ctx.narratorVoiceId || DEFAULT_VOICE

  const resolved = segments.map((segment): TtsSpeakSegment => {
    if (segment.speaker === null) {
      return { text: segment.text, voice: narratorVoice, speed: KOKORO_NARRATION_SPEED }
    }
    if (ctx.playerName && sameName(segment.speaker, ctx.playerName)) {
      return { text: segment.text, voice: ctx.playerVoiceId || narratorVoice, speed: KOKORO_DIALOGUE_SPEED }
    }
    const npc = ctx.npcs.find((n) => sameName(n.name, segment.speaker as string))
    if (npc?.voiceId) {
      return {
        text: segment.text,
        voice: npc.voiceId,
        speed: npc.voiceSpeed > 0 ? npc.voiceSpeed : KOKORO_DIALOGUE_SPEED,
      }
    }
    // Degrade to the narrator's voice — see this function's doc comment, point 4.
    return { text: segment.text, voice: narratorVoice, speed: KOKORO_DIALOGUE_SPEED }
  })

  return { segments: resolved, narratorVoice }
}
