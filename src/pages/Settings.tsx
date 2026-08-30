import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "@/components/ui/toast";
import { ArrowLeft, Loader2, Play, Square } from "lucide-react";
import {
  loadCampaignFile,
  loadSettings,
  saveSettings,
} from "@/lib/google/campaignRepo";
import {
  getCachedCampaign,
  patchCachedCampaignSettings,
} from "@/hooks/campaignCache";
import { usePlayHeaderStore } from "@/store/playHeaderStore";
import {
  AI_MODES,
  CLAUDE_MODELS,
  LOCAL_MODEL_IDS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  type CampaignSettings,
  type LocalModelId,
} from "@/types/campaign";
import {
  getGlobalSettings,
  setGlobalSettings,
  type GlobalSettings,
} from "@/lib/settings/globalSettings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsSection } from "@/components/SettingsSection";
import { CollapsibleSettingsCard } from "@/components/CollapsibleSettingsCard";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { useGoogleAuth } from "@/lib/google/authStore";
import {
  getElevenLabsApiKey,
  setElevenLabsApiKey,
} from "@/lib/voice/elevenLabsKey";
import {
  listElevenLabsVoicesForStoredKey,
  type ElevenLabsVoice,
} from "@/lib/voice/elevenLabsVoices";
import { getClaudeApiKey, setClaudeApiKey } from "@/lib/ai/claudeKey";
import { formatBytes } from "@/lib/modelDownloadProgress";
import {
  describeLocalModelProgress,
  getLocalModelDevice,
  getLocalModelLoadState,
  hasDownloadedLocalModel,
  hasPartiallyDownloadedLocalModel,
  isLocalModelSupported,
  LOCAL_MODELS,
  preloadLocalModel,
  removeLocalModel,
  setLocalModelDevice,
  type LocalModelDevice,
} from "@/lib/ai/localModel";
import {
  DEFAULT_VOICE as KOKORO_DEFAULT_VOICE,
  describeKokoroProgress,
  generateKokoroPreview,
  getKokoroDevice,
  getKokoroLoadState,
  hasDownloadedKokoroModel,
  listKokoroVoices,
  preloadKokoroModel,
  removeKokoroModel,
  setKokoroDevice,
  type KokoroDevice,
  type KokoroVoice,
} from "@/lib/voice/kokoroTts";

interface LocalModelRowState {
  loadState: "unloaded" | "loading" | "ready";
  statusMessage: string;
  downloadProgress: number | null;
  removing: boolean;
  /** An interrupted/incomplete download sitting on disk, distinct from fully downloaded — lets a
   * "not downloaded" row still offer to clear the space a failed attempt already used. */
  hasPartial: boolean;
  /** Which backend this model runs on. Seeded from storage when this screen mounts and updated
   * when changed here; an automatic fallback happens outside React, so it shows up the next time
   * Settings is opened rather than live. */
  device: LocalModelDevice;
}

const INITIAL_ROW_STATE: LocalModelRowState = {
  loadState: "unloaded",
  statusMessage: "",
  downloadProgress: null,
  removing: false,
  hasPartial: false,
  device: "webgpu",
};

const CLAUDE_MODEL_LABELS: Record<(typeof CLAUDE_MODELS)[number], string> = {
  "claude-opus-5": "Opus 5 — strongest reasoning, highest cost",
  "claude-sonnet-5": "Sonnet 5 — balanced (recommended)",
  "claude-haiku-4-5": "Haiku 4.5 — fastest, cheapest",
};

