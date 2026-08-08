import { EMPTY_ROLLING_SUMMARY_PLACEHOLDER } from '@/lib/google/campaignRepo'
import type { Quest } from '@/types/sheets'

/**
 * Formatting helpers for the header's "quick recap" info dialog (issue #24). Both live here
 * rather than inline in Play.tsx/Header.tsx so the trimming rule is one small, obviously-correct
 * place instead of duplicated logic — and so a future Storybook/Playwright case can exercise them
 * without spinning up the whole page.
 */

/** Max characters of the rolling summary shown in the recap dialog. Trimmed from the *end* of the
 * string, not the start: `story/summary/rolling.md` only ever grows by appending
 * (`useCampaign.ts`'s `submitReply` does `${rollingSummary} ${summary_update}`), so the most
 * recently narrated events — the ones that actually help a player re-orient after stepping away —
 * sit at the tail, not the head. */
export const RECAP_SUMMARY_MAX_CHARS = 280

/** Trims a (typically much longer) rolling summary down to a short, word-boundary-safe excerpt
 * for the recap dialog. Returns null for an empty/whitespace-only summary (a brand-new campaign
 * with no turns yet) so the caller can skip rendering that section entirely rather than showing
 * an empty "So far" heading. */
export function buildRecapSummary(rollingSummary: string, maxChars = RECAP_SUMMARY_MAX_CHARS): string | null {
  let trimmed = rollingSummary.trim()
  // Every campaign's rolling.md starts as this exact placeholder (see campaignRepo.ts's
  // createCampaign) until the first turn appends a real summary_update — and useCampaign.ts's
  // submitReply only ever *appends* to the existing summary, so this placeholder stays as a
  // permanent leading prefix on every campaign's rolling summary, not just its very first turn
  // (a pre-existing wart, filed separately as its own issue — out of scope to fix the storage
  // side here). Strip it wherever it leads the string so it never surfaces as recap text,
  // Markdown underscores and all.
  if (trimmed.startsWith(EMPTY_ROLLING_SUMMARY_PLACEHOLDER)) {
    trimmed = trimmed.slice(EMPTY_ROLLING_SUMMARY_PLACEHOLDER.length).trim()
  }
  if (!trimmed) return null
  if (trimmed.length <= maxChars) return trimmed

  const tail = trimmed.slice(trimmed.length - maxChars)
  // Cut at the first remaining space so the excerpt starts on a whole word instead of mid-word —
  // if there's no space at all (one very long "word"), fall back to the raw slice.
  const firstSpace = tail.indexOf(' ')
  const clipped = firstSpace === -1 ? tail : tail.slice(firstSpace + 1)
  return `…${clipped}`
}

/** Quests still open — what the issue calls "active/incomplete" — for the recap's quest list.
 * Completed/failed quests are left out on purpose: they're history, not something the player
 * needs to be reminded of to re-orient (the Codex's Quests tab still has the full list). */
export function getActiveQuests(quests: Quest[]): Quest[] {
  return quests.filter((quest) => quest.status === 'active')
}
