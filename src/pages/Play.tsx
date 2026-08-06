import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowUp, ChevronDown, CircleAlert, Loader2, Mic, MicOff, Square, Volume2 } from 'lucide-react'
import { useCampaign } from '@/hooks/useCampaign'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { DEFAULT_SETTINGS, type TtsProvider as TtsProviderKind } from '@/types/campaign'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { describeKokoroProgress } from '@/lib/voice/kokoroTts'
import { generateClaudeReply } from '@/lib/ai/claudeProvider'
import { describeLocalModelProgress, generateLocalReply } from '@/lib/ai/localModel'
import { buildSpokenScript, splitNarrativeIntoBlocks } from '@/lib/ai/turnBlocks'
import { TurnContent } from '@/components/TurnContent'

type DialogStage = 'closed' | 'prompt'

/** How far past the bottom of the story log still counts as "at the bottom", in px. Shared by the
 * IntersectionObserver's rootMargin and the reconcile check that runs when suppression ends — the
 * two must agree or they'd disagree about the same scroll position. */
const AT_BOTTOM_SLACK_PX = 32

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
  /** The last turn number we've already spoken aloud — set to the campaign's current turn on
   * load so resuming a session never re-narrates history, only turns completed from here on. */
  const spokenTurnRef = useRef<number | null>(null)
  /** The freshly-parsed `{label, manus?}` options for the turn most recently applied via
   * handleSubmitReply, keyed by turn number so a stale value from an earlier turn is never
   * mistaken for the current one. See blocksForTurn's doc comment for why this exists — it's the
   * one place manus data survives long enough to actually be spoken. */
  const pendingSpokenOptionsRef = useRef<{ turn: number; options: TurnOption[] } | null>(null)
  const prevReadAloudRef = useRef(readAloud)
  const bottomRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  /** Whether the options/free-text input are shown — relevant only once the player has read up to
   * the latest turn, so they're hidden while scrolled away (with a "scroll down to continue"
   * affordance, and the log growing to reclaim the freed space, in their place) rather than
   * sitting below text the player hasn't reached yet, or leaving that space blank.
   *
   * A one-way latch, not a live "currently at the bottom" reading: the IntersectionObserver below
   * only ever turns it *off* (leaving the bottom); turning it back on only ever happens via an
   * explicit scrollToBottom() call (the "scroll to continue" tap, or a new turn's auto-scroll).
   * That's deliberate, not an oversight — the log's own height depends on this flag (see the
   * ScrollArea wrapper below), so if reaching the bottom automatically flipped it back on, the
   * resulting shrink could push the bottom back out of view, flipping it off again, regrowing the
   * log, revealing the bottom again — an infinite resize loop. Requiring an explicit action to
   * turn it back on breaks that cycle by construction. */
  const [isAtBottom, setIsAtBottom] = useState(true)
  /** Whether the free-text box currently has focus — kept separate from isAtBottom so that
   * scrolling the log away from the bottom (e.g. an incidental wheel/trackpad nudge) never yanks
   * away an input the player is mid-composing in. Without this, the input row would hard-unmount
   * under a focused textarea, silently dropping keyboard focus with no way to get it back short
   * of scrolling back down and clicking in again. */
  const [inputFocused, setInputFocused] = useState(false)

  const lastTurn = recentTurns.at(-1)

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

  // Reacts to the header's Read-aloud toggle (see playHeaderStore) — must run before the
  // auto-narrate effect below so a just-enabled toggle's spokenTurnRef reset takes effect before
  // that effect checks it in the same commit.
  useEffect(() => {
    if (prevReadAloudRef.current === readAloud) return
    prevReadAloudRef.current = readAloud
    if (!readAloud) {
      ttsProviderRef.current?.provider.stop()
      setPlayingTurn(null)
    } else {
      // Turning it on should only narrate turns from here forward, not retroactively speak
      // whatever turn is already sitting on screen (e.g. one applied while it was off).
      spokenTurnRef.current = lastTurn?.turn ?? spokenTurnRef.current
    }
  }, [readAloud, lastTurn])

  /** Speaks arbitrary turn text — used both for the auto-narrate-new-turns effect below and the
   * per-turn "play this turn" button, so a turn missed the first time (read-aloud was off, or you
   * weren't listening) can always be replayed on demand. `turn`, if given, drives which turn's
   * button shows a stop icon while this plays. */
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
            })
      if (!provider) {
        toast.error("Text-to-speech isn't available — check Settings or your browser's support.")
        return
      }
      ttsProviderRef.current = { kind, provider }
      setPlayingTurn(turn ?? null)
      provider
        .speak(text, { voice: settings.elevenLabsVoiceId })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to read this aloud.')
        })
        .finally(() => {
          setVoiceLoadMessage('')
          // Only clear if nothing newer has already taken over (e.g. stop() was called manually
          // and already reset this, or another turn started playing in the meantime).
          setPlayingTurn((current) => (current === (turn ?? null) ? null : current))
        })
    },
    [settings],
  )

  /** Reads a logged turn aloud on demand — the spoken script covers prose *and*, for the
   * currently-live turn, its options read out in order (see turnBlocks.ts's buildSpokenScript),
   * so voice-only play can select an option by ear. */
  function toggleTurnPlayback(turn: TurnRecord) {
    if (playingTurn === turn.turn) {
      ttsProviderRef.current?.provider.stop()
      setPlayingTurn(null)
      return
    }
    const isLive = turn.turn === lastTurn?.turn
    const override = isLive && pendingSpokenOptionsRef.current?.turn === turn.turn
      ? pendingSpokenOptionsRef.current.options
      : undefined
    const script = buildSpokenScript(blocksForTurn(turn, isLive, override))
    speakText(script, turn.turn)
  }

  useEffect(() => {
    if (!readAloud || !ttsAvailable || !lastTurn) return
    if (spokenTurnRef.current !== null && lastTurn.turn <= spokenTurnRef.current) return
    spokenTurnRef.current = lastTurn.turn
    const override =
      pendingSpokenOptionsRef.current?.turn === lastTurn.turn ? pendingSpokenOptionsRef.current.options : undefined
    speakText(buildSpokenScript(blocksForTurn(lastTurn, true, override)), lastTurn.turn)
  }, [lastTurn, readAloud, ttsAvailable, settings, speakText])

  /** While true, the observer below ignores what it sees — set for a short window around a
   * programmatic scrollToBottom(). That scroll is smooth (animated over several frames), and the
   * sentinel is genuinely out of view for the earlier frames of that animation, before it
   * actually arrives — an accurate reading, just a premature one relative to our intent (we're
   * already headed there). Ordinarily a premature "false" would self-correct once the animation
   * settles at "true" — but isAtBottom is a one-way latch (see its doc comment) specifically to
   * avoid a resize feedback loop, and a one-way latch can't self-correct: a premature false during
   * our *own* auto-scroll would latch shut permanently, hiding the input right after a turn
   * lands, exactly when the player needs it back. */
  const suppressObserverRef = useRef(false)
  const suppressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Ends the suppression window and immediately reconciles against reality. The re-check is the
   * important half: an IntersectionObserver only fires on *changes*, so anything it was told to
   * ignore mid-window is not re-reported afterwards. Without this, a player who scrolls up during
   * the post-turn auto-scroll would leave the options/input showing over text they haven't read,
   * stuck that way until some later scroll happened to change the intersection state again. */
  const endSuppression = useCallback(() => {
    suppressObserverRef.current = false
    const root = viewportRef.current
    const target = bottomRef.current
    if (!root || !target) return
    // Same test the observer's rootMargin encodes, just evaluated once here rather than per frame.
    const isSentinelInView =
      target.getBoundingClientRect().top <= root.getBoundingClientRect().bottom + AT_BOTTOM_SLACK_PX
    if (!isSentinelInView) setIsAtBottom(false)
  }, [])

  // Detects leaving the bottom of the log via the sentinel's real visibility within the
  // ScrollArea's viewport, rather than computing it by hand from scrollTop/scrollHeight on every
  // 'scroll' event — an IntersectionObserver reports the *actual* overlap at each moment, so it
  // can't be fooled by reading stale geometry the way a plain scroll-math check can. rootMargin
  // gives the same "close enough" slack a pixel-distance check would.
  // One-way only (see isAtBottom's doc comment for why): never sets it back to true.
  useEffect(() => {
    const root = viewportRef.current
    const target = bottomRef.current
    if (!root || !target) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (suppressObserverRef.current) return
        if (!entry.isIntersecting) setIsAtBottom(false)
      },
      { root, rootMargin: `0px 0px ${AT_BOTTOM_SLACK_PX}px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
    // Deliberately lastTurn?.turn, not recentTurns.length: useCampaign keeps only the most recent
    // 6 turns (slice(-6)), so length plateaus once a session passes that many — turn *number*
    // keeps climbing regardless, which is what should re-arm this on every actual new turn.
  }, [lastTurn?.turn])

  // Ends suppression when the scroll actually finishes rather than after a guessed duration —
  // 'scrollend' fires once the browser's smooth-scroll animation settles, however far it had to
  // travel (a long story log can need more than a token delay). The timeout in scrollToBottom
  // remains a genuine fallback: 'scrollend' never fires when nothing moved at all (already at the
  // bottom), and measurement showed it can also fail to fire for a user scroll that happens
  // *during* the programmatic one — in that case the timeout is what ends the window, so the
  // options can linger over unread text for up to its duration rather than clearing immediately.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    el.addEventListener('scrollend', endSuppression)
    return () => el.removeEventListener('scrollend', endSuppression)
  }, [endSuppression])

  useEffect(() => {
    return () => {
      if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current)
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    setIsAtBottom(true)
    suppressObserverRef.current = true
    if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current)
    suppressTimeoutRef.current = setTimeout(endSuppression, 1500)
    // Deferred a frame rather than scrolled straight away, because setIsAtBottom(true) above
    // *shrinks* the log (the taller scrolled-away height collapses back to h-[50svh]) and React
    // hasn't committed that yet. A synchronous scrollIntoView would aim at the pre-shrink layout
    // and stop a few hundred px short of the real bottom — which then made endSuppression measure
    // "not at the bottom", latch closed again, regrow the log, and leave "Scroll to continue"
    // showing while the player was already at the bottom. Clicking it just alternated between the
    // two states forever.
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    })
  }, [endSuppression])

  // Scrolls to the newest turn as soon as one is added — a chat-style "jump to the latest
  // message" so a freshly-generated/applied turn is never left scrolled out of view. See the
  // observer effect above for why lastTurn?.turn, not recentTurns.length.
  useEffect(() => {
    scrollToBottom()
  }, [lastTurn?.turn, scrollToBottom])

  useEffect(() => {
    return () => {
      sttProviderRef.current?.stop()
      ttsProviderRef.current?.provider.stop()
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

  function startTurn(action: string) {
    if (generating) return
    const built = buildPromptForAction(action)
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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      {campaign.meta.difficulty !== 'Standard' && (
        <div className="flex justify-end">
          <Badge variant="secondary">{campaign.meta.difficulty}</Badge>
        </div>
      )}

      {/* Padding lives on the inner content, not on ScrollArea itself — Radix's Viewport clips
          at its own edge, and text sitting exactly flush against that clip boundary triggers a
          software-rasterization glyph artifact in some renderers. A wrapper div inside the
          clipped viewport keeps glyphs safely away from the clip edge.

          The log grows to a taller *fixed* height while the options/input are hidden, reclaiming
          most of the vertical space they'd otherwise leave blank below a lone "Scroll to
          continue" button. Deliberately an explicit bound (calc against the viewport), not
          flex-1/min-h — a flex-grow child of an auto/min-height-only flex container has no fixed
          budget to distribute, and different browsers resolve that ambiguity by sizing the child
          to its full *content* height instead of the visible viewport (confirmed empirically: the
          log's clientHeight grew to match its entire scrollHeight, thousands of pixels tall). That
          also would have kept the bottom sentinel permanently visible, which — combined with
          isAtBottom's one-way latch — meant "Scroll to continue" never went away again. An
          explicit calc() height has no such ambiguity to resolve. Approximate, not exact: the
          point is reclaiming most of the freed area, not filling to the pixel, and undershooting
          is deliberately safer than overshooting into an unwanted extra scrollbar.

          Both heights are in `svh`, not a mix of `vh` and `svh`: on iOS `vh` tracks the *large*
          viewport (toolbars hidden) while `svh` tracks the small one, so mixing them would measure
          the two states against different boxes and make the "grown" height not actually the
          bigger of the two while the toolbars are showing. The max() guards the same thing for
          short viewports generally — below roughly 350px of height, `100svh - 7rem` is *smaller*
          than `50svh`, so without it the log would shrink on scrolling away instead of growing
          (landscape phones hit this; the tests' fixed 844px viewport does not).

          The `7rem` reserve is just the header plus this page's own top/bottom padding — it used
          to be `11rem` to additionally cover the fixed `BottomNav` and the bottom-padding reserve
          `App.tsx` set aside for it (see issue #21); now that both are gone, nothing sits below
          the log any more, so the smaller reserve is the one that actually reaches close to the
          bottom of the viewport instead of leaving the old nav's-worth of dead space behind. */}
      <div className="relative">
        <ScrollArea
          className={isAtBottom ? 'h-[50svh]' : 'h-[max(50svh,calc(100svh-7rem))]'}
          viewportRef={viewportRef}
        >
          {recentTurns.length === 0 ? (
            <p className="p-4 font-serif text-sm text-muted-foreground italic sm:p-5">
              No story yet — describe your first action below to begin.
            </p>
          ) : (
            <div className="flex flex-col gap-6 p-4 sm:p-5">
              {recentTurns.map((t) => {
                const isLastTurn = t.turn === lastTurn?.turn
                return (
                  <div key={t.turn} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Turn {t.turn} — you: {t.playerAction}
                      </p>
                      {ttsAvailable && (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => toggleTurnPlayback(t)}
                          title={playingTurn === t.turn ? 'Stop playback' : 'Play this turn aloud'}
                          aria-label={playingTurn === t.turn ? 'Stop playback' : 'Play this turn aloud'}
                        >
                          {playingTurn === t.turn ? <Square className="size-3.5" /> : <Volume2 className="size-3.5" />}
                        </Button>
                      )}
                    </div>
                    {/* Options render inline with the narrative — at the point the AI marked with
                        {{options}}, or appended at the end as a fallback — only for the live
                        turn; historical turns render prose only (see TurnContent.tsx). Scrolling
                        away from the bottom of the log naturally scrolls the live turn's options
                        out of view too, so no extra gating is needed here beyond what already
                        hides the free-text input below. */}
                    <TurnContent
                      blocks={blocksForTurn(t, isLastTurn)}
                      onSelectOption={isLastTurn ? startTurn : undefined}
                      disabled={generating}
                    />
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>

        {/* The free-text input only makes sense once the player has read up to the latest turn —
            this affordance is what surfaces in its place while scrolled up through earlier
            history, so it's never unclear how to get back to acting. */}
        {!isAtBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="pointer-events-auto animate-in fade-in shadow-md"
              onClick={scrollToBottom}
            >
              <ChevronDown className="size-4" />
              Scroll to continue
            </Button>
          </div>
        )}
      </div>

      {voiceLoadMessage && <p className="text-xs text-muted-foreground">{voiceLoadMessage}</p>}

      {/* Generation status/progress is informational, not interactive — unlike the options and
          input below, it stays visible regardless of scroll position (same treatment as
          voiceLoadMessage above) so scrolling up to reread history never hides the only feedback
          that a turn — possibly a multi-minute local-model download — is still in flight. */}
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

      {/* Also shown while the input has focus or is actively recording, even if the log has since
          scrolled away from the bottom (e.g. an incidental wheel nudge mid-typing) — hard-hiding
          on scroll position alone would otherwise unmount a focused textarea or an in-progress
          voice recording out from under the player with no way to get back to it. */}
      {(isAtBottom || inputFocused || listening) && (
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
