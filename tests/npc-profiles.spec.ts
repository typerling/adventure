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

  test('a short NPC name matches whole words only, not as a substring of an unrelated word', async ({ page }) => {
    // Flagged in PR #37's review: a plain substring check on a short name like "Al" would
    // false-positive against "alley" and pull in an irrelevant detail file. findMentionedNpcs
    // uses a word-boundary regex specifically to avoid this.
    await hideToasts(page)
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(page, 'talk to the dockhand', 'Al leans on a crate, watching the ship unload.', {
      new_npcs: [{ name: 'Al', description: 'a dockhand', notes_add: 'Owes money to the harbormaster.' }],
    })

    const promptTextarea = page.locator('textarea[readonly]')

    // Contains "Al" as a substring of "alley," not as the standalone name — should not match.
    await actAndOpenDialog(page, 'duck into the alley to avoid the crowd')
    await expect(promptTextarea).not.toHaveValue(/## Recalled history/)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Names him as a whole word — should match.
    await actAndOpenDialog(page, 'ask Al about the harbormaster')
    await expect(promptTextarea).toHaveValue(/## Recalled history for NPCs named in this turn's action/)
    await expect(promptTextarea).toHaveValue(/Owes money to the harbormaster\./)
  })

  test('a secret reaches a later turn\'s prompt — manual mode cannot hide it, unlike Play/Codex', async ({ page }) => {
    // A secret only does its job (the DM staying consistent about something it hasn't told the
    // player yet) if the model actually sees it again on a later turn — so unlike the earlier
    // "never leaks into Play/Codex" test, this specifically checks the *prompt* the app builds
    // for the *next* turn, where it deliberately does appear. See promptBuilder.ts's "Known
    // NPCs" doc comment: this is an accepted, pre-existing property of manual mode (it shows the
    // whole built prompt for the player to copy — nothing in a prompt can be hidden from someone
    // relaying it by hand), not a gap this test is settling for.
    //
    // Two turns/dialogs open back-to-back below with no pause — hide toasts so a lingering
    // "Turn applied." doesn't intercept the second Act click (see hideToasts's doc comment /
    // the "returning NPC" test above for the same issue).
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
            secrets: 'she sold the key to the cult, not the other way around',
          },
        ],
      },
    )

    // Renders unconditionally with every known NPC each turn — unlike detail-file recall, this
    // isn't gated on the new action naming her.
    await actAndOpenDialog(page, 'look around the market square')
    await expect(page.locator('textarea[readonly]')).toHaveValue(/she sold the key to the cult/)
  })
})
