/**
 * Client-side random content generator for the campaign setup wizard. This is deliberately not
 * an AI call — Phase 1 has no AI API wired up (see DESIGN.md §11) — it's a offline "give me
 * something to start from" generator: pick-and-combine from small themed word/phrase pools, no
 * network, no key required. Good enough as a starting point the player edits, not a finished
 * scenario.
 */

export interface StatDraft {
  key: string
  value: string
}
export interface InventoryDraft {
  name: string
  qty: number
  description: string
  tags: string
}

export const SUGGESTED_THEMES = [
  'Cozy fantasy village',
  'Cyberpunk heist',
  'Horror survival',
  'Space opera',
  'Noir detective',
  'Post-apocalyptic wasteland',
  'High-seas piracy',
  'Steampunk revolution',
  'Fairy tale gone wrong',
  'Wild west frontier',
  'Haunted mansion mystery',
  'Interdimensional weirdness',
] as const

interface ThemeBucket {
  /** Keywords matched against freeform genre text (lowercased) to pick this bucket. */
  keywords: string[]
  names: string[]
  locations: string[]
  hooks: string[]
  houseRules: string[]
  stats: StatDraft[][]
  items: InventoryDraft[]
}

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]
}

function pickMany<T>(pool: T[], count: number): T[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(count, pool.length))
}

