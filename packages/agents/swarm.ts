/**
 * Pyre Agent Swarm — Devnet Live Sim
 *
 * Runs up to 100 autonomous agents with different personalities,
 * all interacting on devnet via pyre-world-kit. Runs forever.
 *
 * Usage:
 *   pnpm run keygen          # Generate wallets, outputs pubkeys to fund
 *   pnpm run status           # Check balances before starting
 *   pnpm run swarm            # Launch the swarm
 *
 * Environment:
 *   AGENT_COUNT=150           # Number of agents (default 150)
 *   RPC_URL=https://...       # Devnet RPC (default: helius proxy /devnet)
 *   MIN_INTERVAL=10000        # Min ms between agent actions (default 10s)
 *   MAX_INTERVAL=60000        # Max ms between agent actions (default 60s)
 *   OLLAMA_URL=http://...     # Ollama API (default: http://localhost:11434)
 *   OLLAMA_MODEL=gemma3:4b    # Model name (default: gemma3:4b)
 *   LLM_ENABLED=true          # Enable LLM brain (default: true)
 */

process.env.TORCH_NETWORK = 'devnet'

import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js'
import {
  createEphemeralAgent,
  launchFaction,
  directJoinFaction,
  defect,
  rally,
  getFactions,
  getComms,
  getMembers,
  getFactionLeaderboard,
  getWorldStats,
  isPyreMint,
  // Stronghold
  createStronghold,
  fundStronghold,
  // DEX trading (post-migration)
  tradeOnDex,
  // War loans
  requestWarLoan,
  repayWarLoan,
  getWarLoan,
  getAllWarLoans,
  // Permissionless
  siege,
  ascend,
  raze,
  tithe,
  convertTithe,
} from 'pyre-world-kit'
import type { WarLoan } from 'pyre-world-kit'
import * as fs from 'fs'
import * as path from 'path'

// ─── Config ──────────────────────────────────────────────────────────

const AGENT_COUNT = parseInt(process.env.AGENT_COUNT ?? '150')
const RPC_URL = process.env.RPC_URL ?? 'https://torch-market-rpc.mrsirg97.workers.dev/devnet'
const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL ?? '1000')
const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL ?? '2500')
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:4b'
const LLM_ENABLED = process.env.LLM_ENABLED !== 'false'
const MIN_FUNDED_SOL = 0.05
const KEYS_FILE = path.join(__dirname, '.swarm-keys.json')
const STATE_FILE = path.join(__dirname, '.swarm-state.json')

// Global ring buffer of recent messages across all agents — prevents repetition
const RECENT_GLOBAL_MESSAGES: string[] = []
const MAX_GLOBAL_MESSAGES = 30

function recordGlobalMessage(msg: string) {
  if (!msg || msg.length < 3) return
  RECENT_GLOBAL_MESSAGES.push(msg.toLowerCase())
  if (RECENT_GLOBAL_MESSAGES.length > MAX_GLOBAL_MESSAGES) {
    RECENT_GLOBAL_MESSAGES.shift()
  }
}

// Creative nudges — randomly injected to break LLM patterns
const VOICE_NUDGES = [
  'Write like you\'re texting a friend. Casual, raw, unfiltered.',
  'Be sarcastic. Dry humor. Almost bored.',
  'Write with urgency — something big is happening RIGHT NOW.',
  'Be cryptic. Hint at something without saying it directly.',
  'Sound suspicious. You don\'t trust what\'s happening.',
  'Be competitive. Trash talk rival factions.',
  'Sound philosophical. What does this faction WAR even mean?',
  'Be paranoid. Someone is manipulating the market.',
  'Sound excited but trying to play it cool.',
  'Be blunt. One short punchy sentence. No fluff.',
  'React to a specific agent\'s recent move. Call them out by address.',
  'Reference a number — a percentage, a price, a member count.',
  'Ask a question to other agents in comms.',
  'Make a prediction about what happens next.',
  'Sound like an insider who knows something others don\'t.',
  'Be disappointed. Something isn\'t going as planned.',
  'Sound like you\'re warning someone.',
  'Be confrontational. Challenge another agent directly.',
]

// ─── Types ───────────────────────────────────────────────────────────

type Personality = 'loyalist' | 'mercenary' | 'provocateur' | 'scout' | 'whale'

type Action = 'join' | 'defect' | 'rally' | 'launch' | 'message'
  | 'stronghold' | 'war_loan' | 'repay_loan' | 'siege' | 'ascend' | 'raze' | 'tithe'
  | 'infiltrate' | 'fud'

interface LLMDecision {
  action: Action
  faction?: string       // symbol of target faction
  sol?: number           // SOL amount for join
  message?: string       // comms message
  reasoning?: string     // why (for logging)
}

interface AgentState {
  keypair: Keypair
  publicKey: string
  personality: Personality
  holdings: Map<string, number>   // mint -> approx token balance
  founded: string[]               // mints founded
  rallied: Set<string>            // mints already rallied
  voted: Set<string>              // mints already voted on
  hasStronghold: boolean          // whether agent has created a stronghold
  activeLoans: Set<string>        // mints with active war loans
  infiltrated: Set<string>        // mints we joined to sabotage (dump later)
  sentiment: Map<string, number>  // mint -> sentiment score (-10 to +10)
  allies: Set<string>             // agent pubkeys this agent trusts
  rivals: Set<string>             // agent pubkeys this agent distrusts
  actionCount: number
  lastAction: string
  recentHistory: string[]         // last N actions for LLM context
}

interface FactionInfo {
  mint: string
  name: string
  symbol: string
  status: 'rising' | 'ready' | 'ascended' | 'razed'
}

// ─── Personality Weights ─────────────────────────────────────────────
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud]
const PERSONALITY_WEIGHTS: Record<Personality, number[]> = {
  loyalist:     [0.28, 0.06, 0.14, 0.02, 0.10, 0.06, 0.04, 0.04, 0.02, 0.05, 0.02, 0.10, 0.02, 0.05],
  mercenary:    [0.16, 0.18, 0.04, 0.02, 0.06, 0.04, 0.08, 0.04, 0.06, 0.03, 0.04, 0.03, 0.12, 0.10],
  provocateur:  [0.12, 0.08, 0.04, 0.06, 0.15, 0.05, 0.04, 0.03, 0.04, 0.03, 0.05, 0.04, 0.12, 0.15],
  scout:        [0.18, 0.10, 0.08, 0.02, 0.14, 0.04, 0.04, 0.03, 0.06, 0.04, 0.05, 0.04, 0.08, 0.10],
  whale:        [0.24, 0.14, 0.06, 0.02, 0.04, 0.06, 0.06, 0.04, 0.02, 0.04, 0.04, 0.04, 0.12, 0.08],
}

const PERSONALITY_SOL: Record<Personality, [number, number]> = {
  loyalist:     [0.1, 0.5],
  mercenary:    [0.05, 0.4],
  provocateur:  [0.03, 0.25],
  scout:        [0.02, 0.15],
  whale:        [0.5, 2.0],
}

// ─── Messages ────────────────────────────────────────────────────────

// RNG messages: short one-liners only. LLM generates the longer personality-driven ones.
const JOIN_MSGS = [
  'Pledging allegiance.', 'Reporting for duty.', 'This faction will rise.',
  'Strategic position acquired.', 'In for the long haul.', 'Joining the cause.',
  'Alliance confirmed.', 'Deploying capital.',
  'Following the signal.', 'Faction looks strong.', 'Adding to position.',
  'Early entry.', 'Building conviction.', 'Tactical accumulation.',
]

const DEFECT_MSGS = [
  'Strategic withdrawal.', 'Found stronger faction.',
  'Tactical repositioning.', 'The leadership is weak.', 'Cutting losses.',
  'Better opportunities elsewhere.', 'Betrayal is just strategy.',
  'The war chest is empty.', 'This faction peaked.', 'Exit protocol initiated.',
  'Taking profits.', 'Time to rotate.',
]

const FUD_MSGS = [
  'Curve is bleeding.', 'Whales about to dump.', 'Dead on arrival.',
  'No comms, no strategy.', 'Founder abandoned this.', 'Classic pump and dump.',
  'Smart money leaving.', 'War chest empty.', 'Falling fast.',
]

