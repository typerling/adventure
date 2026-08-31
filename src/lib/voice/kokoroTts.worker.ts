/**
 * Runs Kokoro model loading and generation off the main thread — mirrors
 * `src/lib/ai/localModel.worker.ts`'s pattern for the local text models (see that file's doc
 * comment for the general rationale: a long unbroken stretch of WASM inference on the main thread
 * competes with React rendering and locks up the UI for the duration, including whatever's meant
 * to show it's still alive).
 *
 * This didn't used to matter as much for Kokoro: the original per-chunk generate-ahead-then-play
 * loop (predating even issue #44, back when this all ran on the main thread) interleaved one
 * `tts.generate()` call at a time with real `<audio>` playback in between, which incidentally gave
 * the main thread breathing room every sentence. Issue #44 then moved to generating a whole turn's
 * narration up front — every chunk's `tts.generate()` back-to-back with nothing interleaved at all,
 * so it could be stitched into one continuous clip and played gaplessly.
 * Measured (not assumed) against a representative ~700-character turn on this model's `q8` build:
 * tens of seconds of unbroken CPU-bound inference — comfortably enough to freeze the whole UI for
 * the entire pre-generation wait if left on the main thread. (Measured via kokoro-js's
 * Node/onnxruntime-node CPU backend, not literally in-browser WASM — kokoro-js's Node build only
 * supports the `cuda`/`cpu` devices, not `wasm`, so an exact in-browser number wasn't obtained;
 * native CPU execution is generally at least as fast as WASM, so this is a conservative lower bound
 * on the real blocking time, not an overstated one. See the PR this shipped in for the actual
 * numbers.) That tens-of-seconds figure is exactly the wait issue #62 (below) shortens — it hasn't
 * gotten any *faster* to generate a whole turn, but the player no longer has to wait for all of it
 * before hearing anything.
 *
 * **Streaming playback (issue #62).** `doSpeak()`/`speak()` below are the *original* #44
 * generate-everything-then-stitch-one-blob path — kept only for generateKokoroPreview()'s short,
 * fixed preview text, where "wait for the whole (one-chunk) clip" costs nothing extra anyway.
 * Real turn narration now goes through `doSpeakStream()`/`speakStream()` instead: each chunk's raw
 * audio is posted back (`chunkAudio`) the moment it's generated, so kokoroTts.ts can start playing
 * chunk 1 while this worker is still generating chunk 2 and beyond — see that file's doc comment
 * for the playback side. This doesn't change *why* generation needs to stay off the main thread
 * (it's still the same tens-of-seconds of unbroken inference, just reported incrementally instead
 * of all at the end) — only what happens to each chunk's result once it's ready.
 *
 * kokoroTts.ts keeps the UI-facing state (progress listeners, load status) and talks to this over
 * the protocol in kokoroWorkerProtocol.ts. Nothing here may touch `window` or the DOM —
 * `navigator.storage.persist()` in particular is Window-only, which is why kokoroTts.ts calls it on
 * the main thread before asking for a load, same as localModel.ts does for the text models.
 *
 * **Per-chunk voice/speed (issue #66).** `speak()`/`speakStream()` no longer take one job-wide
 * `voice` — each chunk in `chunks` (KokoroWorkerChunk, kokoroWorkerProtocol.ts) carries its own
 * resolved voice and an optional `speed`, so one turn's job can switch between the narrator's/
 * player's/several NPCs' voices chunk to chunk. `generateChunks` below resolves each chunk's own
 * voice independently; nothing about the WebGPU-fallback restart or the streaming/superseded-job
 * bookkeeping above changes, since both already operate purely in terms of chunk *indices* — the
 * `chunks` array itself (voice/speed included) is simply resent unchanged on a restart, so the same
 * index always regenerates with the same voice/speed it had the first time. `doSpeakStream` also
 * kicks off a best-effort voice-file prefetch (`prefetchVoices`) for every distinct voice `chunks`
 * names, in parallel with the model load — see that function's doc comment.
 *
 * **WebGPU backend (issue #51).** Kokoro originally ran WASM-only, deliberately — see this
 * repo's git history / CLAUDE.md for why that was a feature (no hard support gate, unlike the
 * local text models). WebGPU is now a selectable, opt-in-in-Settings alternative
 * (kokoroConstants.ts's KokoroDevice), default still `wasm`. Unlike localModel.worker.ts, there is
 * no modelId dimension to key by — Kokoro is exactly one model — so `ttsPromises` is keyed by
 * device alone, and loadWithFallback()/doSpeak()/doSpeakStream() below mirror that file's
 * device-lost-mid-generation fallback logic without the per-model bookkeeping.
 */

