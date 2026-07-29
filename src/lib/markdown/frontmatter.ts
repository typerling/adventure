/**
 * Minimal YAML-frontmatter reader/writer for flat key/value metadata (no nested objects/arrays
 * needed anywhere in this app's schema — see CampaignMeta / CampaignSettings). Keeping this
 * hand-rolled avoids pulling in a Node-oriented YAML lib into a browser-only bundle.
 */

function coerce(raw: string): string | number | boolean {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  // Strip matching quotes if present.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseFrontmatter(content: string): {
  data: Record<string, string | number | boolean>
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: content }

  const [, yamlBlock, body] = match
  const data: Record<string, string | number | boolean> = {}
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1)
    data[key] = coerce(value)
  }
  return { data, body: body.replace(/^\r?\n/, '') }
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string' && /[:#\n]/.test(v)) return JSON.stringify(v)
  return String(v)
}

export function stringifyFrontmatter(data: object, body: string): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${stringifyValue(v)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}
