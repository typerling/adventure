export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export const isGoogleConfigured = Boolean(GOOGLE_CLIENT_ID)

/**
 * drive.file: the app only ever sees files/folders it created or that you explicitly picked.
 * spreadsheets: required for cell-range read/write via the Sheets API — see DESIGN.md §2/§12.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ')
