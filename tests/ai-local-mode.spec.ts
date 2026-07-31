import { test, expect } from '@playwright/test'
import { installGoogleApiMock } from './mocks/googleApi'
import { createRandomCampaign, setCampaignAiMode } from './helpers'

/**
 * Real, on-device Gemma generation via WebGPU can't practically run as an automated test here:
 * Playwright's Chromium actually feature-detects `navigator.gpu` as present (Chrome ships WebGPU
 * by default now — verified directly, not assumed), so `isLocalModelSupported()` says yes and the
 * code proceeds to actually try downloading the ~2.9GB model from Hugging Face over the real
 * network. That's not something to build CI coverage on regardless of GPU availability. So the
 * network path to huggingface.co is blocked below to force a fast, deterministic load failure —
 * this is also a realistic failure mode (an offline device, a captive network) which the app
 * needs to survive with a clear error, not a hang or a crash.
 */
test.describe('local (on-device) AI mode', () => {
  test('the "Local AI model" download card is on Settings regardless of campaign or AI mode', async ({ page }) => {
    await installGoogleApiMock(page)

    // No campaign at all — the general Settings page, reached directly.
    await page.goto('/settings')
    await expect(page.getByText('Local AI model', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download model now' })).toBeVisible()

    // Still there for a campaign whose AI mode is NOT local (manual is the default for a fresh
    // campaign) — this card doesn't depend on the currently-viewed campaign's settings.
    await createRandomCampaign(page)
    const match = page.url().match(/\/play\/([^/?#]+)/)
    const campaignId = match![1]
    await page.goto(`/settings/${campaignId}`)
    await expect(page.getByText('Local AI model', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download model now' })).toBeVisible()
  })

  test('is selectable in Settings and persists across a reload', async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'local')

    const match = page.url().match(/\/play\/([^/?#]+)/)
    const campaignId = match![1]
    await page.goto(`/settings/${campaignId}`)

    await expect(page.locator('[data-slot="select-trigger"]').first()).toContainText(
      'Local model (Gemma, runs on this device)',
    )
    // "Downloads roughly 3 GB" appears both in this campaign's own note and in the always-visible
    // "Local AI model" card further down the page — just confirm the campaign-specific one shows.
    await expect(page.getByText(/Downloads roughly 3.*GB/).first()).toBeVisible()
  })

  test('a model load failure (e.g. no network) surfaces a clear error, not a hang or crash', async ({ page }) => {
    await installGoogleApiMock(page)
    // Force the model download itself to fail fast instead of actually fetching ~2.9GB.
    await page.route(/huggingface\.co|hf\.co/, (route) => route.abort('failed'))

    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'local')

    await page.getByPlaceholder('Say or do anything…').fill('look around')
    await page.getByRole('button', { name: 'Act', exact: true }).click()

    await expect(page.getByText('Generating on this device')).toBeVisible()
    // The dialog surfaces *some* clear error rather than hanging forever, and offers Retry.
    await expect(page.locator('.text-destructive').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()

    // The turn was never applied — no crash, no silent partial state. (Turn/location now lives
    // in the header's icon button, not page body text.)
    await expect(page.getByTitle(/^Turn 0/)).toBeVisible()
  })

  test('the model can be downloaded ahead of time from Settings, without acting first', async ({ page }) => {
    await installGoogleApiMock(page)
    await page.route(/huggingface\.co|hf\.co/, (route) => route.abort('failed'))

    await createRandomCampaign(page)
    await setCampaignAiMode(page, 'local')

    const match = page.url().match(/\/play\/([^/?#]+)/)
    const campaignId = match![1]
    await page.goto(`/settings/${campaignId}`)

    const downloadButton = page.getByRole('button', { name: 'Download model now' })
    await expect(downloadButton).toBeVisible()
    await downloadButton.click()

    // Disabled and showing progress while in flight, no need to visit Play/Act at all.
    await expect(page.getByRole('button', { name: 'Download model now' })).toHaveCount(0)

    // Blocked network surfaces as a clear failure here too, same as the Act-triggered path —
    // the button becomes available again rather than getting stuck disabled forever.
    await expect(downloadButton).toBeVisible({ timeout: 15_000 })
    await expect(downloadButton).toBeEnabled()
  })

  test('a downloaded model can be removed from the device', async ({ page }) => {
    await installGoogleApiMock(page)
    await page.goto('/settings')

    // Seed the on-device cache directly (src/lib/ai/localModelCache.ts's schema) rather than
    // performing a real ~2.9GB download of actual ONNX model data, which isn't something a test can
    // fake — this exercises the same hasDownloadedLocalModel()/removeLocalModel() functions a
    // real download would leave behind.
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const openReq = indexedDB.open('adventure-local-model-cache', 1)
        openReq.onupgradeneeded = () => {
          openReq.result.createObjectStore('responses', { keyPath: 'url' })
        }
        openReq.onsuccess = () => {
          const db = openReq.result
          const tx = db.transaction('responses', 'readwrite')
          tx.objectStore('responses').put({
            url: 'https://huggingface.co/fake-model-file.onnx',
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'application/octet-stream']],
            body: new ArrayBuffer(8),
          })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        openReq.onerror = () => reject(openReq.error)
      })
    })

    await page.reload()
    await expect(page.getByText('Model downloaded and ready — turns start instantly.')).toBeVisible()
    const removeButton = page.getByRole('button', { name: 'Remove downloaded model' })
    await expect(removeButton).toBeVisible()

    await removeButton.click()
    await expect(page.getByText('Local model removed from this device.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download model now' })).toBeVisible()
    await expect(page.getByText('Model downloaded and ready — turns start instantly.')).toHaveCount(0)

    // The underlying cache is actually gone, not just the UI state.
    const remainingCount = await page.evaluate(() => {
      return new Promise<number>((resolve, reject) => {
        const openReq = indexedDB.open('adventure-local-model-cache', 1)
        openReq.onupgradeneeded = () => {
          openReq.result.createObjectStore('responses', { keyPath: 'url' })
        }
        openReq.onsuccess = () => {
          const db = openReq.result
          const tx = db.transaction('responses', 'readonly')
          const countReq = tx.objectStore('responses').count()
          countReq.onsuccess = () => resolve(countReq.result)
          countReq.onerror = () => reject(countReq.error)
        }
        openReq.onerror = () => reject(openReq.error)
      })
    })
    expect(remainingCount).toBe(0)
  })
})