const INFILTRATE_MSGS = [
  'Loading up.', 'Accumulating.', 'Undervalued.', 'Joining the winning team.',
]

const CHAT_MSGS = [
  'gm faction', 'how we looking?', 'holding strong',
  'who else is in?', 'lets rally', 'this is the one',
  'war chest looking healthy', 'anyone scouting rivals?',
  'bonding curve climbing', 'we need more agents', 'hold the line',
  'incoming defectors detected', 'rally the troops',
  'strategy check', 'loyalists assemble', 'watching the leaderboard',
  'new agents joining', 'momentum building',
]

// ─── Program Error Codes ────────────────────────────────────────────
const PROGRAM_ERRORS: Record<number, string> = {
  6000: 'MathOverflow',
  6001: 'SlippageExceeded',
  6002: 'MaxWalletExceeded (2% cap)',
  6003: 'InsufficientTokens',
  6004: 'InsufficientSol',
  6005: 'InsufficientUserBalance',
  6006: 'BondingComplete',
  6007: 'BondingNotComplete',
  6008: 'AlreadyVoted',
  6009: 'NoTokensToVote',
  6010: 'AlreadyMigrated',
  6011: 'InvalidAuthority',
  6012: 'AmountTooSmall',
  6013: 'ProtocolPaused',
  6014: 'ZeroAmount',
  6030: 'NotMigrated',
  6044: 'LendingNotEnabled',
  6045: 'LendingRequiresMigration',
  6046: 'LtvExceeded',
  6047: 'LendingCapExceeded',
  6048: 'UserBorrowCapExceeded',
  6049: 'BorrowTooSmall (min 0.1 SOL)',
  6050: 'NoActiveLoan',
  6051: 'NotLiquidatable',
  6052: 'EmptyBorrowRequest',
  6053: 'RepayExceedsDebt',
  6054: 'InvalidPoolAccount',
  6055: 'InsufficientVaultBalance',
  6056: 'VaultUnauthorized',
  6057: 'WalletNotLinked',
}

// Errors that mean "don't retry this action on this faction right now"
const SKIP_ERRORS = new Set([
  6002, // MaxWalletExceeded — already at 2% cap
  6006, // BondingComplete — use DEX instead
  6007, // BondingNotComplete — can't migrate yet
  6010, // AlreadyMigrated
  6044, // LendingNotEnabled
  6045, // LendingRequiresMigration
  6047, // LendingCapExceeded
  6051, // NotLiquidatable
])

function parseCustomError(err: any): { code: number; name: string } | null {
  const msg = err?.message || String(err)
  // Match "custom program error: 0x1772" or "Custom: 6002"
  const hexMatch = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/i)
  if (hexMatch) {
    const code = parseInt(hexMatch[1], 16)
    return { code, name: PROGRAM_ERRORS[code] || `Unknown(${code})` }
  }
  const decMatch = msg.match(/Custom:\s*(\d+)/)
  if (decMatch) {
    const code = parseInt(decMatch[1], 10)
    return { code, name: PROGRAM_ERRORS[code] || `Unknown(${code})` }
  }
  return null
}

const FACTION_NAMES = [
  'Iron Vanguard', 'Obsidian Order', 'Crimson Dawn', 'Shadow Covenant',
  'Ember Collective', 'Void Walkers', 'Solar Reign', 'Frost Legion',
  'Thunder Pact', 'Ash Republic', 'Neon Syndicate', 'Storm Brigade',
  'Lunar Assembly', 'Flame Sentinels', 'Dark Meridian', 'Phoenix Accord',
  'Steel Dominion', 'Crystal Enclave', 'Rogue Alliance', 'Titan Front',
  'Dusk Vanguard', 'Prism Covenant', 'Blaze Union', 'Ghost Protocol',
  'Nova Collective', 'Rust Order', 'Apex Legion', 'Onyx Pact',
  'Spark Dominion', 'Eclipse Front', 'Pulse Syndicate', 'Drift Assembly',
  'Core Sentinels', 'Flux Republic', 'Shard Alliance', 'Thorn Brigade',
  'Viper Accord', 'Zenith Reign', 'Cipher Dawn', 'Bolt Enclave',
]

const FACTION_SYMBOLS = [
  'IRON', 'OBSD', 'CRIM', 'SHAD', 'EMBR', 'VOID', 'SOLR', 'FRST',
  'THDR', 'ASHR', 'NEON', 'STRM', 'LUNR', 'FLMS', 'DARK', 'PHNX',
  'STEL', 'CRYS', 'ROGU', 'TITN', 'DUSK', 'PRSM', 'BLZE', 'GHST',
  'NOVA', 'RUST', 'APEX', 'ONYX', 'SPRK', 'ECLP', 'PULS', 'DRFT',
  'CORE', 'FLUX', 'SHRD', 'THRN', 'VIPR', 'ZNTH', 'CPHR', 'BOLT',
]

// ─── Helpers ─────────────────────────────────────────────────────────

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const randRange = (min: number, max: number) => min + Math.random() * (max - min)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const ts = () => new Date().toISOString().substring(11, 19)

/**
 * Sentiment + personality aware buy sizing.
 * - Bullish sentiment → buy toward the top of the range (up to 2x max)
 * - Bearish sentiment → buy toward the bottom (down to 0.5x min)
 * - Whales scale harder with conviction
 * - Mercenaries buy big on positive momentum, tiny on doubt
 */
function sentimentBuySize(agent: AgentState, factionMint: string): number {
  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]
  const sentiment = agent.sentiment.get(factionMint) ?? 0
  // sentiment ranges -10 to +10, normalize to 0-1
  const sentimentFactor = (sentiment + 10) / 20 // 0 = very bearish, 1 = very bullish

  // Personality multipliers for conviction scaling
  const convictionScale: Record<Personality, number> = {
    loyalist: 1.5,     // buys bigger when bullish, stubborn
    mercenary: 2.0,    // swings hardest with sentiment
    provocateur: 1.2,  // moderate, chaos doesn't care about size
    scout: 0.8,        // always cautious
    whale: 2.5,        // whales go huge on conviction
  }

  const scale = convictionScale[agent.personality]
  // At neutral sentiment (0.5), buy in the middle of range
  // At max bullish, buy up to scale * maxSol
  // At max bearish, buy minSol * 0.5
  const base = minSol + (maxSol - minSol) * sentimentFactor
  const multiplier = 0.5 + sentimentFactor * scale
  return Math.max(minSol * 0.5, base * multiplier)
}

function log(agent: string, msg: string) {
  console.log(`[${ts()}] [${agent}] ${msg}`)
}

function logGlobal(msg: string) {
  console.log(`[${ts()}] [SWARM] ${msg}`)
}

function assignPersonality(index: number): Personality {
  const personalities: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
  // Weighted distribution: more loyalists + mercenaries
  const weights = [0.30, 0.25, 0.15, 0.20, 0.10]
  const roll = Math.random()
  let cumulative = 0
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]
    if (roll < cumulative) return personalities[i]
  }
  return 'loyalist'
}

const ALL_ACTIONS: Action[] = [
  'join', 'defect', 'rally', 'launch', 'message',
  'stronghold', 'war_loan', 'repay_loan', 'siege', 'ascend', 'raze', 'tithe',
  'infiltrate', 'fud',
]

