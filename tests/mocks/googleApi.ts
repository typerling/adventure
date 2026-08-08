import type { Page, Route } from '@playwright/test'

/**
 * In-memory fake Google Drive + Sheets backend for e2e tests. This app talks to both APIs
 * directly from the browser (src/lib/google/driveApi.ts, sheetsApi.ts) with no server in
 * between, so mocking "the backend" means intercepting those exact HTTP calls and answering
 * them the way the real APIs would for the handful of operations this app performs — not a
 * general-purpose Drive/Sheets emulator.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SESSION_STORAGE_KEY = 'adventure:google-session'

type CellValue = string | number | boolean
type Row = CellValue[]

interface FakeSheet {
  sheetId: number
  rows: Row[]
}

interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
  content?: string
  spreadsheet?: { sheets: Record<string, FakeSheet> }
}

function fixedTimestamp(): string {
  // Real Date.now()/new Date() are fine here — this runs in Node during the test run, not
  // inside a Workflow script (the Date restriction there doesn't apply to Playwright tests).
  return new Date(2026, 0, 1).toISOString()
}

export class FakeDriveStore {
  private files = new Map<string, FakeFile>()
  private nextId = 1

  private newId(): string {
    return `file_${this.nextId++}`
  }

  findChildren(parentId: string, name?: string, mimeType?: string): FakeFile[] {
    return [...this.files.values()].filter(
      (f) =>
        f.parents.includes(parentId) &&
        (name === undefined || f.name === name) &&
        (mimeType === undefined || f.mimeType === mimeType),
    )
  }

  get(id: string): FakeFile | undefined {
    return this.files.get(id)
  }

  /** All folders in the store, for debugging/assertions in tests. */
  allFiles(): FakeFile[] {
    return [...this.files.values()]
  }

  createFolder(name: string, parents: string[]): FakeFile {
    const file: FakeFile = {
      id: this.newId(),
      name,
      mimeType: FOLDER_MIME,
      parents: [...parents],
      modifiedTime: fixedTimestamp(),
    }
    this.files.set(file.id, file)
    return file
  }

  createFile(name: string, mimeType: string, parents: string[], content: string): FakeFile {
    const file: FakeFile = {
      id: this.newId(),
      name,
      mimeType,
      parents: [...parents],
      modifiedTime: fixedTimestamp(),
      content,
    }
    this.files.set(file.id, file)
    return file
  }

  updateContent(id: string, content: string): FakeFile {
    const file = this.files.get(id)
    if (!file) throw new Error(`updateContent: unknown file ${id}`)
    file.content = content
    file.modifiedTime = fixedTimestamp()
    return file
  }

  moveParents(id: string, addParent: string, removeParent?: string): FakeFile {
    const file = this.files.get(id)
    if (!file) throw new Error(`moveParents: unknown file ${id}`)
    const withoutRemoved = removeParent ? file.parents.filter((p) => p !== removeParent) : file.parents
    file.parents = withoutRemoved.includes(addParent) ? withoutRemoved : [...withoutRemoved, addParent]
    return file
  }

  createSpreadsheet(title: string, tabTitles: string[]): FakeFile {
    const sheets: Record<string, FakeSheet> = {}
    tabTitles.forEach((t, i) => {
      sheets[t] = { sheetId: i + 1, rows: [] }
    })
    const file: FakeFile = {
      id: this.newId(),
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      // Real Sheets API creates spreadsheets under the user's Drive root by default.
      parents: ['root'],
      modifiedTime: fixedTimestamp(),
      spreadsheet: { sheets },
    }
    this.files.set(file.id, file)
    return file
  }

  /** Deletes one tab from an existing fake spreadsheet — lets a test simulate an older campaign
   * whose spreadsheet predates a tab SHEET_TABS has since grown to include (see
   * campaignRepo.ts's loadSheetSnapshot / addMissingTabs). */
  removeSheetTab(spreadsheetId: string, tabTitle: string): void {
    const file = this.files.get(spreadsheetId)
    if (!file?.spreadsheet) throw new Error(`removeSheetTab: unknown spreadsheet ${spreadsheetId}`)
    delete file.spreadsheet.sheets[tabTitle]
  }

  /** Directly overwrites one tab's rows (header row included, at index 0) — bypassing every real
   * write path, which only ever produces *today's* column shape. This is what lets
   * tests/fixtures/backward-compat/'s row-shape fixtures plant a tab in some genuinely older,
   * narrower/reordered column layout so the current app's read path (sheetSchema.ts's
   * rowCodecs/decodeTab) can be exercised against it. See seedLegacyCampaign.ts. */
  setSheetRows(spreadsheetId: string, tabTitle: string, rows: Row[]): void {
    const file = this.files.get(spreadsheetId)
    if (!file?.spreadsheet) throw new Error(`setSheetRows: unknown spreadsheet ${spreadsheetId}`)
    const sheet = file.spreadsheet.sheets[tabTitle]
    if (!sheet) throw new Error(`setSheetRows: unknown tab "${tabTitle}" on spreadsheet ${spreadsheetId}`)
    sheet.rows = rows
  }
}

