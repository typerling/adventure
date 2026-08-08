/**
 * Literal `settings.md` frontmatter exactly as this app's first commit (`ea70fd2`, "Add
 * Drive/Sheets API client layer, data model types, Google auth store") would have written it —
 * verified against that commit's `src/types/campaign.ts` (`git show ea70fd2:src/types/campaign.ts`),
 * not reconstructed from memory. At that point `CampaignSettings` had only `aiMode`,
 * `sttProvider`, `ttsProvider`, an optional `elevenLabsVoiceId`, and `summarizationCadence` —
 * `claudeModel` and `localModelId` didn't exist until direct AI modes landed (`b6c4961`), and
 * `kokoroVoiceId` didn't exist until the Kokoro voice picker (`d9fc9f5`, #42). A campaign whose
 * `settings.md` a real user saved back then still has exactly this shape sitting in their Drive
 * today — this is what `campaignRepo.ts`'s `loadSettings` (`{ ...DEFAULT_SETTINGS, ...parsed }`)
 * has to keep tolerating.
 */
export const PHASE1_SETTINGS_MD = `---
aiMode: manual
sttProvider: browser
ttsProvider: browser
summarizationCadence: 15
---

`
