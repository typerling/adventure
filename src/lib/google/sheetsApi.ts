import { googleFetch } from './http'
import { moveFileToFolder } from './driveApi'

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export type CellValue = string | number | boolean
export type Row = CellValue[]

interface CreateSpreadsheetResponse {
  spreadsheetId: string
  sheets: { properties: { sheetId: number; title: string } }[]
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

  await googleFetch(`${SHEETS_BASE}/${created.spreadsheetId}/values:batchUpdate`, {
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

  await googleFetch(`${SHEETS_BASE}/${created.spreadsheetId}:batchUpdate`, {
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

  return { spreadsheetId: created.spreadsheetId, sheetIds }
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
