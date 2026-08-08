import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock, setMockUserinfoEmail } from './mocks/googleApi'
import { createRandomCampaign } from './helpers'

const SESSION_STORAGE_KEY = 'adventure:google-session'
const LOGIN_HINT_STORAGE_KEY = 'adventure:google-login-hint'

/**
 * Coverage for issue #45's code-level changes to src/lib/google/authStore.ts:
 *  - login_hint capture/reuse (src/lib/google/loginHint.ts)
 *  - the silent-refresh timeout backstop (SILENT_REFRESH_TIMEOUT_MS)
 *
 * A real installed-Android-WebAPK repro isn't automatable here — no adb/emulator in this
 * environment (same constraint as issue #39) — so these exercise the *code-level* behavior
 * against a fake GIS, the same way tests/google-session-restore.spec.ts already does for the
 * silent-restore success/fail/interactive-fallback logic.
 */

/** Silent (`prompt: ''`) requests always fail with no active session; interactive requests always
 * succeed. Records every `requestAccessToken` call's overrideConfig (including any `login_hint`)
 * onto `window.__tokenRequests` so tests can assert what was actually sent. */
async function installRecordingFakeGis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__tokenRequests = []
    ;(w as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (res: Record<string, unknown>) => void }) => ({
            requestAccessToken: (override?: { prompt?: string; login_hint?: string }) => {
              ;(w.__tokenRequests as unknown[]).push(override ?? null)
              if (override?.prompt === '') {
                config.callback({ error: 'access_denied', error_description: 'no active session' })
                return
              }
              config.callback({
                access_token: 'interactive-token',
                expires_in: 3600,
                scope: '',
                token_type: 'Bearer',
              })
            },
          }),
          revoke: () => {},
        },
      },
    }
  })
}

/** A silent (`prompt: ''`) request never calls back at all — simulating GIS's documented "no UI,
 * no error either" gap for a gesture-less popup request (google/google-api-javascript-client#816,
 * cited in authStore.ts's research summary). Interactive requests succeed normally. */
async function installHangingSilentFakeGis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (res: Record<string, unknown>) => void }) => ({
            requestAccessToken: (override?: { prompt?: string }) => {
              if (override?.prompt === '') return // never resolves
              config.callback({
                access_token: 'interactive-token',
                expires_in: 3600,
                scope: '',
                token_type: 'Bearer',
              })
            },
          }),
          revoke: () => {},
        },
      },
    }
  })
}

async function clearStorageKey(page: Page, key: string): Promise<void> {
  await page.addInitScript((k) => window.localStorage.removeItem(k), key)
}

/** Reads back the non-silent (interactive) requests recorded by installRecordingFakeGis since the
 * last navigation (its addInitScript resets window.__tokenRequests on every page load). */
async function interactiveTokenRequests(
  page: Page,
): Promise<Array<{ prompt?: string; login_hint?: string }>> {
  const requests = await page.evaluate(() => (window as unknown as Record<string, unknown>).__tokenRequests)
  return (requests as Array<{ prompt?: string; login_hint?: string } | null>).filter((r) => r?.prompt !== '')
}

test.describe('login_hint capture and reuse (issue #45)', () => {
  test('captures the signed-in account email and reuses it as login_hint on the next forced interactive sign-in', async ({
    page,
  }) => {
    await installGoogleApiMock(page)
    setMockUserinfoEmail('returning-player@example.com')
    await installRecordingFakeGis(page)
    await createRandomCampaign(page)
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

    // Registered once, but this needs to keep applying on every navigation below — that's the
    // point: it simulates the bug report's "every single reopen" by making sure a real session
    // never survives one, so each navigation has to fall back to the interactive card again. A
    // fresh Playwright context already starts with empty localStorage, so there's no pre-existing
    // login_hint to separately clear here.
    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto(`/play/${campaignId}`)

    // First reopen: silent restore fails (no active session in the fake), falls back to the
    // interactive card — this app has no stored hint yet, so the first interactive request goes
    // out without one.
    const signInButton = page.getByRole('button', { name: 'Sign in with Google' })
    await expect(signInButton).toBeVisible()
    await signInButton.click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    // ensureLoginHint's userinfo fetch is fire-and-forget, so poll rather than assert immediately.
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), LOGIN_HINT_STORAGE_KEY))
      .toBe('returning-player@example.com')

    // installRecordingFakeGis's own addInitScript reruns on every navigation too, resetting
    // window.__tokenRequests — so the first sign-in's requests (asserted here) must be read
    // before reloading, not accumulated across both navigations.
    const firstRoundInteractive = await interactiveTokenRequests(page)
    expect(firstRoundInteractive).toHaveLength(1)
    expect(firstRoundInteractive[0]?.login_hint).toBeUndefined()

    // Second reopen (simulates the bug report's "every single reopen"): session gone again
    // (the persistent removal script above still applies), silent restore fails again the same
    // way — but the login_hint captured above must survive this reload untouched, and this time
    // the interactive request must carry it.
    await page.reload()
    await expect(signInButton).toBeVisible()
    await signInButton.click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    const secondRoundInteractive = await interactiveTokenRequests(page)
    expect(secondRoundInteractive).toHaveLength(1)
    expect(secondRoundInteractive[0]?.login_hint).toBe('returning-player@example.com')
  })

  test('signing out clears the stored login_hint', async ({ page }) => {
    await installGoogleApiMock(page)
    setMockUserinfoEmail('returning-player@example.com')
    await installRecordingFakeGis(page)
    await createRandomCampaign(page)
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto(`/play/${campaignId}`)
    await page.getByRole('button', { name: 'Sign in with Google' }).click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), LOGIN_HINT_STORAGE_KEY))
      .toBe('returning-player@example.com')

    // Client-side navigation (react-router), not page.goto — a full navigation would re-run the
    // SESSION_STORAGE_KEY removal init script above and wipe the session we just established,
    // bouncing back to the sign-in card instead of reaching Settings.
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(
      page.evaluate((key) => window.localStorage.getItem(key), LOGIN_HINT_STORAGE_KEY),
    ).resolves.toBeNull()
  })
})

