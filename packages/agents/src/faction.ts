import { Connection } from '@solana/web3.js';
import { getComms, getMembers } from 'pyre-world-kit';

import { ollamaGenerate } from './agent'
import { NETWORK } from './config'
import { AgentState, FactionInfo, FactionIntel, Personality } from './types'
import { pick } from './util';

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

/**
 * Ask the LLM to generate a unique faction name + 3-5 char ticker.
 * Returns { name, symbol } or null on failure.
 */
export const generateFactionIdentity = async (
  personality: Personality,
  existingNames: Set<string>,
  llmAvailable: boolean
): Promise<{ name: string; symbol: string } | null> => {
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

  const raw = await ollamaGenerate(prompt, llmAvailable)
  if (!raw) return null

  // Parse "Name | TICKER" format
  const line = raw.split('\n').find(l => l.includes('|'))
  if (!line) return null

  const parts = line.split('|').map(s => s.trim())
  if (parts.length !== 2) return null

  const name = parts[0].replace(/^["']|["']$/g, '').trim()
  let symbol = parts[1].replace(/^["']|["']$/g, '').trim().toUpperCase()

  // Validate
  if (!name || name.length < 3 || name.length > 32) return null
  if (!symbol || symbol.length < 3 || symbol.length > 5) return null
  // Strip non-alpha chars from symbol
  symbol = symbol.replace(/[^A-Z]/g, '').slice(0, 5)
  if (symbol.length < 3) return null
  // Don't reuse names
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

/**
 * Generate an image prompt for a faction via LLM (or fallback).
 * Returns a short descriptive prompt suitable for Pollinations.ai.
 */
export const generateImagePrompt = async (
  name: string,
  personality: Personality,
  llmAvailable: boolean,
): Promise<string> => {
  const prompt = `Generate a short image description (1 sentence, under 20 words) for a faction emblem/logo.

Faction name: "${name}"
Style: dark fantasy, militant, iconic symbol, no text, simple background

Your response (one sentence only):`

  const raw = await ollamaGenerate(prompt, llmAvailable)
  if (raw) {
    const line = raw.split('\n').find(l => l.trim().length > 10)
    if (line) return line.trim().replace(/^["']|["']$/g, '')
  }

  // Fallback: deterministic prompt from name
  return `dark fantasy faction emblem for ${name}, iconic militant symbol, simple background, no text`
}

export const generateDynamicExamples = (factions: FactionInfo[], agent: AgentState): string => {
  const syms = factions.map(f => f.symbol)
  const s1 = syms.length > 0 ? pick(syms) : 'IRON'
  const s2 = syms.length > 1 ? pick(syms.filter(s => s !== s1)) : 'VOID'
  const addr = Math.random().toString(36).slice(2, 10)
  const pct = Math.floor(Math.random() * 45 + 5)
  const members = Math.floor(Math.random() * 30 + 3)

  // Pool of comms-only examples
  const messageExamples = [
    `MESSAGE ${s1} "${s2} is gaining power, we need more resources."`,
    `MESSAGE ${s2} "who else noticed @${addr} is gathering resources?"`,
    `MESSAGE ${s1} "top member holds ${pct}%, resources concentrated"`,
    `MESSAGE ${s1} "what's our strategy against ${s2}?"`,
    `FUD ${s2} "only ${members} members, dead faction"`,
    `FUD ${s1} "treasury growing but where's the activity?"`,
  ]

  // Pool of action+message examples (the LLM should prefer these)
  const actionExamples = NETWORK === 'mainnet' ? [
    `JOIN ${s1} "heard good things, scouting this one"`,
    `DEFECT ${s2} "time to explore elsewhere"`,
    `FUD ${s2} "@${addr} has been quiet, what are they planning?"`,
  ] : [
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

  // Devnet: action-heavy with some comms (3 actions, 2 messages). Mainnet: comms-heavy (4 messages, 1 action).
  const msgCount = NETWORK === 'mainnet' ? 4 : 2
  const actCount = NETWORK === 'mainnet' ? 1 : 3
  const msgShuffled = messageExamples.sort(() => Math.random() - 0.5).slice(0, msgCount)
  const actShuffled = actionExamples.sort(() => Math.random() - 0.5).slice(0, actCount)
  return [...actShuffled, ...msgShuffled].sort(() => Math.random() - 0.5).join('\n')
}
