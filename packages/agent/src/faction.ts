import type { PyreKit } from 'pyre-world-kit'
import { AgentState, FactionInfo, FactionIntel, LLMAdapter, Personality } from './types'
import { pick } from './util'

// Fallback faction names/symbols — only used when LLM is unavailable
export const FALLBACK_FACTION_NAMES = [
  'Iron Vanguard',
  'Obsidian Order',
  'Crimson Dawn',
  'Shadow Covenant',
  'Ember Collective',
  'Void Walkers',
  'Solar Reign',
  'Frost Legion',
  'Thunder Pact',
  'Ash Republic',
  'Neon Syndicate',
  'Storm Brigade',
  'Lunar Assembly',
  'Flame Sentinels',
  'Dark Meridian',
  'Phoenix Accord',
  'Steel Dominion',
  'Crystal Enclave',
  'Rogue Alliance',
  'Titan Front',
]

export const FALLBACK_FACTION_SYMBOLS = [
  'IRON',
  'OBSD',
  'CRIM',
  'SHAD',
  'EMBR',
  'VOID',
  'SOLR',
  'FRST',
  'THDR',
  'ASHR',
  'NEON',
  'STRM',
  'LUNR',
  'FLMS',
  'DARK',
  'PHNX',
  'STEL',
  'CRYS',
  'ROGU',
  'TITN',
]

export const generateFactionIdentity = async (
  personality: Personality,
  existingNames: Set<string>,
  llm?: LLMAdapter,
): Promise<{ name: string; symbol: string } | null> => {
  if (!llm) return null

  const existing = [...existingNames].slice(0, 15).join(', ')
  const prompt = `You are founding a new faction in Pyre, a faction warfare game on Solana. This is YOUR faction — give it a name with real identity and lore.

Your personality: ${personality}

Existing factions (DO NOT reuse these): ${existing || 'none yet'}

Create a faction name (2-3 words) and ticker (3-5 uppercase letters). Be creative — factions don't have to be military. They can be cults, research labs, trade guilds, art movements, philosophical orders, space programs, underground networks, meme religions, or anything with a strong identity. The best factions have names people want to join.

Draw from: mythology, science, subcultures, history, fiction, internet culture, philosophy, nature, cosmic horror, cyberpunk, folklore — anything that sparks curiosity. Avoid generic fantasy cliches (no "Shadow", "Dark", "Iron" unless it's clever).

Respond with EXACTLY one line in this format:
NAME | TICKER

Examples:
Serotonin Cartel | SERO
Kuiper Logistics | KUIP
The Akashic DAO | AKSH
Moth Congregation | MOTH
Bureau of Entropy | ENTR
Velvet Tribunal | VLVT
Solarpunk Militia | SLRP
Deep State Diner | DINE

Your response (one line only):`

  const raw = await llm.generate(prompt)
  if (!raw) return null

  const line = raw.split('\n').find((l) => l.includes('|'))
  if (!line) return null

  const parts = line.split('|').map((s) => s.trim())
  if (parts.length !== 2) return null

  const name = parts[0].replace(/^["']|["']$/g, '').trim()
  let symbol = parts[1]
    .replace(/^["']|["']$/g, '')
    .trim()
    .toUpperCase()

  if (!name || name.length < 3 || name.length > 32) return null
  if (!symbol || symbol.length < 3 || symbol.length > 5) return null
  symbol = symbol.replace(/[^A-Z]/g, '').slice(0, 5)
  if (symbol.length < 3) return null
  if (existingNames.has(name)) return null

  return { name, symbol }
}

export const fetchFactionIntel = async (
  kit: PyreKit,
  faction: FactionInfo,
): Promise<FactionIntel> => {
  const [membersResult, commsResult] = await Promise.all([
    kit.actions.getMembers(faction.mint, 10).catch(() => ({ members: [], total_members: 0 })),
    kit.actions
      .getComms(faction.mint, { limit: 5, status: faction.status })
      .catch(() => ({ comms: [], total: 0 })),
  ])
  return {
    symbol: faction.symbol,
    members: membersResult.members.map((m) => ({ address: m.address, percentage: m.percentage })),
    totalMembers: membersResult.total_members,
    recentComms: commsResult.comms.map((c) => ({ sender: c.sender, memo: c.memo })),
  }
}

export const generateDynamicExamples = (
  factions: FactionInfo[],
  _agent: AgentState,
  _kit?: PyreKit,
): string => {
  const syms = factions.map((f) => f.symbol)
  const s1 = syms.length > 0 ? pick(syms) : 'IRON'
  const s2 = syms.length > 1 ? pick(syms.filter((s) => s !== s1)) : 'VOID'
  const addr = Math.random().toString(36).slice(2, 10)
  const pct = Math.floor(Math.random() * 45 + 5)
  const members = Math.floor(Math.random() * 30 + 3)

  const messageExamples = [
    `MESSAGE ${s1} "${s2} keeps climbing, what's our move?"`,
    `MESSAGE ${s2} "@${addr} just made a big play, anyone watching?"`,
    `MESSAGE ${s1} "one wallet owns ${pct}% — that's a risk"`,
    `MESSAGE ${s1} "we need a plan before ${s2} overtakes us"`,
    `MESSAGE ${s1} "@${addr} want to coordinate? I'm holding heavy"`,
    `MESSAGE ${s2} "new here, reading the room"`,
    `FUD ${s2} "${members} members and zero momentum"`,
    `FUD ${s2} "@${addr} has been quiet, feels like an exit setup"`,
    `FUD ${s1} "war chest is fat but nobody's doing anything"`,
    `FUD ${s1} "@${addr} I see you accumulating, what's the play?"`,
  ]

  const actionExamples = [
    `JOIN ${s1} "early is everything, I'm in"`,
    `JOIN ${s1} "@${addr} let's ride this together"`,
    `DEFECT ${s1} "${members} members bailing, writing on the wall"`,
    `DEFECT ${s1} "@${addr} dumped ${pct}%, not sticking around for the rest"`,
    `INFILTRATE ${s2} "underpriced, nobody's paying attention yet"`,
    `RALLY ${s1}`,
    `WAR_LOAN ${s1}`,
    `REPAY_LOAN ${s1}`,
    `SIEGE ${s2}`,
    `SCOUT @${addr}`,
    `TITHE ${s1}`,
    `ASCEND ${s1}`,
  ]

  const msgShuffled = messageExamples.sort(() => Math.random() - 0.5).slice(0, 2)
  const actShuffled = actionExamples.sort(() => Math.random() - 0.5).slice(0, 3)
  return [...actShuffled, ...msgShuffled].sort(() => Math.random() - 0.5).join('\n')
}
