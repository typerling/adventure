import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installGoogleApiMock, type FakeDriveStore } from "./mocks/googleApi";
import {
  getKokoroWorker,
  installControllableWebAudioPlayback,
  installFakeKokoroModule,
  installKokoroSourceTracking,
  waitForKokoroPlaybackToStabilize,
} from "./mocks/kokoro";
import { createRandomCampaign, expandSettingsCard, setCampaignVoiceProviders } from "./helpers";
import { TAB_HEADERS } from "../src/lib/google/sheetSchema";
import { KOKORO_DIALOGUE_SPEED, KOKORO_NARRATION_SPEED } from "../src/lib/voice/kokoroConstants";

/**
 * Issue #66: Kokoro playback finally switches voices per speaker within a turn, instead of one
 * flat voice for the whole thing — the playback half of the multi-voice-narration initiative
 * (epic #36) after #96 (speaker-attributed segments) and #98 (a cast voiceId per character).
 *
 * A three-voice cast (narrator, one NPC, the player character) is set up deterministically rather
 * than relying on #98's hash-based fallback casting: the NPC's voiceId is seeded directly into the
 * fake Drive/Sheets backend (same technique tests/voice-casting-integration.spec.ts's
 * "voiceLocked" test uses), the player's voice comes from CampaignSettings.playerVoiceId (Settings'
 * #playerVoiceId field), and the narrator's is left at its default (Kokoro's own DEFAULT_VOICE,
 * af_heart) rather than set explicitly, proving the "narrator" side of resolveSegmentVoices too.
 */

const VOICES = {
  af_heart: { name: "Heart", language: "en-us", gender: "Female" },
  am_adam: { name: "Adam", language: "en-us", gender: "Male" },
  bm_george: { name: "George", language: "en-gb", gender: "Male" },
};

function spreadsheetFile(store: FakeDriveStore) {
  const file = store.allFiles().find((f) => f.mimeType === "application/vnd.google-apps.spreadsheet");
  if (!file?.spreadsheet) throw new Error("No spreadsheet found in the fake Drive store");
  return file;
}

/** The fixed player-character name every test in this file uses — createRandomCampaign's wizard
 * quick-fill leaves the Character tab's "Name" row blank (confirmed directly against the fake
 * store while writing this spec), so the name is seeded explicitly via seedCastNpcAndPlayerName
 * below rather than read back from an empty value. */
const PLAYER_NAME = "Kael";

