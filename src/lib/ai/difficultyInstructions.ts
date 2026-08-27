import type { Difficulty } from '@/types/campaign'

/** DM-facing instructions per difficulty. See DESIGN.md §7 and §9 (fail-forward). */
export const DIFFICULTY_INSTRUCTIONS: Record<Difficulty, string> = {
  Story: `Difficulty: Story. Conflict is rare and low-stakes. Failure costs little — a setback
in tone, not in resources or lasting harm. Character death is effectively off the table unless
the player is clearly and repeatedly courting it. Pacing should mostly be quiet, exploratory
beats — treat any tense moment as a brief accent, not the norm, and let it resolve gently.`,
  Easy: `Difficulty: Easy. Danger is present but forgiving. Failed actions usually still move
things forward with a minor complication rather than a hard stop. Resource loss and injury are
possible but rarely severe. Pacing should favor quieter beats overall, with occasional light
tension rather than sustained danger.`,
  Standard: `Difficulty: Standard. Use fail-forward: a failed or risky action should still move
the story forward, but with a complication, cost, or unwanted consequence — not "nothing
happens, try again." Real risk to resources, standing, and physical safety exists. Death is
possible but should follow from clearly telegraphed danger, not a sudden gotcha. Pacing should
alternate: let tense, high-stakes beats be followed by quieter ones where the player can take
stock, rather than running at the same intensity every turn.`,
  Hard: `Difficulty: Hard. Resources are scarce and consequences are weighted harshly. Failure
often costs real resources, time, or standing, not just flavor. Injuries persist. Death is a
real and present possibility when the player takes clear risks. Pacing should skew tense more
often than not, but still give the player the occasional quieter beat to plan or recover in —
constant unbroken danger reads as exhausting, not thrilling.`,
  Brutal: `Difficulty: Brutal. This is a survival-grade, permadeath-on experience. Threats are
lethal and the world does not go easy. Do not pull punches to protect the character — if the
fiction supports a fatal or catastrophic outcome, let it happen. Pacing should stay taut and
consequence-forward throughout; even a lull should feel like the tension coiling, not release.`,
}
