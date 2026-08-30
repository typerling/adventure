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

/**
 * Literal `settings.md` frontmatter in the full shape `CampaignSettings` had immediately before
 * issue #77 (verified against `src/types/campaign.ts` as it stood at commit `b7beefa`, this PR's
 * base — every field except `summarizationCadence` moved to the new global,
 * localStorage-backed store in `src/lib/settings/globalSettings.ts`). Deliberately populated with
 * non-default values throughout (aiMode `api`, a non-default Claude model, ElevenLabs for both
 * STT and TTS, both voice IDs set) rather than values that happen to match
 * `DEFAULT_GLOBAL_SETTINGS` — a fixture built from defaults couldn't tell "the migration actually
 * read this campaign's values" apart from "the migration silently did nothing and defaults filled
 * in on their own," which is exactly the distinction issue #77's migration behavior needs a test
 * to prove. A campaign whose settings.md a real user saved under any pre-#77 client still has
 * exactly this shape sitting in their Drive today.
 *
 * Doubles, since issue #97, as the fixture for that issue's "Case A" backward-compat requirement:
 * ElevenLabs was removed entirely (and `STT_PROVIDERS`/`TTS_PROVIDERS` narrowed accordingly), so
 * this fixture's literal `sttProvider: elevenlabs`/`ttsProvider: elevenlabs` now exercises "does a
 * legacy value naming a since-removed provider get skipped safely" rather than "does it migrate
 * through unchanged" — see `tests/backward-compat-frontmatter.spec.ts` and
 * `src/lib/settings/globalSettings.ts`'s `pickLegacyGlobalFields` doc comment.
 */
export const PRE_GLOBAL_SETTINGS_SETTINGS_MD = `---
aiMode: api
claudeModel: claude-opus-5
localModelId: onnx-community/Qwen2.5-1.5B-Instruct
sttProvider: elevenlabs
ttsProvider: elevenlabs
elevenLabsVoiceId: legacy-eleven-voice-id
kokoroVoiceId: legacy-kokoro-voice-id
summarizationCadence: 20
---

`
