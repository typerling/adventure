import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installGoogleApiMock, type FakeDriveStore } from './mocks/googleApi'
import { createRandomCampaign, hideToasts } from './helpers'

/**
 * Coverage for issue #83 — GM-only foreshadowed threads and ticking threats ("fronts/clocks"),
 * the story-level equivalent of NPC `secrets` (#30). See DESIGN.md §4/§5 for the data model and
 * `src/lib/ai/contract.ts`'s "Story threads" instructions. Structurally mirrors
 * tests/npc-profiles.spec.ts, which established this same crafted-state_delta technique.
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

/** Reaches into the fake Drive store's spreadsheet file for a tab's raw rows — there's no
 * player-facing UI for Threads (deliberately GM-only, see PR description), so asserting
 * persistence means reading the mock backend directly, same as npc-profiles.spec.ts does for
 * voice/secrets/attributes. */
function sheetRows(store: FakeDriveStore, tab: string): (string | number | boolean)[][] {
  const file = store.allFiles().find((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet')
  if (!file?.spreadsheet) throw new Error('No spreadsheet found in the fake Drive store')
  const sheet = file.spreadsheet.sheets[tab]
  if (!sheet) throw new Error(`No "${tab}" tab in the fake spreadsheet`)
  return sheet.rows
}

test.describe('Story threads / fronts-clocks tracking (#83)', () => {
  test('a planted, unrevealed thread is persisted GM-only and never leaks into Play or Codex', async ({
    page,
  }) => {
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(
      page,
      'explore the cellar',
      'Dust motes hang in the light. Nothing seems out of place.',
      {
        new_threads: [
          {
            title: 'The cult beneath the chapel',
            description: 'A cult is quietly preparing a ritual in the crypt below the chapel.',
            status: 'dormant',
            revealed: false,
            progress: 0,
            progressMax: 6,
          },
        ],
      },
    )

    // Columns: id, title, description, status, revealed, progress, progressMax, createdTurn, updatedTurn
    const row = sheetRows(store, 'Threads').find((r) => r[1] === 'The cult beneath the chapel')
    expect(row, 'the thread was persisted').toBeDefined()
    expect(row![2]).toBe('A cult is quietly preparing a ritual in the crypt below the chapel.')
    expect(row![3]).toBe('dormant')
    expect(row![4]).toBe(false)
    expect(row![5]).toBe(0)
    expect(row![6]).toBe(6)

    // Never appears in the just-applied turn's rendered narrative/options.
    await expect(page.locator('body')).not.toContainText('cult beneath the chapel')
    await expect(page.locator('body')).not.toContainText('preparing a ritual')

    // Nor in Codex, which has no Threads surface at all (deliberately GM-only scoping).
    const campaignId = campaignIdFromUrl(page)
    await page.goto(`/codex/${campaignId}`)
    await expect(page.locator('body')).not.toContainText('cult beneath the chapel')
    await expect(page.locator('body')).not.toContainText('preparing a ritual')
  })

  test('an unrevealed thread still reaches the next turn\'s DM prompt (GM-only, like NPC secrets)', async ({
    page,
  }) => {
    await hideToasts(page)
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(
      page,
      'explore the cellar',
      'Dust motes hang in the light. Nothing seems out of place.',
      {
        new_threads: [
          {
            title: 'The cult beneath the chapel',
            description: 'A cult is quietly preparing a ritual in the crypt below the chapel.',
            status: 'active',
            revealed: false,
            progress: 1,
            progressMax: 6,
          },
        ],
      },
    )

    // A wholly unrelated next action still carries the unresolved thread forward in the prompt —
    // this is what lets the DM keep it consistent/advancing without the player raising it.
    await actAndOpenDialog(page, 'go back upstairs and make tea')
    const promptTextarea = page.locator('textarea[readonly]')
    await expect(promptTextarea).toHaveValue(/Story threads/)
    await expect(promptTextarea).toHaveValue(/The cult beneath the chapel/)
    await expect(promptTextarea).toHaveValue(/revealed: no/)
    await expect(promptTextarea).toHaveValue(/1\/6/)
  })

  test('a thread advances (its clock ticks and it can go active) off-screen, on a turn the player never engages it', async ({
    page,
  }) => {
    await hideToasts(page)
    const store = await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(page, 'explore the cellar', 'Nothing seems out of place, for now.', {
      new_threads: [
        {
          title: 'The cult beneath the chapel',
          description: 'A cult is quietly preparing a ritual in the crypt below the chapel.',
          status: 'dormant',
          revealed: false,
          progress: 0,
          progressMax: 6,
        },
      ],
    })

    // Player does something with zero connection to the cult/chapel — the DM still ticks the
    // clock forward in the state block, matching contract.ts's "advance ... even on turns where
    // the player didn't touch it directly" instruction.
    await submitTurnWithDelta(page, 'haggle with a fruit seller', 'You talk the price down by a few coins.', {
      thread_updates: [{ title: 'The cult beneath the chapel', status: 'active', progress: 2 }],
    })

    const row = sheetRows(store, 'Threads').find((r) => r[1] === 'The cult beneath the chapel')
    expect(row![3]).toBe('active')
    expect(row![5]).toBe(2)
    expect(row![6]).toBe(6)
    // updatedTurn (column 8) moved to the second turn, distinct from createdTurn (column 7).
    expect(row![7]).toBe(1)
    expect(row![8]).toBe(2)

    // Still hasn't leaked anywhere player-facing despite two turns of activity.
    await expect(page.locator('body')).not.toContainText('cult beneath the chapel')
  })

  test('revealing a thread flips it visible in the prompt, and resolving it drops it from later prompts', async ({
    page,
  }) => {
    await hideToasts(page)
    await installGoogleApiMock(page)
    await createRandomCampaign(page)

    await submitTurnWithDelta(page, 'explore the cellar', 'Nothing seems out of place, for now.', {
      new_threads: [
        {
          title: 'The cult beneath the chapel',
          description: 'A cult is quietly preparing a ritual in the crypt below the chapel.',
          status: 'active',
          revealed: false,
          progress: 5,
          progressMax: 6,
        },
      ],
    })

    // The story reveals it — the DM flips `revealed` the turn this actually happens.
    await submitTurnWithDelta(
      page,
      'push open the crypt door',
      'Robed figures scatter as torchlight spills across the altar — a cult, mid-ritual.',
      { thread_updates: [{ title: 'The cult beneath the chapel', revealed: true, progress: 6 }] },
    )

    await actAndOpenDialog(page, 'confront them')
    const promptTextarea = page.locator('textarea[readonly]')
    await expect(promptTextarea).toHaveValue(/revealed: yes/)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Now resolve it — from here on it should no longer be fed back into prompts at all (bounded
    // context, same reasoning as "Active quests" only showing status === 'active').
    await submitTurnWithDelta(
      page,
      'confront them',
      'The ritual is broken up before it can finish. The cult scatters into the dark.',
      { thread_updates: [{ title: 'The cult beneath the chapel', status: 'resolved' }] },
    )

    await actAndOpenDialog(page, 'head back to town')
    await expect(promptTextarea).not.toHaveValue(/The cult beneath the chapel/)
  })
})