import { createProgressAggregator } from '@/lib/modelDownloadProgress'
import {
  KOKORO_MODEL_ID,
  KOKORO_VOICES_CACHE_NAME,
  DEFAULT_VOICE,
  KOKORO_WASM_DTYPE,
  KOKORO_WEBGPU_DTYPE,
  type KokoroDevice,
} from './kokoroConstants'
import type { KokoroWorkerChunk, KokoroWorkerRequest, KokoroWorkerResponse, KokoroWorkerVoice } from './kokoroWorkerProtocol'

// Typed view of the worker global rather than a `/// <reference lib="webworker" />`, which would
// pull the WorkerGlobalScope lib into a project otherwise compiled against the DOM lib and produce
// conflicting global declarations — same reasoning as localModel.worker.ts's identical `ctx`.
const ctx = self as unknown as {
  postMessage(message: KokoroWorkerResponse, transfer?: Transferable[]): void
  addEventListener(type: 'message', handler: (event: MessageEvent<KokoroWorkerRequest>) => void): void
}

/** `transfer` moves a chunkAudio message's sample buffer instead of structured-cloning it (see
 * generateChunks' postChunk) — everything else posts with no transfer list, same as before. */
function post(message: KokoroWorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer)
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

/** The same URL kokoro-js@1.2.1's own (unexported) per-voice fetch helper builds internally —
 * verified against the installed package's bundled source (`voices/<id>.bin` under this model's
 * `resolve/main/` tree) — kept as a plain string template here rather than importing anything from
 * kokoro-js itself, since the whole point of this file's `prefetchVoices` (issue #66) is to warm
 * the *same* Cache Storage entry kokoro-js's own fetch will later look for, without needing a
 * loaded model (or even the kokoro-js module) to do it. */
function voiceFileUrl(voiceId: string): string {
  return `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/voices/${voiceId}.bin`
}

/**
 * Best-effort prefetch of every distinct voice `chunks` will need, run in parallel with the model
 * load itself (see doSpeakStream/doSpeak) rather than serialized after it — issue #66's "falling
 * behind" concern: each voice is a separate ~510KB download kokoro-js's own `generate_from_ids`
 * otherwise only fetches lazily, mid-turn, the first time that voice is actually used, which is
 * exactly the kind of stall issue #62's streaming design was built to avoid for the model weights
 * themselves. This warms the *same* 'kokoro-voices' Cache Storage bucket kokoro-js's own internal
 * fetch reads from (see voiceFileUrl's doc comment) — a real network fetch this app controls
 * ahead of time, not a guess or a no-op — so that internal fetch finds a cache hit instead of
 * blocking generation on a live download.
 *
 * Deliberately best-effort per voice: a single voice's fetch failing (offline, a bad id, a CDN
 * hiccup) must not block the others or the turn overall — kokoro-js's own lazy fetch inside
 * `generate_from_ids` is still there as the real fallback if this didn't manage to warm the cache,
 * exactly as if this function didn't exist at all. `onProgress` fires once up front (0/total) and
 * once per voice as it settles (success or failure alike count toward `completed`), letting
 * kokoroTts.ts reflect this in the same progress plumbing a model download uses instead of leaving
 * a silent stall — see kokoroWorkerProtocol.ts's 'voicePrefetch' response.
 */
