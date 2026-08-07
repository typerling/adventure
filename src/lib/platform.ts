/**
 * True when this page is running as an installed Android home-screen app ("WebAPK") in
 * standalone display mode, rather than an ordinary browser tab. Used by AuthGate (issue #45) to
 * scope its "you may need to sign in every time" note to the context that actually has the known
 * silent-session-restore limitation (see authStore.ts's research summary), instead of showing it
 * to every visitor regardless of platform.
 *
 * Both checks are ordinary, well-supported feature/UA detection — `display-mode: standalone` is a
 * standard CSS media feature, and Android detection is deliberately loose (a substring match) so
 * it degrades to "note not shown" rather than throwing on any environment lacking these APIs.
 */
export function isInstalledAndroidApp(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  const android = /Android/i.test(navigator.userAgent)
  return standalone && android
}
