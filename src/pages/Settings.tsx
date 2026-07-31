import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { loadCampaignFile, loadSettings, saveSettings } from '@/lib/google/campaignRepo'
import { getCachedCampaign, patchCachedCampaignSettings } from '@/hooks/campaignCache'
import { usePlayHeaderStore } from '@/store/playHeaderStore'
import { AI_MODES, CLAUDE_MODELS, STT_PROVIDERS, TTS_PROVIDERS, type CampaignSettings } from '@/types/campaign'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { useGoogleAuth } from '@/lib/google/authStore'
import { getElevenLabsApiKey, setElevenLabsApiKey } from '@/lib/voice/elevenLabsKey'
import { getClaudeApiKey, setClaudeApiKey } from '@/lib/ai/claudeKey'
import {
  describeLocalModelProgress,
  getLocalModelLoadState,
  hasDownloadedLocalModel,
  isLocalModelSupported,
  preloadLocalModel,
  removeLocalModel,
} from '@/lib/ai/localModel'
import {
  describeKokoroProgress,
  getKokoroLoadState,
  hasDownloadedKokoroModel,
  preloadKokoroModel,
  removeKokoroModel,
} from '@/lib/voice/kokoroTts'

const CLAUDE_MODEL_LABELS: Record<(typeof CLAUDE_MODELS)[number], string> = {
  'claude-opus-5': 'Opus 5 — strongest reasoning, highest cost',
  'claude-sonnet-5': 'Sonnet 5 — balanced (recommended)',
  'claude-haiku-4-5': 'Haiku 4.5 — fastest, cheapest',
}

