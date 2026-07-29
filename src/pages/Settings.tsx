import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { loadSettings, saveSettings } from '@/lib/google/campaignRepo'
import { AI_MODES, STT_PROVIDERS, TTS_PROVIDERS, type CampaignSettings } from '@/types/campaign'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGoogleAuth } from '@/lib/google/authStore'

export function Settings() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const { signOut } = useGoogleAuth()
  const [settings, setSettings] = useState<CampaignSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!campaignId) return
    void loadSettings(campaignId).then(setSettings)
  }, [campaignId])

  async function save() {
    if (!campaignId || !settings) return
    setSaving(true)
    try {
      await saveSettings(campaignId, settings)
      toast.success('Settings saved.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        {campaignId && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/play/${campaignId}`}>Back to play</Link>
          </Button>
        )}
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
                    <SelectItem key={m} value={m} disabled={m === 'api'}>
                      {m === 'manual' ? 'Manual (copy/paste into claude.ai or chatgpt.com)' : 'Direct API key (Phase 3 — coming soon)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
                    <SelectItem key={p} value={p} disabled={p !== 'browser'}>
                      {p === 'browser' ? 'Browser (Web Speech API)' : 'ElevenLabs (Phase 2 — coming soon)'}
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
                    <SelectItem key={p} value={p} disabled={p !== 'browser'}>
                      {p === 'browser'
                        ? 'Browser (SpeechSynthesis)'
                        : p === 'elevenlabs'
                          ? 'ElevenLabs (Phase 2 — coming soon)'
                          : 'Local Hugging Face model (Phase 2 — coming soon)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
