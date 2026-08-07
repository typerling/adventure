/**
 * Runs Kokoro model loading and generation off the main thread — mirrors
 * `src/lib/ai/localModel.worker.ts`'s pattern for the local text models (see that file's doc
 * comment for the general rationale: a long unbroken stretch of WASM inference on the main thread
 * competes with React rendering and locks up the UI for the duration, including whatever's meant
 * to show it's still alive).
 *
 * This didn't used to matter as much for Kokoro: the old per-chunk generate-ahead-then-play loop
 * (see kokoroTts.ts's git history / issue #44) interleaved one `tts.generate()` call at a time with
 * real `<audio>` playback in between, which incidentally gave the main thread breathing room every
 * sentence. Generating a whole turn's narration up front — so it can be stitched into one
 * continuous clip and played gaplessly, matching ElevenLabs — means running every chunk's
 * `tts.generate()` back-to-back with nothing interleaved at all. Measured (not assumed) against a
 * representative ~700-character turn on this model's `q8` build: tens of seconds of unbroken
 * CPU-bound inference — comfortably enough to freeze the whole UI for the entire pre-generation
 * wait if left on the main thread. (Measured via kokoro-js's Node/onnxruntime-node CPU backend,
 * not literally in-browser WASM — kokoro-js's Node build only supports the `cuda`/`cpu` devices,
 * not `wasm`, so an exact in-browser number wasn't obtained; native CPU execution is generally at
 * least as fast as WASM, so this is a conservative lower bound on the real blocking time, not an
 * overstated one. See the PR this shipped in for the actual numbers.)
 *
 * kokoroTts.ts keeps the UI-facing state (progress listeners, load status) and talks to this over
 * the protocol in kokoroWorkerProtocol.ts. Nothing here may touch `window` or the DOM —
 * `navigator.storage.persist()` in particular is Window-only, which is why kokoroTts.ts calls it on
 * the main thread before asking for a load, same as localModel.ts does for the text models.
 *
 * **WebGPU backend (issue #51).** Kokoro originally ran WASM-only, deliberately — see this
 * repo's git history / CLAUDE.md for why that was a feature (no hard support gate, unlike the
 * local text models). WebGPU is now a selectable, opt-in-in-Settings alternative
 * (kokoroConstants.ts's KokoroDevice), default still `wasm`. Unlike localModel.worker.ts, there is
 * no modelId dimension to key by — Kokoro is exactly one model — so `ttsPromises` is keyed by
 * device alone, and loadWithFallback()/doSpeak() below mirror that file's device-lost-mid-generation
 * fallback logic without the per-model bookkeeping.
 */

import { createProgressAggregator } from '@/lib/modelDownloadProgress'
import { KOKORO_MODEL_ID, DEFAULT_VOICE, KOKORO_WASM_DTYPE, KOKORO_WEBGPU_DTYPE, type KokoroDevice } from './kokoroConstants'
import type { KokoroWorkerRequest, KokoroWorkerResponse, KokoroWorkerVoice } from './kokoroWorkerProtocol'

// Typed view of the worker global rather than a `/// <reference lib="webworker" />`, which would
// pull the WorkerGlobalScope lib into a project otherwise compiled against the DOM lib and produce
// conflicting global declarations — same reasoning as localModel.worker.ts's identical `ctx`.
const ctx = self as unknown as {
  postMessage(message: KokoroWorkerResponse): void
  addEventListener(type: 'message', handler: (event: MessageEvent<KokoroWorkerRequest>) => void): void
}

function post(message: KokoroWorkerResponse): void {
  ctx.postMessage(message)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ttsPromises = new Map<KokoroDevice, Promise<any>>()

function loadTts(device: KokoroDevice) {
  let promise = ttsPromises.get(device)
  if (!promise) {
    promise = (async () => {
      const { KokoroTTS } = await import('kokoro-js')
      // KokoroTTS.from_pretrained() internally makes two concurrent from_pretrained() calls (model
      // weights + tokenizer) sharing one progress_callback, so the same per-file-progress-resets
      // problem localModel.ts has applies here — see createProgressAggregator's doc comment.
      return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: device === 'webgpu' ? KOKORO_WEBGPU_DTYPE : KOKORO_WASM_DTYPE,
        device,
        progress_callback: createProgressAggregator((p) => post({ kind: 'progress', progress: p })),
      })
    })()
    ttsPromises.set(device, promise)
    // Don't cache a failed load — let the next attempt retry cleanly.
    promise.catch(() => {
      if (ttsPromises.get(device) === promise) ttsPromises.delete(device)
    })
  }
  return promise
}

