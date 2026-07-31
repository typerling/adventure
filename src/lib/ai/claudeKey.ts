/**
 * Claude API key storage — localStorage, not sessionStorage or Drive. Same reasoning as
 * elevenLabsKey.ts: a key the player shouldn't have to re-enter every browser session, but
 * that must never be written to Drive (settings.md is shared/synced storage).
 */

const STORAGE_KEY = 'adventure:claude-api-key'

export function getClaudeApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setClaudeApiKey(key: string): void {
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
