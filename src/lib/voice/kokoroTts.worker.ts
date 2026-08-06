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
 */

import { createProgressAggregator } from '@/lib/modelDownloadProgress'
import { KOKORO_MODEL_ID, DEFAULT_VOICE } from './kokoroConstants'
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
let ttsPromise: Promise<any> | null = null

function loadTts() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js')
      // KokoroTTS.from_pretrained() internally makes two concurrent from_pretrained() calls (model
      // weights + tokenizer) sharing one progress_callback, so the same per-file-progress-resets
      // problem localModel.ts has applies here — see createProgressAggregator's doc comment.
      return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: createProgressAggregator((p) => post({ kind: 'progress', progress: p })),
      })
    })()
    // Don't cache a failed load — let the next attempt retry cleanly.
    ttsPromise.catch(() => {
      ttsPromise = null
    })
  }
  return ttsPromise
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

async function listVoices(requestId: number): Promise<void> {
  const tts = await loadTts()
  const voices: KokoroWorkerVoice[] = Object.entries(tts.voices).map(([id, v]) => {
    const voice = v as { name: string; language: string; gender: string; traits?: string }
    return { id, name: voice.name, language: voice.language, gender: voice.gender, traits: voice.traits }
  })
  post({ kind: 'voices', requestId, voices })
}

/**
 * Generates every chunk, then stitches them into one continuous clip — the whole point of #44.
 * `chunks` is always non-empty here; kokoroTts.ts skips sending the request at all for empty text.
 */
async function speak(requestId: number, chunks: string[], voice: string): Promise<void> {
  const tts = await loadTts()
  const resolvedVoice = resolveVoice(tts, voice)
  const generated: { audio: Float32Array; sampling_rate: number }[] = []
  for (let i = 0; i < chunks.length; i++) {
    // Sequential, deliberately: kokoro-js's WASM session isn't verified safe for concurrent
    // generate() calls (nothing in its source or docs promises reentrancy), and issue #44 was
    // explicit about not assuming that without checking — which this didn't attempt, since moving
    // to a Worker was already enough to fix the main-thread-blocking problem that motivated looking
    // at concurrency in the first place. If per-turn generation time ever becomes the bottleneck
    // (rather than "does it block the UI"), verifying safe concurrent generate() calls is the next
    // place to look — not assumed safe here.
    const audio = await tts.generate(chunks[i], { voice: resolvedVoice })
    generated.push({ audio: audio.audio, sampling_rate: audio.sampling_rate })
    post({ kind: 'chunkProgress', requestId, completed: i + 1, total: chunks.length })
  }
  post({ kind: 'audio', requestId, blob: stitchAudio(generated) })
}

ctx.addEventListener('message', (event) => {
  const message = event.data
  const fail = (err: unknown) =>
    post({ kind: 'error', requestId: message.requestId, message: err instanceof Error ? err.message : String(err) })

  switch (message.kind) {
    case 'load':
      loadTts()
        .then(() => post({ kind: 'done', requestId: message.requestId }))
        .catch(fail)
      break
    case 'listVoices':
      listVoices(message.requestId).catch(fail)
      break
    case 'speak':
      speak(message.requestId, message.chunks, message.voice).catch(fail)
      break
    case 'evict':
      // Drops the loaded model reference so the next load/speak starts genuinely fresh — mirrors
      // localModel.worker.ts's 'evict', minus the per-backend Map since Kokoro has only one model.
      ttsPromise = null
      post({ kind: 'done', requestId: message.requestId })
      break
  }
})
