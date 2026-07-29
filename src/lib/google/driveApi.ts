import { googleFetch, googleFetchText } from './http'

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  parents?: string[]
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function findChild(
  parentId: string,
  name: string,
  mimeType?: string,
): Promise<DriveFile | null> {
  const clauses = [
    `'${parentId}' in parents`,
    `name = '${escapeQueryValue(name)}'`,
    'trashed = false',
  ]
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`)
  const q = encodeURIComponent(clauses.join(' and '))
  const res = await googleFetch<{ files: DriveFile[] }>(
    `${DRIVE_BASE}/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,parents)&spaces=drive`,
  )
  return res.files[0] ?? null
}

export async function listChildren(parentId: string, mimeType?: string): Promise<DriveFile[]> {
  const clauses = [`'${parentId}' in parents`, 'trashed = false']
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`)
  const q = encodeURIComponent(clauses.join(' and '))
  const res = await googleFetch<{ files: DriveFile[] }>(
    `${DRIVE_BASE}/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,parents)&spaces=drive&orderBy=name`,
  )
  return res.files
}

/** Finds a folder by name under parentId (root Drive space if omitted), creating it if missing.
 * Relies on drive.file scope's persistent per-file grant: folders this app created earlier
 * remain discoverable by files.list across sessions. */
export async function ensureFolder(name: string, parentId?: string): Promise<DriveFile> {
  const parent = parentId ?? 'root'
  const existing = await findChild(parent, name, FOLDER_MIME)
  if (existing) return existing
  return googleFetch<DriveFile>(`${DRIVE_BASE}/files?fields=id,name,mimeType,parents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  })
}

export async function findFile(parentId: string, name: string): Promise<DriveFile | null> {
  return findChild(parentId, name)
}

function buildMultipartBody(
  metadata: Record<string, unknown>,
  content: string,
  mimeType: string,
): { body: string; boundary: string } {
  const boundary = `-------ai-adventure-${crypto.randomUUID()}`
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n${content}\r\n` +
    `--${boundary}--`
  return { body, boundary }
}

export async function createTextFile(
  parentId: string,
  name: string,
  content: string,
  mimeType = 'text/markdown',
): Promise<DriveFile> {
  const { body, boundary } = buildMultipartBody(
    { name, parents: [parentId], mimeType },
    content,
    mimeType,
  )
  return googleFetch<DriveFile>(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,parents`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
  )
}

export async function updateTextFile(fileId: string, content: string, mimeType = 'text/markdown') {
  return googleFetch<DriveFile>(`${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': mimeType },
    body: content,
  })
}

export async function getTextFile(fileId: string): Promise<string> {
  return googleFetchText(`${DRIVE_BASE}/files/${fileId}?alt=media`)
}

/** Find-or-create a text file, returning both the file and whether it was just created. */
export async function ensureTextFile(
  parentId: string,
  name: string,
  initialContent: string,
  mimeType = 'text/markdown',
): Promise<{ file: DriveFile; created: boolean }> {
  const existing = await findFile(parentId, name)
  if (existing) return { file: existing, created: false }
  const file = await createTextFile(parentId, name, initialContent, mimeType)
  return { file, created: true }
}

export async function moveFileToFolder(fileId: string, folderId: string): Promise<void> {
  await googleFetch(
    `${DRIVE_BASE}/files/${fileId}?addParents=${folderId}&removeParents=root&fields=id,parents`,
    { method: 'PATCH' },
  )
}