function toDriveFileJson(file: FakeFile) {
  return { id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, parents: file.parents }
}

/** Extracts the tab title from a Sheets A1 range like `'Inventory'!A1:ZZ`. */
function parseSheetTitle(range: string): string {
  const match = range.match(/^'([^']*)'/)
  if (!match) throw new Error(`Could not parse sheet title from range "${range}"`)
  return match[1]
}

function parseMultipart(contentType: string, bodyText: string): { metadata: { name: string; mimeType: string; parents: string[] }; content: string } {
  const boundary = contentType.split('boundary=')[1]?.trim()
  if (!boundary) throw new Error(`No multipart boundary in content-type "${contentType}"`)

  let metadata: { name: string; mimeType: string; parents: string[] } | null = null
  let content = ''

  for (const raw of bodyText.split(`--${boundary}`)) {
    const part = raw.startsWith('\r\n') ? raw.slice(2) : raw
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers = part.slice(0, headerEnd)
    let body = part.slice(headerEnd + 4)
    // buildMultipartBody always appends exactly one \r\n before the next boundary marker.
    if (body.endsWith('\r\n')) body = body.slice(0, -2)
    if (/application\/json/i.test(headers)) {
      metadata = JSON.parse(body)
    } else {
      content = body
    }
  }

  if (!metadata) throw new Error('multipart request had no application/json metadata part')
  return { metadata, content }
}

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

/**
 * The email returned by the fake `/oauth2/v3/userinfo` endpoint (src/lib/google/loginHint.ts's
 * `fetchAccountEmail`) — set per test via `setMockUserinfoEmail`. Defaults to a fixed address so
 * tests that don't care about the login_hint mechanism still get a well-formed response.
 */
let mockUserinfoEmail: string | null = 'mock-player@example.com'

/** Overrides the email `fetchAccountEmail` resolves to for the rest of this test, or `null` to
 * make the endpoint behave as if the account has no email (loginHint.ts treats that as "no hint
 * available" rather than an error). */
export function setMockUserinfoEmail(email: string | null): void {
  mockUserinfoEmail = email
}