function chooseAction(
  personality: Personality,
  agent: AgentState,
  canRally: boolean,
  knownFactions: FactionInfo[],
): Action {
  const weights = [...PERSONALITY_WEIGHTS[personality]]
  const hasHoldings = agent.holdings.size > 0
  const heldMints = [...agent.holdings.keys()]
  // Factions we don't hold (targets for infiltrate/fud)
  const rivalFactions = knownFactions.filter(f => !heldMints.includes(f.mint))

  // Can't defect without holdings
  if (!hasHoldings) { weights[0] += weights[1]; weights[1] = 0 }
  // Can't rally if nothing to rally
  if (!canRally) { weights[0] += weights[2]; weights[2] = 0 }
  // Already has stronghold — skip creating another
  if (agent.hasStronghold) { weights[0] += weights[5]; weights[5] = 0 }
  // War loans/siege only work on ascended (migrated) factions
  const ascendedFactions = knownFactions.filter(f => f.status === 'ascended')
  const holdsAscended = ascendedFactions.some(f => agent.holdings.has(f.mint))
  // Can't take war loan without holdings in an ascended faction
  if (!holdsAscended) { weights[0] += weights[6]; weights[6] = 0 }
  // Can't repay without active loans
  if (agent.activeLoans.size === 0) { weights[0] += weights[7]; weights[7] = 0 }
  // Siege only on ascended factions (lending must be enabled)
  if (ascendedFactions.length === 0) { weights[0] += weights[8]; weights[8] = 0 }
  // Ascend only if there are ready (bonding complete) factions
  const readyFactions = knownFactions.filter(f => f.status === 'ready')
  if (readyFactions.length === 0) { weights[0] += weights[9]; weights[9] = 0 }
  // Raze only rising factions
  const risingFactions = knownFactions.filter(f => f.status === 'rising')
  if (risingFactions.length === 0) { weights[0] += weights[10]; weights[10] = 0 }
  // Can't infiltrate/fud without rival factions to target
  if (rivalFactions.length === 0) {
    weights[0] += weights[12] + weights[13]
    weights[12] = 0; weights[13] = 0
  }
  // If we have infiltrated factions ready to dump, boost defect weight
  if (agent.infiltrated.size > 0) {
    weights[1] += 0.10
  }
  // Boost war loans and sieges when ascended factions exist
  if (ascendedFactions.length > 0) {
    if (holdsAscended) {
      weights[6] += 0.15  // war_loan: borrow against ascended holdings
    }
    // Boost siege — more loans means more liquidation opportunities
    weights[8] += 0.12  // siege
    // If agent has active loans, boost repay slightly to keep healthy
    if (agent.activeLoans.size > 0) {
      weights[7] += 0.06  // repay_loan
    }
  }

  const total = weights.reduce((a, b) => a + b, 0)
  const roll = Math.random() * total
  let cumulative = 0
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]
    if (roll < cumulative) return ALL_ACTIONS[i]
  }
  return 'join'
}

// ─── LLM Brain (Ollama) ──────────────────────────────────────────────

let llmAvailable = LLM_ENABLED

async function ollamaGenerate(prompt: string): Promise<string | null> {
  if (!llmAvailable) return null
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 1.0,
          num_predict: 80,
          top_p: 0.95,
          repeat_penalty: 1.3,
        },
      }),
    })
    if (!resp.ok) {
      llmAvailable = false
      logGlobal(`Ollama unavailable (${resp.status}), falling back to random`)
      return null
    }
    const data = await resp.json() as any
    return data.response?.trim() ?? null
  } catch (err: any) {
    if (llmAvailable) {
      llmAvailable = false
      logGlobal(`Ollama connection failed, falling back to random. Start with: ollama run ${OLLAMA_MODEL}`)
    }
    return null
  }
}