export function Settings() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const { signOut } = useGoogleAuth()
  const [settings, setSettings] = useState<CampaignSettings | null>(null)
  const [campaignName, setCampaignName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [elevenLabsKey, setElevenLabsKeyInput] = useState(() => getElevenLabsApiKey() ?? '')
  const [claudeKey, setClaudeKeyInput] = useState(() => getClaudeApiKey() ?? '')
  const [modelLoadState, setModelLoadState] = useState(() => getLocalModelLoadState())
  const [modelStatusMessage, setModelStatusMessage] = useState('')
  const [modelDownloadProgress, setModelDownloadProgress] = useState<number | null>(null)
  const [removingModel, setRemovingModel] = useState(false)
  const [voiceLoadState, setVoiceLoadState] = useState(() => getKokoroLoadState())
  const [voiceStatusMessage, setVoiceStatusMessage] = useState('')
  const [voiceDownloadProgress, setVoiceDownloadProgress] = useState<number | null>(null)
  const [removingVoiceModel, setRemovingVoiceModel] = useState(false)
  const setHeaderContext = usePlayHeaderStore((s) => s.setContext)

  useEffect(() => {
    if (!campaignId) return
    // If Play/Codex already loaded this campaign this session, reuse its cache instead of
    // fetching settings.md (and the campaign file, for its name) from Drive again.
    const cached = getCachedCampaign(campaignId)
    if (cached) {
      setSettings(cached.settings)
      setCampaignName(cached.campaign.meta.name)
      return
    }
    void loadSettings(campaignId)
      .then(setSettings)
      // Without this a Drive failure was an unhandled rejection *and* a silently empty form.
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
    void loadCampaignFile(campaignId)
      .then((f) => setCampaignName(f.meta.name))
      .catch(() => {})
  }, [campaignId])

  // See Play.tsx for why the top-bar header reads this from a shared store.
  useEffect(() => {
    if (!campaignId || !campaignName) return
    setHeaderContext({ campaignId, campaignName, showReadAloudToggle: false, turnLabel: null })
    return () => setHeaderContext(null)
  }, [campaignId, campaignName, setHeaderContext])

  // Refines the in-memory-only guess from getLocalModelLoadState() (which only knows about this
  // page session) with what's actually on disk — a model downloaded in an earlier session should
  // still show as ready here, not prompt for a redundant re-download.
  useEffect(() => {
    let cancelled = false
    // Both can reject where IndexedDB/Cache Storage is unavailable (private browsing, storage
    // disabled). That just means nothing is cached, so fall through to the un-downloaded state
    // rather than throwing into an unhandled rejection.
    void hasDownloadedLocalModel()
      .then((has) => {
        if (!cancelled && has) setModelLoadState('ready')
      })
      .catch(() => {})
    void hasDownloadedKokoroModel()
      .then((has) => {
        if (!cancelled && has) setVoiceLoadState('ready')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // A download can already be in flight before this component mounts — e.g. the user started it
  // from here, navigated away (the load itself is a module-level singleton, not tied to this
  // component's lifetime, so it keeps running), and came back. Reattach to it so progress keeps
  // showing instead of reading as abandoned just because nothing was listening while unmounted.
  // Guarded to only reattach, never start a fresh, unrequested download.
  useEffect(() => {
    if (getLocalModelLoadState() === 'loading') void downloadModel()
    if (getKokoroLoadState() === 'loading') void downloadVoiceModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
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

  function saveElevenLabsKey() {
    setElevenLabsApiKey(elevenLabsKey)
    toast.success(elevenLabsKey.trim() ? 'ElevenLabs API key saved.' : 'ElevenLabs API key cleared.')
  }

  function saveClaudeKey() {
    setClaudeApiKey(claudeKey)
    toast.success(claudeKey.trim() ? 'Claude API key saved.' : 'Claude API key cleared.')
  }

  async function downloadModel() {
    setModelLoadState('loading')
    setModelStatusMessage('Fetching local model…')
    setModelDownloadProgress(null)
    try {
      await preloadLocalModel((p) => {
        setModelStatusMessage(describeLocalModelProgress(p))
        setModelDownloadProgress(typeof p.progress === 'number' ? p.progress : null)
      })
      setModelLoadState('ready')
      setModelStatusMessage('')
      setModelDownloadProgress(null)
      toast.success('Local model downloaded and ready.')
    } catch (err) {
      setModelLoadState('unloaded')
      setModelStatusMessage('')
      setModelDownloadProgress(null)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeModel() {
    setRemovingModel(true)
    try {
      await removeLocalModel()
      setModelLoadState('unloaded')
      toast.success('Local model removed from this device.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRemovingModel(false)
    }
  }

  async function downloadVoiceModel() {
    setVoiceLoadState('loading')
    setVoiceStatusMessage('Fetching voice model…')
    setVoiceDownloadProgress(null)
    try {
      await preloadKokoroModel((p) => {
        setVoiceStatusMessage(describeKokoroProgress(p))
        setVoiceDownloadProgress(typeof p.progress === 'number' ? p.progress : null)
      })
      setVoiceLoadState('ready')
      setVoiceStatusMessage('')
      setVoiceDownloadProgress(null)
      toast.success('Voice model downloaded and ready.')
    } catch (err) {
      setVoiceLoadState('unloaded')
      setVoiceStatusMessage('')
      setVoiceDownloadProgress(null)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeVoiceModel() {
    setRemovingVoiceModel(true)
    try {
      await removeKokoroModel()
      setVoiceLoadState('unloaded')
      toast.success('Voice model removed from this device.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRemovingVoiceModel(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-medium text-foreground">Settings</h1>
        <Button asChild size="sm" variant="ghost">
          <Link to={campaignId ? `/play/${campaignId}` : '/'}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
      </div>

      {campaignId && settings && (
        <Card>
          <CardHeader>
            <CardTitle>This campaign</CardTitle>
            <CardDescription>
              AI mode and voice provider choices, stored in this campaign's settings.md.
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
                          : 'Local model (Gemma, runs on this device)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {settings.aiMode === 'local' && (
              <p className="text-xs text-muted-foreground">
                No key needed — everything runs on this device. Needs a browser with WebGPU
                (Chrome/Edge on Android, Safari 26+ on iOS/macOS). Downloads roughly 3&nbsp;GB
                once and caches it after that — a large download that can crash the tab on
                memory-constrained devices — see "Local AI model" below to download it ahead of
                time. Quality and reliability (especially following the reply format) are
                noticeably weaker than the API mode.
              </p>
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
                  Needs a Claude API key below — every turn is billed to your own key.
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

            {(settings.sttProvider === 'elevenlabs' || settings.ttsProvider === 'elevenlabs') && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="voiceId">ElevenLabs voice ID (optional)</Label>
                <Input
                  id="voiceId"
                  value={settings.elevenLabsVoiceId ?? ''}
                  onChange={(e) =>
                    setSettings({ ...settings, elevenLabsVoiceId: e.target.value.trim() || undefined })
                  }
                  placeholder="Defaults to a standard ElevenLabs voice if left blank"
                />
                <p className="text-xs text-muted-foreground">Only used for text-to-speech.</p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="cadence">Re-summarize every N turns</Label>
              <Input
                id="cadence"
                type="number"
                min={5}
                value={settings.summarizationCadence}
                onChange={(e) =>
                  setSettings({ ...settings, summarizationCadence: Number(e.target.value) || 15 })
                }
              />
            </div>

            <Button onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Local AI model</CardTitle>
          <CardDescription>
            Used by any campaign set to "Local model (Gemma, runs on this device)" — no key, no
            server, runs fully on-device via WebGPU. Downloads roughly 3&nbsp;GB once and caches
            it in this browser after that — a large download that can crash the tab on
            memory-constrained devices. Download it ahead of time here so the first turn of a
            local-mode campaign doesn't have to wait on it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!isLocalModelSupported() ? (
            <p className="text-sm text-destructive">
              This browser doesn't support WebGPU, so local mode won't work here.
            </p>
          ) : modelLoadState === 'ready' ? (
            <>
              <p className="text-sm text-muted-foreground">Model downloaded and ready — turns start instantly.</p>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void removeModel()}
                disabled={removingModel}
              >
                {removingModel ? 'Removing…' : 'Remove downloaded model'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void downloadModel()}
                disabled={modelLoadState === 'loading'}
              >
                {modelLoadState === 'loading' ? (modelStatusMessage || 'Downloading…') : 'Download model now'}
              </Button>
              {modelDownloadProgress !== null && <Progress value={modelDownloadProgress} className="w-full" />}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kokoro voice model</CardTitle>
          <CardDescription>
            Used by any campaign set to "Kokoro (on-device, runs locally)" for text-to-speech — no
            key, no server, and no WebGPU needed. Downloads once, then generates speech entirely on
            this device. Download it ahead of time here so the first turn read aloud doesn't have
            to wait on it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {voiceLoadState === 'ready' ? (
            <>
              <p className="text-sm text-muted-foreground">
                Voice model downloaded and ready — playback starts instantly.
              </p>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void removeVoiceModel()}
                disabled={removingVoiceModel}
              >
                {removingVoiceModel ? 'Removing…' : 'Remove downloaded voice model'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void downloadVoiceModel()}
                disabled={voiceLoadState === 'loading'}
              >
                {voiceLoadState === 'loading' ? (voiceStatusMessage || 'Downloading…') : 'Download voice model now'}
              </Button>
              {voiceDownloadProgress !== null && <Progress value={voiceDownloadProgress} className="w-full" />}
              {typeof caches === 'undefined' && (
                <p className="text-xs text-muted-foreground">
                  This page isn't on HTTPS or localhost, so the browser cache Kokoro relies on
                  isn't available — the model works but re-downloads each page load.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {campaignId && settings?.aiMode === 'api' && (
        <Card>
          <CardHeader>
            <CardTitle>Claude API</CardTitle>
            <CardDescription>
              Needed since this campaign uses the direct API AI mode. Stored only in this
              browser's local storage — never written to Drive. Every turn generated this way is
              billed to this key directly by Anthropic.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="claudeKey">API key</Label>
              <Input
                id="claudeKey"
                type="password"
                autoComplete="off"
                value={claudeKey}
                onChange={(e) => setClaudeKeyInput(e.target.value)}
                placeholder="sk-ant-…"
              />
            </div>
            <Button variant="outline" onClick={saveClaudeKey} className="self-start">
              {claudeKey.trim() ? 'Save key' : 'Clear key'}
            </Button>
          </CardContent>
        </Card>
      )}

      {campaignId && (settings?.sttProvider === 'elevenlabs' || settings?.ttsProvider === 'elevenlabs') && (
        <Card>
          <CardHeader>
            <CardTitle>ElevenLabs</CardTitle>
            <CardDescription>
              Needed since this campaign uses ElevenLabs for speech-to-text or text-to-speech.
              Stored only in this browser's local storage — never written to Drive.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="elevenLabsKey">API key</Label>
              <Input
                id="elevenLabsKey"
                type="password"
                autoComplete="off"
                value={elevenLabsKey}
                onChange={(e) => setElevenLabsKeyInput(e.target.value)}
                placeholder="sk_…"
              />
            </div>
            <Button variant="outline" onClick={saveElevenLabsKey} className="self-start">
              {elevenLabsKey.trim() ? 'Save key' : 'Clear key'}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Google account</CardTitle>
          <CardDescription>Disconnect this app from your Google Drive.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => signOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