async function handleGoogleRequest(route: Route, store: FakeDriveStore): Promise<void> {
  const request = route.request()
  const method = request.method()
  const url = new URL(request.url())
  const pathname = url.pathname

  try {
    // ---- OAuth2: userinfo (login_hint capture — see src/lib/google/loginHint.ts) ----
    if (pathname === '/oauth2/v3/userinfo' && method === 'GET') {
      await fulfillJson(route, mockUserinfoEmail ? { email: mockUserinfoEmail } : {})
      return
    }

    // ---- Drive: list children / create folder ----
    if (pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const parentId = q.match(/'([^']*)' in parents/)?.[1]
      const name = q.match(/name = '([^']*)'/)?.[1]
      const mimeType = q.match(/mimeType = '([^']*)'/)?.[1]
      const files = parentId ? store.findChildren(parentId, name, mimeType) : []
      await fulfillJson(route, { files: files.map(toDriveFileJson) })
      return
    }

    if (pathname === '/drive/v3/files' && method === 'POST') {
      const body = request.postDataJSON() as { name: string; mimeType: string; parents: string[] }
      const file = store.createFolder(body.name, body.parents)
      await fulfillJson(route, toDriveFileJson(file))
      return
    }

    const fileIdMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)
    if (fileIdMatch && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const file = store.get(fileIdMatch[1])
      if (!file) {
        await route.fulfill({ status: 404, body: 'Not found' })
        return
      }
      await route.fulfill({ status: 200, contentType: 'text/plain', body: file.content ?? '' })
      return
    }

    if (fileIdMatch && method === 'PATCH' && url.searchParams.has('addParents')) {
      const addParents = url.searchParams.get('addParents')!
      const removeParents = url.searchParams.get('removeParents') ?? undefined
      const file = store.moveParents(fileIdMatch[1], addParents, removeParents)
      await fulfillJson(route, toDriveFileJson(file))
      return
    }

    // ---- Drive upload: create text file (multipart) ----
    if (pathname === '/upload/drive/v3/files' && method === 'POST') {
      const contentType = request.headers()['content-type'] ?? ''
      const { metadata, content } = parseMultipart(contentType, request.postData() ?? '')
      const file = store.createFile(metadata.name, metadata.mimeType, metadata.parents, content)
      await fulfillJson(route, toDriveFileJson(file))
      return
    }

    // ---- Drive upload: update text file (PATCH media) ----
    const uploadIdMatch = pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)
    if (uploadIdMatch && method === 'PATCH') {
      const file = store.updateContent(uploadIdMatch[1], request.postData() ?? '')
      await fulfillJson(route, toDriveFileJson(file))
      return
    }

    // ---- Sheets: create spreadsheet ----
    if (pathname === '/v4/spreadsheets' && method === 'POST') {
      const body = request.postDataJSON() as {
        properties: { title: string }
        sheets: { properties: { title: string } }[]
      }
      const file = store.createSpreadsheet(
        body.properties.title,
        body.sheets.map((s) => s.properties.title),
      )
      await fulfillJson(route, {
        spreadsheetId: file.id,
        sheets: Object.entries(file.spreadsheet!.sheets).map(([title, s]) => ({
          properties: { sheetId: s.sheetId, title },
        })),
      })
      return
    }

    const spreadsheetIdMatch = pathname.match(/^\/v4\/spreadsheets\/([^/:]+)/)
    if (spreadsheetIdMatch) {
      const file = store.get(spreadsheetIdMatch[1])
      if (!file?.spreadsheet) {
        await route.fulfill({ status: 404, body: 'Spreadsheet not found' })
        return
      }
      const sheets = file.spreadsheet.sheets

      if (pathname.endsWith('/values:batchUpdate') && method === 'POST') {
        const body = request.postDataJSON() as { data: { range: string; values: Row[] }[] }
        for (const d of body.data) {
          const sheet = sheets[parseSheetTitle(d.range)]
          if (sheet) sheet.rows[0] = d.values[0]
        }
        await fulfillJson(route, {})
        return
      }

      if (pathname === `/v4/spreadsheets/${spreadsheetIdMatch[1]}` && method === 'GET') {
        // Metadata fetch (addMissingTabs' existence check) — only the fields this app ever
        // requests (?fields=sheets.properties.title) are populated.
        await fulfillJson(route, {
          sheets: Object.entries(sheets).map(([title, s]) => ({ properties: { sheetId: s.sheetId, title } })),
        })
        return
      }

      if (pathname === `/v4/spreadsheets/${spreadsheetIdMatch[1]}:batchUpdate` && method === 'POST') {
        const body = request.postDataJSON() as {
          requests: ({
            addSheet?: { properties: { sheetId?: number; title: string } }
            updateCells?: {
              range: { sheetId: number }
              rows: { values: { userEnteredValue?: { stringValue?: string } }[] }[]
            }
          } & Record<string, unknown>)[]
        }
        // Real Sheets API rejects an explicit duplicate sheet title outright rather than silently
        // deduping/renaming it — addMissingTabs' TOCTOU-race comment (sheetsApi.ts) depends on
        // this actually erroring here, not being tolerated.
        for (const r of body.requests) {
          if (r.addSheet && sheets[r.addSheet.properties.title]) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({
                error: {
                  code: 400,
                  message: `Invalid requests[0].addSheet: A sheet with the name "${r.addSheet.properties.title}" already exists. Please enter another name.`,
                  status: 'INVALID_ARGUMENT',
                },
              }),
            })
            return
          }
        }
        // addSheet actually creates a tab (using the caller's own chosen sheetId if given, the
        // same way addMissingTabs pre-allocates one to reference within the same batch —
        // repeatCell (bold-only formatting) is cosmetic and has nothing to apply, but updateCells
        // (header row values, possibly bolded in the same call) does.
        const replies = body.requests.map((r) => {
          if (r.addSheet) {
            const title = r.addSheet.properties.title
            const sheetId =
              r.addSheet.properties.sheetId ?? Object.values(sheets).reduce((max, s) => Math.max(max, s.sheetId), 0) + 1
            sheets[title] = { sheetId, rows: [] }
            return { addSheet: { properties: { sheetId, title } } }
          }
          if (r.updateCells) {
            const sheet = Object.values(sheets).find((s) => s.sheetId === r.updateCells!.range.sheetId)
            if (sheet) {
              sheet.rows[0] = r.updateCells.rows[0].values.map((v) => v.userEnteredValue?.stringValue ?? '')
            }
            return {}
          }
          return {}
        })
        await fulfillJson(route, { spreadsheetId: spreadsheetIdMatch[1], replies })
        return
      }

      if (pathname.endsWith('/values:batchGet') && method === 'GET') {
        const ranges = url.searchParams.getAll('ranges')
        // Real Sheets API fails the *entire* batchGet if even one referenced tab doesn't exist —
        // "Unable to parse range: '<title>'!A1:ZZ" — rather than treating it as empty. Matching
        // that here is what makes campaignRepo.ts's missing-tab recovery path testable at all.
        for (const r of ranges) {
          const title = parseSheetTitle(decodeURIComponent(r))
          if (!sheets[title]) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({
                error: { code: 400, message: `Unable to parse range: '${title}'!A1:ZZ`, status: 'INVALID_ARGUMENT' },
              }),
            })
            return
          }
        }
        const valueRanges = ranges.map((r) => {
          const sheet = sheets[parseSheetTitle(decodeURIComponent(r))]
          return { values: sheet.rows }
        })
        await fulfillJson(route, { valueRanges })
        return
      }

      const appendMatch = pathname.match(/\/values\/([^/]+):append$/)
      if (appendMatch && method === 'POST') {
        const sheet = sheets[parseSheetTitle(decodeURIComponent(appendMatch[1]))]
        const body = request.postDataJSON() as { values: Row[] }
        if (sheet) sheet.rows.push(...body.values)
        await fulfillJson(route, {})
        return
      }

      const putMatch = pathname.match(/\/values\/([^/]+)$/)
      if (putMatch && method === 'PUT') {
        const range = decodeURIComponent(putMatch[1])
        const sheet = sheets[parseSheetTitle(range)]
        const rowNumber = Number(range.match(/!A(\d+)/)?.[1])
        const body = request.postDataJSON() as { values: Row[] }
        if (sheet && rowNumber) sheet.rows[rowNumber - 1] = body.values[0]
        await fulfillJson(route, {})
        return
      }
    }
  } catch (err) {
    await route.fulfill({ status: 500, body: `Mock error: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  await route.fulfill({ status: 501, body: `Unhandled mock request: ${method} ${pathname}${url.search}` })
}

/** Seeds a valid Google session into localStorage before any app script runs, so AuthGate
 * (src/lib/google/authStore.ts) starts already signed-in — real Google Identity Services is
 * never involved. */
async function seedGoogleSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, token, expiresAt }) => {
      window.localStorage.setItem(key, JSON.stringify({ accessToken: token, expiresAt }))
    },
    { key: SESSION_STORAGE_KEY, token: 'fake-test-access-token', expiresAt: Date.now() + 60 * 60 * 1000 },
  )
}

/** Installs the full mock: a signed-in session plus every Drive/Sheets endpoint this app calls,
 * backed by a fresh in-memory store. Call once per test before navigating. */
export async function installGoogleApiMock(page: Page): Promise<FakeDriveStore> {
  const store = new FakeDriveStore()
  // Module state, not per-page — reset per install so one test's setMockUserinfoEmail override
  // can't leak into the next test sharing this worker process.
  mockUserinfoEmail = 'mock-player@example.com'
  await seedGoogleSession(page)
  // Defensive stub — should never be hit given the seeded session above, but avoids a real
  // network call to Google if something unexpectedly tries to load the GIS script.
  await page.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
  )
  await page.route('https://www.googleapis.com/**', (route) => handleGoogleRequest(route, store))
  await page.route('https://sheets.googleapis.com/**', (route) => handleGoogleRequest(route, store))
  return store
}
