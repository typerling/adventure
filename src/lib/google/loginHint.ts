/**
 * Persists the signed-in Google account's email address purely to use as GIS's `login_hint` on a
 * future *interactive* token request — added for issue #45. When the installed Android app's
 * silent session restore fails (see authStore.ts's module doc comment on why that's the likely
 * culprit there, not ordinary token expiry), the fallback interactive sign-in can pass this hint
 * so GIS skips the account picker — per GIS's own documented `login_hint` field: "When successful,
 * account selection is skipped." That turns forced re-login into a single tap/consent instead of a
 * full account chooser. It's a mitigation, not a fix: the underlying silent-restore failure (see
 * authStore.ts) isn't addressed by this at all.
 *
 * Deliberately localStorage, not Drive: this-browser-only, like the OAuth token itself (see
 * SESSION_STORAGE_KEY's comment in authStore.ts), and unlike the token it isn't sensitive by
 * itself — just an email address the user already gave Google. Cleared on explicit sign-out (see
 * authStore.ts's signOut) since a stale hint would bias account selection toward the *previous*
 * account, working against someone who signed out specifically to switch accounts.
 */
const STORAGE_KEY = 'adventure:google-login-hint'

export function getStoredLoginHint(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setStoredLoginHint(email: string | null): void {
  try {
    if (email) {
      localStorage.setItem(STORAGE_KEY, email)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // localStorage unavailable (private browsing, disabled storage, …) — login_hint just won't be
    // available next time; sign-in still works, just back to the full account picker.
  }
}

/**
 * One-shot lookup of the signed-in account's email via Google's OpenID userinfo endpoint, using an
 * access token we already have (needs the `userinfo.email` scope — see config.ts). Best-effort by
 * design: any failure here must never block sign-in itself, so callers should treat this as
 * fire-and-forget and swallow errors (authStore.ts's `ensureLoginHint` does).
 */
export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { email?: unknown }
  return typeof data.email === 'string' && data.email ? data.email : null
}
