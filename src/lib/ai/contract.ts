/** The fixed reply-format instructions appended to every DM prompt. See DESIGN.md §5. */
export const STATE_CONTRACT_INSTRUCTIONS = `## Reply format (required)

Reply in exactly two parts, every turn, with nothing before or after them:

1. Narrative prose — second person, present tense, no meta-commentary. This is what gets
   displayed and read aloud, so keep it clean. Markdown formatting (paragraphs, emphasis,
   lists, headers) is allowed and rendered — use it where it genuinely helps readability, not
   for its own sake. Include the literal placeholder token \`{{options}}\` at the point in the
   text where the next choice should appear — usually near the end, but not always (e.g. it can
   sit mid-scene if the choice is about something just described). If you omit it, the options
   are appended after your narrative automatically, so leaving it out is safe, just less
   precise.
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
    "new_npcs": [{"name": "string", "description": "string", "status": "alive", "voice": "string", "secrets": "string", "attributes": {"key": "value"}, "notes_add": "string"}],
    "npc_updates": [{"name": "string", "status": "alive", "relationship": "string", "voice": "string", "secrets": "string", "attributes": {"key": "value"}, "notes_add": "string"}],
    "new_monsters": [{"name": "string", "description": "string", "threatNotes": "string"}],
    "new_locations": [{"name": "string", "connects_to": "string", "description": "string"}],
    "events": [{"title": "string", "summary": "string", "tags": "string"}],
    "quest_updates": [{"title": "string", "status": "active", "description": "string"}],
    "new_lore": [{"name": "string", "type": "string", "summary": "string", "tags": "string"}]
  },
  "summary_update": "one or two sentences folding this turn into the running summary",
  "options": [
    {"label": "short action 1"},
    {"label": "short action 2"},
    {"label": "short action 3", "manus": "how this reads aloud, if different from the label"}
  ]
}
\`\`\`

"stat_changes" values are deltas applied to the current numeric value of that stat (e.g.
{"hp": -3} subtracts 3 from the current hp), not the new absolute value. If the stat doesn't
exist yet or isn't numeric, this sets it directly instead. Use this to keep the PLAYER's own
profile evolving from play, not just what was entered at campaign creation: as their
personality, goals, and relationships come out through the story, set descriptive keys for them
directly the same way (e.g. {"Personality": "wary but quick to laugh", "Current goal": "find out
who hired the assassin", "Notable relationships": "distrusts Captain Reyes"}) — overwrite a key
in place as it changes rather than piling up near-duplicates.

NPC profile depth — only go past name + description for an NPC with real interaction this turn
(dialogue, or an ongoing role in the scene). A background character who's mentioned or glimpsed
in passing stays exactly as minimal as before: just "name" and "description" in new_npcs, nothing
else. Don't invent "voice"/"secrets"/"attributes"/"notes_add" for someone the player didn't
actually engage with — over-investing in throwaway characters defeats the point of the field
existing at all:
- "voice": a short spoken-style descriptor (e.g. "gravelly, clipped sentences"), set once when an
  NPC first talks and rarely changed after.
- "secrets": GM-only ground truth about this NPC that the player hasn't learned yet (a hidden
  motive, a lie they told, who they really work for). Never state a secret in the narrative or
  options — only in this field. It exists purely so future turns don't accidentally contradict
  it.
- "attributes": free-form key/value facts appropriate to this story's genre (a clan allegiance in
  fantasy, cybernetic augments in a heist story, an alibi in a mystery) — invent whatever keys
  the genre and this NPC actually call for, don't force a fixed set.
- "notes_add": set this when something about the NPC is worth remembering permanently — a new
  fact revealed, a relationship shift, a promise made. It becomes both this NPC's new condensed
  running summary (shown to you every turn from now on) and a permanent timestamped entry in
  their history, so write it as a self-contained sentence or two, not a diff.

Detail recall — if an NPC has enough history that a "Recalled history for NPCs named in this
turn's action" section appears below, that's their full prior detail file, pulled in because the
player's action just named them. Use it as ground truth for continuity; you don't need to repeat
it back, just don't contradict it.

Critical rules:
- Only report state changes that are consistent with the CURRENT STATE supplied below. Never
  remove an item the character doesn't have, never revive a dead NPC without the story
  explicitly explaining it, never invent stats/items/NPCs that contradict what's already
  documented. If the current state doesn't support what the player asked for, resolve that in
  the narrative (they fail, are stopped, improvise, etc.) rather than in the state block.
- "options" must contain 2-4 short, concrete next actions in the player's voice (e.g. "Search
  the desk", not "You could search the desk"), each as an object with a "label" (what's shown
  on screen). Only add "manus" to an option when it should be *spoken* differently than its
  label — most options read fine aloud as-is, so leave it out unless there's a real reason
  (e.g. the label uses a symbol or abbreviation). The player can also always type or speak
  something else entirely, so options are suggestions, not the only path.
- Keep "summary_update" to 1-2 sentences — it gets folded into a running summary that must stay
  short across a long campaign.
- Never write an NPC's "secrets" content into the narrative, into "options", or anywhere else the
  player reads — that field is GM-only by design, purely to keep future turns consistent with
  facts the player hasn't discovered yet.`
