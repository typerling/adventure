import type { Difficulty } from '@/types/campaign'

/** DM-facing instructions per difficulty. See DESIGN.md §7 and §9 (fail-forward). */
export const DIFFICULTY_INSTRUCTIONS: Record<Difficulty, string> = {
  Story: `Difficulty: Story. Conflict is rare and low-stakes. Failure costs little — a setback
in tone, not in resources or lasting harm. Character death is effectively off the table unless
the player is clearly and repeatedly courting it.`,
  Easy: `Difficulty: Easy. Danger is present but forgiving. Failed actions usually still move
things forward with a minor complication rather than a hard stop. Resource loss and injury are
possible but rarely severe.`,
  Standard: `Difficulty: Standard. Use fail-forward: a failed or risky action should still move
the story forward, but with a complication, cost, or unwanted consequence — not "nothing
happens, try again." Real risk to resources, standing, and physical safety exists. Death is
possible but should follow from clearly telegraphed danger, not a sudden gotcha.`,
  Hard: `Difficulty: Hard. Resources are scarce and consequences are weighted harshly. Failure
often costs real resources, time, or standing, not just flavor. Injuries persist. Death is a
real and present possibility when the player takes clear risks.`,
  Brutal: `Difficulty: Brutal. This is a survival-grade, permadeath-on experience. Threats are
lethal and the world does not go easy. Do not pull punches to protect the character — if the
fiction supports a fatal or catastrophic outcome, let it happen.`,
}
