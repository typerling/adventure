import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock, type FakeDriveStore } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'
import { TAB_HEADERS } from '../src/lib/google/sheetSchema'
import { KOKORO_VOICE_IDS } from '../src/lib/voice/kokoroVoiceCatalog'

/**
 * End-to-end coverage for issue #98's voice-casting pipeline (contract -> validate -> applyDelta),
 * driven the same way tests/npc-profiles.spec.ts drives the rest of the NPC-profile contract:
 * through the real manual copy/paste turn dialog against the fake Drive/Sheets backend, asserting
 * on the persisted sheet rows rather than any UI (no Codex surface for voice casting exists yet).
 */

async function actAndOpenDialog(page: Page, action: string): Promise<void> {
  await page.getByPlaceholder('Say or do anything…').fill(action)
  await page.getByRole('button', { name: 'Act', exact: true }).click()
}

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

function spreadsheetFile(store: FakeDriveStore) {
  const file = store.allFiles().find((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet')
  if (!file?.spreadsheet) throw new Error('No spreadsheet found in the fake Drive store')
  return file
}

function npcRows(store: FakeDriveStore): (string | number | boolean)[][] {
  return spreadsheetFile(store).spreadsheet!.sheets.NPCs.rows
}

// Columns: id, name, description, relationship, status, lastSeenTurn, voice, secrets, notes,
// detailFile, voiceId, voiceSpeed, voiceLocked.
const NPC_COL = {
  name: 1,
  voiceId: 10,
  voiceSpeed: 11,
  voiceLocked: 12,
} as const

test.describe('Voice casting (#98)', () => {
  test('an AI reply casting an unrecognized voiceId still applies the rest of the turn (validation warns, does not block)', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)

    // submitTurnWithDelta itself already asserts the dialog closed (no blocking validation
    // error) — the real point of this test is that the garbage voiceId doesn't survive onto the
    // sheet either, defense-in-depth alongside the warning.
    await submitTurnWithDelta(page, 'talk to the old caretaker', 'Old Maren eyes you warily.', {
      new_npcs: [
        {
          name: 'Old Maren',
          description: 'the chapel caretaker',
          voiceId: 'not-a-real-voice-id',
          voiceSpeed: 99, // also out of range — same coerce-don't-block rule
        },
      ],
    })

    const row = npcRows(store).find((r) => r[1] === 'Old Maren')
    expect(row, 'the NPC was persisted despite the garbage voiceId/voiceSpeed').toBeDefined()
    expect(row![NPC_COL.voiceId]).not.toBe('not-a-real-voice-id')
    expect(row![NPC_COL.voiceSpeed]).not.toBe(99)
  })

  test('a character who speaks (per the {{v:Name}} token) but the AI never cast a voice for gets a deterministic fallback voiceId', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(
      page,
      'talk to the old caretaker',
      '{{v:Old Maren}}"Keys like that one do not come free."{{/v}} she says.',
      {
        new_npcs: [{ name: 'Old Maren', description: 'the chapel caretaker' }],
      },
    )

    const row = npcRows(store).find((r) => r[1] === 'Old Maren')
    expect(row, 'the NPC was persisted').toBeDefined()
    // Never cast by the AI (new_npcs above has no voiceId at all) — must still end up with a
    // real, recognizable catalog voice, not left blank, since she spoke this turn.
    expect(KOKORO_VOICE_IDS).toContain(row![NPC_COL.voiceId])
  })

  test('the same speaking character gets the same fallback voiceId across two separate campaigns (determinism, not just "picks something")', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)
    await submitTurnWithDelta(
      page,
      'talk to the harbormaster',
      '{{v:Harbormaster Voss}}"State your business."{{/v}}',
      { new_npcs: [{ name: 'Harbormaster Voss', description: 'runs the docks' }] },
    )
    const firstVoiceId = npcRows(store).find((r) => r[1] === 'Harbormaster Voss')?.[NPC_COL.voiceId]
    expect(firstVoiceId).toBeTruthy()

    // A second, entirely separate campaign (fresh spreadsheet, fresh Drive folder) — nothing
    // about "narrator voice"/"player voice"/"other cast NPCs" carries over, since this is a brand
    // new campaign, so the fallback's inputs for this one character are identical to the first.
    await createRandomCampaign(page)
    await submitTurnWithDelta(
      page,
      'talk to the harbormaster',
      '{{v:Harbormaster Voss}}"State your business."{{/v}}',
      { new_npcs: [{ name: 'Harbormaster Voss', description: 'runs the docks' }] },
    )
    const secondVoiceId = npcRows(store).find((r) => r[1] === 'Harbormaster Voss')?.[NPC_COL.voiceId]
    expect(secondVoiceId).toBe(firstVoiceId)
  })

  test('a voiceLocked NPC keeps its cast voice even when the AI sends a different voiceId', async ({ page }) => {
    await hideToasts(page)
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)
    const spreadsheetId = spreadsheetFile(store).id

    // Seed a locked, already-cast NPC directly into the fake backend (no Codex override UI exists
    // yet for this — that's #100) — bypasses the app entirely, same technique
    // backward-compat fixtures use to model a shape the app itself wouldn't produce today.
    store.setSheetRows(spreadsheetId, 'NPCs', [
      TAB_HEADERS.NPCs,
      ['npc-locked-1', 'Old Maren', 'the chapel caretaker', '', 'alive', 1, '', '', '', '', 'af_heart', 1, true],
    ])
    // The running page's in-memory campaignCache still has the pre-seed snapshot — only a full
    // reload re-fetches from the (now directly-mutated) fake store, per campaignCache.ts's own
    // doc comment ("cleared only by a full page reload").
    await page.reload()
    await expect(page.getByPlaceholder('Say or do anything…')).toBeVisible()

    await submitTurnWithDelta(page, 'talk to the old caretaker', 'Old Maren nods at you.', {
      npc_updates: [{ name: 'Old Maren', voiceId: 'am_adam', voiceSpeed: 1.5 }],
    })

    const row = npcRows(store).find((r) => r[1] === 'Old Maren')
    expect(row, 'the locked NPC still exists').toBeDefined()
    expect(row![NPC_COL.voiceId], 'a locked NPC\'s voiceId must never change').toBe('af_heart')
    expect(row![NPC_COL.voiceSpeed], 'a locked NPC\'s voiceSpeed must never change either').toBe(1)
    expect(row![NPC_COL.voiceLocked]).toBe(true)
  })
})
