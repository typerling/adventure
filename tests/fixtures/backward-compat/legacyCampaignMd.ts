/**
 * Synthetic — `CampaignMeta`'s shape has not actually changed since this app's first commit (see
 * `git log -- src/types/campaign.ts`), so there is no *real* older `campaign.md` shape to draw on
 * the way `legacySettingsMd.ts` and `legacyNpcRows.ts` can. This models the day it does gain a
 * field the same way `CampaignSettings` already has three times: `currentLocation` stands in for
 * "whichever required-looking field is next added," entirely absent rather than blank, proving
 * `loadCampaignFile`'s per-field defaulting (`String(data.x ?? '')`) degrades safely for a field
 * an older `campaign.md` predates — without waiting for a real instance of that to happen first.
 * `spreadsheetId` is filled in by `seedLegacyCampaign` (see its doc comment on the
 * `{{SPREADSHEET_ID}}` token) since the real write order creates the spreadsheet first.
 */
export const CAMPAIGN_MD_MISSING_CURRENT_LOCATION = `---
name: The Sunken Chapel Mystery
slug: sunken-chapel-mystery
genre: Gothic mystery
difficulty: Standard
createdAt: 2026-01-01T00:00:00.000Z
currentTurn: 0
spreadsheetId: {{SPREADSHEET_ID}}
---

You wake at the edge of a fog-bound harbor town, the tide bell tolling somewhere out past the point.
`