export function Settings() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { signOut } = useGoogleAuth();
  // Per-campaign: only summarizationCadence lives here now (issue #77 moved everything else —
  // AI mode, model choices, STT/TTS provider, voice IDs — to the global form below). Null until
  // (if a campaign is open) its settings.md has loaded.
  const [campaignSettings, setCampaignSettings] =
    useState<CampaignSettings | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [savingCadence, setSavingCadence] = useState(false);
  // Global AI mode/model/provider/voice preferences (localStorage, device-scoped — issue #77).
  // Seeded once from storage; edited live here and only persisted on "Save settings" below,
  // matching the explicit-Save pattern the campaign-scoped card (and the API key cards) already
  // use, rather than writing on every keystroke/selection.
  const [globalForm, setGlobalForm] = useState<GlobalSettings>(() =>
    getGlobalSettings(),
  );
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [elevenLabsKey, setElevenLabsKeyInput] = useState(
    () => getElevenLabsApiKey() ?? "",
  );
  const [claudeKey, setClaudeKeyInput] = useState(
    () => getClaudeApiKey() ?? "",
  );
  const [modelRows, setModelRows] = useState<
    Record<LocalModelId, LocalModelRowState>
  >(
    () =>
      Object.fromEntries(
        LOCAL_MODEL_IDS.map((id) => [
          id,
          {
            ...INITIAL_ROW_STATE,
            loadState: getLocalModelLoadState(id),
            device: getLocalModelDevice(id),
          },
        ]),
      ) as Record<LocalModelId, LocalModelRowState>,
  );
  const [voiceLoadState, setVoiceLoadState] = useState(() =>
    getKokoroLoadState(),
  );
  const [voiceStatusMessage, setVoiceStatusMessage] = useState("");
  const [voiceDownloadProgress, setVoiceDownloadProgress] = useState<
    number | null
  >(null);
  const [removingVoiceModel, setRemovingVoiceModel] = useState(false);
  // Which backend Kokoro TTS runs on — seeded from storage when this screen mounts and updated
  // when changed here, same "an automatic fallback happens outside React, so it shows up next
  // time Settings is opened rather than live" caveat as LocalModelRowState.device.
  const [voiceDevice, setVoiceDevice] = useState<KokoroDevice>(() =>
    getKokoroDevice(),
  );
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voicesLoadState, setVoicesLoadState] = useState<
    "idle" | "loading" | "error" | "loaded"
  >("idle");
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(
    null,
  );
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [kokoroVoicePickerOpen, setKokoroVoicePickerOpen] = useState(false);
  const [kokoroVoices, setKokoroVoices] = useState<KokoroVoice[]>([]);
  const [kokoroVoicesLoadState, setKokoroVoicesLoadState] = useState<
    "idle" | "loading" | "error" | "loaded"
  >("idle");
  const [kokoroVoicesStatusMessage, setKokoroVoicesStatusMessage] =
    useState("");
  // Distinct from kokoroVoicesLoadState: the list can be fully loaded while one particular card's
  // preview is still generating (the model is resident either way by the time any card is
  // clickable, but generate() is still an async call worth showing feedback for).
  const [kokoroPreviewLoadingVoiceId, setKokoroPreviewLoadingVoiceId] =
    useState<string | null>(null);
  const [kokoroPreviewingVoiceId, setKokoroPreviewingVoiceId] = useState<
    string | null
  >(null);
  const kokoroPreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const kokoroPreviewUrlRef = useRef<string | null>(null);
  // Bumped by stopKokoroPreview() — every path that should invalidate an in-flight preview
  // (starting a different preview, selecting a voice, closing the dialog) already calls that, so
  // a preview's async continuation can tell it's been superseded by comparing against this after
  // its await, the same playToken/isStale pattern kokoroTts.ts's own speak() uses.
  const kokoroPreviewTokenRef = useRef(0);
  const setHeaderContext = usePlayHeaderStore((s) => s.setContext);

  function patchModelRow(
    modelId: LocalModelId,
    patch: Partial<LocalModelRowState>,
  ) {
    setModelRows((prev) => ({
      ...prev,
      [modelId]: { ...prev[modelId], ...patch },
    }));
  }

  useEffect(() => {
    if (!campaignId) return;
    // If Play/Codex already loaded this campaign this session, reuse its cache instead of
    // fetching settings.md (and the campaign file, for its name) from Drive again.
    const cached = getCachedCampaign(campaignId);
    if (cached) {
      setCampaignSettings(cached.settings);
      setCampaignName(cached.campaign.meta.name);
      return;
    }
    void loadSettings(campaignId)
      .then(setCampaignSettings)
      // Without this a Drive failure was an unhandled rejection *and* a silently empty form.
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : String(err)),
      );
    void loadCampaignFile(campaignId)
      .then((f) => setCampaignName(f.meta.name))
      .catch(() => {});
  }, [campaignId]);

  // See Play.tsx for why the top-bar header reads this from a shared store.
  useEffect(() => {
    if (!campaignId || !campaignName) return;
    setHeaderContext({
      campaignId,
      campaignName,
      showReadAloudToggle: false,
      turnLabel: null,
      recapSummary: null,
      activeQuests: [],
    });
    return () => setHeaderContext(null);
  }, [campaignId, campaignName, setHeaderContext]);

  // Leaving the page mid-preview shouldn't leave a voice sample playing in the background.
  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      kokoroPreviewAudioRef.current?.pause();
      if (kokoroPreviewUrlRef.current) {
        URL.revokeObjectURL(kokoroPreviewUrlRef.current);
      }
    };
  }, []);

  // Refines the in-memory-only guess from getLocalModelLoadState() (which only knows about this
  // page session) with what's actually on disk — a model downloaded in an earlier session should
  // still show as ready here, not prompt for a redundant re-download. Also checks for an
  // interrupted/partial download for each model, so a failed attempt's leftover data can be
  // offered for cleanup even for a model that was never fully downloaded.
  useEffect(() => {
    let cancelled = false;
    // Both can reject where IndexedDB/Cache Storage is unavailable (private browsing, storage
    // disabled). That just means nothing is cached, so fall through to the un-downloaded state
    // rather than throwing into an unhandled rejection.
    for (const id of LOCAL_MODEL_IDS) {
      void hasDownloadedLocalModel(id)
        .then((has) => {
          if (!cancelled && has) patchModelRow(id, { loadState: "ready" });
        })
        .catch(() => {});
      void hasPartiallyDownloadedLocalModel(id)
        .then((has) => {
          if (!cancelled && has) patchModelRow(id, { hasPartial: true });
        })
        .catch(() => {});
    }
    void hasDownloadedKokoroModel()
      .then((has) => {
        if (!cancelled && has) setVoiceLoadState("ready");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // A download can already be in flight before this component mounts — e.g. the user started it
  // from here, navigated away (the load itself is a module-level singleton, not tied to this
  // component's lifetime, so it keeps running), and came back. Reattach to it so progress keeps
  // showing instead of reading as abandoned just because nothing was listening while unmounted.
  // Guarded to only reattach, never start a fresh, unrequested download.
  useEffect(() => {
    for (const id of LOCAL_MODEL_IDS) {
      if (getLocalModelLoadState(id) === "loading") void downloadModel(id);
    }
    if (getKokoroLoadState() === "loading") void downloadVoiceModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveCadence() {
    if (!campaignId || !campaignSettings) return;
    setSavingCadence(true);
    try {
      await saveSettings(campaignId, campaignSettings);
      patchCachedCampaignSettings(campaignId, campaignSettings);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCadence(false);
    }
  }

  function saveGlobal() {
    setSavingGlobal(true);
    try {
      setGlobalSettings(globalForm);
      toast.success("Settings saved.");
    } finally {
      setSavingGlobal(false);
    }
  }

  function saveElevenLabsKey() {
    setElevenLabsApiKey(elevenLabsKey);
    // A new/cleared key invalidates any voice list already loaded under the old one — without
    // this, reopening the picker would keep showing the previous account's voices instead of
    // refetching under the key just saved.
    setVoices([]);
    setVoicesLoadState("idle");
    toast.success(
      elevenLabsKey.trim()
        ? "ElevenLabs API key saved."
        : "ElevenLabs API key cleared.",
    );
  }

  function stopVoicePreview() {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    setPreviewingVoiceId(null);
  }

  function togglePreview(voice: ElevenLabsVoice) {
    if (previewingVoiceId === voice.voiceId) {
      stopVoicePreview();
      return;
    }
    if (!voice.previewUrl) return;
    previewAudioRef.current?.pause();
    const audio = new Audio(voice.previewUrl);
    audio.onended = () =>
      setPreviewingVoiceId((current) =>
        current === voice.voiceId ? null : current,
      );
    audio.onerror = () => {
      toast.error("Couldn't play that voice preview.");
      setPreviewingVoiceId((current) =>
        current === voice.voiceId ? null : current,
      );
    };
    previewAudioRef.current = audio;
    setPreviewingVoiceId(voice.voiceId);
    // Switching previews quickly pauses the previous Audio before its play() promise settles,
    // which rejects with an AbortError — not a real playback failure (onerror above handles
    // those), so it's swallowed here rather than left as an unhandled rejection.
    void audio.play().catch(() => {});
  }

  async function openVoicePicker() {
    setVoicePickerOpen(true);
    // Skip re-fetching once a load has already succeeded, and also while one is still in
    // flight — otherwise a second click before the first request resolves fires a duplicate,
    // undeduplicated fetch, and if that redundant call fails after the first one already
    // succeeded, its error would wrongly clobber a good "loaded" state.
    if (voicesLoadState === "loaded" || voicesLoadState === "loading") return;
    setVoicesLoadState("loading");
    try {
      const list = await listElevenLabsVoicesForStoredKey();
      setVoices(list);
      setVoicesLoadState("loaded");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load ElevenLabs voices.",
      );
      setVoicesLoadState("error");
    }
  }

  function selectVoice(voice: ElevenLabsVoice) {
    setGlobalForm({ ...globalForm, elevenLabsVoiceId: voice.voiceId });
    stopVoicePreview();
    setVoicePickerOpen(false);
  }

  function stopKokoroPreview() {
    kokoroPreviewTokenRef.current++;
    kokoroPreviewAudioRef.current?.pause();
    kokoroPreviewAudioRef.current = null;
    if (kokoroPreviewUrlRef.current) {
      URL.revokeObjectURL(kokoroPreviewUrlRef.current);
      kokoroPreviewUrlRef.current = null;
    }
    setKokoroPreviewingVoiceId(null);
  }

  async function openKokoroVoicePicker() {
    setKokoroVoicePickerOpen(true);
    // Same dedup reasoning as openVoicePicker: skip a redundant fetch (here, a redundant model
    // load) for a list already loaded or in flight.
    if (
      kokoroVoicesLoadState === "loaded" ||
      kokoroVoicesLoadState === "loading"
    )
      return;
    setKokoroVoicesLoadState("loading");
    setKokoroVoicesStatusMessage("");
    try {
      const list = await listKokoroVoices((p) =>
        setKokoroVoicesStatusMessage(describeKokoroProgress(p)),
      );
      setKokoroVoices(list);
      setKokoroVoicesLoadState("loaded");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load Kokoro voices.",
      );
      setKokoroVoicesLoadState("error");
    } finally {
      setKokoroVoicesStatusMessage("");
    }
  }

  async function previewKokoroVoice(voice: KokoroVoice) {
    if (kokoroPreviewingVoiceId === voice.id) {
      stopKokoroPreview();
      return;
    }
    stopKokoroPreview();
    // Captured *after* stopKokoroPreview()'s bump, so this call owns the token current as of now
    // — selecting a voice, closing the dialog, or starting a different preview all call
    // stopKokoroPreview() too, which bumps past this and makes the check below fail.
    const token = kokoroPreviewTokenRef.current;
    setKokoroPreviewLoadingVoiceId(voice.id);
    try {
      // The model is already resident by the time any card is clickable (listing the catalog
      // above required loading it), so this onProgress is really only exercised if a previous
      // load failed and this preview click is what retries it.
      const blob = await generateKokoroPreview(voice.id, (p) =>
        setKokoroVoicesStatusMessage(describeKokoroProgress(p)),
      );
      // Superseded while generating (a voice was selected, the dialog closed, or another preview
      // started) — don't create or play audio for a choice that's no longer current.
      if (token !== kokoroPreviewTokenRef.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      kokoroPreviewUrlRef.current = url;
      kokoroPreviewAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (kokoroPreviewUrlRef.current === url) kokoroPreviewUrlRef.current = null;
        setKokoroPreviewingVoiceId((current) =>
          current === voice.id ? null : current,
        );
      };
      audio.onerror = () => {
        toast.error("Couldn't play that voice preview.");
        URL.revokeObjectURL(url);
        if (kokoroPreviewUrlRef.current === url) kokoroPreviewUrlRef.current = null;
        setKokoroPreviewingVoiceId((current) =>
          current === voice.id ? null : current,
        );
      };
      setKokoroPreviewingVoiceId(voice.id);
      await audio.play();
    } catch (err) {
      // Same staleness check — a superseded preview failing shouldn't toast an error for a
      // choice the player has already moved on from.
      if (token === kokoroPreviewTokenRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Couldn't generate that voice preview.",
        );
      }
    } finally {
      setKokoroVoicesStatusMessage("");
      setKokoroPreviewLoadingVoiceId((current) =>
        current === voice.id ? null : current,
      );
    }
  }

  function selectKokoroVoice(voice: KokoroVoice) {
    setGlobalForm({ ...globalForm, kokoroVoiceId: voice.id });
    stopKokoroPreview();
    setKokoroVoicePickerOpen(false);
  }

  function saveClaudeKey() {
    setClaudeApiKey(claudeKey);
    toast.success(
      claudeKey.trim() ? "Claude API key saved." : "Claude API key cleared.",
    );
  }

  async function downloadModel(modelId: LocalModelId) {
    patchModelRow(modelId, {
      loadState: "loading",
      statusMessage: "Fetching local model…",
      downloadProgress: null,
    });
    try {
      await preloadLocalModel(modelId, (p) => {
        patchModelRow(modelId, {
          statusMessage: describeLocalModelProgress(p),
          downloadProgress: typeof p.progress === "number" ? p.progress : null,
        });
      });
      patchModelRow(modelId, {
        loadState: "ready",
        statusMessage: "",
        downloadProgress: null,
        hasPartial: false,
      });
      toast.success(`${LOCAL_MODELS[modelId].label} downloaded and ready.`);
    } catch (err) {
      patchModelRow(modelId, {
        loadState: "unloaded",
        statusMessage: "",
        downloadProgress: null,
      });
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /** Switching backends means a different build of the model, so "downloaded" has to be asked
   * again rather than carried over — the GPU build being on disk says nothing about the CPU one. */
  async function changeModelDevice(
    modelId: LocalModelId,
    device: LocalModelDevice,
  ) {
    await setLocalModelDevice(modelId, device);
    patchModelRow(modelId, {
      device,
      loadState: "unloaded",
      statusMessage: "",
      downloadProgress: null,
    });
    const [downloaded, partial] = await Promise.all([
      hasDownloadedLocalModel(modelId).catch(() => false),
      hasPartiallyDownloadedLocalModel(modelId).catch(() => false),
    ]);
    patchModelRow(modelId, {
      loadState: downloaded ? "ready" : "unloaded",
      hasPartial: partial,
    });
  }

  async function removeModel(modelId: LocalModelId) {
    patchModelRow(modelId, { removing: true });
    try {
      await removeLocalModel(modelId);
      patchModelRow(modelId, {
        loadState: "unloaded",
        removing: false,
        hasPartial: false,
        device: "webgpu",
      });
      toast.success(`${LOCAL_MODELS[modelId].label} removed from this device.`);
    } catch (err) {
      patchModelRow(modelId, { removing: false });
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function downloadVoiceModel() {
    setVoiceLoadState("loading");
    setVoiceStatusMessage("Fetching voice model…");
    setVoiceDownloadProgress(null);
    try {
      await preloadKokoroModel((p) => {
        setVoiceStatusMessage(describeKokoroProgress(p));
        setVoiceDownloadProgress(
          typeof p.progress === "number" ? p.progress : null,
        );
      });
      setVoiceLoadState("ready");
      setVoiceStatusMessage("");
      setVoiceDownloadProgress(null);
      toast.success("Voice model downloaded and ready.");
    } catch (err) {
      setVoiceLoadState("unloaded");
      setVoiceStatusMessage("");
      setVoiceDownloadProgress(null);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeVoiceModel() {
    setRemovingVoiceModel(true);
    try {
      await removeKokoroModel();
      setVoiceLoadState("unloaded");
      // removeKokoroModel() resets the backend preference to 'wasm' — mirror that here so the
      // "Run on" selector doesn't keep showing a stale 'webgpu' after Remove.
      setVoiceDevice("wasm");
      // The voice picker's own list is now stale (it belonged to the model instance that just got
      // evicted) — reset it back to idle so reopening "Browse voices" triggers a real reload
      // (with visible progress) instead of silently reusing a list from a model no longer resident,
      // which would otherwise make a Preview click kick off an undisclosed multi-hundred-MB
      // re-download behind a bare spinner.
      setKokoroVoicesLoadState("idle");
      setKokoroVoices([]);
      toast.success("Voice model removed from this device.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingVoiceModel(false);
    }
  }

  /** Switching backends means a different build of the model, so "downloaded" has to be asked
   * again rather than carried over — same reasoning as changeModelDevice for the local text
   * models. */
  async function changeVoiceDevice(device: KokoroDevice) {
    await setKokoroDevice(device);
    setVoiceDevice(device);
    setVoiceLoadState("unloaded");
    setVoiceStatusMessage("");
    setVoiceDownloadProgress(null);
    const downloaded = await hasDownloadedKokoroModel().catch(() => false);
    setVoiceLoadState(downloaded ? "ready" : "unloaded");
  }

  // Default-expanded state for the two on-device download-management cards below (issue #22,
  // revised for #77): open by default only when the *global* AI mode/TTS provider currently in
  // effect actually uses that mode — no campaign-specific gating anymore, since neither field is
  // per-campaign now. Unlike the pre-#77 version, no remount key is needed to keep this stable
  // against a live dropdown edit: CollapsibleSettingsCard only reads `defaultOpen` once, on mount
  // (see its own doc comment), and nothing here ever needs to force a fresh mount — the value
  // being global means it no longer changes meaning when the player switches which campaign (if
  // any) they're viewing Settings from.
  const localModelsDefaultOpen = globalForm.aiMode === "local";
  const kokoroModelDefaultOpen = globalForm.ttsProvider === "huggingface-local";

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-medium text-foreground">
          Settings
        </h1>
        <Button asChild size="sm" variant="ghost">
          <Link to={campaignId ? `/play/${campaignId}` : "/"}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
      </div>

      {campaignId && campaignSettings && (
        <SettingsSection title="This campaign">
          <Card data-testid="campaign-cadence">
            <CardHeader>
              <CardTitle>This campaign</CardTitle>
              <CardDescription>
                The one setting genuinely tied to this particular story — a
                narrative-pacing choice, not a device/provider preference (see
                "AI & voice providers" below for those). Stored in this
                campaign's settings.md.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="cadence">Re-summarize every N turns</Label>
                <Input
                  id="cadence"
                  type="number"
                  min={5}
                  value={campaignSettings.summarizationCadence}
                  onChange={(e) =>
                    setCampaignSettings({
                      ...campaignSettings,
                      summarizationCadence: Number(e.target.value) || 15,
                    })
                  }
                />
              </div>

              <Button onClick={() => void saveCadence()} disabled={savingCadence}>
                {savingCadence ? "Saving…" : "Save"}
              </Button>
            </CardContent>
          </Card>
        </SettingsSection>
      )}

      <SettingsSection
        title="AI & voice providers"
        description="The same AI mode, models, and voice choices apply to every campaign on this device — not saved per campaign, and not synced to other devices signed into the same Google account (see below)."
      >
        <Card data-testid="global-settings">
          <CardHeader>
            <CardTitle>AI &amp; voice</CardTitle>
            <CardDescription>
              Stored only in this browser's local storage — global to this
              device, never written to Drive.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>AI mode</Label>
              <Select
                value={globalForm.aiMode}
                onValueChange={(v) =>
                  setGlobalForm({
                    ...globalForm,
                    aiMode: v as GlobalSettings["aiMode"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m === "manual"
                        ? "Manual (copy/paste into claude.ai or chatgpt.com)"
                        : m === "api"
                          ? "Direct API key (Claude)"
                          : "Local model (runs on this device)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {globalForm.aiMode === "local" && (
              <div className="flex flex-col gap-2">
                <Label>Local model</Label>
                <Select
                  value={globalForm.localModelId}
                  onValueChange={(v) =>
                    setGlobalForm({
                      ...globalForm,
                      localModelId: v as LocalModelId,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCAL_MODEL_IDS.map((id) => (
                      <SelectItem key={id} value={id}>
                        {LOCAL_MODELS[id].label} —{" "}
                        {formatBytes(LOCAL_MODELS[id].sizeBytes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  No key needed — everything runs on this device. Needs a
                  browser with WebGPU (Chrome/Edge on Android, Safari 26+ on
                  iOS/macOS). Bigger models are higher quality but slower to
                  download and more likely to crash the tab on
                  memory-constrained devices — see "Local AI models" below to
                  download or remove any of them ahead of time. Quality and
                  reliability (especially following the reply format) are
                  noticeably weaker than the API mode, more so for smaller
                  models.
                </p>
              </div>
            )}

            {globalForm.aiMode === "api" && (
              <div className="flex flex-col gap-2">
                <Label>Claude model</Label>
                <Select
                  value={globalForm.claudeModel}
                  onValueChange={(v) =>
                    setGlobalForm({
                      ...globalForm,
                      claudeModel: v as GlobalSettings["claudeModel"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLAUDE_MODELS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {CLAUDE_MODEL_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Needs a Claude API key below — every turn is billed to your
                  own key.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label>Speech-to-text</Label>
              <Select
                value={globalForm.sttProvider}
                onValueChange={(v) =>
                  setGlobalForm({
                    ...globalForm,
                    sttProvider: v as GlobalSettings["sttProvider"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STT_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p === "browser"
                        ? "Browser (Web Speech API)"
                        : "ElevenLabs (Scribe)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Text-to-speech</Label>
              <Select
                value={globalForm.ttsProvider}
                onValueChange={(v) =>
                  setGlobalForm({
                    ...globalForm,
                    ttsProvider: v as GlobalSettings["ttsProvider"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTS_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p === "browser"
                        ? "Browser (SpeechSynthesis)"
                        : p === "elevenlabs"
                          ? "ElevenLabs"
                          : "Kokoro (on-device, runs locally)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {globalForm.ttsProvider === "browser" && (
                <p className="text-xs text-muted-foreground">
                  On Android, Chrome stops browser speech when the tab is
                  backgrounded or the screen locks — a platform limitation of
                  the Web Speech API itself (its audio isn&apos;t exposed as a
                  real media stream, so it can&apos;t hold background audio
                  focus the way ElevenLabs/Kokoro&apos;s playback does), not a
                  bug in this app. Switch to ElevenLabs or Kokoro if you need
                  narration to keep playing with the screen off or another app
                  in front.
                </p>
              )}
            </div>

            {(globalForm.sttProvider === "elevenlabs" ||
              globalForm.ttsProvider === "elevenlabs") && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="voiceId">ElevenLabs voice ID (optional)</Label>
                <div className="flex gap-2">
                  <Input
                    id="voiceId"
                    value={globalForm.elevenLabsVoiceId ?? ""}
                    onChange={(e) =>
                      setGlobalForm({
                        ...globalForm,
                        elevenLabsVoiceId: e.target.value.trim() || undefined,
                      })
                    }
                    placeholder="Defaults to a standard ElevenLabs voice if left blank"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openVoicePicker()}
                  >
                    Browse voices
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {voicesLoadState === "loaded" &&
                    globalForm.elevenLabsVoiceId &&
                    (() => {
                      const name = voices.find(
                        (v) => v.voiceId === globalForm.elevenLabsVoiceId,
                      )?.name;
                      return name ? `Currently: ${name}. ` : "";
                    })()}
                  Only used for text-to-speech.
                </p>
              </div>
            )}

            {globalForm.ttsProvider === "huggingface-local" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="kokoroVoiceId">Kokoro voice (optional)</Label>
                <div className="flex gap-2">
                  <Input
                    id="kokoroVoiceId"
                    value={globalForm.kokoroVoiceId ?? ""}
                    onChange={(e) =>
                      setGlobalForm({
                        ...globalForm,
                        kokoroVoiceId: e.target.value.trim() || undefined,
                      })
                    }
                    placeholder={`Defaults to ${KOKORO_DEFAULT_VOICE} if left blank`}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openKokoroVoicePicker()}
                  >
                    Browse voices
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {kokoroVoicesLoadState === "loaded" &&
                    globalForm.kokoroVoiceId &&
                    (() => {
                      const name = kokoroVoices.find(
                        (v) => v.id === globalForm.kokoroVoiceId,
                      )?.name;
                      return name ? `Currently: ${name}. ` : "";
                    })()}
                  Only used for text-to-speech. Browsing voices downloads the
                  on-device voice model the first time (see "Kokoro voice
                  model" below) — after that, previews and playback are
                  instant.
                </p>
              </div>
            )}

            <Dialog
              open={voicePickerOpen}
              onOpenChange={(open) => {
                setVoicePickerOpen(open);
                if (!open) stopVoicePreview();
              }}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Choose an ElevenLabs voice</DialogTitle>
                  <DialogDescription>
                    Preview plays ElevenLabs' hosted sample clip for each
                    voice — no text-to-speech call is made just to listen.
                  </DialogDescription>
                </DialogHeader>
                {voicesLoadState === "loading" && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading voices…
                  </div>
                )}
                {voicesLoadState === "error" && (
                  <p className="py-4 text-sm text-muted-foreground">
                    Couldn't load voices. Make sure your ElevenLabs API key
                    (below) is saved and valid, then try again.
                  </p>
                )}
                {voicesLoadState === "loaded" &&
                  (voices.length === 0 ? (
                    <p className="py-4 text-sm text-muted-foreground">
                      No voices found on this ElevenLabs account.
                    </p>
                  ) : (
                    <ScrollArea className="h-80 pr-3">
                      <div className="flex flex-col gap-1">
                        {voices.map((voice) => (
                          <div
                            key={voice.voiceId}
                            className="flex items-center gap-2 rounded-md p-2 hover:bg-muted/50"
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0"
                              disabled={!voice.previewUrl}
                              onClick={() => togglePreview(voice)}
                              aria-label={
                                previewingVoiceId === voice.voiceId
                                  ? `Stop preview of ${voice.name}`
                                  : `Preview ${voice.name}`
                              }
                            >
                              {previewingVoiceId === voice.voiceId ? (
                                <Square className="size-4" />
                              ) : (
                                <Play className="size-4" />
                              )}
                            </Button>
                            <button
                              type="button"
                              className="flex-1 truncate text-left text-sm"
                              onClick={() => selectVoice(voice)}
                            >
                              {voice.name}
                              {voice.category && (
                                <span className="ml-1.5 text-xs text-muted-foreground">
                                  {voice.category}
                                </span>
                              )}
                            </button>
                            {globalForm.elevenLabsVoiceId === voice.voiceId && (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                Selected
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  ))}
              </DialogContent>
            </Dialog>

            <Dialog
              open={kokoroVoicePickerOpen}
              onOpenChange={(open) => {
                setKokoroVoicePickerOpen(open);
                if (!open) stopKokoroPreview();
              }}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Choose a Kokoro voice</DialogTitle>
                  <DialogDescription>
                    Preview generates a short clip on this device — the voice
                    model downloads the first time, then previews and
                    playback are instant.
                  </DialogDescription>
                </DialogHeader>
                {kokoroVoicesLoadState === "loading" && (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {kokoroVoicesStatusMessage || "Loading voices…"}
                  </div>
                )}
                {kokoroVoicesLoadState === "error" && (
                  <p className="py-4 text-sm text-muted-foreground">
                    Couldn't load Kokoro's voice list — it needs to download
                    the voice model once. Check your connection and try
                    again.
                  </p>
                )}
                {kokoroVoicesLoadState === "loaded" &&
                  (kokoroVoices.length === 0 ? (
                    <p className="py-4 text-sm text-muted-foreground">
                      No voices found.
                    </p>
                  ) : (
                    <ScrollArea className="h-80 pr-3">
                      <div className="flex flex-col gap-1">
                        {kokoroVoices.map((voice) => (
                          <div
                            key={voice.id}
                            data-testid={`kokoro-voice-${voice.id}`}
                            className="flex items-center gap-2 rounded-md p-2 hover:bg-muted/50"
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0"
                              // Disabled while *any* preview is generating — including this
                              // voice's own, since clicking again mid-generation would otherwise
                              // fire a second concurrent generate() call for the same voice.
                              disabled={kokoroPreviewLoadingVoiceId !== null}
                              onClick={() => void previewKokoroVoice(voice)}
                              aria-label={
                                kokoroPreviewingVoiceId === voice.id
                                  ? `Stop preview of ${voice.name}`
                                  : `Preview ${voice.name}`
                              }
                            >
                              {kokoroPreviewLoadingVoiceId === voice.id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : kokoroPreviewingVoiceId === voice.id ? (
                                <Square className="size-4" />
                              ) : (
                                <Play className="size-4" />
                              )}
                            </Button>
                            <button
                              type="button"
                              className="flex-1 truncate text-left text-sm"
                              onClick={() => selectKokoroVoice(voice)}
                            >
                              {voice.name}
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                {voice.language}
                                {voice.gender ? ` · ${voice.gender}` : ""}
                                {voice.traits ? ` ${voice.traits}` : ""}
                              </span>
                            </button>
                            {(globalForm.kokoroVoiceId === voice.id ||
                              (!globalForm.kokoroVoiceId &&
                                voice.id === KOKORO_DEFAULT_VOICE)) && (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {globalForm.kokoroVoiceId === voice.id
                                  ? "Selected"
                                  : "Default"}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  ))}
              </DialogContent>
            </Dialog>

            <Button onClick={saveGlobal} disabled={savingGlobal}>
              {savingGlobal ? "Saving…" : "Save settings"}
            </Button>
          </CardContent>
        </Card>

        {globalForm.aiMode === "api" && (
          <Card>
            <CardHeader>
              <CardTitle>Claude API</CardTitle>
              <CardDescription>
                Needed since your AI mode above is set to the direct API.
                Stored only in this browser's local storage — never written
                to Drive. Every turn generated this way is billed to this key
                directly by Anthropic.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="claudeKey">API key</Label>
                <Input
                  id="claudeKey"
                  type="password"
                  autoComplete="off"
                  value={claudeKey}
                  onChange={(e) => setClaudeKeyInput(e.target.value)}
                  placeholder="sk-ant-…"
                />
              </div>
              <Button
                variant="outline"
                onClick={saveClaudeKey}
                className="self-start"
              >
                {claudeKey.trim() ? "Save key" : "Clear key"}
              </Button>
            </CardContent>
          </Card>
        )}

        {(globalForm.sttProvider === "elevenlabs" ||
          globalForm.ttsProvider === "elevenlabs") && (
          <Card>
            <CardHeader>
              <CardTitle>ElevenLabs</CardTitle>
              <CardDescription>
                Needed since your speech-to-text or text-to-speech provider
                above is set to ElevenLabs. Stored only in this browser's
                local storage — never written to Drive.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="elevenLabsKey">API key</Label>
                <Input
                  id="elevenLabsKey"
                  type="password"
                  autoComplete="off"
                  value={elevenLabsKey}
                  onChange={(e) => setElevenLabsKeyInput(e.target.value)}
                  placeholder="sk_…"
                />
              </div>
              <Button
                variant="outline"
                onClick={saveElevenLabsKey}
                className="self-start"
              >
                {elevenLabsKey.trim() ? "Save key" : "Clear key"}
              </Button>
            </CardContent>
          </Card>
        )}

        <CollapsibleSettingsCard
          defaultOpen={localModelsDefaultOpen}
          testId="local-models-card"
          title="Local AI models"
          description={
            <>
              Used when AI mode above is "Local model (runs on this device)"
              — no key, no server, each runs fully on-device via WebGPU.
              Bigger models are higher quality but slower to download and
              more likely to crash the tab on memory-constrained devices.
              Download whichever ones you want ahead of time here so a
              local-mode turn doesn't have to wait on it.
            </>
          }
        >
          {/* No longer a hard stop: a model set to run on the CPU doesn't touch WebGPU at all, so
              the rows stay usable and this only says which of the two options is off the table. */}
          {!isLocalModelSupported() && (
            <p className="text-sm text-muted-foreground">
              This browser doesn't support WebGPU, so these models can only run
              on the CPU here — much slower per turn, but it does work.
            </p>
          )}
          {LOCAL_MODEL_IDS.map((modelId) => {
            const info = LOCAL_MODELS[modelId];
            const row = modelRows[modelId];
            return (
              <div
                key={modelId}
                data-testid={`local-model-row-${modelId}`}
                className="flex flex-col gap-2 border-b border-border/50 pb-4 last:border-0 last:pb-0"
              >
                <div>
                  <p className="text-sm font-medium">{info.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(info.sizeBytes)}
                  </p>
                  {row.device === "wasm" && (
                    <p className="text-xs text-muted-foreground">
                      Running on the CPU: much slower per turn, but it doesn't
                      use the GPU's memory at all. Uses a separate download from
                      the GPU version.
                    </p>
                  )}
                </div>
                {/* Offered up front rather than only reached by an automatic fallback after a
                      GPU crash: on a device whose GPU can't hold the model, that fallback costs a
                      wasted generation every time it's rediscovered. Switching backends changes
                      which build is needed, so the row's downloaded state is re-checked after. */}
                <div className="flex items-center gap-2">
                  <Label
                    className="text-xs text-muted-foreground"
                    htmlFor={`device-${modelId}`}
                  >
                    Run on
                  </Label>
                  <Select
                    value={row.device}
                    onValueChange={(v) =>
                      void changeModelDevice(modelId, v as LocalModelDevice)
                    }
                    // Switching mid-download would leave the in-flight load fetching the build for
                    // the backend that was just switched away from, and its completion would then
                    // mark the row ready for a backend whose files were never fetched.
                    disabled={row.loadState === 'loading' || row.removing}
                  >
                    <SelectTrigger
                      id={`device-${modelId}`}
                      className="h-8 w-[260px] text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="webgpu">GPU — fastest</SelectItem>
                      <SelectItem value="wasm">
                        CPU — slower, avoids GPU memory limits
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {row.loadState === "ready" ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">
                      Downloaded and ready.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void removeModel(modelId)}
                      disabled={row.removing}
                    >
                      {row.removing ? "Removing…" : "Remove"}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void downloadModel(modelId)}
                        disabled={row.loadState === "loading"}
                      >
                        {row.loadState === "loading"
                          ? row.statusMessage || "Downloading…"
                          : "Download"}
                      </Button>
                      {row.hasPartial && row.loadState !== "loading" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeModel(modelId)}
                          disabled={row.removing}
                        >
                          {row.removing
                            ? "Clearing…"
                            : "Clear partial download"}
                        </Button>
                      )}
                    </div>
                    {row.downloadProgress !== null && (
                      <Progress
                        value={row.downloadProgress}
                        className="w-full"
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CollapsibleSettingsCard>

        <CollapsibleSettingsCard
          defaultOpen={kokoroModelDefaultOpen}
          testId="kokoro-model-card"
          title="Kokoro voice model"
          description={
            <>
              Used when text-to-speech above is "Kokoro (on-device, runs
              locally)" — no key, no server. Runs on the CPU by default, so
              no WebGPU is needed; WebGPU below is an optional, opt-in
              alternative that's faster where it's supported. Downloads once,
              then generates speech entirely on this device. Download it
              ahead of time here so the first turn read aloud doesn't have to
              wait on it.
            </>
          }
        >
          {/* Offered up front for the same reason the local text models' identical control is:
              on a device whose WebGPU can't sustain Kokoro, waiting for the automatic fallback
              costs a wasted generation every time it's rediscovered. */}
          <div className="flex items-center gap-2">
            <Label
              className="text-xs text-muted-foreground"
              htmlFor="kokoro-device"
            >
              Run on
            </Label>
            <Select
              value={voiceDevice}
              onValueChange={(v) => void changeVoiceDevice(v as KokoroDevice)}
              // Switching mid-download would leave the in-flight load fetching the build for the
              // backend just switched away from, whose completion would then mark the row ready
              // for a backend whose files were never fetched.
              disabled={voiceLoadState === "loading" || removingVoiceModel}
            >
              <SelectTrigger id="kokoro-device" className="h-8 w-[260px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wasm">CPU — default, broadly compatible</SelectItem>
                <SelectItem value="webgpu">
                  GPU — faster where supported, larger download
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {voiceDevice === "webgpu" && (
            <p className="text-xs text-muted-foreground">
              Uses a separate, larger download from the CPU version. Falls
              back to the CPU automatically if this browser/device can't
              sustain WebGPU (and remembers that, so it won't keep retrying
              WebGPU on every turn).
            </p>
          )}
          {voiceLoadState === "ready" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Voice model downloaded and ready — playback starts instantly.
              </p>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void removeVoiceModel()}
                disabled={removingVoiceModel}
              >
                {removingVoiceModel
                  ? "Removing…"
                  : "Remove downloaded voice model"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => void downloadVoiceModel()}
                disabled={voiceLoadState === "loading"}
              >
                {voiceLoadState === "loading"
                  ? voiceStatusMessage || "Downloading…"
                  : "Download voice model now"}
              </Button>
              {voiceDownloadProgress !== null && (
                <Progress value={voiceDownloadProgress} className="w-full" />
              )}
              {typeof caches === "undefined" && (
                <p className="text-xs text-muted-foreground">
                  This page isn't on HTTPS or localhost, so the browser cache
                  Kokoro relies on isn't available — the model works but
                  re-downloads each page load.
                </p>
              )}
            </>
          )}
        </CollapsibleSettingsCard>
      </SettingsSection>

      <SettingsSection title="Account">
        <Card>
          <CardHeader>
            <CardTitle>Google account</CardTitle>
            <CardDescription>
              Disconnect this app from your Google Drive.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => signOut()}>
              Sign out
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>
    </div>
  );
}