async function prefetchVoices(voiceIds: string[], onProgress: (completed: number, total: number) => void): Promise<void> {
  const distinct = [...new Set(voiceIds.filter(Boolean))]
  if (distinct.length === 0) return
  let completed = 0
  onProgress(0, distinct.length)
  await Promise.all(
    distinct.map(async (id) => {
      try {
        if (typeof caches !== 'undefined') {
          const cache = await caches.open(KOKORO_VOICES_CACHE_NAME)
          const url = voiceFileUrl(id)
          const cached = await cache.match(url)
          if (!cached) {
            const res = await fetch(url)
            // Cache Storage entries are consumed once (the body stream), so this stores a real
            // Response object same as kokoro-js's own internal helper does — nothing here reads
            // the body itself; the whole point is to have it sitting in cache for kokoro-js's own
            // later fetch to find, not to use the bytes ourselves.
            if (res.ok) await cache.put(url, res)
          }
        }
      } catch {
        // Cache Storage unavailable (plain HTTP — see kokoroTts.ts's caching caveat), or the
        // network fetch itself failed — either way, kokoro-js's own lazy fetch inside
        // generate_from_ids is the real fallback; this was only ever trying to get ahead of it.
      } finally {
        completed++
        onProgress(completed, distinct.length)
      }
    }),
  )
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

/** The most recent 'speak'/'speakStream' request kokoroTts.ts actually wants — set synchronously
 * the instant a new request arrives, not when its turn in speakQueue comes up. Lets doSpeak/
 * doSpeakStream notice it's been superseded (a newer turn started playing before this one
 * finished) and bail without either running a pointless generation or posting a result nothing
 * will use. */
let currentSpeakRequestId: number | null = null
/** Serializes speak-family jobs ('speak' and 'speakStream' alike, since both drive the same
 * shared model instance) — kokoro-js's WASM session isn't verified safe for concurrent
 * generate() calls (nothing in its source or docs promises reentrancy), and issue #44 was
 * explicit about not assuming that without checking. Without this, clicking a different turn's
 * play button while an earlier turn's generation is still running would dispatch a second job
 * straight into the same shared model instance. */
let speakQueue: Promise<void> = Promise.resolve()

/** Queues `job` behind whatever speak-family work is already in flight, keeping the queue itself
 * alive even when a job rejects so one failed/superseded turn doesn't permanently wedge every
 * request queued after it — the rejection still propagates to this call's own caller (the message
 * handler's `.catch(fail)`) via the returned promise, just not the queue. */
function runSpeakJob(job: () => Promise<void>): Promise<void> {
  const wrapped = speakQueue.then(job)
  speakQueue = wrapped.catch(() => {})
  return wrapped
}

/** `null` return means superseded (see doSpeak's staleness checks) — distinct from an empty array,
 * which can't happen since kokoroTts.ts never sends an empty `chunks` list. `onChunk`, when given,
 * fires synchronously right after each chunk succeeds — doSpeakStream (issue #62) uses it to post
 * that chunk's audio immediately instead of waiting for the whole loop to finish; doSpeak (used
 * only for generateKokoroPreview's short, almost-always-one-chunk clip) passes none, since there's
 * nothing worth streaming ahead of for that case. */
async function generateChunks(
  requestId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tts: any,
  chunks: KokoroWorkerChunk[],
  onChunk?: (index: number, audio: Float32Array, samplingRate: number) => void,
): Promise<{ audio: Float32Array; sampling_rate: number }[] | null> {
  const generated: { audio: Float32Array; sampling_rate: number }[] = []
  for (let i = 0; i < chunks.length; i++) {
    // Superseded mid-generation — stop after whatever chunk is already in flight rather than
    // grinding through the rest of a turn nothing will play.
    if (requestId !== currentSpeakRequestId) return null
    const chunk = chunks[i]
    // Each chunk resolves its *own* voice (issue #66) rather than one job-wide voice — a turn can
    // mix narrator/player/several NPCs' voices in one job. speed undefined lets Kokoro use its own
    // default (1); kokoroTts.ts always supplies one for a real turn (see kokoroConstants.ts).
    const audio = await tts.generate(chunk.text, { voice: resolveVoice(tts, chunk.voice), speed: chunk.speed })
    generated.push({ audio: audio.audio, sampling_rate: audio.sampling_rate })
    onChunk?.(i, audio.audio, audio.sampling_rate)
  }
  return requestId === currentSpeakRequestId ? generated : null
}

/**
 * Generates every chunk, then stitches them into one continuous clip for generateKokoroPreview()'s
 * benefit — a single, almost always one-chunk preview clip has nothing to gain from streaming (see
 * doSpeakStream for the real turn-narration path, issue #62). `chunks` is always non-empty here;
 * kokoroTts.ts skips sending the request at all for empty text.
 *
 * WebGPU fallback (issue #51) has two separate places it can trigger, both handled here rather
 * than only in loadWithFallback: no adapter at all surfaces the moment `loadWithFallback` tries to
 * load, before any chunk runs; a *lost* device only surfaces once `tts.generate()` actually starts
 * failing, which can be mid-turn after some chunks already succeeded on the GPU. Either way the
 * whole job restarts on WASM from chunk 0 — discarding any WebGPU-generated audio rather than
 * splicing dtypes/backends mid-clip, mirroring localModel.worker.ts's generate(), which restarts
 * the whole reply on the CPU rather than trying to resume where the GPU left off.
 */
async function doSpeak(requestId: number, chunks: KokoroWorkerChunk[], preferredDevice: KokoroDevice): Promise<void> {
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
    generated = await generateChunks(requestId, tts, chunks)
  } catch (err) {
    if (device !== 'webgpu' || !isWebgpuFailure(err)) throw err
    ttsPromises.delete('webgpu')
    const wasmTts = await loadTts('wasm')
    // Posted only once the WASM retry has actually produced a result (matching
    // loadWithFallback's identical fix, and localModel.worker.ts's pattern this mirrors) — not
    // before attempting it, so a second, genuine failure on WASM propagates as a normal error
    // instead of a UI that already claims the fallback backend is in use.
    generated = await generateChunks(requestId, wasmTts, chunks)
    post({ kind: 'backend', device: 'wasm' })
  }
  if (generated === null) {
    post({ kind: 'done', requestId })
    return
  }
  post({ kind: 'audio', requestId, blob: stitchAudio(generated) })
}

