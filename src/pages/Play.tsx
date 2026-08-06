import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowUp, CircleAlert, Loader2, Mic, MicOff, Square, Volume2 } from 'lucide-react'
import { useCampaign } from '@/hooks/useCampaign'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { DEFAULT_SETTINGS, type TtsProvider as TtsProviderKind } from '@/types/campaign'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { TurnOption, TurnRecord, ValidationIssue } from '@/types/turn'
import { getSttProvider, getTtsProvider, isSttProviderAvailable, isTtsProviderAvailable } from '@/lib/voice/getProvider'
import type { SttProvider, TtsProvider } from '@/lib/voice/types'
import { describeKokoroGenerateProgress, describeKokoroProgress } from '@/lib/voice/kokoroTts'
import {
  clearMediaSession,
  setMediaSessionHandlers,
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
} from '@/lib/voice/mediaSession'
import { generateClaudeReply } from '@/lib/ai/claudeProvider'
import { describeLocalModelProgress, generateLocalReply } from '@/lib/ai/localModel'
import { buildSpokenScript, splitNarrativeIntoBlocks } from '@/lib/ai/turnBlocks'
import { TurnPager, type TurnPagerPage } from '@/components/TurnPager'

type DialogStage = 'closed' | 'prompt'

/** Turns a logged turn into its render/speak block sequence (see turnBlocks.ts). Options are only
 * included for the currently-live turn (`interactive`) — historical turns render/speak prose
 * only, matching today's behavior where only the latest turn's options are ever offered again.
 *
 * `optionsOffered` on a `TurnRecord` only ever carries plain labels (story/log/*.md has no
 * persisted `manus` — see useCampaign.ts), so without `optionsOverride` manus here always falls
 * back to the label. `optionsOverride` is how the *just-applied* live turn gets manus fidelity
 * anyway: `handleSubmitReply` below captures the freshly-parsed `{label, manus?}` options (from
 * `SubmitOutcome`) before they're downgraded to labels-only in `recentTurns`, and passes them
 * through for that one turn's narration. */
function blocksForTurn(turn: TurnRecord, interactive: boolean, optionsOverride?: TurnOption[]) {
  const items: TurnOption[] = interactive ? (optionsOverride ?? turn.optionsOffered.map((label) => ({ label }))) : []
  return splitNarrativeIntoBlocks(turn.narrative, items)
}

