import { create } from 'zustand'
import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES, isGoogleConfigured } from './config'
import { GIS_SCRIPT_SRC, loadScript } from './loadScript'

type AuthStatus = 'unconfigured' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'

interface AuthState {
  status: AuthStatus
  accessToken: string | null
  /** epoch ms */
  expiresAt: number | null
  errorMessage: string | null
  signIn: () => Promise<void>
  signOut: () => void
  /** Returns a currently-valid access token, silently refreshing if the existing one is stale.
   * Throws if the user needs to interactively sign in again — callers should catch and prompt. */
  getValidAccessToken: () => Promise<string>
}

let tokenClient: TokenClient | null = null

async function ensureTokenClient(onToken: (res: TokenResponse) => void): Promise<TokenClient> {
  if (tokenClient) return tokenClient
  await loadScript(GIS_SCRIPT_SRC)
  if (!window.google) throw new Error('Google Identity Services failed to load')
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID as string,
    scope: GOOGLE_SCOPES,
    callback: onToken,
  })
  return tokenClient
}

export const useGoogleAuth = create<AuthState>((set, get) => ({
  status: isGoogleConfigured ? 'signed-out' : 'unconfigured',
  accessToken: null,
  expiresAt: null,
  errorMessage: null,

  signIn: async () => {
    if (!isGoogleConfigured) {
      set({ status: 'unconfigured' })
      return
    }
    set({ status: 'signing-in', errorMessage: null })
    try {
      await new Promise<void>((resolve, reject) => {
        ensureTokenClient((res) => {
          if (res.error) {
            reject(new Error(res.error_description ?? res.error))
            return
          }
          set({
            status: 'signed-in',
            accessToken: res.access_token,
            expiresAt: Date.now() + res.expires_in * 1000,
          })
          resolve()
        })
          .then((client) => client.requestAccessToken({ prompt: 'consent' }))
          .catch(reject)
      })
    } catch (err) {
      set({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  signOut: () => {
    const token = get().accessToken
    if (token && window.google) {
      window.google.accounts.oauth2.revoke(token)
    }
    set({ status: 'signed-out', accessToken: null, expiresAt: null })
  },

  getValidAccessToken: async () => {
    const { accessToken, expiresAt } = get()
    // 60s safety margin before expiry
    if (accessToken && expiresAt && expiresAt - Date.now() > 60_000) {
      return accessToken
    }
    if (!isGoogleConfigured) {
      throw new Error('Google Drive is not configured yet — add VITE_GOOGLE_CLIENT_ID.')
    }
    // Try a silent refresh first (no consent prompt) before falling back to interactive sign-in.
    return new Promise<string>((resolve, reject) => {
      ensureTokenClient((res) => {
        if (res.error) {
          set({ status: 'signed-out', accessToken: null, expiresAt: null })
          reject(new Error('Session expired — please sign in again.'))
          return
        }
        set({
          status: 'signed-in',
          accessToken: res.access_token,
          expiresAt: Date.now() + res.expires_in * 1000,
        })
        resolve(res.access_token)
      })
        .then((client) => client.requestAccessToken({ prompt: '' }))
        .catch(reject)
    })
  },
}))