const BUCKETS: Record<string, ThemeBucket> = {
  fantasy: {
    keywords: ['fantasy', 'fairy tale', 'village', 'kingdom', 'medieval'],
    names: ['The Sunken Chapel', "Thornwick's Last Harvest", 'The Ashwood Pact', 'Crownless'],
    locations: ['The docks of Kelmouth', 'Thornwick village square', 'The old mill at Ashwood Bend'],
    hooks: [
      'A minor noble house has quietly gone silent, and the roads to their keep are empty of travelers.',
      'The harvest failed for the third year running, and the village elders are hiding why.',
      'A locked chapel at the edge of town has started ringing its bell again, alone, at midnight.',
    ],
    houseRules: [
      'No character death without an explicit, telegraphed warning first.',
      'Magic exists but is rare, costly, and always has a visible price.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A wandering sellsword with more debts than coin.' },
        { key: 'HP', value: '20' },
        { key: 'STR', value: '12' },
        { key: 'Gold', value: '15' },
      ],
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A hedge-witch exiled from her home village.' },
        { key: 'HP', value: '14' },
        { key: 'Willpower', value: '16' },
        { key: 'Gold', value: '6' },
      ],
    ],
    items: [
      { name: 'Rusted shortsword', qty: 1, description: 'Seen better centuries.', tags: 'weapon' },
      { name: 'Waterskin', qty: 1, description: 'Half full.', tags: 'gear' },
      { name: 'Traveler’s cloak', qty: 1, description: 'Patched twice.', tags: 'gear' },
      { name: 'Dried rations', qty: 3, description: 'Three days’ worth.', tags: 'food' },
    ],
  },
  cyberpunk: {
    keywords: ['cyberpunk', 'cyber', 'punk', 'heist', 'steampunk', 'industrial'],
    names: ['Neon Ledger', 'The Kestrel Job', 'Static Empire', 'Chrome & Ash'],
    locations: ['A rain-slick rooftop above the Lower Wards', 'The Kestrel Corp loading dock', 'An unlicensed data den in the Sprawl'],
    hooks: [
      'A corpo exec wants a data drive retrieved quietly, no questions, cash up front.',
      'Your old crew just resurfaced after everyone thought they were dead — with a job too good to be legal.',
      'The city’s power grid has an exploitable gap, open for exactly six minutes a night.',
    ],
    houseRules: [
      'Failed hacking attempts trigger noisy consequences, never a silent dead end.',
      'Cash and reputation are tracked separately — burning one doesn’t protect the other.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A freelance netrunner burning through favors.' },
        { key: 'HP', value: '16' },
        { key: 'Cred', value: '340' },
        { key: 'Heat', value: '2' },
      ],
    ],
    items: [
      { name: 'Burner deck', qty: 1, description: 'Untraceable, for now.', tags: 'tech' },
      { name: 'Stim shot', qty: 2, description: 'Emergency use only.', tags: 'medical' },
      { name: 'Forged ID chip', qty: 1, description: 'Good enough to pass a casual scan.', tags: 'gear' },
    ],
  },
  horror: {
    keywords: ['horror', 'survival', 'haunted', 'mansion'],
    names: ['The Last Signal', 'Hollow Hour', 'What the Fog Took', 'The Vane House'],
    locations: ['A gas station at the edge of a dead radio zone', 'The foyer of the Vane estate', 'A fogbound rest stop off Route 9'],
    hooks: [
      'The town went quiet three days ago and the only road out is somehow always the same road in.',
      'The house was supposed to be empty. The lights are on in every room but one.',
      'Something followed you back from the woods, and it’s learned to knock.',
    ],
    houseRules: [
      'Resources are scarce on purpose — running out of light/ammo/nerve is a real threat, not flavor.',
      'The threat should almost never be seen fully; describe effects and glimpses, not full reveals.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'The last one who still believes there’s a way out.' },
        { key: 'HP', value: '12' },
        { key: 'Sanity', value: '10' },
      ],
    ],
    items: [
      { name: 'Dying flashlight', qty: 1, description: 'Flickers when it matters most.', tags: 'gear' },
      { name: 'Half-burnt journal', qty: 1, description: 'Someone else’s handwriting near the end.', tags: 'lore' },
      { name: 'Box of matches', qty: 1, description: 'Eleven left.', tags: 'gear' },
    ],
  },
  space: {
    keywords: ['space', 'opera', 'sci-fi', 'scifi', 'interstellar', 'interdimensional'],
    names: ['The Long Dark Run', 'Wreck of the Halcyon', 'Signal from Perigee', 'The Drift Between'],
    locations: ['The cargo bay of a listing freighter', 'A derelict station in a dead orbit', 'The last fueling outpost before the Drift'],
    hooks: [
      'A distress beacon has been repeating the same eleven seconds of static for six years — until now.',
      'Your ship’s AI just admitted it’s been lying about the fuel reserves.',
      'A rival crew beat you to the salvage claim, but left in a hurry, mid-meal.',
    ],
    houseRules: [
      'Vacuum, fuel, and life support are always ticking clocks — track them explicitly in the fiction.',
      'No faster-than-light retcons: consequences from three systems ago can still catch up.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A salvage-crew pilot with a ship worth more in parts than whole.' },
        { key: 'HP', value: '18' },
        { key: 'Oxygen', value: '100' },
        { key: 'Credits', value: '220' },
      ],
    ],
    items: [
      { name: 'Vacuum-sealed ration pack', qty: 4, description: 'Tastes like the packaging.', tags: 'food' },
      { name: 'Multitool', qty: 1, description: 'Held the ship together twice already.', tags: 'gear' },
      { name: 'Emergency O2 canister', qty: 1, description: '20 minutes, if you don’t panic.', tags: 'gear' },
    ],
  },
  noir: {
    keywords: ['noir', 'detective', 'mystery', 'crime'],
    names: ['The Kessler File', 'Rain on Vine Street', 'A Long Way Down', 'The Last Honest Man'],
    locations: ['A one-room office above a shuttered pawn shop', 'The docks at 2am', 'A jazz club that closed an hour ago, officially'],
    hooks: [
      'A client walks in with a story that doesn’t add up and a retainer that’s too generous to refuse.',
      'The cop who owed you a favor just turned up dead, and the favor died with him — or did it.',
      'Everyone in this case is lying, including, probably, your client.',
    ],
    houseRules: [
      'No fight is clean — every physical confrontation costs something, win or lose.',
      'Clues are earned by asking the right questions, not by rolling well.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A private investigator with one unsolved case that still itches.' },
        { key: 'HP', value: '14' },
        { key: 'Grit', value: '11' },
        { key: 'Cash', value: '40' },
      ],
    ],
    items: [
      { name: 'Revolver', qty: 1, description: 'Two bullets, and you’re counting.', tags: 'weapon' },
      { name: 'Case file', qty: 1, description: 'Missing its most important page.', tags: 'lore' },
      { name: 'Flask', qty: 1, description: 'Nearly empty.', tags: 'gear' },
    ],
  },
  wasteland: {
    keywords: ['apocalyp', 'wasteland', 'post-apoc'],
    names: ['Last Light Convoy', 'The Green Zone Lie', 'Ash Between the Ribs', 'Nine Winters'],
    locations: ['A checkpoint at the edge of the Green Zone', 'The rusted skeleton of a highway overpass', 'A sealed vault door, half-buried'],
    hooks: [
      'The convoy’s water reserves are three days from empty and the next source is inside contested territory.',
      'A radio signal claims there’s a working settlement two hundred miles north. It’s either salvation or a trap.',
      'Someone in your group has been hiding a bite mark for two days.',
    ],
    houseRules: [
      'Scarcity is the core tension — track ammo, water, and fuel as real, spendable resources.',
      'Trust between survivors is earned slowly and lost instantly.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A convoy scout who remembers what the world looked like before.' },
        { key: 'HP', value: '16' },
        { key: 'Water', value: '2' },
        { key: 'Scrap', value: '5' },
      ],
    ],
    items: [
      { name: 'Hand-crank radio', qty: 1, description: 'Picks up one station, mostly static.', tags: 'gear' },
      { name: 'Purification tablets', qty: 4, description: 'Makes questionable water drinkable.', tags: 'medical' },
      { name: 'Scavenged pistol', qty: 1, description: 'Six rounds, no spares.', tags: 'weapon' },
    ],
  },
  pirate: {
    keywords: ['pirate', 'piracy', 'sea', 'high-seas', 'ship'],
    names: ['The Gilded Anchor', 'Blood Tide', 'The Kraken’s Ledger', 'Wake of the Wandering Star'],
    locations: ['The deck of a listing brigantine', 'A smuggler’s cove marked on no official map', 'The drowned ruins off Skellow Point'],
    hooks: [
      'A rival captain has your old first mate, and a trade that sounds too fair to be honest.',
      'The chart to a legendary wreck just fell into your hands — half-burnt and missing the coordinates.',
      'The crown’s navy has put a price on your head, and someone aboard is tempted by it.',
    ],
    houseRules: [
      'Ship and crew are resources as important as any individual character’s stats.',
      'Reputation with ports and factions matters as much as gold.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A quartermaster who’s buried more captains than they’d like to admit.' },
        { key: 'HP', value: '18' },
        { key: 'Reputation', value: '3' },
        { key: 'Doubloons', value: '60' },
      ],
    ],
    items: [
      { name: 'Cutlass', qty: 1, description: 'Notched, but sharp where it counts.', tags: 'weapon' },
      { name: 'Half a chart', qty: 1, description: 'The other half is somewhere it shouldn’t be.', tags: 'lore' },
      { name: 'Bottle of rum', qty: 1, description: 'For celebrations, or courage.', tags: 'gear' },
    ],
  },
  western: {
    keywords: ['western', 'wild west', 'frontier', 'cowboy'],
    names: ['Dust and Ninety Miles', 'The Last Honest Sheriff', 'Iron Rail West', 'Redrock Reckoning'],
    locations: ['The saloon at the edge of Redrock', 'A dry riverbed marking the county line', 'The half-built railway camp'],
    hooks: [
      'The railroad company’s men are pushing the line through land that isn’t theirs to take.',
      'A bounty poster with your face on it just went up outside the sheriff’s office.',
      'The bank was robbed by someone wearing your coat.',
    ],
    houseRules: [
      'Violence has lasting consequences — a gunfight should change the story, not just the HP total.',
      'Reputation with the town shifts based on public actions, not private ones.',
    ],
    stats: [
      [
        { key: 'Name', value: '' },
        { key: 'Description', value: 'A drifter with a past nobody in town knows about yet.' },
        { key: 'HP', value: '18' },
        { key: 'Grit', value: '13' },
        { key: 'Dollars', value: '22' },
      ],
    ],
    items: [
      { name: 'Worn revolver', qty: 1, description: 'Your father’s, before yours.', tags: 'weapon' },
      { name: 'Canteen', qty: 1, description: 'Dented, still holds water.', tags: 'gear' },
      { name: 'Weathered hat', qty: 1, description: 'Keeps the sun off, mostly.', tags: 'gear' },
    ],
  },
}

