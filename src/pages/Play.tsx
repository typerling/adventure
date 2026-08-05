import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Compass,
  Feather,
  Footprints,
  Loader2,
  Mic,
  MicOff,
  Sparkles,
  Square,
  Volume2,
} from 'lucide-react'
import { useCampaign } from '@/hooks/useCampaign'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { cn } from '@/lib/utils'
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
import type { ValidationIssue } from '@/types/turn'
import { getSttProvider, getTtsProvider, isSttProviderAvailable, isTtsProviderAvailable } from '@/lib/voice/getProvider'
import type { SttProvider, TtsProvider } from '@/lib/voice/types'
import { describeKokoroProgress } from '@/lib/voice/kokoroTts'
import { generateClaudeReply } from '@/lib/ai/claudeProvider'
import { describeLocalModelProgress, generateLocalReply } from '@/lib/ai/localModel'

type DialogStage = 'closed' | 'prompt'

/** How close to the bottom of the story log (in px) still counts as "at the bottom" — the
 * options and free-text input only appear there, so a small slack avoids them flickering away
 * from sub-pixel scroll rounding when the log exactly fills the viewport. */
const AT_BOTTOM_THRESHOLD_PX = 32

/** Options are arbitrary AI-generated strings with no inherent icon/color meaning — these just
 * cycle to give the choice list the same varied, illustrated-card look as a fixed icon per option
 * would, without pretending to understand what each option is about. */
const OPTION_ICONS = [Footprints, Compass, Feather, Sparkles]
const OPTION_COLORS = [
  'bg-primary text-primary-foreground',
  'bg-secondary text-secondary-foreground',
  'bg-accent text-accent-foreground',
]

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
  const prevReadAloudRef = useRef(readAloud)
  const bottomRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  /** Whether the story log is scrolled to its bottom — the options and free-text input are only
   * relevant once the player has read up to the latest turn, so they're hidden until then (with
   * a "scroll down to continue" affordance in their place) rather than sitting below text the
   * player hasn't reached yet. */
  const [isAtBottom, setIsAtBottom] = useState(true)

  const lastTurn = recentTurns.at(-1)
  const options = lastTurn?.optionsOffered ?? []

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

  function toggleTurnPlayback(turn: number, narrative: string) {
    if (playingTurn === turn) {
      ttsProviderRef.current?.provider.stop()
      setPlayingTurn(null)
      return
    }
    speakText(narrative, turn)
  }

  useEffect(() => {
    if (!readAloud || !ttsAvailable || !lastTurn) return
    if (spokenTurnRef.current !== null && lastTurn.turn <= spokenTurnRef.current) return
    spokenTurnRef.current = lastTurn.turn
    speakText(lastTurn.narrative, lastTurn.turn)
  }, [lastTurn, readAloud, ttsAvailable, settings, speakText])

  /** While true, checkAtBottom's own onScroll-driven updates are ignored — set for a short window
   * around a programmatic scrollIntoView(). That scroll is smooth (animated over several frames),
   * and each intermediate frame fires its own 'scroll' event with a scrollTop nowhere near the
   * destination yet; without suppressing those, isAtBottom would flicker false mid-animation and
   * hide the options/input right after the player acts, exactly when they need to see the result. */
  const suppressScrollChecksRef = useRef(false)
  const suppressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Recomputes isAtBottom from the story log viewport's actual scroll position. Passed both to
   * the ScrollArea's onScroll and called directly after programmatic scrolls settle. */
  const checkAtBottom = useCallback(() => {
    if (suppressScrollChecksRef.current) return
    const el = viewportRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setIsAtBottom(distanceFromBottom < AT_BOTTOM_THRESHOLD_PX)
  }, [])

  const scrollToBottom = useCallback(() => {
    // Optimistic: we're deliberately moving to the bottom, so treat it as already there rather
    // than waiting for the animation to finish — see suppressScrollChecksRef above.
    setIsAtBottom(true)
    suppressScrollChecksRef.current = true
    if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current)
    suppressTimeoutRef.current = setTimeout(() => {
      suppressScrollChecksRef.current = false
      checkAtBottom()
    }, 700)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [checkAtBottom])

  useEffect(() => {
    return () => {
      if (suppressTimeoutRef.current) clearTimeout(suppressTimeoutRef.current)
    }
  }, [])

  // Scrolls to the newest turn as soon as one is added — a chat-style "jump to the latest
  // message" so a freshly-generated/applied turn is never left scrolled out of view.
  useEffect(() => {
    scrollToBottom()
  }, [recentTurns.length, scrollToBottom])

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
          clipped viewport keeps glyphs safely away from the clip edge. */}
      <div className="relative">
        <ScrollArea className="h-[50vh]" viewportRef={viewportRef} onViewportScroll={checkAtBottom}>
          {recentTurns.length === 0 ? (
            <p className="p-4 font-serif text-sm text-muted-foreground italic sm:p-5">
              No story yet — describe your first action below to begin.
            </p>
          ) : (
            <div className="flex flex-col gap-6 p-4 sm:p-5">
              {recentTurns.map((t) => (
                <div key={t.turn} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Turn {t.turn} — you: {t.playerAction}
                    </p>
                    {ttsAvailable && (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => toggleTurnPlayback(t.turn, t.narrative)}
                        title={playingTurn === t.turn ? 'Stop playback' : 'Play this turn aloud'}
                        aria-label={playingTurn === t.turn ? 'Stop playback' : 'Play this turn aloud'}
                      >
                        {playingTurn === t.turn ? <Square className="size-3.5" /> : <Volume2 className="size-3.5" />}
                      </Button>
                    )}
                  </div>
                  <p className="font-serif text-base leading-relaxed whitespace-pre-wrap">{t.narrative}</p>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>

        {/* Options and the free-text input only make sense once the player has read up to the
            latest turn — this affordance is what surfaces in their place while scrolled up
            through earlier history, so it's never unclear how to get back to acting. */}
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

      {isAtBottom && (
        <div className="flex animate-in fade-in flex-col gap-4 duration-200">
          {options.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {options.map((opt, i) => {
                const Icon = OPTION_ICONS[i % OPTION_ICONS.length]
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => startTurn(opt)}
                    disabled={generating}
                    className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-xl',
                        OPTION_COLORS[i % OPTION_COLORS.length],
                      )}
                    >
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1 font-heading text-base leading-snug text-foreground">{opt}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                )
              })}
            </div>
          )}

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

          <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card px-3 py-2 shadow-sm">
            <Textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
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