/** A lost GPU device (mid-generation) or an environment with no usable WebGPU adapter at all
 * (first load) are both unrecoverable for that specific attempt — the only route forward is the
 * WASM backend. Matched on the message because ONNX Runtime/WebGPU surface both as plain text with
 * no error code to branch on: "device lost"-style messages come from ONNX Runtime's C++ layer (see
 * localModel.worker.ts's identical isDeviceLost, which this mirrors); "WebGPU is not supported" and
 * "WebGPU not available on this browser (requestAdapter returned null)" are onnxruntime-web's own
 * strings for "no adapter" (verified by reading the installed onnxruntime-web's bundled source, not
 * assumed). */
function isWebgpuFailure(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err)
  return /device.{0,20}(is )?lost|mapAsync|GPUDevice|createBindGroup|GPUAdapter|WebGPU (is not supported|not available)|requestAdapter/i.test(
    raw,
  )
}

/**
 * Resolves a preferred device to an actually-loaded model instance, falling back to WASM (and
 * reporting the switch) if WebGPU was requested but no adapter is available at all — the failure
 * mode this app can't hit in its own CI/dev sandbox (no WebGPU there either) but a real player's
 * browser can, e.g. an older GPU, a locked-down enterprise Chrome, or Firefox/Safari without WebGPU
 * support. Not attempted for a device that's already 'wasm': there is nothing further to fall back
 * to, and a genuine WASM failure (OOM, corrupt download) should surface as-is rather than retry
 * pointlessly on itself.
 */
async function loadWithFallback(preferred: KokoroDevice): Promise<{ tts: unknown; device: KokoroDevice }> {
  if (preferred === 'wasm') return { tts: await loadTts('wasm'), device: 'wasm' }
  try {
    return { tts: await loadTts('webgpu'), device: 'webgpu' }
  } catch (err) {
    if (!isWebgpuFailure(err)) throw err
    ttsPromises.delete('webgpu')
    // Post the fallback notice only once the WASM load has actually succeeded — matches
    // localModel.worker.ts's generate(), which reports its own CPU fallback only after the CPU
    // run has actually produced a reply, not before attempting it; found (and originally missed
    // here) in independent review of the PR this shipped in. A WASM load failure right after a
    // WebGPU one should surface as its own error, not pin the UI to a backend that never actually
    // came up.
    const tts = await loadTts('wasm')
    post({ kind: 'backend', device: 'wasm' })
    return { tts, device: 'wasm' }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveVoice(tts: any, voice: string): string {
  return voice && voice in tts.voices ? voice : DEFAULT_VOICE
}

/**
 * Encodes mono 32-bit-float PCM samples as a WAV file buffer.
 *
 * `tts.generate()` resolves an (unexported) `RawAudio`-shaped object exposing `.audio` (a
 * `Float32Array` of raw samples) and `.sampling_rate`, plus its own `.toBlob()`/`.toWav()` that
 * encode exactly those two fields — verified against the installed kokoro-js@1.2.1's bundled
 * `@huggingface/transformers` source (`RawAudio`/`encodeWAV` in its `utils/audio.js`): format code
 * 3 (IEEE float), mono, 32-bit. kokoro-js itself only exports `KokoroTTS`/`TextSplitterStream`/
 * `env` — not `RawAudio` — so stitching several chunks' raw samples into one clip means building
 * this header ourselves rather than reusing that class. This is *not* guessing at the format: it's
 * the same header the library's own (unexported) encoder writes.
 */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const headerSize = 44
  const buffer = new ArrayBuffer(headerSize + samples.length * 4)
  const view = new DataView(buffer)

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 4, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true) // sample format: IEEE float
  view.setUint16(22, 1, true) // channel count: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 4, true) // byte rate = sampleRate * blockAlign
  view.setUint16(32, 4, true) // block align: 1 channel * 4 bytes/sample
  view.setUint16(34, 32, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 4, true)

  let offset = headerSize
  for (let i = 0; i < samples.length; i++, offset += 4) view.setFloat32(offset, samples[i], true)

  return buffer
}

