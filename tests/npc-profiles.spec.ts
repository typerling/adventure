import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock, type FakeDriveStore } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'

/**
 * Coverage for issue #30 — persistent, evolving NPC and player profiles. See the issue's scoping
 * comment for the design: NPCAttributes tab, NPCs gains voice/secrets/notes/detailFile,
 * world/npcs/<slug>.md detail files, and profile-depth gating (full profile only for NPCs with
 * real interaction — a background character stays name+description only).
 */

function campaignIdFromUrl(page: Page): string {
  const match = page.url().match(/\/play\/([^/?#]+)/)
  if (!match) throw new Error(`campaignIdFromUrl: no campaign id in URL "${page.url()}"`)
  return match[1]
}

async function actAndOpenDialog(page: Page, action: string): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill(action)
  await page.getByRole('button', { name: 'Act', exact: true }).click()
}

/** Drives the manual copy/paste turn dialog end to end with a crafted state_delta — same
 * technique tests/mobile-layout.spec.ts / tests/ai-api-mode.spec.ts already use, extended to
 * accept an arbitrary state_delta rather than always submitting an empty one (see helpers.ts's
 * submitFreeTextTurn for the empty-delta version this mirrors). */
async function submitTurnWithDelta(
  page: Page,
  action: string,
  narrative: string,
  stateDelta: Record<string, unknown>,
): Promise<void> {
  await actAndOpenDialog(page, action)
  const reply = `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: stateDelta,
    summary_update: narrative,
    options: ['Look around', 'Move on'],
  })}\n\`\`\``
  await page.getByPlaceholder(/Paste the narrative/).fill(reply)
  await page.getByRole('button', { name: 'Apply turn' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Reaches into the fake Drive store's spreadsheet file for a tab's raw rows (row 0 is the
 * header, same convention decodeTab strips). There's no UI surface for voice/secrets/notes/
 * attributes yet (Codex display is explicitly out of scope for this ticket — see #31), so
 * asserting persistence means reading the mock backend directly rather than the rendered page. */
function sheetRows(store: FakeDriveStore, tab: string): (string | number | boolean)[][] {
  const file = store.allFiles().find((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet')
  if (!file?.spreadsheet) throw new Error('No spreadsheet found in the fake Drive store')
  const sheet = file.spreadsheet.sheets[tab]
  if (!sheet) throw new Error(`No "${tab}" tab in the fake spreadsheet`)
  return sheet.rows
}

test.describe('NPC + player character profiles (#30)', () => {
  test('a background NPC mentioned in passing stays minimal — no forced voice/secrets/attributes', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(page, 'walk through the market', 'A passerby nods and keeps walking.', {
      new_npcs: [{ name: 'A Passerby', description: 'nods and keeps walking' }],
    })

    const npcRows = sheetRows(store, 'NPCs')
    const row = npcRows.find((r) => r[1] === 'A Passerby')
    expect(row, 'the background NPC was persisted').toBeDefined()
    // Columns: id, name, description, relationship, status, lastSeenTurn, voice, secrets, notes, detailFile
    expect(row![6]).toBe('')
    expect(row![7]).toBe('')
    expect(row![8]).toBe('')
    expect(row![9]).toBe('')

    const attrRows = sheetRows(store, 'NPCAttributes').slice(1)
    expect(attrRows).toHaveLength(0)
  })

  test('an NPC with real interaction gets a full profile written to the sheet and a detail file in Drive', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(
      page,
      'talk to the old caretaker',
      'Old Maren eyes you warily before speaking.',
      {
        new_npcs: [
          {
            name: 'Old Maren',
            description: 'the chapel caretaker',
            voice: 'gravelly, clipped sentences',
            secrets: 'she sold the key to the cult, not the other way around',
            attributes: { Occupation: 'chapel caretaker' },
            notes_add: "Admitted she's been paid to keep strangers out of the crypt.",
          },
        ],
      },
    )

    const npcRow = sheetRows(store, 'NPCs').find((r) => r[1] === 'Old Maren')
    expect(npcRow, 'the interactive NPC was persisted').toBeDefined()
    expect(npcRow![6]).toBe('gravelly, clipped sentences')
    expect(npcRow![7]).toBe('she sold the key to the cult, not the other way around')
    expect(npcRow![8]).toBe("Admitted she's been paid to keep strangers out of the crypt.")
    expect(npcRow![9]).toBe('world/npcs/old-maren.md')

    const attrRow = sheetRows(store, 'NPCAttributes').find((r) => r[1] === 'Occupation')
    expect(attrRow?.[2]).toBe('chapel caretaker')

    // The detail-file append actually landed in Drive.
    const detailFile = store.allFiles().find((f) => f.name === 'old-maren.md')
    expect(detailFile, 'world/npcs/old-maren.md was created in Drive').toBeDefined()
    expect(detailFile!.content).toContain('## Turn 1')
    expect(detailFile!.content).toContain("Admitted she's been paid to keep strangers out of the crypt.")

    // Secrets never leak into any player-facing render: not the just-applied turn's narrative/
    // options on Play, and not Codex once the NPC is looked up there.
    await expect(page.locator('body')).not.toContainText('she sold the key to the cult')
    const campaignId = campaignIdFromUrl(page)
    await page.goto(`/codex/${campaignId}`)
    await page.getByRole('tab', { name: 'NPCs' }).click()
    await expect(page.getByText('Old Maren')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('she sold the key to the cult')
  })

  test("the player's own Character profile picks up a new descriptive key mid-campaign", async ({ page }) => {
    await installGoogleApiMock(page)
    await createRandomCampaign(page)
    const campaignId = campaignIdFromUrl(page)

    await submitTurnWithDelta(
      page,
      'reflect on the journey so far',
      'You pause for a moment, thinking about how far you have come.',
      { stat_changes: { Personality: 'curious and quick to trust' } },
    )

    await page.goto(`/codex/${campaignId}`)
    await expect(page.getByText('Personality', { exact: true })).toBeVisible()
    await expect(page.getByText('curious and quick to trust')).toBeVisible()
  })

  test("naming a returning NPC pulls their detail file into the next turn's prompt", async ({ page }) => {
    // Two turns apply back-to-back with no pause between the first Apply and the second Act
    // click below — hide toasts so a lingering "Turn applied." doesn't intercept that click (see
    // hideToasts's doc comment / ai-api-mode.spec.ts for the same issue).
    await hideToasts(page)
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(
      page,
      'talk to the old caretaker',
      'Old Maren eyes you warily before speaking.',
      {
        new_npcs: [
          {
            name: 'Old Maren',
            description: 'the chapel caretaker',
            voice: 'gravelly, clipped sentences',
            notes_add: "Admitted she's been paid to keep strangers out of the crypt.",
          },
        ],
      },
    )

    // A later action that doesn't name her shouldn't pull her *detail file* in — the condensed
    // `notes` line still renders every turn regardless (see promptBuilder's "Known NPCs"
    // section), so this specifically checks for the "## Recalled history" markdown heading that
    // only appears on a name match — not just any mention of the phrase, since contract.ts's own
    // instructions describe that section by name too (without the "##" heading marker).
    await actAndOpenDialog(page, 'look around the market square')
    const promptTextarea = page.locator('textarea[readonly]')
    await expect(promptTextarea).not.toHaveValue(/## Recalled history/)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Naming her by name should.
    await actAndOpenDialog(page, 'Ask Old Maren about the key')
    await expect(promptTextarea).toHaveValue(/## Recalled history for NPCs named in this turn's action/)
    await expect(promptTextarea).toHaveValue(/Admitted she's been paid to keep strangers out of the crypt\./)
  })
})
