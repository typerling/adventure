/**
 * ElevenLabs API key storage — deliberately localStorage, not sessionStorage or Drive: per
 * DESIGN.md §8 it's a paid credential the user shouldn't have to re-enter every browser session,
 * but it must never be written to Drive (settings.md is shared/synced storage, localStorage is
 * this-browser-only). Google's OAuth token also lives in localStorage, but for a different
 * reason — it's short-lived and silently refreshed, so persisting it only avoids a needless
 * re-login; see the note at the top of src/lib/google/authStore.ts.
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