/**
 * Concatenates each generated chunk's *raw* samples into one continuous stream before encoding —
 * not, as issue #44 flagged, naively concatenating already-encoded blobs, which doesn't produce
 * valid single-file audio for most encodings (WAV's own header alone — RIFF/data chunk lengths —
 * makes N separately-encoded files invalid if just laid end to end). Every chunk comes from the
 * same loaded model/voice in the same 'speak' job, so a shared sample rate is assumed rather than
 * reconciled across chunks.
 */
function stitchAudio(chunks: { audio: Float32Array; sampling_rate: number }[]): Blob {
  const sampleRate = chunks[0].sampling_rate
  const totalSamples = chunks.reduce((sum, c) => sum + c.audio.length, 0)
  const samples = new Float32Array(totalSamples)
  let offset = 0
  for (const c of chunks) {
    samples.set(c.audio, offset)
    offset += c.audio.length
  }
  return new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' })
}

async function listVoices(requestId: number, device: KokoroDevice): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { tts } = (await loadWithFallback(device)) as { tts: any }
  const voices: KokoroWorkerVoice[] = Object.entries(tts.voices).map(([id, v]) => {
    const voice = v as { name: string; language: string; gender: string; traits?: string }
    return { id, name: voice.name, language: voice.language, gender: voice.gender, traits: voice.traits }
  })
  post({ kind: 'voices', requestId, voices })
}

/** The most recent 'speak' request kokoroTts.ts actually wants — set synchronously the instant a
 * new 'speak' message arrives, not when its turn in speakQueue comes up. Lets doSpeak notice it's
 * been superseded (a newer turn started playing before this one finished) and bail without either
 * running a pointless generation or posting a result nothing will use. */
let currentSpeakRequestId: number | null = null
/** Serializes 'speak' jobs — kokoro-js's WASM session isn't verified safe for concurrent
 * generate() calls (nothing in its source or docs promises reentrancy), and issue #44 was
 * explicit about not assuming that without checking. Without this, clicking a different turn's
 * play button while an earlier turn's pre-generation is still running (now tens of seconds, not
 * the second or two the old per-chunk-interleaved-with-playback design left as a window) would
 * dispatch a second 'speak' job straight into the same shared model instance. */
let speakQueue: Promise<void> = Promise.resolve()

/** `null` return means superseded (see doSpeak's staleness checks) — distinct from an empty array,
 * which can't happen since kokoroTts.ts never sends an empty `chunks` list. */
async function generateChunks(
  requestId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tts: any,
  chunks: string[],
  voice: string,
): Promise<{ audio: Float32Array; sampling_rate: number }[] | null> {
  const resolvedVoice = resolveVoice(tts, voice)
  const generated: { audio: Float32Array; sampling_rate: number }[] = []
  for (let i = 0; i < chunks.length; i++) {
    // Superseded mid-generation — stop after whatever chunk is already in flight rather than
    // grinding through the rest of a turn nothing will play.
    if (requestId !== currentSpeakRequestId) return null
    const audio = await tts.generate(chunks[i], { voice: resolvedVoice })
    generated.push({ audio: audio.audio, sampling_rate: audio.sampling_rate })
    post({ kind: 'chunkProgress', requestId, completed: i + 1, total: chunks.length })
  }
  return requestId === currentSpeakRequestId ? generated : null
}

