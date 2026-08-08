import { stripRollingSummaryPlaceholder } from '@/lib/google/campaignRepo'
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
  // Every campaign's rolling.md starts as the exact EMPTY_ROLLING_SUMMARY_PLACEHOLDER string (see
  // campaignRepo.ts's createCampaign) until the first turn appends a real summary_update.
  // useCampaign.ts's submitReply now strips that placeholder before appending (issue #70), so a
  // campaign that has submitted a turn since that fix landed never carries it here. Two cases
  // still reach this line with the placeholder present, so the strip below stays needed rather
  // than becoming dead code: a brand-new campaign that hasn't submitted its first turn yet (this
  // function is what makes that case return null, below), and a campaign whose stored rolling.md
  // still has the placeholder baked in from before the write-side fix shipped and hasn't
  // submitted a turn since (issue #70's backward-compatibility case — self-heals in storage on
  // that campaign's next turn, but this display path can't wait for that).
  const trimmed = stripRollingSummaryPlaceholder(rollingSummary)
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
