import { googleFetch } from './http'
import { moveFileToFolder } from './driveApi'

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export type CellValue = string | number | boolean
export type Row = CellValue[]

interface CreateSpreadsheetResponse {
  spreadsheetId: string
  sheets: { properties: { sheetId: number; title: string } }[]
}

/** Writes each tab's header row (bolded) as its first row — shared by createSpreadsheet (every
 * tab, on a brand-new spreadsheet) and addMissingTabs (just the newly-added ones, on an existing
 * spreadsheet that predates them). */
async function writeTabHeaders(
  spreadsheetId: string,
  tabs: { title: string; headers: string[] }[],
  sheetIds: Record<string, number>,
): Promise<void> {
  await googleFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: tabs.map((t) => ({
        range: `'${t.title}'!A1`,
        values: [t.headers],
      })),
    }),
  })

  await googleFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: tabs.map((t) => ({
        repeatCell: {
          range: { sheetId: sheetIds[t.title], startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      })),
    }),
  })
}

/** Creates a spreadsheet with one tab per entry, moves it into folderId, and writes each tab's
 * header row (bolded) as the first row. Returns the spreadsheet id and per-tab sheetId map. */
export async function createSpreadsheet(
  title: string,
  folderId: string,
  tabs: { title: string; headers: string[] }[],
): Promise<{ spreadsheetId: string; sheetIds: Record<string, number> }> {
  const created = await googleFetch<CreateSpreadsheetResponse>(SHEETS_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: tabs.map((t) => ({ properties: { title: t.title } })),
    }),
  })

  await moveFileToFolder(created.spreadsheetId, folderId)

  const sheetIds: Record<string, number> = {}
  for (const s of created.sheets) sheetIds[s.properties.title] = s.properties.sheetId

  await writeTabHeaders(created.spreadsheetId, tabs, sheetIds)

  return { spreadsheetId: created.spreadsheetId, sheetIds }
}

/** Adds whichever of `tabs` aren't already present in the spreadsheet, with the same header-row
 * setup a freshly created campaign gets — a no-op if every tab already exists. Exists because
 * SHEET_TABS has grown over time (e.g. NPCAttributes, added when NPC profiles shipped), so an
 * older campaign's actual spreadsheet can predate a tab the app now always expects to be there.
 * See loadSheetSnapshot's retry-on-missing-tab handling, the caller of this.
 *
 * Unlike createSpreadsheet's writeTabHeaders (two sequential calls, fine there since a failure
 * mid-setup just abandons a still-empty brand-new spreadsheet), this runs against a *live*
 * spreadsheet that may already hold real data in its other tabs. addSheet and its header-row
 * values/formatting are therefore issued as a *single* batchUpdate — Sheets applies a batchUpdate
 * atomically, so there's no network-observable state where a healed tab exists with no header:
 * a lost header row would otherwise mean the first real data row later appended to that tab gets
 * silently treated as the header and dropped by decodeTab's `rows.slice(1)`, forever, with no
 * error anywhere. This does mean picking each new tab's sheetId ourselves up front (Sheets lets
 * addSheet specify one instead of auto-assigning) rather than reading it back from an addSheet
 * reply, since the header-writing requests in the same batch need to reference it immediately.
 *
 * Known narrow gap, not fixed here: if the same spreadsheet is healed from two tabs/sessions at
 * once, both compute the same "missing" set from one read each and could race to add the same
 * title — Google rejects an explicit duplicate title rather than silently deduping, so the losing
 * call surfaces a confusing error on that one load instead of a silent heal. Self-recovers on the
 * next reload (the tab the winner created is now present), not data-corrupting — just a rough
 * edge, considered acceptable for how rarely two sessions would race the very first load of a
 * newly-outdated campaign.
 */
export async function addMissingTabs(
  spreadsheetId: string,
  tabs: { title: string; headers: string[] }[],
): Promise<void> {
  const meta = await googleFetch<{ sheets: { properties: { sheetId: number; title: string } }[] }>(
    `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
  )
  const existingTitles = new Set(meta.sheets.map((s) => s.properties.title))
  const missing = tabs.filter((t) => !existingTitles.has(t.title))
  if (missing.length === 0) return

  let nextSheetId = Math.max(0, ...meta.sheets.map((s) => s.properties.sheetId)) + 1
  const sheetIds: Record<string, number> = {}
  for (const t of missing) sheetIds[t.title] = nextSheetId++

  const requests = missing.flatMap((t) => {
    const sheetId = sheetIds[t.title]
    return [
      { addSheet: { properties: { sheetId, title: t.title } } },
      {
        updateCells: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: t.headers.length },
          rows: [
            {
              values: t.headers.map((h) => ({
                userEnteredValue: { stringValue: h },
                userEnteredFormat: { textFormat: { bold: true } },
              })),
            },
          ],
          fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
        },
      },
    ]
  })

  await googleFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  })
}

/** Reads every tab in one round trip. Returns raw rows (row 0 is the header row) per tab title. */
export async function batchGetTabs(
  spreadsheetId: string,
  tabTitles: string[],
): Promise<Record<string, Row[]>> {
  const ranges = tabTitles.map((t) => `ranges=${encodeURIComponent(`'${t}'!A1:ZZ`)}`).join('&')
  const res = await googleFetch<{ valueRanges: { values?: Row[] }[] }>(
    `${SHEETS_BASE}/${spreadsheetId}/values:batchGet?${ranges}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
  )
  const out: Record<string, Row[]> = {}
  tabTitles.forEach((title, i) => {
    out[title] = res.valueRanges[i]?.values ?? []
  })
  return out
}

export async function appendRow(spreadsheetId: string, tabTitle: string, row: Row): Promise<void> {
  const range = encodeURIComponent(`'${tabTitle}'!A1`)
  await googleFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    },
  )
}

export async function appendRows(
  spreadsheetId: string,
  tabTitle: string,
  rows: Row[],
): Promise<void> {
  if (rows.length === 0) return
  const range = encodeURIComponent(`'${tabTitle}'!A1`)
  await googleFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    },
  )
}

/** Overwrites one data row. rowNumber is 1-based sheet row (row 1 = header, so first data row = 2). */
export async function updateRow(
  spreadsheetId: string,
  tabTitle: string,
  rowNumber: number,
  row: Row,
): Promise<void> {
  const range = encodeURIComponent(`'${tabTitle}'!A${rowNumber}`)
  await googleFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  })
}