/**
 * Generates every chunk, then stitches them into one continuous clip — the whole point of #44.
 * `chunks` is always non-empty here; kokoroTts.ts skips sending the request at all for empty text.
 *
 * WebGPU fallback (issue #51) has two separate places it can trigger, both handled here rather
 * than only in loadWithFallback: no adapter at all surfaces the moment `loadWithFallback` tries to
 * load, before any chunk runs; a *lost* device only surfaces once `tts.generate()` actually starts
 * failing, which can be mid-turn after some chunks already succeeded on the GPU. Either way the
 * whole job restarts on WASM from chunk 0 — discarding any WebGPU-generated audio rather than
 * splicing dtypes/backends mid-clip, mirroring localModel.worker.ts's generate(), which restarts
 * the whole reply on the CPU rather than trying to resume where the GPU left off.
 */
async function doSpeak(requestId: number, chunks: string[], voice: string, preferredDevice: KokoroDevice): Promise<void> {
  // Every bail-out below posts 'done' (a plain no-payload response, same as 'load'/'evict' use)
  // rather than just returning — kokoroTts.ts's pending Map is keyed by requestId and only cleaned
  // up when *some* response arrives for it; silently returning here would leave that entry (and
  // its awaiting caller) hanging forever instead of settling. The caller already checks its own
  // staleness (isStale()) before ever looking at what kind of response it got, so 'done' is a safe
  // stand-in for a superseded 'audio' — its content is never inspected.
  if (requestId !== currentSpeakRequestId) {
    post({ kind: 'done', requestId })
    return
  }
  const { tts, device } = await loadWithFallback(preferredDevice)
  let generated: { audio: Float32Array; sampling_rate: number }[] | null
  try {
    generated = await generateChunks(requestId, tts, chunks, voice)
  } catch (err) {
    if (device !== 'webgpu' || !isWebgpuFailure(err)) throw err
    ttsPromises.delete('webgpu')
    const wasmTts = await loadTts('wasm')
    // Posted only once the WASM retry has actually produced a result (matching
    // loadWithFallback's identical fix, and localModel.worker.ts's pattern this mirrors) — not
    // before attempting it, so a second, genuine failure on WASM propagates as a normal error
    // instead of a UI that already claims the fallback backend is in use.
    generated = await generateChunks(requestId, wasmTts, chunks, voice)
    post({ kind: 'backend', device: 'wasm' })
  }
  if (generated === null) {
    post({ kind: 'done', requestId })
    return
  }
  post({ kind: 'audio', requestId, blob: stitchAudio(generated) })
}

function speak(requestId: number, chunks: string[], voice: string, device: KokoroDevice): Promise<void> {
  currentSpeakRequestId = requestId
  const job = speakQueue.then(() => doSpeak(requestId, chunks, voice, device))
  // Keep the queue itself alive even when a job rejects, so one failed/superseded turn doesn't
  // permanently wedge every 'speak' request queued after it — the rejection still propagates to
  // this call's own caller (the message handler's `.catch(fail)`) via `job`, just not the queue.
  speakQueue = job.catch(() => {})
  return job
}

ctx.addEventListener('message', (event) => {
  const message = event.data
  const fail = (err: unknown) =>
    post({ kind: 'error', requestId: message.requestId, message: err instanceof Error ? err.message : String(err) })

  switch (message.kind) {
    case 'load':
      // loadWithFallback (not loadTts directly) so a WebGPU preference with no adapter available
      // is discovered — and silently recovered from — right here, before kokoroTts.ts's caller
      // ever gets to a 'speak' request. Without this, the *first* sign of trouble would be the
      // generation-time fallback in doSpeak, which is fine but strictly later than necessary.
      loadWithFallback(message.device)
        .then(() => post({ kind: 'done', requestId: message.requestId }))
        .catch(fail)
      break
    case 'listVoices':
      listVoices(message.requestId, message.device).catch(fail)
      break
    case 'speak':
      speak(message.requestId, message.chunks, message.voice, message.device).catch(fail)
      break
    case 'evict':
      // Drops every loaded backend's reference so the next load/speak starts genuinely fresh —
      // mirrors localModel.worker.ts's 'evict', minus the per-modelId loop since Kokoro has only
      // one model (just the two backends, both cleared unconditionally rather than picking one).
      ttsPromises.clear()
      post({ kind: 'done', requestId: message.requestId })
      break
  }
})