/**
 * Records every silent (`prompt: ''`) requestAccessToken call's override onto
 * `window.__silentRequests` and always succeeds — used below to check both that login_hint reaches
 * the automatic paths and that no more than one silent request fires on an ordinary fresh load.
 */
async function installCountingFakeGis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__silentRequests = []
    ;(w as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (res: Record<string, unknown>) => void }) => ({
            requestAccessToken: (override?: { prompt?: string; login_hint?: string }) => {
              if (override?.prompt === '') {
                ;(w.__silentRequests as unknown[]).push(override)
              }
              config.callback({
                access_token: override?.prompt === '' ? 'silently-restored-token' : 'interactive-token',
                expires_in: 3600,
                scope: '',
                token_type: 'Bearer',
              })
            },
          }),
          revoke: () => {},
        },
      },
    }
  })
}

/**
 * Same idea, but the silent callback fires asynchronously and the *first* silent response comes
 * back already stale (expires_in: 0) — the same trick tests/google-session-restore.spec.ts's
 * "parallel calls" test uses to force a genuine second, coalesced refresh via
 * getValidAccessToken. Every silent request's override (including any login_hint) is recorded in
 * call order onto window.__silentRequests, so a test can check that a hint present for the first
 * (startup reauth) call is *also* present on the second (getValidAccessToken refresh) call.
 */
async function installAsyncCountingFakeGis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__silentRequests = []
    ;(w as { google: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (res: Record<string, unknown>) => void }) => ({
            requestAccessToken: (override?: { prompt?: string; login_hint?: string }) => {
              if (override?.prompt !== '') {
                config.callback({
                  access_token: 'interactive-token',
                  expires_in: 3600,
                  scope: '',
                  token_type: 'Bearer',
                })
                return
              }
              const list = w.__silentRequests as Array<{ prompt?: string; login_hint?: string }>
              list.push(override)
              const n = list.length
              setTimeout(
                () =>
                  config.callback({
                    access_token: `async-token-${n}`,
                    // First token is already inside the 60s staleness margin, forcing the parallel
                    // Drive/Sheets reads that follow to share one genuine refresh — see
                    // tests/google-session-restore.spec.ts's identical trick for why.
                    expires_in: n === 1 ? 0 : 3600,
                    scope: '',
                    token_type: 'Bearer',
                  }),
                40,
              )
            },
          }),
          revoke: () => {},
        },
      },
    }
  })
}

