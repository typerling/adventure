import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { useGoogleAuth } from "@/lib/google/authStore";
import {
  getElevenLabsApiKey,
  setElevenLabsApiKey,
} from "@/lib/voice/elevenLabsKey";
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
  describeKokoroProgress,
  getKokoroLoadState,
  hasDownloadedKokoroModel,
  preloadKokoroModel,
  removeKokoroModel,
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
  const [settings, setSettings] = useState<CampaignSettings | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
      setSettings(cached.settings);
      setCampaignName(cached.campaign.meta.name);
      return;
    }
    void loadSettings(campaignId)
      .then(setSettings)
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
    });
    return () => setHeaderContext(null);
  }, [campaignId, campaignName, setHeaderContext]);

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

  async function save() {
    if (!campaignId || !settings) return;
    setSaving(true);
    try {
      await saveSettings(campaignId, settings);
      patchCachedCampaignSettings(campaignId, settings);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function saveElevenLabsKey() {
    setElevenLabsApiKey(elevenLabsKey);
    toast.success(
      elevenLabsKey.trim()
        ? "ElevenLabs API key saved."
        : "ElevenLabs API key cleared.",
    );
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
      toast.success("Voice model removed from this device.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingVoiceModel(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
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

      {campaignId && settings && (
        <Card data-testid="campaign-settings">
          <CardHeader>
            <CardTitle>This campaign</CardTitle>
            <CardDescription>
              AI mode and voice provider choices, stored in this campaign's
              settings.md.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>AI mode</Label>
              <Select
                value={settings.aiMode}
                onValueChange={(v) =>
                  setSettings({
                    ...settings,
                    aiMode: v as CampaignSettings["aiMode"],
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

            {settings.aiMode === "local" && (
              <div className="flex flex-col gap-2">
                <Label>Local model</Label>
                <Select
                  value={settings.localModelId}
                  onValueChange={(v) =>
                    setSettings({
                      ...settings,
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

            {settings.aiMode === "api" && (
              <div className="flex flex-col gap-2">
                <Label>Claude model</Label>
                <Select
                  value={settings.claudeModel}
                  onValueChange={(v) =>
                    setSettings({
                      ...settings,
                      claudeModel: v as CampaignSettings["claudeModel"],
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
                value={settings.sttProvider}
                onValueChange={(v) =>
                  setSettings({
                    ...settings,
                    sttProvider: v as CampaignSettings["sttProvider"],
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
                value={settings.ttsProvider}
                onValueChange={(v) =>
                  setSettings({
                    ...settings,
                    ttsProvider: v as CampaignSettings["ttsProvider"],
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
            </div>

            {(settings.sttProvider === "elevenlabs" ||
              settings.ttsProvider === "elevenlabs") && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="voiceId">ElevenLabs voice ID (optional)</Label>
                <Input
                  id="voiceId"
                  value={settings.elevenLabsVoiceId ?? ""}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      elevenLabsVoiceId: e.target.value.trim() || undefined,
                    })
                  }
                  placeholder="Defaults to a standard ElevenLabs voice if left blank"
                />
                <p className="text-xs text-muted-foreground">
                  Only used for text-to-speech.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="cadence">Re-summarize every N turns</Label>
              <Input
                id="cadence"
                type="number"
                min={5}
                value={settings.summarizationCadence}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    summarizationCadence: Number(e.target.value) || 15,
                  })
                }
              />
            </div>

            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Local AI models</CardTitle>
          <CardDescription>
            Used by any campaign set to "Local model (runs on this device)" — no
            key, no server, each runs fully on-device via WebGPU. Bigger models
            are higher quality but slower to download and more likely to crash
            the tab on memory-constrained devices. Download whichever ones you
            want ahead of time here so a local-mode campaign's first turn
            doesn't have to wait on it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kokoro voice model</CardTitle>
          <CardDescription>
            Used by any campaign set to "Kokoro (on-device, runs locally)" for
            text-to-speech — no key, no server, and no WebGPU needed. Downloads
            once, then generates speech entirely on this device. Download it
            ahead of time here so the first turn read aloud doesn't have to wait
            on it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
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
        </CardContent>
      </Card>

      {campaignId && settings?.aiMode === "api" && (
        <Card>
          <CardHeader>
            <CardTitle>Claude API</CardTitle>
            <CardDescription>
              Needed since this campaign uses the direct API AI mode. Stored
              only in this browser's local storage — never written to Drive.
              Every turn generated this way is billed to this key directly by
              Anthropic.
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

      {campaignId &&
        (settings?.sttProvider === "elevenlabs" ||
          settings?.ttsProvider === "elevenlabs") && (
          <Card>
            <CardHeader>
              <CardTitle>ElevenLabs</CardTitle>
              <CardDescription>
                Needed since this campaign uses ElevenLabs for speech-to-text or
                text-to-speech. Stored only in this browser's local storage —
                never written to Drive.
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
    </div>
  );
}
