import type { StateDelta, ValidationIssue, ValidationResult } from '@/types/turn'
import type { SheetSnapshot } from './promptBuilder'
import { isKnownKokoroVoiceId } from '@/lib/voice/kokoroVoiceCatalog'
import { isValidVoiceSpeed } from '@/lib/voice/voiceCasting'

function issue(severity: ValidationIssue['severity'], path: string, message: string): ValidationIssue {
  return { severity, path, message }
}

/** A miscast voice must never cost the player their turn (issue #98) — an unrecognized `voiceId`
 * or an out-of-range `voiceSpeed` is always a warning, never an error, on both `new_npcs` and
 * `npc_updates`. This only flags the problem; `applyDelta.ts` is what actually discards/coerces
 * the bad value before it's written (same defense-in-depth split as `new_threads`/`thread_updates`'
 * progress-range checks below, which similarly warn here and get clamped in applyDelta.ts). */
function pushVoiceCastingWarnings(
  issues: ValidationIssue[],
  path: string,
  name: string,
  entry: { voiceId?: string; voiceSpeed?: number },
): void {
  if (entry.voiceId !== undefined && !isKnownKokoroVoiceId(entry.voiceId)) {
    issues.push(issue('warning', path, `"${name}" is cast with an unrecognized voiceId "${entry.voiceId}" — will fall back to a default cast instead.`))
  }
  if (entry.voiceSpeed !== undefined && !isValidVoiceSpeed(entry.voiceSpeed)) {
    issues.push(issue('warning', path, `"${name}" has an out-of-range voiceSpeed (${entry.voiceSpeed}) — will be ignored.`))
  }
}

/** Deterministic client-side checks that run before any state_delta is written to the sheet.
 * See DESIGN.md §5. Errors block the write; warnings are shown but don't. */