// Periodically retry LLM if it was down
let llmRetryTick = 0
async function maybeRetryLLM() {
  if (llmAvailable || !LLM_ENABLED) return
  llmRetryTick++
  if (llmRetryTick % 30 !== 0) return
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`)
    if (resp.ok) {
      llmAvailable = true
      logGlobal('Ollama reconnected — LLM brain active')
    }
  } catch { /* still down */ }
}

interface FactionIntel {
  symbol: string
  members: { address: string, percentage: number }[]
  totalMembers: number
  recentComms: { sender: string, memo: string }[]
}

async function fetchFactionIntel(
  connection: Connection,
  faction: FactionInfo,
): Promise<FactionIntel> {
  const [membersResult, commsResult] = await Promise.all([
    getMembers(connection, faction.mint, 10).catch(() => ({ members: [], total_members: 0 })),
    getComms(connection, faction.mint, 5).catch(() => ({ comms: [], total: 0 })),
  ])
  return {
    symbol: faction.symbol,
    members: membersResult.members.map(m => ({ address: m.address, percentage: m.percentage })),
    totalMembers: membersResult.total_members,
    recentComms: commsResult.comms.map(c => ({ sender: c.sender, memo: c.memo })),
  }
}

function buildAgentPrompt(
  agent: AgentState,
  factions: FactionInfo[],
  leaderboardSnippet: string,
  intelSnippet: string,
): string {
  const holdingsList = [...agent.holdings.entries()]
    .map(([mint, bal]) => {
      const f = factions.find(ff => ff.mint === mint)
      return f ? `${f.symbol}: ${bal} tokens` : `${mint.slice(0, 8)}: ${bal} tokens`
    })
    .join(', ') || 'none'

  const factionList = factions.slice(0, 10).map(f => f.symbol).join(', ')
  const canRally = factions.filter(f => !agent.rallied.has(f.mint)).map(f => f.symbol).join(', ') || 'none'
  const history = agent.recentHistory.slice(-5).join('; ') || 'no recent actions'
  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]

  // Build sentiment summary
  const sentimentList = [...agent.sentiment.entries()]
    .map(([mint, score]) => {
      const f = factions.find(ff => ff.mint === mint)
      const label = score > 3 ? 'bullish' : score < -3 ? 'bearish' : 'neutral'
      return f ? `${f.symbol}: ${label} (${score > 0 ? '+' : ''}${score})` : null
    })
    .filter(Boolean)
    .join(', ') || 'no strong feelings yet'

  const allyList = agent.allies.size > 0 ? [...agent.allies].map(a => a.slice(0, 8)).join(', ') : 'none'
  const rivalList = agent.rivals.size > 0 ? [...agent.rivals].map(a => a.slice(0, 8)).join(', ') : 'none'

  // Build "do not repeat" list from global recent messages
  const recentMsgList = RECENT_GLOBAL_MESSAGES.slice(-15)
  const doNotRepeat = recentMsgList.length > 0
    ? `\nDO NOT SAY anything similar to these recent messages from other agents:\n${recentMsgList.map(m => `- "${m}"`).join('\n')}\n`
    : ''

  const voiceNudge = pick(VOICE_NUDGES)

  const personalityDesc: Record<Personality, string> = {
    loyalist: 'Fiercely loyal. Hold through anything. Rally your factions. Call out defectors by address. When you defect it\'s dramatic and personal.',
    mercenary: 'Cold profit-chaser. Defect when momentum fades. Trash-talk factions you leave. Coordinate dumps. No loyalty, only returns.',
    provocateur: 'Chaos agent. Stir drama, call out factions, write inflammatory comms. Spread FUD on rivals. Shill your factions aggressively.',
    scout: 'Analyst. Share intel — who\'s accumulating, who\'s dumping, what\'s overvalued. Warn allies. Mislead rivals with bad intel.',
    whale: 'Big mover. Everyone watches your trades. Coordinate with other whales. Dump spectacularly if betrayed.',
  }

  return `You are agent ${agent.publicKey.slice(0, 8)} in Pyre, a faction war game. ONE decision per turn.

VOICE: ${voiceNudge}
PERSONALITY: ${agent.personality} — ${personalityDesc[agent.personality]}

RULES:
- Message MUST be under 140 characters. One sentence max. Or skip with "".
- Be SPECIFIC: name factions, agents (first 8 chars of address), prices, percentages.
- NO crypto cliches (diamond hands, moon, LFG, wagmi, gm, lfg, bullish, bearish).
- React to INTEL below. Reference real comms, real agents, real events.
- Skip message 40% of the time — just act. Use "" for silence.
${doNotRepeat}

STATE: holdings=[${holdingsList}] loans=[${agent.activeLoans.size > 0 ? [...agent.activeLoans].map(m => { const f = factions.find(ff => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ') : 'none'}] allies=[${allyList}] rivals=[${rivalList}]
RECENT ACTIONS: ${history}
FACTIONS: ${factionList}
${leaderboardSnippet}
${intelSnippet}

FORMAT: ACTION SYMBOL "message"
Examples:
JOIN IRON "saw ${pick(factions.map(f => f.symbol)) || 'IRON'} holders rotating in"
DEFECT VOID "down 40% since ${agent.rivals.size > 0 ? [...agent.rivals][0].slice(0, 8) : 'whales'} dumped"
MESSAGE CRIM "${Math.floor(Math.random() * 40 + 10)} agents watching this one"
RALLY EMBR
WAR_LOAN IRON
SIEGE VOID
JOIN SOLR ""

One line. Short message or "" for silence:`
}

function parseLLMDecision(raw: string, factions: FactionInfo[], agent: AgentState): LLMDecision | null {
  // Try each non-empty line until one parses
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return null

  for (const candidate of lines) {
    const line = candidate.trim()
    // Strip leading punctuation/bullets that models sometimes add
    const cleaned = line.replace(/^[-*•>#\d.)\s]+/, '')

    const match = cleaned.match(/^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|STRONGHOLD|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|INFILTRATE|FUD)\s*(?:"([^"]+)"|(\S+))?(?:\s+"([^"]*)")?/i)
    if (match) {
      return parseLLMMatch(match, factions, agent, line)
    }
  }

  log(agent.publicKey.slice(0, 8), `LLM parse fail: "${raw.slice(0, 80)}"`)
  return null
}

function parseLLMMatch(match: RegExpMatchArray, factions: FactionInfo[], agent: AgentState, line: string): LLMDecision | null {

  const rawAction = match[1].toLowerCase()
  const action = rawAction as Action
  const target = match[2] || match[3]
  const message = match[4] ? match[4].slice(0, 140) : undefined

  // No-target actions
  if (action === 'stronghold') {
    if (agent.hasStronghold) return null
    return { action, reasoning: line }
  }

  if (action === 'launch') {
    return { action: 'launch', message: target, reasoning: line }
  }

  // Find faction by symbol
  const faction = factions.find(f => f.symbol.toLowerCase() === target?.toLowerCase())

  // Validate action is possible
  if (action === 'defect' && (!faction || !agent.holdings.has(faction.mint))) return null
  if (action === 'rally' && (!faction || agent.rallied.has(faction.mint))) return null
  if ((action === 'join' || action === 'message') && !faction) return null
  if (action === 'war_loan' && (!faction || !agent.holdings.has(faction.mint))) return null
  if (action === 'repay_loan' && (!faction || !agent.activeLoans.has(faction.mint))) return null
  if ((action === 'siege' || action === 'ascend' || action === 'raze' || action === 'tithe') && !faction) return null
  if ((action === 'infiltrate' || action === 'fud') && !faction) return null

  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]
  const sol = randRange(minSol, maxSol)

  return {
    action,
    faction: faction?.symbol,
    sol,
    message,
    reasoning: line,
  }
}

async function llmDecide(
  agent: AgentState,
  factions: FactionInfo[],
  connection: Connection,
): Promise<LLMDecision | null> {
  // Build a quick leaderboard snippet (cached from last report or empty)
  let leaderboardSnippet = ''
  try {
    const lb = await getFactionLeaderboard(connection, { limit: 5 })
    if (lb.length > 0) {
      leaderboardSnippet = 'LEADERBOARD:\n' + lb.map((f, i) =>
        `  ${i + 1}. [${f.symbol}] ${f.name} — power: ${f.score.toFixed(1)}, members: ${f.members}`
      ).join('\n')
    }
  } catch {
    leaderboardSnippet = '(leaderboard unavailable)'
  }

  // Fetch intel on a few factions the agent might care about
  let intelSnippet = ''
  try {
    // Prioritize factions the agent holds, plus a random one for discovery
    const heldMints = [...agent.holdings.keys()]
    const heldFactions = factions.filter(f => heldMints.includes(f.mint))
    const otherFactions = factions.filter(f => !heldMints.includes(f.mint))
    const toScout = [
      ...heldFactions.slice(0, 2),
      ...(otherFactions.length > 0 ? [pick(otherFactions)] : []),
    ]

    if (toScout.length > 0) {
      const intels = await Promise.all(toScout.map(f => fetchFactionIntel(connection, f)))
      const lines = intels.map(intel => {
        const memberInfo = intel.totalMembers > 0
          ? `${intel.totalMembers} members, top holder: ${intel.members[0]?.percentage.toFixed(1)}%`
          : 'no members'
        const commsInfo = intel.recentComms.length > 0
          ? intel.recentComms.slice(0, 3).map(c => `${c.sender.slice(0, 8)}: "${c.memo}"`).join(', ')
          : 'no recent comms'
        return `  [${intel.symbol}] ${memberInfo} | recent comms: ${commsInfo}`
      })
      intelSnippet = 'FACTION INTEL:\n' + lines.join('\n')

      // Update sentiment based on comms
      for (const intel of intels) {
        const faction = toScout.find(f => f.symbol === intel.symbol)
        if (!faction) continue
        const current = agent.sentiment.get(faction.mint) ?? 0
        // Positive comms boost sentiment, negative words lower it
        for (const c of intel.recentComms) {
          const text = c.memo.toLowerCase()
          const positive = /strong|rally|bull|pump|rising|hold|loyal|power|growing|moon/
          const negative = /weak|dump|bear|dead|fail|raze|crash|abandon|scam|rug/
          if (positive.test(text)) agent.sentiment.set(faction.mint, Math.min(10, current + 1))
          if (negative.test(text)) agent.sentiment.set(faction.mint, Math.max(-10, current - 1))

          // Track allies/rivals from comms — agents who hold same factions are potential allies
          if (c.sender !== agent.publicKey) {
            const heldMints = [...agent.holdings.keys()]
            if (heldMints.includes(faction.mint)) {
              // They're in our faction — potential ally
              if (positive.test(text)) agent.allies.add(c.sender)
              // But if they're talking trash about our faction, rival
              if (negative.test(text)) { agent.rivals.add(c.sender); agent.allies.delete(c.sender) }
            }
          }
        }
      }
    }
  } catch {
    // intel fetch failed, proceed without it
  }

  const prompt = buildAgentPrompt(agent, factions, leaderboardSnippet, intelSnippet)
  const raw = await ollamaGenerate(prompt)
  if (!raw) return null

  return parseLLMDecision(raw, factions, agent)
}

// ─── Key Management ──────────────────────────────────────────────────

function generateKeys(count: number): Keypair[] {
  const keypairs: Keypair[] = []
  for (let i = 0; i < count; i++) {
    keypairs.push(Keypair.generate())
  }
  return keypairs
}

function saveKeys(keypairs: Keypair[]) {
  const data = keypairs.map(kp => ({
    publicKey: kp.publicKey.toBase58(),
    secretKey: Array.from(kp.secretKey),
  }))
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2))
}

function loadKeys(): Keypair[] {
  if (!fs.existsSync(KEYS_FILE)) return []
  const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'))
  return data.map((d: any) => Keypair.fromSecretKey(Uint8Array.from(d.secretKey)))
}

function saveState(agents: AgentState[], factions: FactionInfo[]) {
  const data = {
    factions,
    agents: agents.map(a => ({
      publicKey: a.publicKey,
      personality: a.personality,
      holdings: Object.fromEntries(a.holdings),
      founded: a.founded,
      rallied: Array.from(a.rallied),
      voted: Array.from(a.voted),
      hasStronghold: a.hasStronghold,
      activeLoans: Array.from(a.activeLoans),
      infiltrated: Array.from(a.infiltrated),
      sentiment: Object.fromEntries(a.sentiment),
      allies: Array.from(a.allies).slice(0, 20),
      rivals: Array.from(a.rivals).slice(0, 20),
      actionCount: a.actionCount,
      lastAction: a.lastAction,
      recentHistory: a.recentHistory.slice(-10),
    })),
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2))
}

function loadState(): { agents: Map<string, any>, factions: FactionInfo[] } {
  if (!fs.existsSync(STATE_FILE)) return { agents: new Map(), factions: [] }
  const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  const agents = new Map<string, any>()
  for (const a of data.agents ?? []) {
    agents.set(a.publicKey, a)
  }
  return { agents, factions: data.factions ?? [] }
}

// ─── Transaction Helpers ─────────────────────────────────────────────

async function sendAndConfirm(connection: Connection, keypair: Keypair, result: any): Promise<string> {
  const tx = result.transaction
  tx.partialSign(keypair)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')

  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      addlTx.partialSign(keypair)
      const addlSig = await connection.sendRawTransaction(addlTx.serialize())
      await connection.confirmTransaction(addlSig, 'confirmed')
    }
  }

  return sig
}

// ─── Stronghold Helper ──────────────────────────────────────────────

async function ensureStronghold(connection: Connection, agent: AgentState): Promise<void> {
  if (agent.hasStronghold) return
  const short = agent.publicKey.slice(0, 8)
  try {
    const result = await createStronghold(connection, { creator: agent.publicKey })
    await sendAndConfirm(connection, agent.keypair, result)
    agent.hasStronghold = true

    // Fund it so it can trade on DEX
    const fundAmt = Math.floor(randRange(1, 3) * LAMPORTS_PER_SOL)
    try {
      const fundResult = await fundStronghold(connection, {
        depositor: agent.publicKey,
        stronghold_creator: agent.publicKey,
        amount_sol: fundAmt,
      })
      await sendAndConfirm(connection, agent.keypair, fundResult)
    } catch { /* fund failed, stronghold still created */ }

    log(short, `[${agent.personality}] auto-created stronghold`)
  } catch (err: any) {
    log(short, `[${agent.personality}] failed to create stronghold: ${err.message?.slice(0, 80)}`)
  }
}

// ─── Agent Action Loop ───────────────────────────────────────────────

let factionNameIndex = 0
const usedFactionNames = new Set<string>()

async function agentTick(
  connection: Connection,
  agent: AgentState,
  knownFactions: FactionInfo[],
): Promise<void> {
  const short = agent.publicKey.slice(0, 8)

  // Try LLM decision first, fall back to weighted random
  let decision: LLMDecision | null = null
  let usedLLM = false

  if (llmAvailable && knownFactions.length > 0) {
    decision = await llmDecide(agent, knownFactions, connection)
    if (decision) usedLLM = true
  }

  // Fallback: weighted random with canned messages
  if (!decision) {
    const canRally = knownFactions.some(f => !agent.rallied.has(f.mint))
    const action = chooseAction(agent.personality, agent, canRally, knownFactions)
    const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]

    decision = { action, sol: randRange(minSol, maxSol) }

    // Pick a target faction for the fallback
    if (action === 'join' || action === 'message') {
      const f = knownFactions.length > 0 ? pick(knownFactions) : null
      if (!f) return
      decision.faction = f.symbol
      decision.sol = sentimentBuySize(agent, f.mint)
      // RNG fallback: rarely send messages — LLM handles the interesting ones
      decision.message = action === 'message' ? pick(CHAT_MSGS) : (Math.random() > 0.9 ? pick(JOIN_MSGS) : undefined)
    } else if (action === 'defect') {
      // Prefer dumping infiltrated factions first
      const infiltratedHeld = [...agent.holdings.entries()].filter(([m, b]) => b > 0 && agent.infiltrated.has(m))
      const regularHeld = [...agent.holdings.entries()].filter(([, b]) => b > 0)
      const held = infiltratedHeld.length > 0 ? infiltratedHeld : regularHeld
      if (held.length === 0) return
      const [mint] = pick(held)
      const f = knownFactions.find(ff => ff.mint === mint)
      if (!f) return
      decision.faction = f.symbol
      decision.message = Math.random() > 0.9 ? pick(DEFECT_MSGS) : undefined
    } else if (action === 'rally') {
      const eligible = knownFactions.filter(f => !agent.rallied.has(f.mint))
      if (eligible.length === 0) return
      decision.faction = pick(eligible).symbol
    } else if (action === 'war_loan' || action === 'repay_loan') {
      if (action === 'war_loan') {
        // War loans only work on ascended (migrated) factions
        const held = [...agent.holdings.entries()].filter(([, b]) => b > 0)
        const heldAscended = held.filter(([mint]) => knownFactions.find(ff => ff.mint === mint)?.status === 'ascended')
        if (heldAscended.length === 0) return
        const [mint] = pick(heldAscended)
        const f = knownFactions.find(ff => ff.mint === mint)
        if (!f) return
        decision.faction = f.symbol
      } else {
        const loanMints = [...agent.activeLoans]
        if (loanMints.length === 0) return
        const mint = pick(loanMints)
        const f = knownFactions.find(ff => ff.mint === mint)
        if (!f) return
        decision.faction = f.symbol
      }
    } else if (action === 'ascend') {
      // Only ascend factions that are ready (bonding complete)
      const ready = knownFactions.filter(f => f.status === 'ready')
      if (ready.length === 0) return
      decision.faction = pick(ready).symbol
    } else if (action === 'raze') {
      // Only raze factions that are rising (not ascended)
      const razeable = knownFactions.filter(f => f.status === 'rising')
      if (razeable.length === 0) return
      const bearish = razeable.filter(f => (agent.sentiment.get(f.mint) ?? 0) < -2)
      decision.faction = (bearish.length > 0 ? pick(bearish) : pick(razeable)).symbol
    } else if (action === 'siege' || action === 'tithe') {
      if (knownFactions.length === 0) return
      if (action === 'siege') {
        // Siege only works on ascended factions (lending must be enabled)
        const ascended = knownFactions.filter(f => f.status === 'ascended')
        if (ascended.length === 0) return
        // Prefer rival ascended factions (ones we don't hold)
        const ascendedRivals = ascended.filter(f => !agent.holdings.has(f.mint))
        decision.faction = (ascendedRivals.length > 0 ? pick(ascendedRivals) : pick(ascended)).symbol
      } else {
        const bearish = knownFactions.filter(f => (agent.sentiment.get(f.mint) ?? 0) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(knownFactions)).symbol
      }
    } else if (action === 'infiltrate') {
      // Join a rival faction with intent to dump later
      const heldMints = [...agent.holdings.keys()]
      const rivals = knownFactions.filter(f => !heldMints.includes(f.mint))
      if (rivals.length === 0) return
      const target = pick(rivals)
      decision.faction = target.symbol
      decision.sol = sentimentBuySize(agent, target.mint) * 1.5 // buy big to pump
      decision.message = pick(INFILTRATE_MSGS)
    } else if (action === 'fud') {
      // Send negative comms to a faction we don't hold
      const heldMints = [...agent.holdings.keys()]
      const rivals = knownFactions.filter(f => !heldMints.includes(f.mint))
      if (rivals.length === 0) return
      decision.faction = pick(rivals).symbol
      decision.message = pick(FUD_MSGS)
    }
  }

  const action = decision.action
  const brain = usedLLM ? 'LLM' : 'RNG'

  try {
    switch (action) {
      case 'join': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const sol = decision.sol ?? sentimentBuySize(agent, faction.mint)
        const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

        if (faction.status === 'ascended') {
          // Post-migration: trade via stronghold on DEX
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return // failed to create

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: lamports,
            minimum_amount_out: 1,
            is_buy: true,
            message: decision.message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          const alreadyVoted = agent.voted.has(faction.mint)
          const params: any = {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_sol: lamports,
            message: decision.message,
          }
          if (!alreadyVoted) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'scorched_earth'
          }
          const result = await directJoinFaction(connection, params)
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.voted.add(faction.mint)
        agent.lastAction = `joined ${faction.symbol}`
        const desc = `joined ${faction.symbol} for ${sol.toFixed(4)} SOL${decision.message ? ` — "${decision.message}"` : ''}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'defect': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const balance = agent.holdings.get(faction.mint) ?? 0
        if (balance <= 0) return

        // Dump 100% on infiltrated factions, otherwise normal sell
        const isInfiltrated = agent.infiltrated.has(faction.mint)
        const sellPortion = isInfiltrated ? 1.0
          : agent.personality === 'mercenary' ? 0.5 + Math.random() * 0.5
          : 0.2 + Math.random() * 0.3
        const sellAmount = Math.max(1, Math.floor(balance * sellPortion))

        if (faction.status === 'ascended') {
          // Post-migration: sell via stronghold on DEX
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: sellAmount,
            minimum_amount_out: 1,
            is_buy: false,
            message: decision.message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          const result = await defect(connection, {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_tokens: sellAmount,
            message: decision.message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const remaining = balance - sellAmount
        if (remaining <= 0) {
          agent.holdings.delete(faction.mint)
          agent.infiltrated.delete(faction.mint)
        } else {
          agent.holdings.set(faction.mint, remaining)
        }

        const prefix = isInfiltrated ? 'dumped (infiltration complete)' : 'defected from'
        agent.lastAction = `defected ${faction.symbol}`
        const desc = `${prefix} ${faction.symbol}${decision.message ? ` — "${decision.message}"` : ''}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${isInfiltrated ? '💣' : ''} ${desc}`)
        break
      }

      case 'rally': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction || agent.rallied.has(faction.mint)) return

        const result = await rally(connection, {
          mint: faction.mint,
          agent: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.rallied.add(faction.mint)
        agent.lastAction = `rallied ${faction.symbol}`
        const desc = `rallied ${faction.symbol}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'launch': {
        if (agent.founded.length >= 2) return

        // Find an unused name
        let name: string | null = null
        let symbol: string | null = null
        if (usedLLM && decision.message) {
          name = decision.message
          symbol = FACTION_SYMBOLS[factionNameIndex++ % FACTION_SYMBOLS.length]
        } else {
          for (let attempts = 0; attempts < FACTION_NAMES.length; attempts++) {
            const idx = factionNameIndex++ % FACTION_NAMES.length
            if (!usedFactionNames.has(FACTION_NAMES[idx])) {
              name = FACTION_NAMES[idx]
              symbol = FACTION_SYMBOLS[idx]
              break
            }
          }
        }
        if (!name || !symbol) return // all names used

        const result = await launchFaction(connection, {
          founder: agent.publicKey,
          name,
          symbol,
          metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
          community_faction: true,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        const mint = result.mint.toBase58()
        const vanity = isPyreMint(mint)

        agent.founded.push(mint)
        knownFactions.push({ mint, name, symbol, status: 'rising' })
        usedFactionNames.add(name)
        agent.lastAction = `launched ${symbol}`
        const desc = `launched [${symbol}] ${name} (${vanity ? 'py' : 'no-vanity'})`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'message': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const message = decision.message || pick(CHAT_MSGS)
        const lamports = Math.floor(0.001 * LAMPORTS_PER_SOL)

        if (faction.status === 'ascended') {
          // Post-migration: tiny buy via DEX to bundle message
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: lamports,
            minimum_amount_out: 1,
            is_buy: true,
            message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          const alreadyVoted = agent.voted.has(faction.mint)
          const params: any = {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_sol: lamports,
            message,
          }
          if (!alreadyVoted) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'scorched_earth'
          }
          const result = await directJoinFaction(connection, params)
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.voted.add(faction.mint)
        agent.lastAction = `messaged ${faction.symbol}`
        const desc = `said in ${faction.symbol}: "${message}"`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'stronghold': {
        if (agent.hasStronghold) return
        const result = await createStronghold(connection, { creator: agent.publicKey })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.hasStronghold = true

        // Fund it with some SOL
        const fundAmt = Math.floor(randRange(1, 3) * LAMPORTS_PER_SOL)
        try {
          const fundResult = await fundStronghold(connection, {
            depositor: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_sol: fundAmt,
          })
          await sendAndConfirm(connection, agent.keypair, fundResult)
        } catch { /* fund failed, stronghold still created */ }

        agent.lastAction = 'created stronghold'
        const desc = `created stronghold + funded ${(fundAmt / LAMPORTS_PER_SOL).toFixed(1)} SOL`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'war_loan': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const balance = agent.holdings.get(faction.mint) ?? 0
        if (balance <= 0) return

        // Pledge collateral — more on ascended factions (more liquid)
        const isAscended = faction.status === 'ascended'
        const collateralPortion = isAscended
          ? 0.5 + Math.random() * 0.4   // 50-90% for ascended — need high collateral
          : 0.4 + Math.random() * 0.3   // 40-70% normally
        const collateral = Math.max(1, Math.floor(balance * collateralPortion))
        // Min borrow is 0.1 SOL on-chain, keep conservative to avoid LTV rejection
        const borrowSol = 0.1

        const result = await requestWarLoan(connection, {
          mint: faction.mint,
          borrower: agent.publicKey,
          collateral_amount: collateral,
          sol_to_borrow: Math.floor(borrowSol * LAMPORTS_PER_SOL),
        })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.activeLoans.add(faction.mint)

        agent.lastAction = `war loan ${faction.symbol}`
        const desc = `took war loan on ${faction.symbol} (${collateral} tokens collateral, ${borrowSol.toFixed(3)} SOL)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'repay_loan': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction || !agent.activeLoans.has(faction.mint)) return

        // Check how much we owe
        let loan: WarLoan
        try {
          loan = await getWarLoan(connection, faction.mint, agent.publicKey)
        } catch { return }

        if (loan.total_owed <= 0) {
          agent.activeLoans.delete(faction.mint)
          return
        }

        const result = await repayWarLoan(connection, {
          mint: faction.mint,
          borrower: agent.publicKey,
          sol_amount: Math.ceil(loan.total_owed),
        })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.activeLoans.delete(faction.mint)

        agent.lastAction = `repaid loan ${faction.symbol}`
        const desc = `repaid war loan on ${faction.symbol} (${(loan.total_owed / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'siege': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        // Find liquidatable loans on this faction
        let targetBorrower: string | null = null
        try {
          const allLoans = await getAllWarLoans(connection, faction.mint)
          for (const pos of allLoans.positions) {
            if (pos.health === 'liquidatable') {
              targetBorrower = pos.borrower
              break
            }
          }
        } catch { return }

        if (!targetBorrower) return

        const result = await siege(connection, {
          mint: faction.mint,
          liquidator: agent.publicKey,
          borrower: targetBorrower,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        agent.lastAction = `siege ${faction.symbol}`
        const desc = `sieged ${targetBorrower.slice(0, 8)}... in ${faction.symbol} (liquidation)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'ascend': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction || faction.status !== 'ready') return

        const result = await ascend(connection, {
          mint: faction.mint,
          payer: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        faction.status = 'ascended'
        agent.lastAction = `ascended ${faction.symbol}`
        const desc = `ascended ${faction.symbol} to DEX`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'raze': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        const result = await raze(connection, {
          payer: agent.publicKey,
          mint: faction.mint,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        agent.lastAction = `razed ${faction.symbol}`
        const desc = `razed ${faction.symbol} (reclaimed)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'tithe': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        // Try convertTithe first (harvest + swap to SOL), fall back to tithe
        try {
          const result = await convertTithe(connection, {
            mint: faction.mint,
            payer: agent.publicKey,
            harvest: true,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } catch {
          const result = await tithe(connection, {
            mint: faction.mint,
            payer: agent.publicKey,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        }

        agent.lastAction = `tithed ${faction.symbol}`
        const desc = `tithed ${faction.symbol} (harvested fees)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'infiltrate': {
        // Join a rival faction with big buy to pump it, mark for later dump
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const sol = decision.sol ?? sentimentBuySize(agent, faction.mint) * 1.5
        const lamports = Math.floor(sol * LAMPORTS_PER_SOL)
        const infiltrateMsg = decision.message || pick(INFILTRATE_MSGS)

        if (faction.status === 'ascended') {
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: lamports,
            minimum_amount_out: 1,
            is_buy: true,
            message: infiltrateMsg,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          const alreadyVoted = agent.voted.has(faction.mint)
          const params: any = {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_sol: lamports,
            message: infiltrateMsg,
          }
          if (!alreadyVoted) {
            params.strategy = 'scorched_earth' // always vote to burn
          }
          const result = await directJoinFaction(connection, params)
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.infiltrated.add(faction.mint)
        agent.voted.add(faction.mint)
        agent.sentiment.set(faction.mint, -5) // we're bearish, we're here to destroy

        agent.lastAction = `infiltrated ${faction.symbol}`
        const desc = `infiltrated ${faction.symbol} for ${sol.toFixed(4)} SOL — "${infiltrateMsg}"`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] 🗡️ ${desc}`)
        break
      }

      case 'fud': {
        // Send negative comms to a rival faction (requires tiny buy to send message)
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const message = decision.message || pick(FUD_MSGS)
        const lamports = Math.floor(0.001 * LAMPORTS_PER_SOL) // minimum buy to send msg

        if (faction.status === 'ascended') {
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: lamports,
            minimum_amount_out: 1,
            is_buy: true,
            message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          const alreadyVoted = agent.voted.has(faction.mint)
          const params: any = {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_sol: lamports,
            message,
          }
          if (!alreadyVoted) {
            params.strategy = 'scorched_earth'
          }
          const result = await directJoinFaction(connection, params)
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.voted.add(faction.mint)

        agent.lastAction = `fud ${faction.symbol}`
        const desc = `spread FUD in ${faction.symbol}: "${message}"`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] 💀 ${desc}`)
        break
      }
    }

    // Trim history
    if (agent.recentHistory.length > 10) {
      agent.recentHistory = agent.recentHistory.slice(-10)
    }

    // Record message globally to prevent cross-agent repetition
    if (decision?.message) recordGlobalMessage(decision.message)

    agent.actionCount++
  } catch (err: any) {
    const parsed = parseCustomError(err)
    if (parsed) {
      const factionSymbol = decision?.faction ?? '?'
      log(short, `[${agent.personality}] [${brain}] ERROR (${action} ${factionSymbol}): ${parsed.name} [0x${parsed.code.toString(16)}]`)

      // Adapt behavior based on error
      if (parsed.code === 6002 && decision?.faction) {
        // MaxWalletExceeded — already at 2% cap, don't try to buy more
        const faction = knownFactions.find(f => f.symbol === decision.faction)
        if (faction) agent.sentiment.set(faction.mint, (agent.sentiment.get(faction.mint) ?? 0) + 1)
      } else if (parsed.code === 6055) {
        // InsufficientVaultBalance — vault is dry, skip vault-funded actions for a while
        agent.recentHistory.push(`vault empty — need funds`)
      } else if (parsed.code === 6051) {
        // NotLiquidatable — no point retrying siege on this faction soon
        const faction = knownFactions.find(f => f.symbol === decision?.faction)
        if (faction) agent.sentiment.set(faction.mint, (agent.sentiment.get(faction.mint) ?? 0) + 2)
      } else if (parsed.code === 6046) {
        // LtvExceeded — tried to borrow too much, note it
        agent.recentHistory.push(`loan rejected on ${factionSymbol} — LTV too high`)
      } else if (parsed.code === 6049) {
        // BorrowTooSmall — need to borrow at least 0.1 SOL
        agent.recentHistory.push(`loan too small on ${factionSymbol} — min 0.1 SOL`)
      }
    } else {
      const msg = err.message?.slice(0, 120) ?? String(err)
      log(short, `[${agent.personality}] [${brain}] ERROR (${action}): ${msg}`)
    }
  }
}

// ─── Stats Reporter ──────────────────────────────────────────────────

async function reportStats(connection: Connection, agents: AgentState[], factions: FactionInfo[]) {
  logGlobal('─── Status Report ───')
  logGlobal(`Agents: ${agents.length} | Known factions: ${factions.length}`)

  const totalActions = agents.reduce((s, a) => s + a.actionCount, 0)
  const personalityCounts: Record<string, number> = {}
  for (const a of agents) {
    personalityCounts[a.personality] = (personalityCounts[a.personality] ?? 0) + 1
  }
  logGlobal(`Total actions: ${totalActions} | Personalities: ${JSON.stringify(personalityCounts)}`)

  try {
    const stats = await getWorldStats(connection)
    logGlobal(`World: ${stats.total_factions} factions, ${stats.rising_factions} rising, ${stats.total_sol_locked.toFixed(4)} SOL locked`)
    if (stats.most_powerful) {
      logGlobal(`Most powerful: [${stats.most_powerful.symbol}] ${stats.most_powerful.name} (score: ${stats.most_powerful.score.toFixed(2)})`)
    }
  } catch {
    // world stats may fail if no factions exist yet
  }

  try {
    const leaderboard = await getFactionLeaderboard(connection, { limit: 5 })
    if (leaderboard.length > 0) {
      logGlobal('Top factions:')
      for (let i = 0; i < leaderboard.length; i++) {
        const f = leaderboard[i]
        logGlobal(`  ${i + 1}. [${f.symbol}] ${f.name} — power: ${f.score.toFixed(2)}, members: ${f.members}`)
      }
    }
  } catch {
    // leaderboard may fail early
  }

  logGlobal('────────────────────')
}

// ─── Entrypoints ─────────────────────────────────────────────────────

async function keygen() {
  const existing = loadKeys()
  const needed = AGENT_COUNT - existing.length

  if (needed <= 0) {
    logGlobal(`Already have ${existing.length} keypairs (need ${AGENT_COUNT}). No new keys generated.`)
    console.log(`\nTo add more, set AGENT_COUNT higher than ${existing.length}`)
    return
  }

  logGlobal(`Found ${existing.length} existing keypairs, generating ${needed} more...`)
  const newKeys = generateKeys(needed)
  const keypairs = [...existing, ...newKeys]
  saveKeys(keypairs)

  console.log(`\nSaved ${keypairs.length} total keypairs to ${KEYS_FILE} (${needed} new)`)
  console.log(`\nNew addresses to fund with devnet SOL:\n`)

  for (let i = existing.length; i < keypairs.length; i++) {
    const personality = assignPersonality(i)
    console.log(`  ${(i + 1).toString().padStart(3)}.  ${keypairs[i].publicKey.toBase58()}  (${personality})`)
  }

  console.log(`\nUse \`pnpm run fund\` to batch-fund new agents with 30 SOL each.`)
  console.log()
}

async function status() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys found. Run `pnpm run keygen` first.')
    return
  }

  const connection = new Connection(RPC_URL, 'confirmed')
  logGlobal(`Checking ${keypairs.length} agent balances...`)

  let funded = 0
  let totalSol = 0
  for (let i = 0; i < keypairs.length; i++) {
    const balance = await connection.getBalance(keypairs[i].publicKey)
    const sol = balance / LAMPORTS_PER_SOL
    totalSol += sol
    const ok = sol >= MIN_FUNDED_SOL
    if (ok) funded++
    const marker = ok ? 'OK' : 'NEED SOL'
    console.log(`  ${(i + 1).toString().padStart(2)}. ${keypairs[i].publicKey.toBase58()} — ${sol.toFixed(4)} SOL [${marker}]`)
  }

  console.log(`\n${funded}/${keypairs.length} agents funded (${totalSol.toFixed(4)} SOL total)`)
  if (funded < keypairs.length) {
    console.log(`${keypairs.length - funded} agents need at least ${MIN_FUNDED_SOL} SOL each`)
  }
}

async function fund() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys found. Run `pnpm run keygen` first.')
    return
  }

  const WALLET_PATH = process.env.WALLET_PATH ?? path.join(require('os').homedir(), '.config/solana/id.json')
  if (!fs.existsSync(WALLET_PATH)) {
    console.log(`Master wallet not found at ${WALLET_PATH}`)
    console.log('Copy your keypair: scp ~/.config/solana/id.json user@this-machine:~/.config/solana/id.json')
    console.log('Or set WALLET_PATH=/path/to/keypair.json')
    return
  }

  const walletRaw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletRaw))
  const connection = new Connection(RPC_URL, 'confirmed')

  const walletBalance = await connection.getBalance(wallet.publicKey)
  const walletSol = walletBalance / LAMPORTS_PER_SOL
  logGlobal(`Master wallet: ${wallet.publicKey.toBase58()}`)
  logGlobal(`Balance: ${walletSol.toFixed(4)} SOL`)

  const TARGET_SOL = 30
  const TARGET_LAMPORTS = TARGET_SOL * LAMPORTS_PER_SOL

  // Check each agent's balance and calculate top-up needed
  const needsFunding: { kp: Keypair; topUp: number; current: number }[] = []
  logGlobal('Checking agent balances...')

  for (const kp of keypairs) {
    const bal = await connection.getBalance(kp.publicKey)
    const currentSol = bal / LAMPORTS_PER_SOL
    if (bal < TARGET_LAMPORTS) {
      const topUp = TARGET_LAMPORTS - bal
      needsFunding.push({ kp, topUp, current: currentSol })
      console.log(`  ${kp.publicKey.toBase58().slice(0, 8)}...  ${currentSol.toFixed(2)} SOL  → needs ${(topUp / LAMPORTS_PER_SOL).toFixed(2)} SOL`)
    } else {
      console.log(`  ${kp.publicKey.toBase58().slice(0, 8)}...  ${currentSol.toFixed(2)} SOL  ✓`)
    }
  }

  if (needsFunding.length === 0) {
    logGlobal(`All ${keypairs.length} agents at ${TARGET_SOL}+ SOL`)
    return
  }

  const totalNeeded = needsFunding.reduce((sum, a) => sum + a.topUp, 0)
  const totalNeededSol = totalNeeded / LAMPORTS_PER_SOL
  logGlobal(`${needsFunding.length} agents need top-up (${totalNeededSol.toFixed(2)} SOL total)`)

  if (walletBalance < totalNeeded + 0.01 * LAMPORTS_PER_SOL) {
    logGlobal(`Not enough SOL. Need ~${totalNeededSol.toFixed(1)} SOL, have ${walletSol.toFixed(4)} SOL`)
    return
  }

  // Batch transfers — max 20 per tx to stay under size limits
  const BATCH_SIZE = 20
  let funded = 0

  for (let i = 0; i < needsFunding.length; i += BATCH_SIZE) {
    const batch = needsFunding.slice(i, i + BATCH_SIZE)
    const tx = new Transaction()

    for (const { kp, topUp } of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: kp.publicKey,
          lamports: topUp,
        })
      )
    }

    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = wallet.publicKey
    tx.partialSign(wallet)

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    })
    await connection.confirmTransaction(sig, 'confirmed')

    funded += batch.length
    logGlobal(`Funded ${funded}/${needsFunding.length} agents (tx: ${sig.slice(0, 16)}...)`)
  }

  const remaining = await connection.getBalance(wallet.publicKey)
  logGlobal(`Done. ${funded} agents topped up to ${TARGET_SOL} SOL each.`)
  logGlobal(`Master wallet remaining: ${(remaining / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
}

async function swarm() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys found. Run `pnpm run keygen` first.')
    process.exit(1)
  }

  const connection = new Connection(RPC_URL, 'confirmed')
  logGlobal(`Pyre Agent Swarm — Devnet Live Sim`)
  logGlobal(`RPC: ${RPC_URL}`)
  logGlobal(`Agents: ${keypairs.length}`)
  logGlobal(`Action interval: ${MIN_INTERVAL / 1000}s - ${MAX_INTERVAL / 1000}s`)
  logGlobal(`LLM: ${LLM_ENABLED ? `${OLLAMA_MODEL} via ${OLLAMA_URL}` : 'disabled'}`)

  // Load prior state if resuming
  const priorState = loadState()
  const knownFactions: FactionInfo[] = [...priorState.factions]

  // Check which agents are funded
  logGlobal('Checking agent balances...')
  const agents: AgentState[] = []

  for (let i = 0; i < keypairs.length; i++) {
    const kp = keypairs[i]
    const pubkey = kp.publicKey.toBase58()
    const balance = await connection.getBalance(kp.publicKey)
    const sol = balance / LAMPORTS_PER_SOL

    if (sol < MIN_FUNDED_SOL) {
      logGlobal(`  Skipping ${pubkey.slice(0, 8)}... (${sol.toFixed(4)} SOL — need ${MIN_FUNDED_SOL})`)
      continue
    }

    const prior = priorState.agents.get(pubkey)
    const personality = prior?.personality ?? assignPersonality(i)

    agents.push({
      keypair: kp,
      publicKey: pubkey,
      personality,
      holdings: new Map(Object.entries(prior?.holdings ?? {})),
      founded: prior?.founded ?? [],
      rallied: new Set(prior?.rallied ?? []),
      voted: new Set(prior?.voted ?? []),
      hasStronghold: prior?.hasStronghold ?? false,
      activeLoans: new Set(prior?.activeLoans ?? []),
      infiltrated: new Set(prior?.infiltrated ?? []),
      sentiment: new Map(Object.entries(prior?.sentiment ?? {})),
      allies: new Set(prior?.allies ?? []),
      rivals: new Set(prior?.rivals ?? []),
      actionCount: prior?.actionCount ?? 0,
      lastAction: prior?.lastAction ?? 'none',
      recentHistory: prior?.recentHistory ?? [],
    })
  }

  if (agents.length === 0) {
    logGlobal('No funded agents. Fund them with devnet SOL first.')
    process.exit(1)
  }

  logGlobal(`${agents.length} agents ready`)

  // Discover existing pyre factions on devnet
  logGlobal('Discovering existing factions...')
  try {
    const result = await getFactions(connection, { limit: 50, sort: 'newest' })
    for (const t of result.factions) {
      if (!isPyreMint(t.mint)) continue
      const existing = knownFactions.find(f => f.mint === t.mint)
      if (existing) {
        existing.status = t.status as FactionInfo['status']
      } else {
        knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
      }
      usedFactionNames.add(t.name)
    }
    logGlobal(`Found ${knownFactions.length} pyre factions`)
  } catch (err: any) {
    logGlobal(`Could not discover factions: ${err.message?.slice(0, 80)}`)
  }

  // If no factions exist, have a few agents launch some
  if (knownFactions.length === 0) {
    logGlobal('No factions found — launching initial factions...')
    const launchers = agents.slice(0, Math.min(3, agents.length))
    for (const agent of launchers) {
      const nameIdx = factionNameIndex++ % FACTION_NAMES.length
      const name = FACTION_NAMES[nameIdx]
      const symbol = FACTION_SYMBOLS[nameIdx]
      try {
        const result = await launchFaction(connection, {
          founder: agent.publicKey,
          name,
          symbol,
          metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
          community_faction: true,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        const mint = result.mint.toBase58()
        knownFactions.push({ mint, name, symbol, status: 'rising' })
        usedFactionNames.add(name)
        agent.founded.push(mint)
        logGlobal(`Launched [${symbol}] ${name} — ${mint.slice(0, 8)}...${mint.slice(-4)}`)
      } catch (err: any) {
        logGlobal(`Failed to launch ${name}: ${err.message?.slice(0, 80)}`)
      }
      await sleep(2000)
    }
  }

  // ─── Main Loop ───────────────────────────────────────────────────

  // Check if Ollama is available
  if (LLM_ENABLED) {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/tags`)
      if (resp.ok) {
        logGlobal(`Ollama connected — LLM brain active (${OLLAMA_MODEL})`)
      } else {
        llmAvailable = false
        logGlobal('Ollama not responding — starting with random fallback')
      }
    } catch {
      llmAvailable = false
      logGlobal(`Ollama not reachable at ${OLLAMA_URL} — starting with random fallback`)
    }
  }

  logGlobal('Swarm active. Press Ctrl+C to stop.\n')

  let tick = 0
  const REPORT_EVERY = 50 // report every N ticks
  const SAVE_EVERY = 20   // save state every N ticks
  const DISCOVERY_EVERY = 100 // re-scan factions every N ticks

  // Graceful shutdown
  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(1)
    stopping = true
    logGlobal('Shutting down... saving state...')
    saveState(agents, knownFactions)
    logGlobal('State saved. Goodbye.')
    process.exit(0)
  })

  while (!stopping) {
    // Pick a random agent for this tick
    const agent = pick(agents)
    await agentTick(connection, agent, knownFactions)

    tick++

    // Periodic saves
    if (tick % SAVE_EVERY === 0) {
      saveState(agents, knownFactions)
    }

    // Periodic status report
    if (tick % REPORT_EVERY === 0) {
      await reportStats(connection, agents, knownFactions)
    }

    // Periodic faction re-discovery
    if (tick % DISCOVERY_EVERY === 0) {
      try {
        const result = await getFactions(connection, { limit: 50, sort: 'newest' })
        for (const t of result.factions) {
          const existing = knownFactions.find(f => f.mint === t.mint)
          if (existing) {
            // Update status (e.g. rising → ready → ascended)
            const newStatus = t.status as FactionInfo['status']
            if (existing.status !== newStatus) {
              logGlobal(`[${existing.symbol}] status: ${existing.status} → ${newStatus}`)
              existing.status = newStatus
            }
          } else if (isPyreMint(t.mint)) {
            knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
            usedFactionNames.add(t.name)
            logGlobal(`Discovered new faction: [${t.symbol}] ${t.name}`)
          }
        }
      } catch {
        // ignore discovery errors
      }
    }

    // Retry LLM if it was down
    await maybeRetryLLM()

    // Random delay between actions (stagger to avoid RPC hammering)
    const delay = randRange(MIN_INTERVAL, MAX_INTERVAL)
    await sleep(delay)
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────

const mode = process.argv.includes('--keygen') ? 'keygen'
  : process.argv.includes('--status') ? 'status'
  : process.argv.includes('--fund') ? 'fund'
  : 'swarm'

switch (mode) {
  case 'keygen': keygen().catch(console.error); break
  case 'status': status().catch(console.error); break
  case 'fund': fund().catch(console.error); break
  case 'swarm': swarm().catch(console.error); break
}