export function Play() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const data = useCampaign(campaignId)
  const { status, errorMessage, campaign, snapshot, recentTurns, settings, buildPromptForAction, submitReply } = data

  const [freeText, setFreeText] = useState('')
  /** The action awaiting a reply. A ref, not state, because auto modes kick off generation in the
   * same tick they record it — a state setter wouldn't have re-rendered yet, so the generation
   * closure would still see the *previous* turn's action and persist that to the story log. */
  const pendingActionRef = useRef('')
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')
  const [stage, setStage] = useState<DialogStage>('closed')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [streamPreview, setStreamPreview] = useState('')
  /** Local model's download percentage, if the current status update has one — null once
   * generation moves past downloading (e.g. into token streaming), where a percentage no
   * longer applies. */
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)

  const [listening, setListening] = useState(false)
  /** Turn number currently being read aloud (by auto-narrate or a manual per-turn button), if
   * any — drives which turn's button shows a stop icon instead of a play icon. */
  const [playingTurn, setPlayingTurn] = useState<number | null>(null)
  /** Kokoro's first-use model download status, shown next to the story log so read-aloud doesn't
   * look frozen while it fetches. Empty once loaded (or for providers with nothing to download). */
  const [voiceLoadMessage, setVoiceLoadMessage] = useState('')
  const readAloud = usePlayHeaderStore((s) => s.readAloud)
  const setHeaderContext = usePlayHeaderStore((s) => s.setContext)
  const sttProviderRef = useRef<SttProvider | null>(null)
  /** Kept alongside the provider *kind* so a settings change gets a fresh instance, but repeated
   * speak() calls for the same kind reuse one — ElevenLabs/Kokoro track their currently-playing
   * audio per instance, so a fresh instance per call meant stop() could never reach audio started
   * by an earlier instance. */
  const ttsProviderRef = useRef<{ kind: TtsProviderKind; provider: TtsProvider } | null>(null)
  /** The text/turn most recently handed to speakText() — lets the OS-level Media Session "play"
   * control (see mediaSession.ts) restart narration after a "pause", since no TtsProvider
   * implementation can genuinely resume mid-utterance. */
  const lastSpokenRef = useRef<{ text: string; turn?: number } | null>(null)
  /** Always the current render's speakText — see the useEffect below that keeps it in sync. The
   * Media Session's onPlay handler (registered inside speakText itself, see below) calls through
   * this ref rather than self-referencing speakText by name directly: speakText is a useCallback
   * memoized on settings/campaignName/turnLabel, and a handler registered by one call of it closes
   * over *that* call's specific closure — if any of those deps change while a turn sits paused,
   * calling speakText by name from within its own old closure would still run with the stale
   * values, not the current ones. Reading through this ref instead always gets the latest. */
  const speakTextRef = useRef<((text: string, turn?: number) => void) | null>(null)
  /** Bumped on every speakText() call; a pending speak() promise's `finally` only clears the Media
   * Session if it's still the most recent call — otherwise it would wipe out a session that
   * actually belongs to a newer, still-playing turn (one playback pre-empting another). */
  const mediaSessionTokenRef = useRef(0)
  /** True from the moment speakText() sets Media Session metadata/handlers until something
   * actually clears them (a hard stop, or a natural end's finally). Guards pausePlayback: an OS
   * "pause" tap can arrive just after playback already ended naturally and cleared the session on
   * its own — without this check, pausePlayback would unconditionally write playbackState:
   * 'paused' onto a session with no metadata and no live handlers, stuck that way until the next
   * speakText() call overwrites it. */
  const mediaSessionLiveRef = useRef(false)
  /** The last turn number we've already spoken aloud — set to the campaign's current turn on
   * load so resuming a session never re-narrates history, only turns completed from here on. */
  const spokenTurnRef = useRef<number | null>(null)
  /** The freshly-parsed `{label, manus?}` options for the turn most recently applied via
   * handleSubmitReply, keyed by turn number so a stale value from an earlier turn is never
   * mistaken for the current one. See blocksForTurn's doc comment for why this exists — it's the
   * one place manus data survives long enough to actually be spoken. */
  const pendingSpokenOptionsRef = useRef<{ turn: number; options: TurnOption[] } | null>(null)
  const prevReadAloudRef = useRef(readAloud)
  /** The pager's current page index, reported by TurnPager's onCurrentIndexChange — the single
   * source of truth for "where is the player looking," replacing the old scroll-position-derived
   * isAtBottom. Starts `null` (meaning "assume the latest page" — see isOnLatestPage below) so
   * the free-text input doesn't flash hidden for the one render before the pager reports in. */
  const [currentPageIndex, setCurrentPageIndex] = useState<number | null>(null)
  /** Whether the free-text box currently has focus — kept separate from page position so that an
   * incidental page-position change (e.g. a new turn arriving mid-typing) never yanks away an
   * input the player is mid-composing in. Without this, the input row would hard-unmount under a
   * focused textarea, silently dropping keyboard focus with no way to get it back short of paging
   * forward again and clicking in again. */
  const [inputFocused, setInputFocused] = useState(false)

  const lastTurn = recentTurns.at(-1)
  /** True once the player is looking at the live/last turn — gates the free-text input the same
   * way isAtBottom used to, just against page position instead of scroll position. Defaults to
   * true (via the `null` check) until TurnPager reports its actual starting index. */
  const isOnLatestPage =
    recentTurns.length === 0 || currentPageIndex === null || currentPageIndex === recentTurns.length - 1
  const handleCurrentPageIndexChange = useCallback((index: number) => setCurrentPageIndex(index), [])

  const sttAvailable = Boolean(settings) && isSttProviderAvailable(settings!.sttProvider)
  const ttsAvailable = Boolean(settings) && isTtsProviderAvailable(settings!.ttsProvider)
  const isApiMode = settings?.aiMode === 'api'
  const isLocalMode = settings?.aiMode === 'local'
  const isAutoMode = isApiMode || isLocalMode
  const campaignName = campaign?.meta.name
  const turnLabel = campaign ? `Turn ${campaign.meta.currentTurn} · ${campaign.meta.currentLocation}` : null

  // The top-bar header (src/App.tsx) is a sibling, not a parent, of this page — it can't read
  // props from here, so this pushes what it needs (title, Codex/Settings links, whether to show
  // the Read-aloud toggle, the turn/location line) into a shared store instead. Cleared on
  // unmount so navigating away doesn't leave a stale campaign context showing on Dashboard.
  useEffect(() => {
    if (!campaignId || !campaignName) return
    setHeaderContext({ campaignId, campaignName, showReadAloudToggle: ttsAvailable, turnLabel })
    return () => setHeaderContext(null)
  }, [campaignId, campaignName, ttsAvailable, turnLabel, setHeaderContext])

  useEffect(() => {
    if (spokenTurnRef.current === null && campaign) {
      spokenTurnRef.current = campaign.meta.currentTurn
    }
  }, [campaign])

  /** Distinguishes the two ways a speak() in flight can be interrupted, read once by speakText's
   * `finally` (guarded by mediaSessionTokenRef, same as elsewhere) to decide whether to clear the
   * Media Session or leave it showing a "paused" state — see pausePlayback's doc comment for why
   * that distinction exists. Reset at the start of every speakText call, so a natural end (no stop
   * requested at all) always sees 'hard' and clears normally. */
  const pendingStopModeRef = useRef<'hard' | 'soft'>('hard')

  /** Fully stops any current narration, in-app and OS-level alike — clears the Media Session
   * notification entirely (see mediaSession.ts) rather than leaving a dead one visible. The single
   * hard-stop path shared by the per-turn stop button, the Read-aloud toggle turning off, and the
   * OS "stop" media control. */
  const stopPlayback = useCallback(() => {
    pendingStopModeRef.current = 'hard'
    ttsProviderRef.current?.provider.stop()
    setPlayingTurn(null)
    clearMediaSession()
    mediaSessionLiveRef.current = false
  }, [])

  /** Stops the underlying audio like stopPlayback, but — unlike it — deliberately leaves the Media
   * Session's metadata and action handlers in place, only moving its playback state to 'paused'.
   * This exists solely for the OS "pause" media control: none of the three TtsProvider
   * implementations support real pause/resume (see types.ts), so there's no way to actually resume
   * mid-utterance — but a "pause" tap that made the whole Now Playing notification vanish (as a
   * full stop would) leaves no way to resume at all, since its "play" button would vanish with it.
   * Keeping the session alive means the OS "play" control (wired in speakText below) can still
   * restart the same turn from the beginning — a real, working action, just not a true resume. */
  const pausePlayback = useCallback(() => {
    pendingStopModeRef.current = 'soft'
    ttsProviderRef.current?.provider.stop()
    setPlayingTurn(null)
    // If playback already ended naturally (and speakText's finally already cleared the session)
    // just before this OS pause tap arrived, there's no live session left to move to 'paused' —
    // see mediaSessionLiveRef's doc comment.
    if (mediaSessionLiveRef.current) {
      setMediaSessionPlaybackState('paused')
    }
  }, [])

  // Reacts to the header's Read-aloud toggle (see playHeaderStore) — must run before the
  // auto-narrate effect below so a just-enabled toggle's spokenTurnRef reset takes effect before
  // that effect checks it in the same commit.
  useEffect(() => {
    if (prevReadAloudRef.current === readAloud) return
    prevReadAloudRef.current = readAloud
    if (!readAloud) {
      stopPlayback()
    } else {
      // Turning it on should only narrate turns from here forward, not retroactively speak
      // whatever turn is already sitting on screen (e.g. one applied while it was off).
      spokenTurnRef.current = lastTurn?.turn ?? spokenTurnRef.current
    }
  }, [readAloud, lastTurn, stopPlayback])

  /** Speaks arbitrary turn text — used both for the auto-narrate-new-turns effect below and the
   * per-turn "play this turn" button, so a turn missed the first time (read-aloud was off, or you
   * weren't listening) can always be replayed on demand. `turn`, if given, drives which turn's
   * button shows a stop icon while this plays.
   *
   * Also drives the OS-level Media Session (see mediaSession.ts) for whichever provider is
   * speaking — real `navigator.mediaSession` metadata/action handlers, not a parallel mechanism,
   * so Android's "Now Playing" notification/lock-screen controls work the same way for
   * `browser`/`elevenlabs`/`huggingface-local` alike. */
  const speakText = useCallback(
    (text: string, turn?: number) => {
      if (!settings) return
      const kind = settings.ttsProvider
      // Reuse the existing instance for the same provider kind — a fresh instance per call would
      // have its own private "currently playing" state, so stop() could never reach audio a
      // previous instance started (this is exactly what made the per-turn stop button not work).
      const provider =
        ttsProviderRef.current?.kind === kind
          ? ttsProviderRef.current.provider
          : getTtsProvider(kind, {
              // Kokoro downloads a model on its very first use — without this, read-aloud would
              // just sit silent for the duration with nothing on screen explaining why.
              onKokoroLoadProgress: (p) => setVoiceLoadMessage(describeKokoroProgress(p)),
              // Kokoro's speak() now generates a turn's whole clip before playback can start
              // (issue #44) — without this, that wait reads as frozen the same way an unreported
              // model download would.
              onKokoroGenerateProgress: (completed, total) =>
                setVoiceLoadMessage(describeKokoroGenerateProgress(completed, total)),
            })
      if (!provider) {
        toast.error("Text-to-speech isn't available — check Settings or your browser's support.")
        return
      }
      ttsProviderRef.current = { kind, provider }
      setPlayingTurn(turn ?? null)
      lastSpokenRef.current = { text, turn }
      pendingStopModeRef.current = 'hard'
      const mediaSessionToken = ++mediaSessionTokenRef.current
      setMediaSessionMetadata({
        title: turn !== undefined ? `Turn ${turn}` : (turnLabel ?? 'Narration'),
        artist: campaignName ?? 'Adventure',
      })
      mediaSessionLiveRef.current = true
      setMediaSessionPlaybackState('playing')
      setMediaSessionHandlers({
        onPlay: () => {
          const last = lastSpokenRef.current
          if (last) speakTextRef.current?.(last.text, last.turn)
        },
        onPause: pausePlayback,
        onStop: stopPlayback,
      })
      // Each provider that supports voice selection keys off its own campaign setting —
      // elevenLabsVoiceId/kokoroVoiceId are independent choices, not a shared field, since a
      // campaign can switch providers without losing either one's pick.
      const voice =
        kind === 'elevenlabs'
          ? settings.elevenLabsVoiceId
          : kind === 'huggingface-local'
            ? settings.kokoroVoiceId
            : undefined
      provider
        .speak(text, { voice })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to read this aloud.')
        })
        .finally(() => {
          setVoiceLoadMessage('')
          // Only clear if nothing newer has already taken over (e.g. stop() was called manually
          // and already reset this, or another turn started playing in the meantime).
          setPlayingTurn((current) => (current === (turn ?? null) ? null : current))
          // Same "nothing newer took over" guard, for the Media Session notification — a stale
          // settle from a pre-empted call must not clear a session that now belongs to whatever
          // superseded it. Also skipped for a soft pause (pausePlayback already set the Media
          // Session to 'paused' and deliberately left its metadata/handlers alone — see its doc
          // comment) so this settle doesn't wipe out the very session pausing was trying to keep.
          if (mediaSessionTokenRef.current === mediaSessionToken && pendingStopModeRef.current !== 'soft') {
            clearMediaSession()
            mediaSessionLiveRef.current = false
          }
        })
    },
    [settings, campaignName, turnLabel, stopPlayback, pausePlayback],
  )

  // Keeps speakTextRef current — see its own doc comment for why onPlay reads through it instead
  // of self-referencing speakText by name.
  useEffect(() => {
    speakTextRef.current = speakText
  }, [speakText])

  /** Reads a logged turn aloud on demand — the spoken script covers prose *and*, for the
   * currently-live turn, its options read out in order (see turnBlocks.ts's buildSpokenScript),
   * so voice-only play can select an option by ear. */
  function toggleTurnPlayback(turn: TurnRecord) {
    if (playingTurn === turn.turn) {
      stopPlayback()
      return
    }
    const isLive = turn.turn === lastTurn?.turn
    const override = isLive && pendingSpokenOptionsRef.current?.turn === turn.turn
      ? pendingSpokenOptionsRef.current.options
      : undefined
    const script = buildSpokenScript(blocksForTurn(turn, isLive, override))
    speakText(script, turn.turn)
  }

  // Gated on isOnLatestPage, not just a new lastTurn existing — TurnPager auto-advances to the
  // newest page on every new turn (see its own doc comment), but that happens via an async
  // IntersectionObserver confirming the scroll actually landed, so a turn applied while the
  // player is mid-history briefly has lastTurn.turn bumped before currentPageIndex catches up.
  // Without this gate a turn could start narrating before the player has actually arrived at its
  // page — this effect re-fires once isOnLatestPage flips true, which the auto-advance guarantees
  // it eventually will.
  useEffect(() => {
    if (!readAloud || !ttsAvailable || !lastTurn || !isOnLatestPage) return
    if (spokenTurnRef.current !== null && lastTurn.turn <= spokenTurnRef.current) return
    spokenTurnRef.current = lastTurn.turn
    const override =
      pendingSpokenOptionsRef.current?.turn === lastTurn.turn ? pendingSpokenOptionsRef.current.options : undefined
    speakText(buildSpokenScript(blocksForTurn(lastTurn, true, override)), lastTurn.turn)
  }, [lastTurn, readAloud, ttsAvailable, settings, speakText, isOnLatestPage])

  useEffect(() => {
    return () => {
      sttProviderRef.current?.stop()
      ttsProviderRef.current?.provider.stop()
      // Not stopPlayback() — this only runs on unmount, and that also calls setPlayingTurn, which
      // React warns about (harmlessly, but noisily) when called after the component is gone.
      clearMediaSession()
    }
  }, [])

  function toggleListening() {
    if (listening) {
      sttProviderRef.current?.stop()
      return
    }
    const provider = getSttProvider(settings?.sttProvider ?? 'browser')
    if (!provider) {
      toast.error("Speech-to-text isn't available — check Settings or your browser's support.")
      return
    }
    provider.onResult((text) => setFreeText(text))
    provider.onError((message) => toast.error(message))
    provider.onEnd(() => {
      setListening(false)
      sttProviderRef.current = null
    })
    sttProviderRef.current = provider
    setListening(true)
    provider.start()
  }

  async function startTurn(action: string) {
    if (generating) return
    const built = await buildPromptForAction(action)
    if (!built) return
    pendingActionRef.current = action
    setPrompt(built)
    setReply('')
    setDialogError(null)
    setIssues([])
    if (isAutoMode) {
      // Don't pop the dialog open for this — a small status line covers "what's happening
      // while the AI generates" instead; clicking it opens the dialog if the user wants to look.
      setStage('closed')
      void generateAndApply(built)
    } else {
      setStage('prompt')
    }
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt)
    toast.success('Prompt copied — paste it into claude.ai or chatgpt.com')
  }

  async function handleSubmitReply(rawReplyOverride?: string) {
    const rawReply = rawReplyOverride ?? reply
    setSubmitting(true)
    setDialogError(null)
    setIssues([])
    try {
      const outcome = await submitReply(pendingActionRef.current, rawReply)
      if (outcome.ok) {
        setStage('closed')
        setFreeText('')
        toast.success('Turn applied.')
        // Captured here, before this turn's options are downgraded to plain labels in
        // recentTurns — see blocksForTurn's doc comment for why this is the one place manus
        // fidelity survives long enough to be spoken.
        pendingSpokenOptionsRef.current = { turn: outcome.turn, options: outcome.options }
        return
      }
      // Auto modes keep the dialog closed while generating (see startTurn) — surface it now so a
      // failure is never left sitting silently behind the small status line.
      setStage('prompt')
      if ('issues' in outcome) {
        setIssues(outcome.issues)
      } else {
        setDialogError(outcome.error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  function requestCloseDialog() {
    if (!isAutoMode && reply.trim() && !window.confirm('Discard the pasted reply and close?')) {
      return
    }
    setStage('closed')
  }

  function buildCorrectionPrompt(): string {
    const issueList = issues.map((i) => `- ${i.message}`).join('\n')
    return `${prompt}\n\nYour previous reply had these problems — fix them and resend the FULL reply (narrative + \`\`\`state block) in the exact same format:\n${issueList}`
  }

  function copyCorrectionPrompt() {
    void navigator.clipboard.writeText(buildCorrectionPrompt())
    toast.success('Correction prompt copied.')
  }

  /** Both auto modes' whole turn loop: generate (via Claude's API or the campaign's chosen local model),
   * then feed straight into the same submitReply pipeline manual mode uses (parse → validate →
   * apply) — nothing downstream of "raw reply text" differs by mode. */
  async function generateAndApply(promptText: string) {
    setDialogError(null)
    setIssues([])
    setGenerating(true)
    setStreamPreview('')
    setDownloadProgress(null)
    setStatusMessage(isLocalMode ? 'Loading local model…' : 'Generating your turn…')
    try {
      const text = isLocalMode
        ? await generateLocalReply(settings?.localModelId ?? DEFAULT_SETTINGS.localModelId, promptText, {
            onLoadProgress: (p) => {
              setStatusMessage(describeLocalModelProgress(p))
              setDownloadProgress(typeof p.progress === 'number' ? p.progress : null)
            },
            onToken: (soFar) => {
              setStatusMessage('Generating your turn…')
              setDownloadProgress(null)
              setStreamPreview(soFar)
            },
          })
        : await generateClaudeReply(promptText, settings?.claudeModel ?? 'claude-sonnet-5')
      setReply(text)
      await handleSubmitReply(text)
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err))
      // Same reasoning as the failure path in handleSubmitReply — don't leave an error hidden
      // behind the status line the user may not be looking at.
      setStage('prompt')
    } finally {
      setGenerating(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading campaign…</p>
      </div>
    )
  }
  if (status === 'error' || !campaign || !snapshot) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <CircleAlert className="size-6 text-destructive" />
        <p className="max-w-sm text-sm text-destructive">Couldn't load this campaign: {errorMessage}</p>
        <Button asChild variant="outline">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </div>
    )
  }

  // One TurnPager page per logged turn — the interactive options are still exactly what rendered
  // per-turn in the old stacked log, just handed to TurnPager as one page's content instead of
  // one <div> among many in a single scroll. turnLabel is plain text now, not rendered JSX: the
  // pager's own shared top bar (not each page) shows it, for whichever page is current, alongside
  // its back/forward/jump-to-page controls. The per-turn play/stop button stays per-page via
  // `actions` rather than following "current page" — every turn's button needs to exist
  // regardless of which page is current (see TurnPagerPage's own doc comment for why).
  const pages: TurnPagerPage[] = recentTurns.map((t) => {
    const isLastTurn = t.turn === lastTurn?.turn
    return {
      turn: t.turn,
      turnLabel: `Turn ${t.turn} — you: ${t.playerAction}`,
      actions: ttsAvailable && (
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => toggleTurnPlayback(t)}
          title={playingTurn === t.turn ? 'Stop playback' : 'Play this turn aloud'}
          aria-label={playingTurn === t.turn ? 'Stop playback' : 'Play this turn aloud'}
        >
          {playingTurn === t.turn ? <Square className="size-3.5" /> : <Volume2 className="size-3.5" />}
        </Button>
      ),
      blocks: blocksForTurn(t, isLastTurn),
      onSelectOption: isLastTurn ? startTurn : undefined,
    }
  })

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      {campaign.meta.difficulty !== 'Standard' && (
        <div className="flex justify-end">
          <Badge variant="secondary">{campaign.meta.difficulty}</Badge>
        </div>
      )}

      {recentTurns.length === 0 ? (
        <p className="p-4 font-serif text-sm text-muted-foreground italic sm:p-5">
          No story yet — describe your first action below to begin.
        </p>
      ) : (
        <TurnPager pages={pages} disabled={generating} onCurrentIndexChange={handleCurrentPageIndexChange} />
      )}

      {voiceLoadMessage && <p className="text-xs text-muted-foreground">{voiceLoadMessage}</p>}

      {/* Generation status/progress is informational, not interactive — unlike the options and
          input below, it stays visible regardless of which page the player is on (same treatment
          as voiceLoadMessage above) so paging back to reread history never hides the only
          feedback that a turn — possibly a multi-minute local-model download — is still in flight. */}
      {isAutoMode && generating && stage === 'closed' && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setStage('prompt')}
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {statusMessage || 'Generating your turn…'}
          </button>
          {downloadProgress !== null && <Progress value={downloadProgress} className="h-1 w-full" />}
        </div>
      )}

      {/* Also shown while the input has focus or is actively recording, even if a new turn has
          since paged the player away from the latest page (e.g. it arrived mid-typing) —
          hard-hiding on page position alone would otherwise unmount a focused textarea or an
          in-progress voice recording out from under the player with no way to get back to it. */}
      {(isOnLatestPage || inputFocused || listening) && (
        <div className="flex animate-in fade-in flex-col gap-4 duration-200">
          <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm">
            <Textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={listening ? 'Listening…' : 'Say or do anything…'}
              rows={1}
              className="min-h-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0"
            />
            {sttAvailable && (
              <Button
                type="button"
                variant={listening ? 'default' : 'ghost'}
                size="icon"
                className="rounded-full"
                onClick={toggleListening}
                title={listening ? 'Stop listening' : 'Speak your action'}
                aria-label={listening ? 'Stop listening' : 'Speak your action'}
              >
                {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
            )}
            <Button
              size="icon"
              className="rounded-full"
              onClick={() => startTurn(freeText)}
              disabled={!freeText.trim() || generating}
              title="Act"
              aria-label="Act"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog open={stage !== 'closed'} onOpenChange={(open) => !open && requestCloseDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl md:max-w-2xl lg:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {isApiMode ? 'Claude is narrating your turn' : isLocalMode ? 'Generating on this device' : 'Manual DM turn'}
            </DialogTitle>
            <DialogDescription>
              {isApiMode
                ? 'Sent directly to Claude with your API key — no copy/paste needed.'
                : isLocalMode
                  ? 'Running fully on this device via a local model — no key, no server.'
                  : 'Copy this prompt into claude.ai or chatgpt.com, then paste the reply back here.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{isAutoMode ? 'Prompt' : '1. Prompt'}</p>
              {!isAutoMode && (
                <Button size="sm" variant="outline" onClick={() => void copyPrompt()}>
                  Copy prompt
                </Button>
              )}
            </div>
            <Textarea readOnly value={prompt} rows={8} className="font-mono text-xs" />

            {isAutoMode ? (
              generating && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">{statusMessage}</p>
                  {downloadProgress !== null && <Progress value={downloadProgress} />}
                  {isLocalMode && streamPreview && (
                    <Textarea readOnly value={streamPreview} rows={6} className="font-mono text-xs" />
                  )}
                </div>
              )
            ) : (
              <>
                <p className="text-sm font-medium">2. Paste the AI's full reply</p>
                <Textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={8}
                  placeholder="Paste the narrative + trailing ```state block here…"
                  className="font-mono text-xs"
                />
              </>
            )}

            {dialogError && <p className="text-sm text-destructive">{dialogError}</p>}

            {issues.length > 0 && (
              <div className="rounded-md border border-destructive/50 p-3">
                <p className="mb-2 text-sm font-medium text-destructive">
                  This reply doesn't match the documented state:
                </p>
                <ul className="mb-3 list-inside list-disc text-sm">
                  {issues.map((i, idx) => (
                    <li key={idx} className={i.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                      {i.message}
                    </li>
                  ))}
                </ul>
                {issues.some((i) => i.severity === 'error') && !isAutoMode && (
                  <Button size="sm" variant="outline" onClick={copyCorrectionPrompt}>
                    Copy correction prompt
                  </Button>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={requestCloseDialog}>
              Cancel
            </Button>
            {isAutoMode ? (
              (dialogError || issues.length > 0) && (
                <Button
                  onClick={() => void generateAndApply(issues.length > 0 ? buildCorrectionPrompt() : prompt)}
                  disabled={generating}
                >
                  {generating ? 'Retrying…' : 'Retry'}
                </Button>
              )
            ) : (
              <Button onClick={() => void handleSubmitReply()} disabled={!reply.trim() || submitting}>
                {submitting ? 'Applying…' : 'Apply turn'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