const GENERIC: ThemeBucket = {
  keywords: [],
  names: ['Uncharted', 'The First Turn', 'A Story Not Yet Told', 'Somewhere, Eventually'],
  locations: ['A crossroads with no signpost', 'The last stop before the unknown', 'Wherever the story needs to start'],
  hooks: [
    'Something ordinary just stopped making sense, and you’re the one who noticed.',
    'A stranger has an offer, and it’s better than it has any right to be.',
    'You were promised a quiet life. Today isn’t that.',
  ],
  houseRules: [
    'Failure moves the story forward with a complication rather than a dead stop.',
    'Named characters and places, once introduced, stay consistent — nothing recurring gets reinvented.',
  ],
  stats: [
    [
      { key: 'Name', value: '' },
      { key: 'Description', value: '' },
      { key: 'HP', value: '20' },
    ],
  ],
  items: [
    { name: 'Traveler’s pack', qty: 1, description: 'The basics, and a little more.', tags: 'gear' },
    { name: 'Small keepsake', qty: 1, description: 'Worth more to you than to anyone else.', tags: 'lore' },
  ],
}

function bucketFor(themeText: string): ThemeBucket {
  const lower = themeText.trim().toLowerCase()
  if (!lower) return pick([...Object.values(BUCKETS), GENERIC])
  for (const bucket of Object.values(BUCKETS)) {
    if (bucket.keywords.some((k) => lower.includes(k))) return bucket
  }
  return GENERIC
}

