import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from '@/components/ui/toast'
import { generateKokoroPreview } from '@/lib/voice/kokoroTts'
import { CASTABLE_KOKORO_VOICE_IDS, KOKORO_VOICE_CATALOG } from '@/lib/voice/kokoroVoiceCatalog'
import type { Npc } from '@/types/sheets'

/**
 * The Codex's player-facing voice override (issue #100, closing out epic #36's multi-voice-
 * narration initiative). Lets a player fix a badly-cast NPC voice — pick a voice, hear a preview,
 * it locks so applyDelta.ts's AI-casting fallback (issue #98) never recasts them again — without
 * touching a Google Sheet by hand.
 *
 * Lists `CASTABLE_KOKORO_VOICE_IDS` (issue #107's quality-filtered pool), the same catalog the AI
 * itself casts from and Settings' own narrator/player picker draws its list from directly (no
 * model load needed just to *list* voices — the catalog's name/gender/language/grade live in the
 * static `KOKORO_VOICE_CATALOG` mirror, not behind `listKokoroVoices()`, which would force a full
 * Kokoro model download just to open this dialog). Only actually *previewing* a voice touches the
 * model, via the injectable `previewVoice` (defaults to the real `generateKokoroPreview`) — kept
 * injectable so tests/stories can fake voice generation without a real ~90MB on-device model
 * download, the same reasoning `tests/mocks/kokoro.ts` documents for Settings' own picker.
 *
 * State ownership: `npc` is the single source of truth for what's actually persisted — this
 * component never optimistically renders a voice the write hasn't confirmed yet. `onSelect`/
 * `onClear` are awaited; a rejection surfaces via `toast.error` and simply leaves `npc` (and
 * therefore this component's whole rendered state) untouched, which is what "the picker reverts to
 * its prior state" reduces to here — there's no separate revert step because nothing was changed
 * ahead of confirmation in the first place. `pending` only disables controls while a write is in
 * flight; it never drives what voice is shown as selected.
 */
export interface NpcVoicePickerProps {
  npc: Npc
  /** Persists the chosen voice and locks it (voiceLocked: true). Rejecting leaves the row
   * untouched — see this file's doc comment. */
  onSelect: (voiceId: string) => Promise<void>
  /** Clears the override (voiceLocked: false), handing casting back to the AI. Leaves whatever
   * voiceId is already on the row as-is — the next AI turn that casts this character overwrites
   * it, same as any never-locked NPC. */
  onClear: () => Promise<void>
  /** Injectable for tests/stories — see this file's doc comment. */
  previewVoice?: (voiceId: string) => Promise<Blob>
}

function voiceLabel(npc: Npc): string {
  if (!npc.voiceId) return 'Not cast yet'
  const name = KOKORO_VOICE_CATALOG[npc.voiceId]?.name ?? npc.voiceId
  return npc.voiceLocked ? name : `${name} (AI-cast)`
}

export function NpcVoicePicker({
  npc,
  onSelect,
  onClear,
  previewVoice = generateKokoroPreview,
}: NpcVoicePickerProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [previewLoadingVoiceId, setPreviewLoadingVoiceId] = useState<string | null>(null)
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  // Same staleness-token pattern as Settings.tsx's kokoroPreviewTokenRef — an in-flight preview
  // generation whose voice/dialog has since been superseded shouldn't play or toast on arrival.
  const previewTokenRef = useRef(0)

  function stopPreview() {
    previewTokenRef.current++
    previewAudioRef.current?.pause()
    previewAudioRef.current = null
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreviewingVoiceId(null)
  }

  // Leaving the tab (or the row scrolling out and the dialog staying open elsewhere) shouldn't
  // leave a preview sample playing in the background.
  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause()
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  async function handlePreview(voiceId: string, voiceName: string) {
    if (previewingVoiceId === voiceId) {
      stopPreview()
      return
    }
    stopPreview()
    const token = previewTokenRef.current
    setPreviewLoadingVoiceId(voiceId)
    try {
      const blob = await previewVoice(voiceId)
      if (token !== previewTokenRef.current) return
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      previewUrlRef.current = url
      previewAudioRef.current = audio
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (previewUrlRef.current === url) previewUrlRef.current = null
        setPreviewingVoiceId((current) => (current === voiceId ? null : current))
      }
      audio.onerror = () => {
        toast.error('Couldn’t play that voice preview.')
        URL.revokeObjectURL(url)
        if (previewUrlRef.current === url) previewUrlRef.current = null
        setPreviewingVoiceId((current) => (current === voiceId ? null : current))
      }
      setPreviewingVoiceId(voiceId)
      await audio.play()
    } catch (err) {
      if (token === previewTokenRef.current) {
        toast.error(err instanceof Error ? err.message : `Couldn’t generate a preview for ${voiceName}.`)
      }
    } finally {
      setPreviewLoadingVoiceId((current) => (current === voiceId ? null : current))
    }
  }

  async function handleSelect(voiceId: string) {
    setPending(true)
    try {
      await onSelect(voiceId)
      stopPreview()
      setOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Couldn’t save ${npc.name}’s voice — try again.`)
    } finally {
      setPending(false)
    }
  }

  async function handleClear() {
    setPending(true)
    try {
      await onClear()
      toast.success(`${npc.name}’s voice is back to AI casting.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Couldn’t clear ${npc.name}’s voice override — try again.`)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
      <span className="text-xs text-muted-foreground">Voice:</span>
      <span className="text-xs">{voiceLabel(npc)}</span>
      {npc.voiceLocked && (
        <Badge variant="outline" className="text-[10px]">
          Locked
        </Badge>
      )}
      <div className="ml-auto flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid={`npc-voice-button-${npc.id}`}
          onClick={() => setOpen(true)}
        >
          {npc.voiceLocked ? 'Change voice' : 'Set voice'}
        </Button>
        {npc.voiceLocked && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void handleClear()}>
            Clear override
          </Button>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) stopPreview()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Choose a voice for {npc.name}</DialogTitle>
            <DialogDescription>
              Preview generates a short clip on this device — the voice model downloads the
              first time, then previews are instant. Selecting a voice locks it so the AI stops
              recasting {npc.name}.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-80 pr-3">
            <div className="flex flex-col gap-1">
              {CASTABLE_KOKORO_VOICE_IDS.map((voiceId) => {
                const entry = KOKORO_VOICE_CATALOG[voiceId]
                const isCurrent = npc.voiceId === voiceId
                return (
                  <div
                    key={voiceId}
                    data-testid={`npc-voice-option-${voiceId}`}
                    className="flex items-center gap-2 rounded-md p-2 hover:bg-muted/50"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={previewLoadingVoiceId !== null}
                      onClick={() => void handlePreview(voiceId, entry.name)}
                      aria-label={
                        previewingVoiceId === voiceId ? `Stop preview of ${entry.name}` : `Preview ${entry.name}`
                      }
                    >
                      {previewLoadingVoiceId === voiceId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : previewingVoiceId === voiceId ? (
                        <Square className="size-4" />
                      ) : (
                        <Play className="size-4" />
                      )}
                    </Button>
                    <button
                      type="button"
                      className="flex-1 truncate text-left text-sm"
                      disabled={pending}
                      onClick={() => void handleSelect(voiceId)}
                    >
                      {entry.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {entry.language}
                        {entry.gender ? ` · ${entry.gender}` : ''}
                        {entry.traits ? ` ${entry.traits}` : ''}
                      </span>
                    </button>
                    {isCurrent && <span className="shrink-0 text-xs text-muted-foreground">Selected</span>}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  )
}
