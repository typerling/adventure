import { test, expect } from '@playwright/test'
import { pauseForVoiceChange } from '../src/lib/voice/kokoroTts'
import { KOKORO_ENTER_DIALOGUE_PAUSE_SEC, KOKORO_EXIT_DIALOGUE_PAUSE_SEC } from '../src/lib/voice/kokoroConstants'

/**
 * Unit coverage for issue #66's pause-at-voice-change arithmetic (kokoroTts.ts's
 * `pauseForVoiceChange`), run directly with no AudioContext/worker involved — the real scheduling
 * wiring (that this actually reaches `nextStartTime`) is covered separately by
 * tests/kokoro-streaming-playback.spec.ts's "a speaker change inserts a pause" test.
 */
test.describe('pauseForVoiceChange (#66)', () => {
  test('no pause before the very first chunk of a call', () => {
    expect(pauseForVoiceChange('af_heart', null, 'af_heart')).toBe(0)
    expect(pauseForVoiceChange('bm_george', null, 'af_heart')).toBe(0)
  })

  test('no pause between two consecutive chunks with the same voice', () => {
    expect(pauseForVoiceChange('af_heart', 'af_heart', 'af_heart')).toBe(0)
    expect(pauseForVoiceChange('bm_george', 'bm_george', 'af_heart')).toBe(0)
    // Same even with no known narrator voice at all.
    expect(pauseForVoiceChange('bm_george', 'bm_george', null)).toBe(0)
  })

  test('leaving the narrator\'s voice for another voice gets the longer "entering dialogue" pause', () => {
    expect(pauseForVoiceChange('bm_george', 'af_heart', 'af_heart')).toBe(KOKORO_ENTER_DIALOGUE_PAUSE_SEC)
  })

  test('returning to the narrator\'s voice gets the shorter "exiting dialogue" pause', () => {
    expect(pauseForVoiceChange('af_heart', 'bm_george', 'af_heart')).toBe(KOKORO_EXIT_DIALOGUE_PAUSE_SEC)
  })

  test('switching directly between two non-narrator voices also gets the "entering dialogue" pause', () => {
    expect(pauseForVoiceChange('am_fenrir', 'bm_george', 'af_heart')).toBe(KOKORO_ENTER_DIALOGUE_PAUSE_SEC)
  })

  test('with no known narrator voice, every voice change gets the flat "entering dialogue" pause', () => {
    expect(pauseForVoiceChange('bm_george', 'af_heart', null)).toBe(KOKORO_ENTER_DIALOGUE_PAUSE_SEC)
    expect(pauseForVoiceChange('af_heart', 'bm_george', null)).toBe(KOKORO_ENTER_DIALOGUE_PAUSE_SEC)
  })

  test('the enter pause is strictly longer than the exit pause, per the issue\'s own suggestion', () => {
    expect(KOKORO_ENTER_DIALOGUE_PAUSE_SEC).toBeGreaterThan(KOKORO_EXIT_DIALOGUE_PAUSE_SEC)
  })
})