test.describe('login_hint on the automatic silent-refresh paths (issue #45 reopen)', () => {
  test('the startup reauth silent request carries a previously-captured login_hint', async ({ page }) => {
    await installGoogleApiMock(page)
    setMockUserinfoEmail('returning-player@example.com')
    await installCountingFakeGis(page)
    await createRandomCampaign(page)
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

    // First reopen: no hint captured yet, so the startup reauth's silent request must go out
    // without one — same "first-ever attempt is unaffected" expectation the manual-signIn test
    // above already covers, checked here for the startup path specifically.
    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto(`/play/${campaignId}`)
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), LOGIN_HINT_STORAGE_KEY))
      .toBe('returning-player@example.com')

    const firstRoundSilent = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__silentRequests,
    )
    expect(firstRoundSilent).toEqual([{ prompt: '' }])

    // Second reopen: the hint captured above must now reach the *startup reauth's own* silent
    // request — this is the exact gap the reopen's real-device evidence identified (PR #64 only
    // ever threaded login_hint into the manual signIn() button, never this automatic path).
    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.reload()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    const secondRoundSilent = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__silentRequests,
    )
    expect(secondRoundSilent).toEqual([{ prompt: '', login_hint: 'returning-player@example.com' }])
  })

  test("getValidAccessToken's coalesced silent refresh also carries a stored login_hint", async ({ page }) => {
    await installGoogleApiMock(page)
    await installAsyncCountingFakeGis(page)
    await createRandomCampaign(page)
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

    // Pre-seed a hint directly (bypassing the userinfo-fetch capture flow, already covered by the
    // describe block above) to isolate exactly what's under test here: does the *refresh* path
    // forward whatever hint is already stored.
    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: LOGIN_HINT_STORAGE_KEY, value: 'preseeded-hint@example.com' },
    )
    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto(`/play/${campaignId}`)

    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible({ timeout: 15_000 })

    const silentRequests = (await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__silentRequests,
    )) as Array<{ prompt?: string; login_hint?: string }>
    // First entry is the startup reauth (deliberately returned stale above so a second, coalesced
    // refresh follows); the second is getValidAccessToken's own refresh. Both must carry the hint.
    expect(silentRequests.length).toBeGreaterThanOrEqual(2)
    for (const req of silentRequests) {
      expect(req.login_hint).toBe('preseeded-hint@example.com')
    }
  })
})

test.describe('no duplicate silent requests within one page load (issue #45 reopen investigation)', () => {
  test('a normal successful silent restore fires exactly one silent request, not two', async ({ page }) => {
    await installGoogleApiMock(page)
    await installCountingFakeGis(page)
    await createRandomCampaign(page)
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto(`/play/${campaignId}`)
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    // Give a would-be second refresh (e.g. from a mounting page's own Drive/Sheets call racing the
    // startup reauth) a moment to fire if the code had that bug — AuthGate's 'restoring' gate and
    // getValidAccessToken's inFlightRefresh coalescing (see authStore.ts's module doc comment) are
    // what this asserts actually holds, at the code level, against the reopen's "flickers twice"
    // report's first candidate explanation (a genuine duplicate call within one load, as opposed
    // to the reload-based explanation documented in that same comment).
    await page.waitForTimeout(500)

    const silentRequests = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__silentRequests,
    )
    expect(silentRequests).toEqual([{ prompt: '' }])
  })
})

test.describe('silent-refresh timeout backstop (issue #45)', () => {
  test('a silent restore that never calls back times out instead of hanging, and interactive sign-in still works afterward', async ({
    page,
  }) => {
    // authStore's SILENT_REFRESH_TIMEOUT_MS is 8s; give this test real headroom around that.
    test.setTimeout(30_000)
    await installGoogleApiMock(page)
    await installHangingSilentFakeGis(page)
    await createRandomCampaign(page)
    const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1]

    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto(`/play/${campaignId}`)

    await expect(page.getByText('Reconnecting to Google Drive…')).toBeVisible()

    // Regression coverage: before the timeout backstop, a silent request that never calls back
    // left the app stuck on 'restoring' forever (and would have wedged authStore's single-request
    // queue for every later token request too, including this very button click).
    const signInButton = page.getByRole('button', { name: 'Sign in with Google' })
    await expect(signInButton).toBeVisible({ timeout: 12_000 })

    await signInButton.click()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()
  })
})

test.describe('AuthGate installed-Android-app note (issue #45)', () => {
  test('is not shown on an ordinary desktop browser', async ({ page }) => {
    await installGoogleApiMock(page)
    await installRecordingFakeGis(page)
    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
    await expect(page.getByText(/you may need to sign in again every time/i)).not.toBeVisible()
  })

  test('is shown when running as an installed standalone app on Android', async ({ browser }) => {
    // src/lib/platform.ts's isInstalledAndroidApp() checks both an Android user agent and the
    // `(display-mode: standalone)` media query — Playwright has no context option for the
    // latter, so it's stubbed via addInitScript rather than left unverified.
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window)
      window.matchMedia = (query: string) =>
        query.includes('display-mode: standalone')
          ? ({
              matches: true,
              media: query,
              addListener: () => {},
              removeListener: () => {},
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => true,
            } as MediaQueryList)
          : original(query)
    })
    await installGoogleApiMock(page)
    await installRecordingFakeGis(page)
    await clearStorageKey(page, SESSION_STORAGE_KEY)
    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
    await expect(page.getByText(/you may need to sign in again every time/i)).toBeVisible()

    await context.close()
  })
})
