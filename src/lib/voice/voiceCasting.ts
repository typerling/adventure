/**
 * Deterministic voice-casting fallback (issue #98, epic #36) — what fills in a Kokoro `voiceId`
 * for a speaking character the AI either couldn't or didn't cast one for. Pure functions only, no
 * Drive/Sheets/Kokoro dependency, so this is cheap to call from `applyDelta.ts` on every turn and
 * to unit-test directly (see `tests/voice-casting.spec.ts`).
 */

import { CASTABLE_KOKORO_VOICE_IDS, KOKORO_VOICE_CATALOG, KOKORO_VOICE_IDS, type KokoroVoiceGender } from './kokoroVoiceCatalog'

/**
 * Soft cap on distinct fallback-assigned voices per campaign. Each voice is a separate ~510KB
 * download (`voices/<id>.bin`, verified on the installed kokoro-js package — see contract.ts's
 * research notes), fetched the first time playback actually uses it — so an unbounded cast is an
 * unbounded, unpredictable amount of background downloading for a player who never asked for it.
 * 8 is chosen as: comfortably more than a typical scene's simultaneous speaking cast (most scenes
 * have 1-3 active speakers, per this app's own difficulty/pacing design intent — see DESIGN.md §5's
 * "keep scenes focused" principle), while still leaving every returning NPC feeling distinct rather
 * than the whole cast collapsing to two or three voices. At the cap, the total extra download this
 * forces is at most 8 * ~510KB ≈ 4MB — trivial next to the Kokoro model itself (tens of MB) or any
 * local text model (hundreds of MB to a few GB) already documented in CLAUDE.md. Voices explicitly
 * cast by the AI (or locked by the player, once #100 ships) don't count against this cap at
 * all — it only bounds how many *automatic fallback* assignments happen without the player or AI
 * ever having chosen to give a character their own voice.
 */
export const VOICE_CAST_SOFT_CAP = 8

/** Simple, fast, deterministic string hash (a standard 32-bit FNV-ish multiply/add) — not
 * cryptographic, just needs to map the same name to the same number every time, in-process and
 * across page loads (no Math.random, no Date, no external state). */
function stableHash(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) >>> 0
  }
  return hash
}

export interface VoiceCastContext {
  /** Voice ids that must never be handed to a fallback-cast character — normally the narrator's
   * and the player's own `voiceId`s, so a background NPC can never accidentally sound identical to
   * either of them. */
  reservedVoiceIds: readonly (string | undefined)[]
  /** Every OTHER character's currently-cast voice id (AI-cast or previously fallback-cast) this
   * campaign, for the soft-cap reuse rule below. Duplicates are fine — deduped internally. */
  inUseVoiceIds: readonly string[]
  /** This character's gender, if known (see applyDelta.ts's `genderForNpc` — sourced from a
   * free-form NPCAttributes "Gender" fact, since the data model deliberately has no hard-coded
   * gender field — see CLAUDE.md's "Genre-agnostic by design"). Undefined means "cast from the
   * whole catalog," not "exclude this character." */
  gender?: KokoroVoiceGender
}

/**
 * Deterministically picks a fallback `voiceId` for `name` — same name + same context always gives
 * the same voice (see `tests/voice-casting.spec.ts`'s determinism test), so a character's voice
 * never drifts between turns/page loads just because the AI didn't cast one every time.
 *
 * Two pools, in priority order:
 * 1. Below the soft cap: an unreserved, gender-matching (if `gender` is known) *castable* voice
 *    (see `CASTABLE_KOKORO_VOICE_IDS` — excludes the D+-or-worse-graded voices a project-owner
 *    listen test flagged as flat/unconvincing), chosen by `stableHash(name) % pool.length`.
 * 2. At/above the soft cap: reuse one of the voices already in play (`inUseVoiceIds`, minus
 *    reserved ones) instead of growing the cast further — preferring a gender match among those if
 *    one exists, otherwise any of them. This means two different characters CAN end up sharing a
 *    voice once the cap is hit; that's the accepted cost of bounding downloads (see
 *    VOICE_CAST_SOFT_CAP's doc comment), not a bug. Deliberately NOT quality-filtered: a voice
 *    already in play (AI-cast, or fallback-cast before the quality list existed) stays reusable
 *    regardless of grade, so the cap's download-bounding purpose isn't undermined by this filter.
 * Falls back to the full, unfiltered catalog (including low-quality voices) only in the fully
 * degenerate case where every *castable* voice is reserved (impossible today — reservedVoiceIds
 * has at most 2 entries against a 16-voice castable pool — kept only so this can never throw or
 * return undefined).
 */
export function deterministicFallbackVoiceId(name: string, ctx: VoiceCastContext): string {
  const reserved = new Set(ctx.reservedVoiceIds.filter((id): id is string => !!id))
  const matchesGender = (id: string) => !ctx.gender || KOKORO_VOICE_CATALOG[id].gender === ctx.gender

  const distinctInUse = [...new Set(ctx.inUseVoiceIds)].filter((id) => !reserved.has(id))
  if (distinctInUse.length >= VOICE_CAST_SOFT_CAP) {
    const genderMatched = distinctInUse.filter(matchesGender)
    const reusePool = genderMatched.length > 0 ? genderMatched : distinctInUse
    return reusePool[stableHash(name) % reusePool.length]
  }

  const freshPool = CASTABLE_KOKORO_VOICE_IDS.filter((id) => !reserved.has(id) && matchesGender(id))
  const castableUnreserved = CASTABLE_KOKORO_VOICE_IDS.filter((id) => !reserved.has(id))
  const unreserved = KOKORO_VOICE_IDS.filter((id) => !reserved.has(id))
  const pool =
    freshPool.length > 0
      ? freshPool
      : castableUnreserved.length > 0
        ? castableUnreserved
        : unreserved.length > 0
          ? unreserved
          : KOKORO_VOICE_IDS
  return pool[stableHash(name) % pool.length]
}

/** Kokoro's `speed` option is a bare float32 multiplier with no documented valid range (see
 * contract.ts's research notes — `generate(text, {voice, speed})` is the entire options surface).
 * This app enforces its own sane bounds rather than passing anything through unchecked: 0.5-2.0x
 * mirrors the range most TTS engines treat as "still intelligible" (halved or doubled pace is
 * already an extreme character choice; further than that risks unusable audio) — a deliberately
 * conservative choice pending real listening feedback, easy to widen later if it proves too tight. */
export const MIN_VOICE_SPEED = 0.5
export const MAX_VOICE_SPEED = 2.0

export function isValidVoiceSpeed(speed: number | undefined): speed is number {
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= MIN_VOICE_SPEED && speed <= MAX_VOICE_SPEED
}
