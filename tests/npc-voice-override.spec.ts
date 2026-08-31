import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock, type FakeDriveStore } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'
import { TAB_HEADERS } from '../src/lib/google/sheetSchema'

/**
 * End-to-end coverage for issue #100 — the Codex's player-facing NPC voice override, the last
 * piece of the multi-voice-narration epic (#36). Driven through the real Codex UI against the
 * fake Drive/Sheets backend, asserting on the persisted sheet rows directly (not just the UI's
 * optimistic display) — see setNpcVoiceOverride's doc comment (campaignRepo.ts) for why this is a
 * small, dedicated write rather than going through applyDelta.ts's turn-shaped pipeline.
 */

function spreadsheetFile(store: FakeDriveStore) {
  const file = store.allFiles().find((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet')
  if (!file?.spreadsheet) throw new Error('No spreadsheet found in the fake Drive store')
  return file
}

function npcRows(store: FakeDriveStore): (string | number | boolean)[][] {
  return spreadsheetFile(store).spreadsheet!.sheets.NPCs.rows
}

// Columns: id, name, description, relationship, status, lastSeenTurn, voice, secrets, notes,
// detailFile, voiceId, voiceSpeed, voiceLocked — same layout voice-casting-integration.spec.ts
// documents.
const NPC_COL = {
  name: 1,
  voiceId: 10,
  voiceSpeed: 11,
  voiceLocked: 12,
} as const

/** Seeds a single, unlocked, uncast NPC directly into the fake backend (bypassing the app, same
 * technique voice-casting-integration.spec.ts and the backward-compat fixtures use), then reloads
 * so the running page's campaignCache picks up the freshly-mutated store — campaignCache.ts's own
 * doc comment is explicit that only a full reload re-fetches from Drive/Sheets. */
async function seedNpc(page: Page, store: FakeDriveStore, spreadsheetId: string): Promise<void> {
  store.setSheetRows(spreadsheetId, 'NPCs', [
    TAB_HEADERS.NPCs,
    ['npc-1', 'Old Maren', 'the chapel caretaker', '', 'alive', 1, '', '', '', '', '', 0, false],
  ])
  await page.reload()
}

function campaignIdFromUrl(page: Page): string {
  const match = page.url().match(/\/(?:play|codex)\/([^/?#]+)/)
  if (!match) throw new Error(`campaignIdFromUrl: no campaign id in URL "${page.url()}"`)
  return match[1]
}

async function submitTurnWithDelta(
  page: Page,
  action: string,
  narrative: string,
  stateDelta: Record<string, unknown>,
): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill(action)
  await page.getByRole('button', { name: 'Act', exact: true }).click()
  const reply = `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: stateDelta,
    summary_update: narrative,
    options: ['Look around', 'Move on'],
  })}\n\`\`\``
  await page.getByPlaceholder(/Paste the narrative/).fill(reply)
  await page.getByRole('button', { name: 'Apply turn' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test.describe('Codex NPC voice override (#100)', () => {
  test('picking a voice writes voiceId + voiceLocked, and survives a later AI turn trying to recast that NPC', async ({
    page,
  }) => {
    await hideToasts(page)
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)
    const spreadsheetId = spreadsheetFile(store).id
    await seedNpc(page, store, spreadsheetId)

    const campaignId = campaignIdFromUrl(page)
    await page.goto(`/codex/${campaignId}`)
    await page.getByRole('tab', { name: 'NPCs' }).click()
    await expect(page.getByText('Old Maren')).toBeVisible()
    await expect(page.getByText('Not cast yet')).toBeVisible()

    await page.getByTestId('npc-voice-button-npc-1').click()
    await expect(page.getByRole('dialog', { name: 'Choose a voice for Old Maren' })).toBeVisible()

    // The excluded-by-#107 pool must not appear here either — same castable list the AI casts
    // from, per the issue's explicit "closer to the AI's casting pool" reasoning.
    expect(page.getByRole('button', { name: /^Adam/ })).toHaveCount(0)

    await page.getByRole('button', { name: /^George/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The UI reflects the write only after it's confirmed (no optimistic pre-write state) — see
    // NpcVoicePicker's doc comment.
    await expect(page.getByText('George', { exact: true })).toBeVisible()
    await expect(page.getByText('Locked', { exact: true })).toBeVisible()

    let row = npcRows(store).find((r) => r[NPC_COL.name] === 'Old Maren')
    expect(row, 'the NPC row still exists').toBeDefined()
    expect(row![NPC_COL.voiceId]).toBe('bm_george')
    expect(row![NPC_COL.voiceLocked]).toBe(true)

    // Now exercise #98's lock-protection from the *other* direction: a real player-set lock (not
    // a test-seeded one), same as voice-casting-integration.spec.ts's own lock test but reached
    // through this ticket's actual write path rather than store.setSheetRows.
    await page.goto(`/play/${campaignId}`)
    await submitTurnWithDelta(page, 'talk to the old caretaker', 'Old Maren nods at you.', {
      npc_updates: [{ name: 'Old Maren', voiceId: 'am_adam', voiceSpeed: 1.5 }],
    })

    row = npcRows(store).find((r) => r[NPC_COL.name] === 'Old Maren')
    expect(row, 'the NPC still exists after the turn').toBeDefined()
    expect(row![NPC_COL.voiceId], "the player's override must survive an AI recast attempt").toBe('bm_george')
    expect(row![NPC_COL.voiceLocked]).toBe(true)
  })

  test('clearing the override unlocks the NPC without changing its cast voice', async ({ page }) => {
    await hideToasts(page)
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)
    const spreadsheetId = spreadsheetFile(store).id
    store.setSheetRows(spreadsheetId, 'NPCs', [
      TAB_HEADERS.NPCs,
      ['npc-1', 'Old Maren', 'the chapel caretaker', '', 'alive', 1, '', '', '', '', 'af_heart', 1, true],
    ])
    await page.reload()

    const campaignId = campaignIdFromUrl(page)
    await page.goto(`/codex/${campaignId}`)
    await page.getByRole('tab', { name: 'NPCs' }).click()
    await expect(page.getByText('Locked', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Clear override' }).click()
    await expect(page.getByText('Locked', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Set voice' })).toBeVisible()

    const row = npcRows(store).find((r) => r[NPC_COL.name] === 'Old Maren')
    expect(row).toBeDefined()
    expect(row![NPC_COL.voiceLocked]).toBe(false)
    // Clearing hands casting back to the AI — it must NOT blank the existing voiceId, so the
    // character keeps sounding the same until the AI actually casts someone new for them (see
    // setNpcVoiceOverride's doc comment).
    expect(row![NPC_COL.voiceId]).toBe('af_heart')
  })

  test('a failed write surfaces toast.error and the picker reverts rather than showing an unpersisted lock', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    // Registered after installGoogleApiMock, so (Playwright routes run LIFO) this one sees the
    // request first — fails only the NPCs row write, falling back to the real mock for
    // everything else so the rest of the app keeps working normally.
    await page.route('https://sheets.googleapis.com/**', async (route) => {
      const req = route.request()
      if (req.method() === 'PUT' && req.url().includes(encodeURIComponent(`'NPCs'`))) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 500, message: 'Simulated Sheets outage', status: 'INTERNAL' } }),
        })
        return
      }
      await route.fallback()
    })
    await createRandomCampaign(page)
    const spreadsheetId = spreadsheetFile(store).id
    await seedNpc(page, store, spreadsheetId)

    const campaignId = campaignIdFromUrl(page)
    await page.goto(`/codex/${campaignId}`)
    await page.getByRole('tab', { name: 'NPCs' }).click()

    await page.getByTestId('npc-voice-button-npc-1').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: /^George/ }).click()

    await expect(page.getByText(/Google API request failed \(500\)/)).toBeVisible()
    // The dialog stays open — a failed pick shouldn't act like it succeeded — and the row on the
    // fake backend was genuinely never written.
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText('Not cast yet')).toBeVisible()
    expect(page.getByText('Locked', { exact: true })).toHaveCount(0)

    const row = npcRows(store).find((r) => r[NPC_COL.name] === 'Old Maren')
    expect(row, 'the NPC row still exists').toBeDefined()
    expect(row![NPC_COL.voiceId]).toBe('')
    expect(row![NPC_COL.voiceLocked]).toBe(false)
  })
})
