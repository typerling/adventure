/**
 * ElevenLabs API key storage — deliberately localStorage, not sessionStorage or Drive: per
 * DESIGN.md §8 it's a paid credential the user shouldn't have to re-enter every browser session,
 * but it must never be written to Drive (settings.md is shared/synced storage, localStorage is
 * this-browser-only). Google's OAuth token uses sessionStorage instead precisely because that one
 * *should* expire with the browser session — see src/lib/google/authStore.ts.
 */

const STORAGE_KEY = 'adventure:elevenlabs-api-key'

export function getElevenLabsApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setElevenLabsApiKey(key: string): void {
  try {
    const trimmed = key.trim()
    if (trimmed) {
      localStorage.setItem(STORAGE_KEY, trimmed)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // localStorage unavailable (private browsing, disabled storage, …) — the key just won't
    // persist across reloads; callers still work with it for the current page load.
  }
}
