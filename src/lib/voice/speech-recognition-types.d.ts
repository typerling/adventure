/**
 * Minimal ambient types for the Web Speech API's SpeechRecognition constructor/instance.
 * TypeScript's lib.dom.d.ts already declares the event types (SpeechRecognitionEvent,
 * SpeechRecognitionErrorEvent, SpeechRecognitionResult(List), SpeechRecognitionErrorCode) but not
 * SpeechRecognition itself — it's Baseline-available but still non-standard enough (Safari only
 * ships it webkit-prefixed) that TS hasn't added it. Same pattern as gis-types.d.ts.
 */

interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}
