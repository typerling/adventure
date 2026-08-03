import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import {
  LOCAL_MODEL_IDS,
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

/**
 * Device-global settings only — no key, no server, nothing tied to any one campaign: on-device
 * model downloads, API keys (localStorage-only), and the Google account connection. Everything
 * campaign-specific (AI mode, voice provider choices, summarization cadence, etc.) lives in
 * Codex's "Settings" tab instead — see Codex.tsx.
 */
export function Settings() {
  const navigate = useNavigate();
  const { signOut } = useGoogleAuth();
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

  function patchModelRow(
    modelId: LocalModelId,
    patch: Partial<LocalModelRowState>,
  ) {
    setModelRows((prev) => ({
      ...prev,
      [modelId]: { ...prev[modelId], ...patch },
    }));
  }

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
        <Button size="sm" variant="ghost" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        These apply to this device, not any one campaign. AI mode, voice
        provider choices, and other per-campaign settings live in each
        campaign's Codex, under its "Settings" tab.
      </p>

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
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void downloadModel(modelId)}
                        disabled={row.loadState === "loading"}
                      >
                        {row.loadState === "loading" ? "Downloading…" : "Download"}
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
                    {row.loadState === "loading" && row.statusMessage && (
                      <p className="text-xs break-words text-muted-foreground">
                        {row.statusMessage}
                      </p>
                    )}
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
                  ? "Downloading…"
                  : "Download voice model now"}
              </Button>
              {voiceLoadState === "loading" && voiceStatusMessage && (
                <p className="text-xs break-words text-muted-foreground">
                  {voiceStatusMessage}
                </p>
              )}
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

      <Card>
        <CardHeader>
          <CardTitle>Claude API</CardTitle>
          <CardDescription>
            Needed by any campaign using the direct API AI mode. Stored only in
            this browser's local storage — never written to Drive. Every turn
            generated this way is billed to this key directly by Anthropic.
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

      <Card>
        <CardHeader>
          <CardTitle>ElevenLabs</CardTitle>
          <CardDescription>
            Needed by any campaign using ElevenLabs for speech-to-text or
            text-to-speech. Stored only in this browser's local storage — never
            written to Drive.
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