/**
 * Generates every chunk, posting each one's raw audio (`chunkAudio`) the instant it's ready
 * instead of waiting for the whole turn and stitching a blob (issue #62, replacing #44's
 * wait-for-everything design now that pre-generation genuinely runs off the main thread — see this
 * file's doc comment for what changed since #44). `chunks` is always non-empty here; kokoroTts.ts
 * skips sending the request at all for empty text.
 *
 * WebGPU fallback (issue #51) restarts the whole job from chunk 0 on WASM exactly like doSpeak's —
 * see that function's doc comment for why. The difference here is that some of chunks 0..N-1 may
 * already have been posted — and be playing — by the time chunk N fails on the GPU: this still
 * re-generates and re-posts *every* chunk from 0 on WASM rather than resuming from N, same
 * "restart, don't resume" posture as the non-streaming path (and the same one
 * kokoro-webgpu-backend.spec.ts already asserts on at the generation level). The de-duplication
 * that keeps already-heard chunks from playing twice lives on the *main thread*
 * (kokoroTts.ts's nextExpectedChunkIndex) — this worker has no visibility into playback at all, so
 * it can't be the one to skip a resend.
 *
 * Also kicks off prefetchVoices (issue #66) for every distinct voice `chunks` names, in parallel
 * with loadWithFallback rather than serialized before or after it — the model load is already the
 * dominant wait on a cold start, so overlapping the (much smaller, ~510KB-per-voice) prefetch with
 * it costs nothing extra in the common case, and on a warm model load (already resident from an
 * earlier turn) the prefetch alone is what stands between "instant" and "stalls on the first line
 * of a new character's dialogue."
 */
async function doSpeakStream(requestId: number, chunks: KokoroWorkerChunk[], preferredDevice: KokoroDevice): Promise<void> {
  // Same "always settle the request" reasoning as doSpeak.
  if (requestId !== currentSpeakRequestId) {
    post({ kind: 'done', requestId })
    return
  }
  const [{ tts, device }] = await Promise.all([
    loadWithFallback(preferredDevice),
    prefetchVoices(
      chunks.map((c) => c.voice),
      (completed, total) => post({ kind: 'voicePrefetch', requestId, completed, total }),
    ),
  ])
  const postChunk = (index: number, audio: Float32Array, samplingRate: number) => {
    // Transfers the sample buffer rather than structured-cloning it — a chunk can be a few hundred
    // KB of Float32 samples, and nothing on this side reads it again after posting.
    post({ kind: 'chunkAudio', requestId, index, total: chunks.length, audio, samplingRate }, [audio.buffer])
  }
  try {
    await generateChunks(requestId, tts, chunks, postChunk)
  } catch (err) {
    if (device !== 'webgpu' || !isWebgpuFailure(err)) throw err
    ttsPromises.delete('webgpu')
    const wasmTts = await loadTts('wasm')
    await generateChunks(requestId, wasmTts, chunks, postChunk)
    // Posted only once the WASM retry has actually produced a result — see doSpeak's identical fix.
    post({ kind: 'backend', device: 'wasm' })
  }
  // Reached whether generateChunks completed normally or bailed out early as superseded (`null`)
  // — either way there's nothing more to post for this requestId, matching doSpeak's identical
  // "'done' is a safe stand-in" reasoning.
  post({ kind: 'done', requestId })
}

function speak(requestId: number, chunks: KokoroWorkerChunk[], device: KokoroDevice): Promise<void> {
  currentSpeakRequestId = requestId
  return runSpeakJob(() => doSpeak(requestId, chunks, device))
}

function speakStream(requestId: number, chunks: KokoroWorkerChunk[], device: KokoroDevice): Promise<void> {
  currentSpeakRequestId = requestId
  return runSpeakJob(() => doSpeakStream(requestId, chunks, device))
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
      speak(message.requestId, message.chunks, message.device).catch(fail)
      break
    case 'speakStream':
      speakStream(message.requestId, message.chunks, message.device).catch(fail)
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
