import type { StateDelta, ValidationIssue, ValidationResult } from '@/types/turn'
import type { SheetSnapshot } from './promptBuilder'

function issue(severity: ValidationIssue['severity'], path: string, message: string): ValidationIssue {
  return { severity, path, message }
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
  }

  for (const update of delta.npc_updates ?? []) {
    const existing = snapshot.NPCs.find((n) => n.name.trim().toLowerCase() === update.name.trim().toLowerCase())
    if (!existing) {
      issues.push(
        issue('warning', 'npc_updates', `Updates NPC "${update.name}", who isn't documented yet.`),
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

  for (const lore of delta.new_lore ?? []) {
    if (!lore.name?.trim()) issues.push(issue('error', 'new_lore', 'A new lore entry is missing a name.'))
  }

  const ok = !issues.some((i) => i.severity === 'error')
  return { ok, issues }
}
