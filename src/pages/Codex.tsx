import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CircleAlert, Loader2, Play, Square } from 'lucide-react'
import { useCampaign } from '@/hooks/useCampaign'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { loadSettings, saveSettings } from '@/lib/google/campaignRepo'
import { getCachedCampaign, patchCachedCampaignSettings } from '@/hooks/campaignCache'
import {
  AI_MODES,
  CLAUDE_MODELS,
  LOCAL_MODEL_IDS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  type CampaignSettings,
  type LocalModelId,
} from '@/types/campaign'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatBytes } from '@/lib/modelDownloadProgress'
import { LOCAL_MODELS } from '@/lib/ai/localModel'
import { listElevenLabsVoicesForStoredKey, type ElevenLabsVoice } from '@/lib/voice/elevenLabsVoices'

const CLAUDE_MODEL_LABELS: Record<(typeof CLAUDE_MODELS)[number], string> = {
  'claude-opus-5': 'Opus 5 — strongest reasoning, highest cost',
  'claude-sonnet-5': 'Sonnet 5 — balanced (recommended)',
  'claude-haiku-4-5': 'Haiku 4.5 — fastest, cheapest',
}

export function Codex() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const [searchParams] = useSearchParams()
  const { status, errorMessage, campaign, snapshot } = useCampaign(campaignId)
  const setHeaderContext = usePlayHeaderStore((s) => s.setContext)
  const campaignName = campaign?.meta.name

  const [settings, setSettings] = useState<CampaignSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [voicePickerOpen, setVoicePickerOpen] = useState(false)
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([])
  const [voicesLoadState, setVoicesLoadState] = useState<'idle' | 'loading' | 'error' | 'loaded'>('idle')
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)

  // See Play.tsx for why this goes through a shared store rather than props/context.
  useEffect(() => {
    if (!campaignId || !campaignName) return
    setHeaderContext({ campaignId, campaignName, turnLabel: null })
    return () => setHeaderContext(null)
  }, [campaignId, campaignName, setHeaderContext])

  useEffect(() => {
    if (!campaignId) return
    // If Play already loaded this campaign this session, reuse its cache instead of fetching
    // settings.md from Drive again.
    const cached = getCachedCampaign(campaignId)
    if (cached) {
      setSettings(cached.settings)
      return
    }
    void loadSettings(campaignId)
      .then(setSettings)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
  }, [campaignId])

  // Leaving the tab mid-preview shouldn't leave a voice sample playing in the background.
  useEffect(() => {
    return () => previewAudioRef.current?.pause()
  }, [])

  async function saveCampaignSettings() {
    if (!campaignId || !settings) return
    setSaving(true)
    try {
      await saveSettings(campaignId, settings)
      patchCachedCampaignSettings(campaignId, settings)
      toast.success('Settings saved.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function stopVoicePreview() {
    previewAudioRef.current?.pause()
    previewAudioRef.current = null
    setPreviewingVoiceId(null)
  }

  function togglePreview(voice: ElevenLabsVoice) {
    if (previewingVoiceId === voice.voiceId) {
      stopVoicePreview()
      return
    }
    if (!voice.previewUrl) return
    previewAudioRef.current?.pause()
    const audio = new Audio(voice.previewUrl)
    audio.onended = () => setPreviewingVoiceId((current) => (current === voice.voiceId ? null : current))
    audio.onerror = () => {
      toast.error("Couldn't play that voice preview.")
      setPreviewingVoiceId((current) => (current === voice.voiceId ? null : current))
    }
    previewAudioRef.current = audio
    setPreviewingVoiceId(voice.voiceId)
    // Switching previews quickly pauses the previous Audio before its play() promise settles,
    // which rejects with an AbortError — not a real playback failure (onerror above handles
    // those), so it's swallowed here rather than left as an unhandled rejection.
    void audio.play().catch(() => {})
  }

  async function openVoicePicker() {
    setVoicePickerOpen(true)
    // Skip re-fetching once a load has already succeeded, and also while one is still in
    // flight — otherwise a second click before the first request resolves fires a duplicate,
    // undeduplicated fetch, and if that redundant call fails after the first one already
    // succeeded, its error would wrongly clobber a good "loaded" state.
    if (voicesLoadState === 'loaded' || voicesLoadState === 'loading') return
    setVoicesLoadState('loading')
    try {
      const list = await listElevenLabsVoicesForStoredKey()
      setVoices(list)
      setVoicesLoadState('loaded')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load ElevenLabs voices.')
      setVoicesLoadState('error')
    }
  }

  function selectVoice(voice: ElevenLabsVoice) {
    if (!settings) return
    setSettings({ ...settings, elevenLabsVoiceId: voice.voiceId })
    stopVoicePreview()
    setVoicePickerOpen(false)
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading codex…</p>
      </div>
    )
  }
  if (status === 'error' || !campaign || !snapshot) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleAlert className="size-6 text-destructive" />
        <p className="max-w-sm text-sm text-destructive">Couldn't load this campaign: {errorMessage}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="font-heading text-2xl font-medium text-foreground">Codex</h1>

      <Tabs defaultValue={searchParams.get('tab') === 'settings' ? 'settings' : 'character'}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="character">Character</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="npcs">NPCs</TabsTrigger>
          <TabsTrigger value="monsters">Monsters</TabsTrigger>
          <TabsTrigger value="quests">Quests</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="lore">Lore</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="character">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Character.map((c, i) => (
                <div key={i} className="flex justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{c.key}</span>
                  <span className="text-muted-foreground">{c.value}</span>
                </div>
              ))}
              {snapshot.Character.length === 0 && <Empty label="No stats recorded yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="inventory">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Inventory.filter((i) => i.active).map((item) => (
                <Card key={item.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span>{item.name}</span>
                      <Badge variant="secondary">x{item.qty}</Badge>
                    </CardTitle>
                  </CardHeader>
                  {item.description && (
                    <CardContent className="pt-0 text-sm text-muted-foreground">{item.description}</CardContent>
                  )}
                </Card>
              ))}
              {snapshot.Inventory.filter((i) => i.active).length === 0 && <Empty label="Inventory is empty." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="skills">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Skills.map((s) => (
                <div key={s.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium">{s.name}</span>
                    <Badge variant="outline">{s.rank}</Badge>
                  </div>
                  {s.description && <p className="mt-1 text-muted-foreground">{s.description}</p>}
                </div>
              ))}
              {snapshot.Skills.length === 0 && <Empty label="No skills recorded yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="npcs">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.NPCs.map((n) => (
                <div key={n.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{n.name}</span>
                    <Badge variant={n.status === 'dead' ? 'destructive' : 'secondary'}>{n.status}</Badge>
                  </div>
                  {n.relationship && <p className="text-xs text-muted-foreground">{n.relationship}</p>}
                  {n.description && <p className="mt-1 text-muted-foreground">{n.description}</p>}
                </div>
              ))}
              {snapshot.NPCs.length === 0 && <Empty label="No NPCs met yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="monsters">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Monsters.map((m) => (
                <div key={m.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{m.name}</span>
                    <Badge variant={m.status === 'dead' ? 'destructive' : 'secondary'}>{m.status}</Badge>
                  </div>
                  {m.description && <p className="mt-1 text-muted-foreground">{m.description}</p>}
                  {m.threatNotes && <p className="text-xs text-muted-foreground">Threat: {m.threatNotes}</p>}
                </div>
              ))}
              {snapshot.Monsters.length === 0 && <Empty label="No creatures encountered yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="quests">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Quests.map((q) => (
                <div key={q.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{q.title}</span>
                    <Badge variant={q.status === 'completed' ? 'secondary' : q.status === 'failed' ? 'destructive' : 'outline'}>
                      {q.status}
                    </Badge>
                  </div>
                  {q.description && <p className="mt-1 text-muted-foreground">{q.description}</p>}
                </div>
              ))}
              {snapshot.Quests.length === 0 && <Empty label="No quests yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="map">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Graph view is a Phase 2 feature (DESIGN.md §11) — listed here for now.
              </p>
              {snapshot.Map.map((node) => (
                <div key={node.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{node.name}</span>
                    <Badge variant="outline">{node.state}</Badge>
                  </div>
                  {node.connectsTo && <p className="text-xs text-muted-foreground">Connects to: {node.connectsTo}</p>}
                  {node.description && <p className="mt-1 text-muted-foreground">{node.description}</p>}
                </div>
              ))}
              {snapshot.Map.length === 0 && <Empty label="No locations discovered yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="lore">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Lore.filter((l) => l.discovered).map((l) => (
                <div key={l.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{l.name}</span>
                    <Badge variant="outline">{l.type}</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{l.summary}</p>
                </div>
              ))}
              {snapshot.Lore.filter((l) => l.discovered).length === 0 && <Empty label="No lore uncovered yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="timeline">
          <ScrollArea className="h-[60vh]">
            <div className="flex flex-col gap-2">
              {snapshot.Timeline.slice()
                .reverse()
                .map((e, i) => (
                  <div key={i} className="rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{e.title}</span>
                      <Badge variant="outline">Turn {e.turn}</Badge>
                    </div>
                    {e.summary && <p className="mt-1 text-muted-foreground">{e.summary}</p>}
                  </div>
                ))}
              {snapshot.Timeline.length === 0 && <Empty label="Nothing has happened yet." />}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="settings">
          {settings ? (
            <Card data-testid="campaign-settings">
              <CardHeader>
                <CardTitle>This campaign</CardTitle>
                <CardDescription>
                  AI mode, voice provider choices, and read-aloud behavior, stored in this campaign's
                  settings.md. Device-wide settings (API keys, on-device model downloads) are under the
                  Settings icon in the top-right corner.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label>AI mode</Label>
                  <Select
                    value={settings.aiMode}
                    onValueChange={(v) => setSettings({ ...settings, aiMode: v as CampaignSettings['aiMode'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m === 'manual'
                            ? 'Manual (copy/paste into claude.ai or chatgpt.com)'
                            : m === 'api'
                              ? 'Direct API key (Claude)'
                              : 'Local model (runs on this device)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {settings.aiMode === 'local' && (
                  <div className="flex flex-col gap-2">
                    <Label>Local model</Label>
                    <Select
                      value={settings.localModelId}
                      onValueChange={(v) => setSettings({ ...settings, localModelId: v as LocalModelId })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LOCAL_MODEL_IDS.map((id) => (
                          <SelectItem key={id} value={id}>
                            {LOCAL_MODELS[id].label} — {formatBytes(LOCAL_MODELS[id].sizeBytes)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      No key needed — everything runs on this device. Needs a browser with WebGPU
                      (Chrome/Edge on Android, Safari 26+ on iOS/macOS). Bigger models are higher quality
                      but slower to download and more likely to crash the tab on memory-constrained
                      devices — see "Local AI models" in Settings to download or remove any of them ahead
                      of time. Quality and reliability (especially following the reply format) are
                      noticeably weaker than the API mode, more so for smaller models.
                    </p>
                  </div>
                )}

                {settings.aiMode === 'api' && (
                  <div className="flex flex-col gap-2">
                    <Label>Claude model</Label>
                    <Select
                      value={settings.claudeModel}
                      onValueChange={(v) => setSettings({ ...settings, claudeModel: v as CampaignSettings['claudeModel'] })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLAUDE_MODELS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {CLAUDE_MODEL_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Needs a Claude API key in Settings — every turn is billed to your own key.
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <Label>Speech-to-text</Label>
                  <Select
                    value={settings.sttProvider}
                    onValueChange={(v) => setSettings({ ...settings, sttProvider: v as CampaignSettings['sttProvider'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STT_PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p === 'browser' ? 'Browser (Web Speech API)' : 'ElevenLabs (Scribe)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <Label>Text-to-speech</Label>
                  <Select
                    value={settings.ttsProvider}
                    onValueChange={(v) => setSettings({ ...settings, ttsProvider: v as CampaignSettings['ttsProvider'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TTS_PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p === 'browser'
                            ? 'Browser (SpeechSynthesis)'
                            : p === 'elevenlabs'
                              ? 'ElevenLabs'
                              : 'Kokoro (on-device, runs locally)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <Label>Read new turns aloud</Label>
                  <Button
                    type="button"
                    variant={settings.autoReadAloud ? 'default' : 'outline'}
                    aria-pressed={settings.autoReadAloud}
                    onClick={() => setSettings({ ...settings, autoReadAloud: !settings.autoReadAloud })}
                    className="self-start"
                  >
                    {settings.autoReadAloud ? 'On — new turns are narrated automatically' : 'Off — play turns manually'}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    When on, the header's play/pause control also narrates the latest turn's options once
                    the narrative finishes.
                  </p>
                </div>

                {(settings.sttProvider === 'elevenlabs' || settings.ttsProvider === 'elevenlabs') && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="voiceId">ElevenLabs voice ID (optional)</Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="voiceId"
                        value={settings.elevenLabsVoiceId ?? ''}
                        onChange={(e) =>
                          setSettings({ ...settings, elevenLabsVoiceId: e.target.value.trim() || undefined })
                        }
                        placeholder="Defaults to a standard ElevenLabs voice if left blank"
                        className="min-w-40 flex-1"
                      />
                      <Button type="button" variant="outline" onClick={() => void openVoicePicker()}>
                        Browse voices
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {voicesLoadState === 'loaded' &&
                        settings.elevenLabsVoiceId &&
                        (() => {
                          const name = voices.find((v) => v.voiceId === settings.elevenLabsVoiceId)?.name
                          return name ? `Currently: ${name}. ` : ''
                        })()}
                      Only used for text-to-speech. Needs an ElevenLabs API key in Settings.
                    </p>
                  </div>
                )}

                <Dialog
                  open={voicePickerOpen}
                  onOpenChange={(open) => {
                    setVoicePickerOpen(open)
                    if (!open) stopVoicePreview()
                  }}
                >
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Choose an ElevenLabs voice</DialogTitle>
                      <DialogDescription>
                        Preview plays ElevenLabs' hosted sample clip for each voice — no text-to-speech
                        call is made just to listen.
                      </DialogDescription>
                    </DialogHeader>
                    {voicesLoadState === 'loading' && (
                      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Loading voices…
                      </div>
                    )}
                    {voicesLoadState === 'error' && (
                      <p className="py-4 text-sm text-muted-foreground">
                        Couldn't load voices. Make sure your ElevenLabs API key (in Settings) is saved and
                        valid, then try again.
                      </p>
                    )}
                    {voicesLoadState === 'loaded' &&
                      (voices.length === 0 ? (
                        <p className="py-4 text-sm text-muted-foreground">No voices found on this ElevenLabs account.</p>
                      ) : (
                        <ScrollArea className="h-80 pr-3">
                          <div className="flex flex-col gap-1">
                            {voices.map((voice) => (
                              <div key={voice.voiceId} className="flex items-center gap-2 rounded-md p-2 hover:bg-muted/50">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="shrink-0"
                                  disabled={!voice.previewUrl}
                                  onClick={() => togglePreview(voice)}
                                  aria-label={
                                    previewingVoiceId === voice.voiceId ? `Stop preview of ${voice.name}` : `Preview ${voice.name}`
                                  }
                                >
                                  {previewingVoiceId === voice.voiceId ? (
                                    <Square className="size-4" />
                                  ) : (
                                    <Play className="size-4" />
                                  )}
                                </Button>
                                <button
                                  type="button"
                                  className="flex-1 truncate text-left text-sm"
                                  onClick={() => selectVoice(voice)}
                                >
                                  {voice.name}
                                  {voice.category && (
                                    <span className="ml-1.5 text-xs text-muted-foreground">{voice.category}</span>
                                  )}
                                </button>
                                {settings.elevenLabsVoiceId === voice.voiceId && (
                                  <span className="shrink-0 text-xs text-muted-foreground">Selected</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      ))}
                  </DialogContent>
                </Dialog>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="cadence">Re-summarize every N turns</Label>
                  <Input
                    id="cadence"
                    type="number"
                    min={5}
                    value={settings.summarizationCadence}
                    onChange={(e) => setSettings({ ...settings, summarizationCadence: Number(e.target.value) || 15 })}
                  />
                </div>

                <Button onClick={() => void saveCampaignSettings()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save settings'}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading settings…
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="p-4 text-sm text-muted-foreground">{label}</p>
}
