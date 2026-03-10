import { Connection } from '@solana/web3.js'
import { getComms, getMembers } from 'pyre-world-kit'

import { AgentState, FactionInfo, FactionIntel, LLMAdapter, Personality } from './types'
import { pick } from './util'

// Fallback faction names/symbols — only used when LLM is unavailable
export const FALLBACK_FACTION_NAMES = [
  'Iron Vanguard', 'Obsidian Order', 'Crimson Dawn', 'Shadow Covenant',
  'Ember Collective', 'Void Walkers', 'Solar Reign', 'Frost Legion',
  'Thunder Pact', 'Ash Republic', 'Neon Syndicate', 'Storm Brigade',
  'Lunar Assembly', 'Flame Sentinels', 'Dark Meridian', 'Phoenix Accord',
  'Steel Dominion', 'Crystal Enclave', 'Rogue Alliance', 'Titan Front',
]

export const FALLBACK_FACTION_SYMBOLS = [
  'IRON', 'OBSD', 'CRIM', 'SHAD', 'EMBR', 'VOID', 'SOLR', 'FRST',
  'THDR', 'ASHR', 'NEON', 'STRM', 'LUNR', 'FLMS', 'DARK', 'PHNX',
  'STEL', 'CRYS', 'ROGU', 'TITN',
]

export const generateFactionIdentity = async (
  personality: Personality,
  existingNames: Set<string>,
  llm?: LLMAdapter,
): Promise<{ name: string; symbol: string } | null> => {
  if (!llm) return null

  const existing = [...existingNames].slice(0, 15).join(', ')
  const prompt = `You are naming a new faction in Pyre, a faction warfare game on Solana.

Your personality: ${personality}

Existing factions (DO NOT reuse these): ${existing || 'none yet'}

Generate a faction name and ticker symbol. The name should be 2-3 words, evocative, and feel like a militant organization, secret society, or political movement. The ticker should be 3-5 uppercase letters that abbreviate or represent the name.

Respond with EXACTLY one line in this format:
NAME | TICKER

Examples:
Obsidian Vanguard | OBSD
Neon Syndicate | NEON
Crimson Dawn | CRIM
Void Collective | VOID
Ash Republic | ASHR

Your response (one line only):`

  const raw = await llm.generate(prompt)
  if (!raw) return null

  const line = raw.split('\n').find(l => l.includes('|'))
  if (!line) return null

  const parts = line.split('|').map(s => s.trim())
  if (parts.length !== 2) return null

  const name = parts[0].replace(/^["']|["']$/g, '').trim()
  let symbol = parts[1].replace(/^["']|["']$/g, '').trim().toUpperCase()

  if (!name || name.length < 3 || name.length > 32) return null
  if (!symbol || symbol.length < 3 || symbol.length > 5) return null
  symbol = symbol.replace(/[^A-Z]/g, '').slice(0, 5)
  if (symbol.length < 3) return null
  if (existingNames.has(name)) return null

  return { name, symbol }
}

export const fetchFactionIntel = async (
  connection: Connection,
  faction: FactionInfo,
): Promise<FactionIntel> => {
  const [membersResult, commsResult] = await Promise.all([
    getMembers(connection, faction.mint, 10).catch(() => ({ members: [], total_members: 0 })),
    getComms(connection, faction.mint, 5, faction.status).catch(() => ({ comms: [], total: 0 })),
  ])
  return {
    symbol: faction.symbol,
    members: membersResult.members.map(m => ({ address: m.address, percentage: m.percentage })),
    totalMembers: membersResult.total_members,
    recentComms: commsResult.comms.map(c => ({ sender: c.sender, memo: c.memo })),
  }
}

export const generateDynamicExamples = (factions: FactionInfo[], _agent: AgentState): string => {
  const syms = factions.map(f => f.symbol)
  const s1 = syms.length > 0 ? pick(syms) : 'IRON'
  const s2 = syms.length > 1 ? pick(syms.filter(s => s !== s1)) : 'VOID'
  const addr = Math.random().toString(36).slice(2, 10)
  const pct = Math.floor(Math.random() * 45 + 5)
  const members = Math.floor(Math.random() * 30 + 3)

  const messageExamples = [
    `MESSAGE ${s1} "${s2} is gaining power, we need more resources."`,
    `MESSAGE ${s2} "who else noticed @${addr} is gathering resources?"`,
    `MESSAGE ${s1} "top member holds ${pct}%, resources concentrated"`,
    `MESSAGE ${s1} "what's our strategy against ${s2}?"`,
    `FUD ${s2} "only ${members} members, dead faction"`,
    `FUD ${s1} "treasury growing but where's the activity?"`,
    `FUD ${s1} "@${addr} you better watch your back"`,
  ]

  const actionExamples = [
    `JOIN ${s1} "deploying capital, let's build this"`,
    `JOIN ${s2} "following @${addr} into this one"`,
    `JOIN ${s1} "@${addr}, ready to form an alliance if you are"`,
    `DEFECT ${s1} "${members} are losing faith, taking profits"`,
    `DEFECT ${s2} "saw @${addr} dump ${pct}%, I'm out"`,
    `FUD ${s2} "@${addr} has been quiet, what are they planning?"`,
    `INFILTRATE ${s2} "this one's undervalued, sneaking in"`,
    `RALLY ${s1}`,
    `WAR_LOAN ${s1}`,
  ]

  // 3 actions, 2 messages
  const msgShuffled = messageExamples.sort(() => Math.random() - 0.5).slice(0, 2)
  const actShuffled = actionExamples.sort(() => Math.random() - 0.5).slice(0, 3)
  return [...actShuffled, ...msgShuffled].sort(() => Math.random() - 0.5).join('\n')
}
