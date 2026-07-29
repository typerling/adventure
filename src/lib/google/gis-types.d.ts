/** Minimal ambient types for the Google Identity Services token client we load at runtime. */

interface TokenResponse {
  access_token: string
  expires_in: number
  scope: string
  token_type: string
  error?: string
  error_description?: string
}

interface TokenClientConfig {
  client_id: string
  scope: string
  prompt?: string
  callback: (response: TokenResponse) => void
  error_callback?: (error: { type: string; message?: string }) => void
}

interface TokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

interface Window {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (config: TokenClientConfig) => TokenClient
        revoke: (accessToken: string, done?: () => void) => void
      }
    }
  }
}
