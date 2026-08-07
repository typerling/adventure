export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export const isGoogleConfigured = Boolean(GOOGLE_CLIENT_ID)

/**
 * drive.file: the app only ever sees files/folders it created or that you explicitly picked.
 * spreadsheets: required for cell-range read/write via the Sheets API — see DESIGN.md §2/§12.
 *
 * userinfo.email — added for issue #45, deliberate scope creep, called out explicitly rather than
 * slipped in quietly (see that issue/its PR for the full discussion): this app has no backend, so
 * silent session restore on reopen depends entirely on Google Identity Services' `prompt: ''`
 * token flow piggybacking on the browser's own Google session — and that flow is documented to
 * still open a real (if normally invisible) popup even when "silent" (see authStore.ts). Installed
 * standalone contexts (e.g. an Android home-screen WebAPK) are the case most likely to block a
 * popup that wasn't opened by a direct user gesture, forcing the *interactive* fallback every
 * reopen instead of restoring silently. This scope only ever powers `loginHint.ts`'s one-shot
 * userinfo fetch, purely to remember the signed-in account's email as GIS's `login_hint` — so that
 * *interactive* fallback becomes a single tap instead of a full account picker. It is never used
 * to read Gmail, contacts, or any other profile data.
 *
 * Migration edge case (found in independent review, not settled either way): a user already
 * signed in before this scope existed holds a token authorized for only the first two scopes
 * above. Their next silent refresh requests this three-scope union instead — whether GIS's
 * `prompt: ''` flow silently grants the newly-added, non-sensitive `userinfo.email` scope or
 * requires one interactive re-consent isn't settled from documentation alone, and wasn't testable
 * without a real pre-existing session on real Google infrastructure. Either way this fails safe: a
 * refusal here just routes through the same `res.error` → "session expired" → interactive sign-in
 * path every other silent-refresh failure already takes, which succeeds — so at worst an existing
 * user sees one extra interactive prompt the first time, not a break.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')
