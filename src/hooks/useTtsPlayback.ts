import { useEffect, useRef, useState } from 'react'
import type { TtsProvider as TtsProviderKind } from '@/types/campaign'
import { getTtsProvider } from '@/lib/voice/getProvider'
import type { TtsProvider } from '@/lib/voice/types'
import { describeKokoroProgress } from '@/lib/voice/kokoroTts'

export type TtsPlaybackState = 'idle' | 'loading' | 'playing' | 'paused'

interface UseTtsPlaybackOptions {
  ttsProviderKind: TtsProviderKind | undefined
  voice: string | undefined
  campaignName: string | undefined
  onError: (message: string) => void
}

export interface TtsPlayback {
  state: TtsPlaybackState
  activeTurn: number | null
  /** Kokoro's first-use model download status — see the same field's old home in Play.tsx. */
  voiceLoadMessage: string
  play: (text: string, turn: number | null, chainText?: string) => void
  /** Pauses/resumes if `turn` is already the active one, otherwise starts it fresh (superseding
   * whatever was playing) — the shared behavior behind every per-turn "play this turn" button. */
  toggleTurn: (turn: number, text: string, chainText?: string) => void
  /** The header's single master control: idle starts the latest turn, playing pauses, paused
   * resumes, loading is a no-op (the header button is disabled while loading anyway). */
  handleHeaderToggle: (latestTurn: number | undefined, latestText: string | undefined, chainText?: string) => void
  stop: () => void
}

/**
 * One centralized TTS player shared by the header's master play/pause control and every per-turn
 * "play this turn" button — only one utterance plays at a time, and pausing/resuming/stopping
 * always acts on whichever one that is, regardless of which control triggered it. Wired to
 * `navigator.mediaSession` so OS/headphone play-pause controls work while a turn (or its chained
 * options, see `chainText`) is being read aloud.
 */
export function useTtsPlayback(opts: UseTtsPlaybackOptions): TtsPlayback {
  const [state, setState] = useState<TtsPlaybackState>('idle')
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const [voiceLoadMessage, setVoiceLoadMessage] = useState('')

  // Mirror the state above in refs so pause()/resume()/stop() — including when invoked from
  // navigator.mediaSession action handlers registered on an earlier render — always act on the
  // *current* playback instead of a stale closure's view of it.
  const stateRef = useRef<TtsPlaybackState>('idle')
  const activeTurnRef = useRef<number | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  /** Cached by provider *kind*, not recreated per call — ElevenLabs/Kokoro track their currently
   * playing audio per instance, so a fresh instance per call would leave pause()/stop() unable to
   * reach audio an earlier instance started. */
  const providerRef = useRef<{ kind: TtsProviderKind; provider: TtsProvider } | null>(null)
  /** Bumped on every play()/stop() so a superseded utterance's eventual settle (resolve or
   * reject) is recognized as stale and doesn't clobber whatever replaced it. */
  const playTokenRef = useRef(0)

  function setPlaybackState(next: TtsPlaybackState, turn: number | null) {
    stateRef.current = next
    activeTurnRef.current = turn
    setState(next)
    setActiveTurn(turn)
  }

  function getProvider(): TtsProvider | null {
    const kind = optsRef.current.ttsProviderKind
    if (!kind) return null
    if (providerRef.current?.kind === kind) return providerRef.current.provider
    const provider = getTtsProvider(kind, {
      onKokoroLoadProgress: (p) => setVoiceLoadMessage(describeKokoroProgress(p)),
    })
    if (!provider) return null
    providerRef.current = { kind, provider }
    return provider
  }

  function updateMediaSession(turn: number | null, status: 'playing' | 'paused' | 'none') {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    if (status === 'none') {
      session.playbackState = 'none'
      session.setActionHandler('play', null)
      session.setActionHandler('pause', null)
      session.setActionHandler('stop', null)
      return
    }
    if (turn !== null) {
      session.metadata = new MediaMetadata({
        title: `Turn ${turn}`,
        artist: optsRef.current.campaignName ?? 'Adventure',
        album: 'Adventure',
      })
    }
    session.playbackState = status
    session.setActionHandler('play', () => resume())
    session.setActionHandler('pause', () => pause())
    session.setActionHandler('stop', () => stop())
  }

  function stop() {
    playTokenRef.current++
    providerRef.current?.provider.stop()
    setVoiceLoadMessage('')
    setPlaybackState('idle', null)
    updateMediaSession(null, 'none')
  }

  function pause() {
    if (stateRef.current !== 'playing') return
    providerRef.current?.provider.pause()
    setPlaybackState('paused', activeTurnRef.current)
    updateMediaSession(activeTurnRef.current, 'paused')
  }

  function resume() {
    if (stateRef.current !== 'paused') return
    providerRef.current?.provider.resume()
    setPlaybackState('playing', activeTurnRef.current)
    updateMediaSession(activeTurnRef.current, 'playing')
  }

  /** Speaks `text` for `turn`, superseding any current playback. If `chainText` is given and this
   * utterance finishes naturally (not stopped/superseded), immediately speaks `chainText` next as
   * the same continuous playback — how a narrated turn flows straight into its spoken options. */
  function play(text: string, turn: number | null, chainText?: string) {
    const provider = getProvider()
    if (!provider) {
      optsRef.current.onError("Text-to-speech isn't available — check Settings or your browser's support.")
      return
    }
    const token = ++playTokenRef.current
    setPlaybackState('loading', turn)

    provider
      .speak(text, {
        voice: optsRef.current.voice,
        onStateChange: (s) => {
          if (token !== playTokenRef.current) return
          setPlaybackState(s, turn)
          if (s === 'playing') updateMediaSession(turn, 'playing')
        },
      })
      .then(() => {
        setVoiceLoadMessage('')
        if (token !== playTokenRef.current) return // superseded or stopped mid-flight
        if (chainText) {
          play(chainText, turn)
          return
        }
        setPlaybackState('idle', null)
        updateMediaSession(null, 'none')
      })
      .catch((err) => {
        setVoiceLoadMessage('')
        if (token !== playTokenRef.current) return
        optsRef.current.onError(err instanceof Error ? err.message : 'Failed to read this aloud.')
        setPlaybackState('idle', null)
        updateMediaSession(null, 'none')
      })
  }

  function toggleTurn(turn: number, text: string, chainText?: string) {
    if (activeTurnRef.current === turn) {
      if (stateRef.current === 'playing') {
        pause()
        return
      }
      if (stateRef.current === 'paused') {
        resume()
        return
      }
      return // loading — the button is disabled in this state, ignore a stray click.
    }
    play(text, turn, chainText)
  }

  function handleHeaderToggle(latestTurn: number | undefined, latestText: string | undefined, chainText?: string) {
    if (stateRef.current === 'playing') {
      pause()
      return
    }
    if (stateRef.current === 'paused') {
      resume()
      return
    }
    if (stateRef.current === 'idle') {
      if (latestTurn === undefined || !latestText) return
      play(latestText, latestTurn, chainText)
    }
    // loading — the header control is disabled in this state, ignore a stray click.
  }

  useEffect(() => {
    // These are plain mutable-value refs (not DOM node refs), so reading `.current` here — at
    // unmount, to stop whatever's still playing — is the correct, intended use.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      playTokenRef.current++
      providerRef.current?.provider.stop()
      updateMediaSession(null, 'none')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, activeTurn, voiceLoadMessage, play, toggleTurn, handleHeaderToggle, stop }
}
