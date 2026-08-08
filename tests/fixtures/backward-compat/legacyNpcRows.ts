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
