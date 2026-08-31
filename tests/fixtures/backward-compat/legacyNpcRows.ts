/**
 * Literal NPCs-tab shape exactly as it existed before #30/PR #37 added `voice`/`secrets`/`notes`/
 * `detailFile` — verified against that commit's diff (`git show 0147001 -- src/types/sheets.ts`),
 * not reconstructed from memory: real history, not synthetic. A campaign whose spreadsheet was
 * created before that PR genuinely has NPC rows exactly this shape — six columns instead of
 * today's ten. The six columns that do exist (`id`/`name`/`description`/`relationship`/`status`/
 * `lastSeenTurn`) never moved position, so this is squarely the "row shorter than today's header,
 * missing columns only at the end" case `sheetSchema.ts`'s coercion helpers (`str`/`num`/`bool`,
 * all default-on-`undefined`) are meant to degrade gracefully against — see this fixture's use in
 * `tests/backward-compat-row-shapes.spec.ts`.
 */
export const PRE_NPC_PROFILE_NPCS_HEADER = [
  'id',
  'name',
  'description',
  'relationship',
  'status',
  'lastSeenTurn',
]

export const PRE_NPC_PROFILE_NPC_ROW = [
  'npc-001',
  'Old Maren',
  'Keeper of the sunken chapel, more moss than woman these days.',
  'wary',
  'alive',
  3,
]

/**
 * Literal NPCs-tab shape exactly as it existed immediately before issue #98 added `voiceId`/
 * `voiceSpeed`/`voiceLocked` — the full ten-column post-#30 shape (`id`/`name`/`description`/
 * `relationship`/`status`/`lastSeenTurn`/`voice`/`secrets`/`notes`/`detailFile`), with nothing
 * appended for voice casting yet. A campaign whose spreadsheet was created any time between #30 and
 * #98 genuinely has NPC rows exactly this shape — see this fixture's use in
 * `tests/backward-compat-row-shapes.spec.ts` for the assertion that today's `voiceId: ''`/
 * `voiceSpeed: 0`/`voiceLocked: false` defaults apply, not `undefined` or a thrown error.
 */
export const PRE_VOICE_CASTING_NPCS_HEADER = [
  'id',
  'name',
  'description',
  'relationship',
  'status',
  'lastSeenTurn',
  'voice',
  'secrets',
  'notes',
  'detailFile',
]

export const PRE_VOICE_CASTING_NPC_ROW = [
  'npc-002',
  'Corin the Warden',
  'A scarred sentinel who guards the chapel threshold.',
  'wary',
  'alive',
  5,
  'low and measured, every word deliberate',
  'was once a member of the cult he now guards against',
  '',
  '',
]
