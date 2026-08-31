import { test, expect } from '@playwright/test'
import { deterministicFallbackVoiceId, isValidVoiceSpeed, VOICE_CAST_SOFT_CAP } from '../src/lib/voice/voiceCasting'
import { KOKORO_VOICE_CATALOG, KOKORO_VOICE_IDS } from '../src/lib/voice/kokoroVoiceCatalog'

/**
 * Pure-function coverage for issue #98's deterministic voice-casting fallback — no `page`, no
 * browser, same "pure-function contract, not a rendering concern" pattern as
 * backward-compat-row-shapes.spec.ts's row-codec tests. The end-to-end wiring (applyDelta.ts
 * actually calling this against a real turn) is covered separately in
 * tests/voice-casting-integration.spec.ts.
 */

test.describe('deterministicFallbackVoiceId', () => {
  test('the same character name gets the same voice across two separate calls', () => {
    const ctx = { reservedVoiceIds: [], inUseVoiceIds: [] }
    const first = deterministicFallbackVoiceId('Old Maren', ctx)
    const second = deterministicFallbackVoiceId('Old Maren', ctx)
    expect(first).toBe(second)
    // Same again with a fresh, structurally-equal-but-not-identical context object — the function
    // must not be keying off object identity, just the values.
    const third = deterministicFallbackVoiceId('Old Maren', { reservedVoiceIds: [], inUseVoiceIds: [] })
    expect(third).toBe(first)
  })

  test('different names generally get different voices (not a constant-function bug)', () => {
    const ctx = { reservedVoiceIds: [], inUseVoiceIds: [] }
    const names = ['Old Maren', 'Corin the Warden', 'Bram', 'Captain Reyes', 'The Harbormaster']
    const voices = new Set(names.map((n) => deterministicFallbackVoiceId(n, ctx)))
    expect(voices.size).toBeGreaterThan(1)
  })

  test('every returned id is a real catalog voice', () => {
    const ctx = { reservedVoiceIds: [], inUseVoiceIds: [] }
    for (const name of ['A', 'Zzz', 'A very long character name indeed', '']) {
      expect(KOKORO_VOICE_IDS).toContain(deterministicFallbackVoiceId(name, ctx))
    }
  })

  test('respects a known gender filter', () => {
    for (const name of ['Old Maren', 'Corin the Warden', 'Bram', 'Sailor Jess', 'Watchman Cole']) {
      const male = deterministicFallbackVoiceId(name, { reservedVoiceIds: [], inUseVoiceIds: [], gender: 'Male' })
      expect(KOKORO_VOICE_CATALOG[male].gender).toBe('Male')
      const female = deterministicFallbackVoiceId(name, { reservedVoiceIds: [], inUseVoiceIds: [], gender: 'Female' })
      expect(KOKORO_VOICE_CATALOG[female].gender).toBe('Female')
    }
  })

  test('never picks a reserved (narrator/player) voice, below the soft cap', () => {
    const reservedVoiceIds = ['af_heart', 'am_adam']
    for (const name of ['Old Maren', 'Corin the Warden', 'Bram', 'Sailor Jess', 'Watchman Cole', 'Reyes']) {
      const picked = deterministicFallbackVoiceId(name, { reservedVoiceIds, inUseVoiceIds: [] })
      expect(reservedVoiceIds).not.toContain(picked)
    }
  })

  test('once the soft cap is reached, a new character reuses an already-in-use voice instead of growing the cast', () => {
    const inUseVoiceIds = KOKORO_VOICE_IDS.slice(0, VOICE_CAST_SOFT_CAP) // exactly at the cap
    const picked = deterministicFallbackVoiceId('A brand new character', {
      reservedVoiceIds: [],
      inUseVoiceIds,
    })
    expect(inUseVoiceIds).toContain(picked)
  })

  test('below the soft cap, a fresh character can still get a voice not already in use', () => {
    // Only 2 voices in play — well under the cap of 8 — so a fresh, unreserved catalog voice
    // should still be reachable (not forced to reuse one of the 2).
    const inUseVoiceIds = KOKORO_VOICE_IDS.slice(0, 2)
    const distinctPicks = new Set(
      ['name one', 'name two', 'name three', 'name four', 'name five'].map((n) =>
        deterministicFallbackVoiceId(n, { reservedVoiceIds: [], inUseVoiceIds }),
      ),
    )
    // At least one pick should fall outside the tiny in-use set — proving the fallback isn't
    // *always* reusing, only once the cap is actually hit.
    expect([...distinctPicks].some((id) => !inUseVoiceIds.includes(id))).toBe(true)
  })
})

test.describe('isValidVoiceSpeed', () => {
  test('accepts the documented range and rejects outside it', () => {
    expect(isValidVoiceSpeed(1)).toBe(true)
    expect(isValidVoiceSpeed(0.5)).toBe(true)
    expect(isValidVoiceSpeed(2.0)).toBe(true)
    expect(isValidVoiceSpeed(0.49)).toBe(false)
    expect(isValidVoiceSpeed(2.01)).toBe(false)
    expect(isValidVoiceSpeed(-1)).toBe(false)
    expect(isValidVoiceSpeed(Number.NaN)).toBe(false)
    expect(isValidVoiceSpeed(undefined)).toBe(false)
  })
})
