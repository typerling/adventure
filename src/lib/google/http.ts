import { useGoogleAuth } from './authStore'

export class GoogleApiError extends Error {
  status: number
  body?: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'GoogleApiError'
    this.status = status
    this.body = body
  }
}

/** Authorized fetch against a Google API, JSON in/out. Retries once on 401 with a fresh token. */
export async function googleFetch<T>(
  url: string,
  init: RequestInit = {},
  _retried = false,
): Promise<T> {
  const token = await useGoogleAuth.getState().getValidAccessToken()
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  })

  if (res.status === 401 && !_retried) {
    useGoogleAuth.setState({ accessToken: null, expiresAt: null })
    return googleFetch<T>(url, init, true)
  }

  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = await res.text().catch(() => undefined)
    }
    throw new GoogleApiError(`Google API request failed (${res.status}) for ${url}`, res.status, body)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Same as googleFetch but returns raw text (used for downloading file contents). */
export async function googleFetchText(url: string, init: RequestInit = {}): Promise<string> {
  const token = await useGoogleAuth.getState().getValidAccessToken()
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new GoogleApiError(`Google API request failed (${res.status}) for ${url}`, res.status)
  }
  return res.text()
}