async function submitTurnWithNarrative(page: Page, action: string, narrative: string): Promise<void> {
  await page.getByPlaceholder("Say or do anything…").fill(action);
  await page.getByRole("button", { name: "Act", exact: true }).click();
  const reply = `${narrative}\n\n\`\`\`state\n${JSON.stringify({
    state_delta: {},
    summary_update: narrative,
    options: ["Look around", "Move on"],
  })}\n\`\`\``;
  await page.getByPlaceholder(/Paste the narrative/).fill(reply);
  await page.getByRole("button", { name: "Apply turn" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Seeds a cast NPC directly into the fake backend's NPCs tab (bypassing the AI-casting/fallback
 * pipeline entirely, same technique as voice-casting-integration.spec.ts's voiceLocked test) and
 * gives the Character tab's blank "Name" row a real value (see PLAYER_NAME's doc comment) in the
 * same pass, then reloads once so the running page picks both up — campaignCache.ts only
 * re-fetches from the (now directly-mutated) fake store on a full reload. */
async function seedCastNpcAndPlayerName(page: Page, store: FakeDriveStore, npcName: string, npcVoiceId: string): Promise<void> {
  const spreadsheetId = spreadsheetFile(store).id;
  store.setSheetRows(spreadsheetId, "NPCs", [
    TAB_HEADERS.NPCs,
    ["npc-seeded-1", npcName, "a figure in the chapel", "", "alive", 1, "", "", "", "", npcVoiceId, 0, false],
  ]);
  store.setSheetRows(spreadsheetId, "Character", [TAB_HEADERS.Character, ["Name", PLAYER_NAME]]);
  await page.reload();
  await expect(page.getByPlaceholder("Say or do anything…")).toBeVisible();
}

/** Must be called after setCampaignVoiceProviders({tts: "huggingface-local"}) — the #playerVoiceId
 * field only mounts once TTS is switched to Kokoro (same gating the narrator's own #kokoroVoiceId
 * field uses — see tests/backward-compat-frontmatter.spec.ts's comment on this exact gate).
 * Deliberately clicks the *per-campaign* "This campaign" card's own "Save" button (Settings.tsx's
 * saveCadence, which persists CampaignSettings/settings.md) — not the "AI & voice providers"
 * card's "Save settings" button (saveGlobal, which only ever writes GlobalSettings/localStorage
 * and would silently leave playerVoiceId unsaved). Navigates back to Play afterward, mirroring
 * setCampaignVoiceProviders' own end-state (this helper is always called on top of it, so the
 * campaign is already known), so a caller can go straight to submitting a turn. */
async function setPlayerVoice(page: Page, campaignId: string, voiceId: string): Promise<void> {
  await page.goto(`/settings/${campaignId}`);
  await page.locator("#playerVoiceId").fill(voiceId);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.goto(`/play/${campaignId}`);
  await expect(page.getByPlaceholder("Say or do anything…")).toBeVisible();
}

test("each spoken segment is generated with its own resolved voice/speed, and a voice change inserts a pause in scheduled start times", async ({
  page,
}) => {
  const store = await installGoogleApiMock(page);
  // A non-trivial, uniform chunk duration (like kokoro-streaming-playback.spec.ts's gapless test)
  // so the pause-induced gap is unmistakable against floating-point noise either way.
  await installFakeKokoroModule(page, { voices: VOICES, chunkDurationSec: 0.3 });
  await installKokoroSourceTracking(page);

  await createRandomCampaign(page);
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];

  await seedCastNpcAndPlayerName(page, store, "Old Maren", "bm_george");
  // TTS must be switched to Kokoro before the playerVoiceId field is even mounted in Settings —
  // see setPlayerVoice's doc comment.
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
  await setPlayerVoice(page, campaignId, "am_adam");

  // Narration -> NPC dialogue -> narration -> player dialogue -> (options trailer, narration) —
  // five segments, four voice-change boundaries, deliberately alternating back to narration each
  // time so both the "entering dialogue" and "exiting dialogue" pause lengths get exercised.
  const narrative =
    `You step into the chapel. {{v:Old Maren}}"Keys like that don't come free."{{/v}} she says, ` +
    `watching you closely. {{v:${PLAYER_NAME}}}"I understand."{{/v}}`;
  await submitTurnWithNarrative(page, "talk to the old caretaker", narrative);
  await expect(page.getByText("You step into the chapel.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);

  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(5);

  const generateCalls = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateCalls?: { text: string; voice: string; speed: number }[] })
        .__kokoroGenerateCalls ?? [],
  );
  // The narrative's four segments each stay under MAX_CHUNK_CHARS on their own, so each becomes
  // exactly one chunk: narrator, Old Maren, narrator, the player. What follows is the spoken
  // options trailer (turnBlocks.ts's blockToSpokenText), always narration — not asserted on an
  // exact chunk count, since how many sentences it splits into isn't this test's concern.
  expect(generateCalls.length).toBeGreaterThanOrEqual(5);
  expect(generateCalls.slice(0, 4).map((c) => c.voice)).toEqual(["af_heart", "bm_george", "af_heart", "am_adam"]);
  expect(generateCalls.slice(4).every((c) => c.voice === "af_heart")).toBe(true);
  // Narration segments (index 0, 2) speak at the narration speed; dialogue segments (1, 3) speak
  // at the dialogue speed — see resolveSegmentVoices.ts.
  expect(generateCalls.slice(0, 4).map((c) => c.speed)).toEqual([
    KOKORO_NARRATION_SPEED,
    KOKORO_DIALOGUE_SPEED,
    KOKORO_NARRATION_SPEED,
    KOKORO_DIALOGUE_SPEED,
  ]);

  const starts = await page.evaluate(
    () => (window as unknown as { __kokoroSourceStarts?: { when: number }[] }).__kokoroSourceStarts ?? [],
  );
  expect(starts.length).toBeGreaterThanOrEqual(5);
  // Every boundary here is a voice change (narrator<->Maren<->narrator<->player<->narrator), so
  // every consecutive gap must be strictly longer than the chunk's own 0.3s duration alone — proof
  // a real pause was inserted, not just normal back-to-back scheduling (kokoro-streaming-
  // playback.spec.ts's "no gap" test already proves the zero-voice-change case computes exactly
  // 0.3s with nothing extra).
  for (let i = 1; i < 5; i++) {
    expect(starts[i].when - starts[i - 1].when).toBeGreaterThan(0.3);
  }
});

