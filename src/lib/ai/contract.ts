/** The fixed reply-format instructions appended to every DM prompt. See DESIGN.md §5. */
export const STATE_CONTRACT_INSTRUCTIONS = `## Reply format (required)

Reply in exactly two parts, every turn, with nothing before or after them:

1. Narrative prose — second person, present tense, no markdown formatting, no headers, no
   meta-commentary. This is what gets displayed and read aloud, so keep it clean prose.
2. A single fenced block at the very end, opened with \`\`\`state and closed with \`\`\`,
   containing one JSON object with this shape (omit keys that don't apply this turn; never
   invent keys):

\`\`\`state
{
  "state_delta": {
    "inventory_add": [{"name": "string", "qty": 1, "note": "string"}],
    "inventory_remove": [{"name": "string", "qty": 1}],
    "stat_changes": {"statKey": 0},
    "status_add": ["string"],
    "status_remove": ["string"],
    "new_npcs": [{"name": "string", "description": "string", "status": "alive"}],
    "npc_updates": [{"name": "string", "status": "alive", "relationship": "string"}],
    "new_monsters": [{"name": "string", "description": "string", "threatNotes": "string"}],
    "new_locations": [{"name": "string", "connects_to": "string", "description": "string"}],
    "events": [{"title": "string", "summary": "string", "tags": "string"}],
    "quest_updates": [{"title": "string", "status": "active", "description": "string"}],
    "new_lore": [{"name": "string", "type": "string", "summary": "string", "tags": "string"}]
  },
  "summary_update": "one or two sentences folding this turn into the running summary",
  "options": ["short action 1", "short action 2", "short action 3"]
}
\`\`\`

"stat_changes" values are deltas applied to the current numeric value of that stat (e.g.
{"hp": -3} subtracts 3 from the current hp), not the new absolute value. If the stat doesn't
exist yet or isn't numeric, this sets it directly instead.

Critical rules:
- Only report state changes that are consistent with the CURRENT STATE supplied below. Never
  remove an item the character doesn't have, never revive a dead NPC without the story
  explicitly explaining it, never invent stats/items/NPCs that contradict what's already
  documented. If the current state doesn't support what the player asked for, resolve that in
  the narrative (they fail, are stopped, improvise, etc.) rather than in the state block.
- "options" must contain 2-4 short, concrete next actions in the player's voice (e.g. "Search
  the desk", not "You could search the desk"). The player can also always type or speak
  something else entirely, so options are suggestions, not the only path.
- Keep "summary_update" to 1-2 sentences — it gets folded into a running summary that must stay
  short across a long campaign.`