export function validateStateDelta(delta: StateDelta, snapshot: SheetSnapshot): ValidationResult {
  const issues: ValidationIssue[] = []

  for (const removal of delta.inventory_remove ?? []) {
    const held = snapshot.Inventory.find(
      (i) => i.active && i.name.trim().toLowerCase() === removal.name.trim().toLowerCase(),
    )
    const qty = removal.qty ?? 1
    if (!held) {
      issues.push(
        issue('error', 'inventory_remove', `Tries to remove "${removal.name}", which isn't in inventory.`),
      )
    } else if (held.qty < qty) {
      issues.push(
        issue(
          'error',
          'inventory_remove',
          `Tries to remove ${qty}x "${removal.name}", but only ${held.qty} is held.`,
        ),
      )
    }
  }

  for (const add of delta.inventory_add ?? []) {
    if (!add.name?.trim()) issues.push(issue('error', 'inventory_add', 'An added item is missing a name.'))
  }

  for (const npc of delta.new_npcs ?? []) {
    if (!npc.name?.trim()) issues.push(issue('error', 'new_npcs', 'A new NPC is missing a name.'))
    else pushVoiceCastingWarnings(issues, 'new_npcs', npc.name, npc)
  }

  for (const update of delta.npc_updates ?? []) {
    const existing = snapshot.NPCs.find((n) => n.name.trim().toLowerCase() === update.name.trim().toLowerCase())
    pushVoiceCastingWarnings(issues, 'npc_updates', update.name, update)
    if (!existing) {
      // Profile fields (voice/secrets/attributes/notes_add) attached to an update that names an
      // undocumented NPC get the same "isn't documented yet" warning as any other npc_updates
      // entry — called out by name here since silently discarding a whole profile write would be
      // a worse surprise than the existing generic message.
      const hasProfileFields =
        update.voice !== undefined ||
        update.secrets !== undefined ||
        update.attributes !== undefined ||
        update.notes_add !== undefined
      issues.push(
        issue(
          'warning',
          'npc_updates',
          hasProfileFields
            ? `Attaches profile detail (voice/secrets/attributes/notes) to NPC "${update.name}", who isn't documented yet.`
            : `Updates NPC "${update.name}", who isn't documented yet.`,
        ),
      )
    } else if (existing.status === 'dead' && update.status && update.status !== 'dead') {
      issues.push(
        issue(
          'warning',
          'npc_updates',
          `"${update.name}" is documented as dead and is being revived — confirm the narrative actually explains this.`,
        ),
      )
    }
  }

  for (const monster of delta.new_monsters ?? []) {
    if (!monster.name?.trim()) issues.push(issue('error', 'new_monsters', 'A new monster is missing a name.'))
  }

  for (const loc of delta.new_locations ?? []) {
    if (!loc.name?.trim()) issues.push(issue('error', 'new_locations', 'A new location is missing a name.'))
  }

  for (const [key, value] of Object.entries(delta.stat_changes ?? {})) {
    if (key.trim().toLowerCase() === 'hp' && typeof value === 'number') {
      const current = snapshot.Character.find((c) => c.key.trim().toLowerCase() === 'hp')
      const currentNum = current ? Number(current.value) : undefined
      if (currentNum !== undefined && !Number.isNaN(currentNum)) {
        const next = currentNum + value
        if (next < 0) {
          issues.push(
            issue(
              'warning',
              'stat_changes.hp',
              `HP would drop to ${next} (below 0) — confirm this means death/incapacitation under the current difficulty.`,
            ),
          )
        }
      }
    }
  }

  for (const event of delta.events ?? []) {
    if (!event.title?.trim()) issues.push(issue('error', 'events', 'An event is missing a title.'))
  }

  for (const quest of delta.quest_updates ?? []) {
    if (!quest.title?.trim()) issues.push(issue('error', 'quest_updates', 'A quest update is missing a title.'))
  }

  for (const thread of delta.new_threads ?? []) {
    if (!thread.title?.trim()) {
      issues.push(issue('error', 'new_threads', 'A new story thread is missing a title.'))
      continue
    }
    if (thread.progressMax !== undefined && thread.progressMax < 0) {
      issues.push(
        issue('warning', 'new_threads', `Thread "${thread.title}" has a negative progressMax (${thread.progressMax}).`),
      )
    } else if (
      thread.progress !== undefined &&
      thread.progressMax !== undefined &&
      (thread.progress < 0 || thread.progress > thread.progressMax)
    ) {
      issues.push(
        issue(
          'warning',
          'new_threads',
          `Thread "${thread.title}" sets progress (${thread.progress}) outside its clock (0-${thread.progressMax}).`,
        ),
      )
    }
    if (thread.status === 'resolved' && !thread.revealed) {
      issues.push(
        issue(
          'warning',
          'new_threads',
          `Thread "${thread.title}" is created already resolved without ever being revealed — confirm this was meant to pay off entirely off-screen.`,
        ),
      )
    }
  }

  for (const update of delta.thread_updates ?? []) {
    if (!update.title?.trim()) {
      issues.push(issue('error', 'thread_updates', 'A story thread update is missing a title.'))
      continue
    }
    const existing = snapshot.Threads.find(
      (t) => t.title.trim().toLowerCase() === update.title.trim().toLowerCase(),
    )
    if (!existing) {
      issues.push(
        issue('warning', 'thread_updates', `Updates story thread "${update.title}", which isn't documented yet.`),
      )
    } else {
      if (existing.status === 'resolved' && update.status && update.status !== 'resolved') {
        issues.push(
          issue(
            'warning',
            'thread_updates',
            `"${update.title}" is documented as resolved and is being reopened — confirm the narrative actually explains this.`,
          ),
        )
      }
      if (update.status === 'resolved' && !(update.revealed ?? existing.revealed)) {
        issues.push(
          issue(
            'warning',
            'thread_updates',
            `"${update.title}" is being resolved without ever being revealed to the player — confirm this was meant to pay off entirely off-screen, or reveal it first.`,
          ),
        )
      }
    }
    const maxForCheck = update.progressMax ?? existing?.progressMax
    if (
      update.progress !== undefined &&
      maxForCheck !== undefined &&
      (update.progress < 0 || update.progress > maxForCheck)
    ) {
      issues.push(
        issue(
          'warning',
          'thread_updates',
          `Thread "${update.title}" sets progress (${update.progress}) outside its clock (0-${maxForCheck}).`,
        ),
      )
    }
  }

  for (const lore of delta.new_lore ?? []) {
    if (!lore.name?.trim()) issues.push(issue('error', 'new_lore', 'A new lore entry is missing a name.'))
  }

  const ok = !issues.some((i) => i.severity === 'error')
  return { ok, issues }
}
