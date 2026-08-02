import { getElevenLabsApiKey } from './elevenLabsKey'

export interface ElevenLabsVoice {
  voiceId: string
  name: string
  category?: string
  /** A ready-made sample clip ElevenLabs hosts for this voice — lets Settings' picker preview a
   * voice without spending a text-to-speech call just to audition it. Absent for a small number
   * of voices (e.g. some cloned ones), in which case the picker just disables preview for that row. */
  previewUrl: string | null
}

/** Lists the voices available to the account owning `apiKey` (ElevenLabs' premade voices plus any
 * the user has added/cloned) — used by Settings' voice picker. Throws on any non-2xx response;
 * callers surface that as a toast rather than silently falling back, same convention as
 * elevenLabsTts.ts/elevenLabsStt.ts. */
export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Failed to load ElevenLabs voices (${res.status})${body ? `: ${body}` : ''}`)
  }
  const data = (await res.json()) as {
    voices?: { voice_id: string; name: string; category?: string; preview_url?: string | null }[]
  }
  return (data.voices ?? []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    previewUrl: v.preview_url ?? null,
  }))
}

/** Convenience wrapper for callers that just want "the current campaign key's voices, or an
 * explicit error if there's no key" without importing elevenLabsKey.ts separately. */
export async function listElevenLabsVoicesForStoredKey(): Promise<ElevenLabsVoice[]> {
  const apiKey = getElevenLabsApiKey()
  if (!apiKey) {
    throw new Error('Add your ElevenLabs API key first.')
  }
  return listElevenLabsVoices(apiKey)
}
