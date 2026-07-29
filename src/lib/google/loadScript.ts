const loaded = new Map<string, Promise<void>>()

/** Loads an external <script> tag once and caches the promise so repeated calls are free. */
export function loadScript(src: string): Promise<void> {
  const existing = loaded.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(script)
  })

  loaded.set(src, promise)
  return promise
}

export const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client'