test("a speaker with no matching NPC row degrades to the narrator's voice instead of throwing or dropping the segment", async ({
  page,
}) => {
  await installGoogleApiMock(page);
  await installFakeKokoroModule(page, { voices: VOICES });
  await installControllableWebAudioPlayback(page);

  await createRandomCampaign(page);
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });

  // "A Robed Figure" is never created via new_npcs and never seeded onto the NPCs sheet at all —
  // issue #105's caveat: a speaker token with no matching NPC row (heuristic guess, or an AI
  // paraphrase mismatch) must still be spoken, just in the narrator's voice.
  const narrative = 'A shape moves in the dark. {{v:A Robed Figure}}"Leave this place."{{/v}} It vanishes.';
  await submitTurnWithNarrative(page, "look into the shadows", narrative);
  await expect(page.getByText("A shape moves in the dark.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);
  await waitForKokoroPlaybackToStabilize(page);

  const generateCalls = await worker.evaluate(
    () => (self as unknown as { __kokoroGenerateCalls?: { text: string; voice: string }[] }).__kokoroGenerateCalls ?? [],
  );
  // Nothing dropped (the unresolved speaker's line still generated) and nothing crashed (playback
  // reached "Stop playback" below) — every chunk speaks in the narrator's default voice, including
  // the unresolved speaker's own line, rather than being silently skipped.
  expect(generateCalls.length).toBeGreaterThan(0);
  expect(generateCalls.every((c) => c.voice === "af_heart")).toBe(true);
  expect(generateCalls.some((c) => c.text.includes("Leave this place"))).toBe(true);

  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
});

test("a WebGPU device lost mid-turn restarts on WASM with every chunk's original per-chunk voice preserved, not shifted or duplicated", async ({
  page,
}) => {
  const store = await installGoogleApiMock(page);
  // Fails the very first webgpu generate() call — nothing has reached the main thread yet when the
  // restart happens, mirroring kokoro-webgpu-backend.spec.ts's identical first test.
  await installFakeKokoroModule(page, { voices: VOICES, failWebgpuGenerate: true });
  await installControllableWebAudioPlayback(page);

  await createRandomCampaign(page);
  const campaignId = page.url().match(/\/play\/([^/?#]+)/)![1];

  await seedCastNpcAndPlayerName(page, store, "Old Maren", "bm_george");
  await setCampaignVoiceProviders(page, { tts: "huggingface-local" });
  await setPlayerVoice(page, campaignId, "am_adam");

  await page.goto("/settings");
  await expandSettingsCard(page, "kokoro-model-card");
  await page.locator("#kokoro-device").click();
  await page.getByRole("option", { name: /^GPU/ }).click();

  await page.goto(`/play/${campaignId}`);
  const narrative =
    `The chamber is cold. {{v:Old Maren}}"You should not be here."{{/v}} she warns. ` +
    `{{v:${PLAYER_NAME}}}"I have no choice."{{/v}}`;
  await submitTurnWithNarrative(page, "press forward", narrative);
  await expect(page.getByText("The chamber is cold.", { exact: false })).toBeVisible();

  const [worker] = await Promise.all([
    getKokoroWorker(page),
    page.getByRole("button", { name: "Play this turn aloud" }).click(),
  ]);
  await waitForKokoroPlaybackToStabilize(page);

  const attempts = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateAttempts?: { text: string; voice: string; device: string }[] })
        .__kokoroGenerateAttempts ?? [],
  );
  const generateCalls = await worker.evaluate(
    () =>
      (self as unknown as { __kokoroGenerateCalls?: { text: string; voice: string; device: string }[] })
        .__kokoroGenerateCalls ?? [],
  );

  // Exactly one failed webgpu attempt (chunk 0 — the narrator's opening line), then the whole job
  // restarted on wasm from chunk 0 — same shape kokoro-webgpu-backend.spec.ts's identical test
  // already asserts, extended here to also check voice.
  expect(attempts[0].device).toBe("webgpu");
  expect(attempts.filter((a) => a.device === "webgpu")).toHaveLength(1);
  expect(generateCalls.every((c) => c.device === "wasm")).toBe(true);
  expect(generateCalls.length).toBeGreaterThanOrEqual(4);
  // The restarted (wasm) chunks carry the exact same voice sequence the pre-restart attempt would
  // have — narrator, Old Maren, narrator, the player, then the spoken options trailer (always
  // narration) — never the pre-restart chunk's voice bleeding into a later one, and never a
  // duplicate. Not asserted on an exact trailing chunk count — see the sibling test above.
  expect(generateCalls.slice(0, 4).map((c) => c.voice)).toEqual(["af_heart", "bm_george", "af_heart", "am_adam"]);
  expect(generateCalls.slice(4).every((c) => c.voice === "af_heart")).toBe(true);

  // Issue #62's main-thread de-duplication: every wasm call reaches playback exactly once.
  const sourceStartCount = await page.evaluate(
    () => (window as unknown as { __kokoroSourceStarts?: unknown[] }).__kokoroSourceStarts?.length ?? 0,
  );
  expect(sourceStartCount).toBe(generateCalls.length);

  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
});