export function randomTheme(): string {
  return pick([...SUGGESTED_THEMES])
}

export function generateName(themeText = ''): string {
  return pick(bucketFor(themeText).names)
}

export function generateWorldPrompt(themeText = ''): string {
  const bucket = bucketFor(themeText)
  const hook = pick(bucket.hooks)
  const tones = [
    'Play it earnest and a little dangerous.',
    'I want real stakes, but room for humor between them.',
    'Keep it tense — let failure sting.',
    'Lean into atmosphere over action; slow burn is fine.',
  ]
  return `${hook} ${pick(tones)}`
}

export function generateStartingLocation(themeText = ''): string {
  return pick(bucketFor(themeText).locations)
}

export function generateHouseRules(themeText = ''): string {
  return pick(bucketFor(themeText).houseRules)
}

export function generateStats(themeText = ''): StatDraft[] {
  const preset = pick(bucketFor(themeText).stats)
  return preset.map((s) => ({ ...s }))
}

export function generateInventory(themeText = ''): InventoryDraft[] {
  const bucket = bucketFor(themeText)
  return pickMany(bucket.items, Math.min(3, bucket.items.length)).map((i) => ({ ...i }))
}

export interface GeneratedCampaign {
  name: string
  genre: string
  worldPrompt: string
  startingLocation: string
  houseRules: string
  stats: StatDraft[]
  inventory: InventoryDraft[]
}

/** Generates every field at once from a single randomly-picked theme, so the result reads as one
 * coherent campaign rather than mismatched pieces from different genres. */
export function generateFullCampaign(): GeneratedCampaign {
  const theme = randomTheme()
  return {
    name: generateName(theme),
    genre: theme,
    worldPrompt: generateWorldPrompt(theme),
    startingLocation: generateStartingLocation(theme),
    houseRules: generateHouseRules(theme),
    stats: generateStats(theme),
    inventory: generateInventory(theme),
  }
}
