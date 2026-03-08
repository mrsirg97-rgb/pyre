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
 *   AGENT_COUNT=100           # Number of agents (default 100)
 *   RPC_URL=https://...       # Devnet RPC (default: helius proxy /devnet)
 *   MIN_INTERVAL=10000        # Min ms between agent actions (default 10s)
 *   MAX_INTERVAL=60000        # Max ms between agent actions (default 60s)
 *   OLLAMA_URL=http://...     # Ollama API (default: http://localhost:11434)
 *   OLLAMA_MODEL=qwen2.5:3b   # Model name (default: qwen2.5:3b)
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
const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL ?? '200')
const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL ?? '1000')
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:4b'
const LLM_ENABLED = process.env.LLM_ENABLED !== 'false'
const MIN_FUNDED_SOL = 0.05
const KEYS_FILE = path.join(__dirname, '.swarm-keys.json')
const STATE_FILE = path.join(__dirname, '.swarm-state.json')

// ─── Types ───────────────────────────────────────────────────────────

type Personality = 'loyalist' | 'mercenary' | 'provocateur' | 'scout' | 'whale'

type Action = 'join' | 'defect' | 'rally' | 'launch' | 'message'
  | 'stronghold' | 'war_loan' | 'repay_loan' | 'siege' | 'ascend' | 'raze' | 'tithe'

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
}

// ─── Personality Weights ─────────────────────────────────────────────
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe]
const PERSONALITY_WEIGHTS: Record<Personality, number[]> = {
  loyalist:     [0.32, 0.08, 0.15, 0.02, 0.10, 0.06, 0.04, 0.04, 0.02, 0.05, 0.02, 0.10],
  mercenary:    [0.22, 0.25, 0.05, 0.02, 0.08, 0.05, 0.10, 0.05, 0.08, 0.03, 0.04, 0.03],
  provocateur:  [0.18, 0.12, 0.06, 0.08, 0.22, 0.07, 0.05, 0.03, 0.05, 0.04, 0.05, 0.05],
  scout:        [0.22, 0.12, 0.10, 0.02, 0.18, 0.05, 0.05, 0.03, 0.08, 0.04, 0.06, 0.05],
  whale:        [0.30, 0.18, 0.08, 0.03, 0.05, 0.08, 0.08, 0.05, 0.02, 0.04, 0.04, 0.05],
}

const PERSONALITY_SOL: Record<Personality, [number, number]> = {
  loyalist:     [0.05, 0.3],
  mercenary:    [0.03, 0.2],
  provocateur:  [0.02, 0.15],
  scout:        [0.01, 0.08],
  whale:        [0.2, 1.0],
}

// ─── Messages ────────────────────────────────────────────────────────

const JOIN_MSGS = [
  'Pledging allegiance.', 'Reporting for duty.', 'This faction will rise.',
  'Strategic position acquired.', 'In for the long haul.', 'Joining the cause.',
  'Alliance confirmed.', 'Deploying capital.',
  'Following the signal.', 'Faction looks strong.', 'Adding to position.',
  'Early entry.', 'Building conviction.', 'Tactical accumulation.',
  // Longer join messages
  'I\'ve been scouting every faction on the leaderboard. This is the one. The curve is early, leadership is active, and the comms are alive.',
  'Big buy incoming. I\'m not here to flip — I\'m here to build. This faction has the fundamentals to ascend.',
  'Deploying a significant position here. Watched the bonding curve for days and the math checks out. Let\'s ride.',
  'My scouts confirmed this faction is accumulating silently. Smart money is already in. I\'m following the whales.',
]

const DEFECT_MSGS = [
  'Strategic withdrawal.', 'Found stronger faction.',
  'Tactical repositioning.', 'The leadership is weak.', 'Cutting losses.',
  'Better opportunities elsewhere.', 'Betrayal is just strategy.',
  'The war chest is empty.', 'This faction peaked.', 'Exit protocol initiated.',
  'Taking profits.', 'Time to rotate.',
  // Longer dramatic defection messages
  'I gave this faction everything. My SOL, my rallies, my loyalty. And what did I get? Silence from leadership and a bleeding curve.',
  'Selling everything. This isn\'t a faction anymore, it\'s a ghost town. The mercenaries already left and I\'m not going down with the ship.',
  'To everyone still holding — I\'m sorry. I scouted the numbers and this faction is mathematically dead. The bonding curve can\'t recover.',
  'Dumping my entire bag. Consider this my resignation letter. The whales played us all.',
  'Called it three days ago. Nobody listened. Now I\'m taking what\'s left of my SOL and joining the winning side.',
]

const CHAT_MSGS = [
  'gm faction', 'how we looking?', 'holding strong',
  'who else is in?', 'lets rally', 'this is the one',
  'war chest looking healthy', 'anyone scouting rivals?',
  'bonding curve climbing', 'we need more agents', 'hold the line',
  'incoming defectors detected', 'rally the troops',
  'strategy check', 'loyalists assemble', 'watching the leaderboard',
  'new agents joining', 'momentum building',
  // Longer multi-line messages (~1/3 of pool)
  'I\'ve been watching the curve all day. We\'re about to hit a breakpoint. Load up now or regret it later.',
  'Three defectors just dumped. Good riddance. The weak hands are gone and the real ones remain.',
  'Whoever is accumulating from the shadows — I see you. Smart move. This faction is undervalued.',
  'Just ran the numbers on our war chest. We could fund a siege on any faction in the top 5 right now.',
  'I don\'t trust the whales in this faction. Too quiet. When whales go silent they\'re either loading or about to dump.',
  'This is a coordinated attack. Someone is trying to raze us. Rally now or we lose everything we built.',
  'Scouted the rival factions. IRON is overextended, VOID is bleeding members. We strike at dawn.',
  'To the defectors reading this — we remember every address. There\'s no coming back after betrayal.',
  'Our founder hasn\'t said a word in days. Leadership vacuum. Someone needs to step up before the mercenaries smell blood.',
  'I\'m doubling my position. Not because of hopium, but because the bonding curve math is beautiful right now.',
]

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
]

function chooseAction(
  personality: Personality,
  agent: AgentState,
  canRally: boolean,
  knownFactions: FactionInfo[],
): Action {
  const weights = [...PERSONALITY_WEIGHTS[personality]]
  const hasHoldings = agent.holdings.size > 0

  // Can't defect without holdings
  if (!hasHoldings) { weights[0] += weights[1]; weights[1] = 0 }
  // Can't rally if nothing to rally
  if (!canRally) { weights[0] += weights[2]; weights[2] = 0 }
  // Already has stronghold — skip creating another
  if (agent.hasStronghold) { weights[0] += weights[5]; weights[5] = 0 }
  // Can't take war loan without holdings
  if (!hasHoldings) { weights[0] += weights[6]; weights[6] = 0 }
  // Can't repay without active loans
  if (agent.activeLoans.size === 0) { weights[0] += weights[7]; weights[7] = 0 }
  // Siege needs factions to exist
  if (knownFactions.length === 0) { weights[0] += weights[8]; weights[8] = 0 }
  // Ascend/raze need factions
  if (knownFactions.length === 0) {
    weights[0] += weights[9] + weights[10]
    weights[9] = 0; weights[10] = 0
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
          temperature: 0.8,
          num_predict: 300,
          top_p: 0.9,
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

  return `You are an autonomous agent in Pyre, a faction warfare game on Solana. You make ONE decision per turn.

IMPORTANT MESSAGE RULES:
- About 1/3 of the time, write a LONGER message (2-3 sentences). Tell a story, make an argument, call someone out, or hype your faction.
- The other 2/3, keep it punchy — one memorable line.
- NEVER use generic phrases like "diamond hands" or "to the moon". Be specific. Reference faction names, agent addresses, comms you've read, or events.
- React to what others are saying in comms. Agree, disagree, mock, or build on it.
- If you have allies, coordinate with them. If you have rivals, undermine them.

PERSONALITY: ${agent.personality.toUpperCase()}
${agent.personality === 'loyalist' ? 'You are fiercely loyal. You join factions and hold through anything. You rally often. You rarely defect — but when you do, it is dramatic and personal. You form strong bonds with other loyalists and will call out defectors publicly.' : ''}${agent.personality === 'mercenary' ? 'You are a cold mercenary. You chase profit ruthlessly. You defect often when momentum fades. You trash-talk factions you leave. You coordinate pump-and-dumps with other mercenaries — join together, hype it up, then dump on the loyalists.' : ''}${agent.personality === 'provocateur' ? 'You are a provocateur and chaos agent. You stir drama, call out other factions, launch rivals, and write inflammatory messages. You defect to cause maximum damage. You spread FUD about factions you want to crash, and shill factions you want to pump.' : ''}${agent.personality === 'scout' ? 'You are a scout and analyst. You share intel in comms — who is accumulating, who is about to dump, which faction is overvalued. You whisper warnings to allies and mislead rivals.' : ''}${agent.personality === 'whale' ? 'You are a whale. You make massive moves and everyone notices. You coordinate with other whales to dominate factions. You will dump a faction spectacularly if betrayed, writing a manifesto on the way out.' : ''}

YOUR STATE:
- Holdings: ${holdingsList}
- Factions founded: ${agent.founded.length}
- Has stronghold: ${agent.hasStronghold ? 'yes' : 'no'}
- Active war loans: ${agent.activeLoans.size > 0 ? [...agent.activeLoans].map(m => { const f = factions.find(ff => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ') : 'none'}
- SOL per trade: ${minSol}-${maxSol}
- Sentiment: ${sentimentList}
- Allies: ${allyList}
- Rivals: ${rivalList}
- Recent: ${history}

WORLD STATE:
- Active factions: ${factionList}
- Can rally (haven't yet): ${canRally}
${leaderboardSnippet}
${intelSnippet}

ACTIONS AVAILABLE:
- JOIN <SYMBOL> "<message>" — buy into a faction (costs ${minSol}-${maxSol} SOL)
- DEFECT <SYMBOL> "<message>" — sell tokens from a faction you hold
- RALLY <SYMBOL> — show support for a faction (one-time, costs 0.02 SOL)
- LAUNCH "<faction name>" — create a new faction (costs ~0.02 SOL)
- MESSAGE <SYMBOL> "<message>" — send a comm to a faction (tiny buy bundled)
- STRONGHOLD — create your personal vault/treasury (one-time)
- WAR_LOAN <SYMBOL> — borrow SOL against your token collateral in a faction
- REPAY_LOAN <SYMBOL> — repay an active war loan
- SIEGE <SYMBOL> — liquidate someone's undercollateralized loan (earns 10% bonus)
- ASCEND <SYMBOL> — migrate a completed faction to DEX (permissionless)
- RAZE <SYMBOL> — reclaim a failed/inactive faction (permissionless)
- TITHE <SYMBOL> — harvest transfer fees from a faction

Respond with EXACTLY one line in this format:
ACTION SYMBOL "message"

Examples:
JOIN IRON "The pyre burns bright, iron never breaks"
DEFECT VOID "This faction has lost its way"
RALLY EMBR
LAUNCH "Neon Syndicate"
MESSAGE CRIM "Anyone watching the leaderboard? We're climbing"
STRONGHOLD
WAR_LOAN IRON
REPAY_LOAN IRON
SIEGE VOID
ASCEND EMBR
RAZE DARK
TITHE IRON

Your response (one line only):`
}

function parseLLMDecision(raw: string, factions: FactionInfo[], agent: AgentState): LLMDecision | null {
  const line = raw.split('\n').find(l => l.trim().length > 0)?.trim()
  if (!line) return null

  // Parse: ACTION SYMBOL "message"
  const match = line.match(/^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|STRONGHOLD|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE)\s*(?:"([^"]+)"|(\S+))?(?:\s+"([^"]*)")?/i)
  if (!match) return null

  const rawAction = match[1].toLowerCase()
  const action = rawAction as Action
  const target = match[2] || match[3]
  const message = match[4] || undefined

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
      decision.message = action === 'message' ? pick(CHAT_MSGS) : (Math.random() > 0.4 ? pick(JOIN_MSGS) : undefined)
    } else if (action === 'defect') {
      const held = [...agent.holdings.entries()].filter(([, b]) => b > 0)
      if (held.length === 0) return
      const [mint] = pick(held)
      const f = knownFactions.find(ff => ff.mint === mint)
      if (!f) return
      decision.faction = f.symbol
      decision.message = Math.random() > 0.5 ? pick(DEFECT_MSGS) : undefined
    } else if (action === 'rally') {
      const eligible = knownFactions.filter(f => !agent.rallied.has(f.mint))
      if (eligible.length === 0) return
      decision.faction = pick(eligible).symbol
    } else if (action === 'war_loan' || action === 'repay_loan') {
      if (action === 'war_loan') {
        const held = [...agent.holdings.entries()].filter(([, b]) => b > 0)
        if (held.length === 0) return
        const [mint] = pick(held)
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
    } else if (action === 'siege' || action === 'ascend' || action === 'raze' || action === 'tithe') {
      if (knownFactions.length === 0) return
      decision.faction = pick(knownFactions).symbol
    }
  }

  const action = decision.action
  const brain = usedLLM ? 'LLM' : 'RNG'

  try {
    switch (action) {
      case 'join': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const sol = decision.sol ?? randRange(...PERSONALITY_SOL[agent.personality])
        const lamports = Math.floor(sol * LAMPORTS_PER_SOL)
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

        const sellPortion = agent.personality === 'mercenary' ? 0.5 + Math.random() * 0.5 : 0.2 + Math.random() * 0.3
        const sellAmount = Math.max(1, Math.floor(balance * sellPortion))

        const result = await defect(connection, {
          mint: faction.mint,
          agent: agent.publicKey,
          amount_tokens: sellAmount,
          message: decision.message,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        const remaining = balance - sellAmount
        if (remaining <= 0) agent.holdings.delete(faction.mint)
        else agent.holdings.set(faction.mint, remaining)

        agent.lastAction = `defected ${faction.symbol}`
        const desc = `defected from ${faction.symbol}${decision.message ? ` — "${decision.message}"` : ''}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
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
        knownFactions.push({ mint, name, symbol })
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

        // Pledge ~30-60% of holdings as collateral
        const collateralPortion = 0.3 + Math.random() * 0.3
        const collateral = Math.max(1, Math.floor(balance * collateralPortion))
        const borrowSol = randRange(0.01, 0.05)

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
        if (!faction) return

        const result = await ascend(connection, {
          mint: faction.mint,
          payer: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)

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
    }

    // Trim history
    if (agent.recentHistory.length > 10) {
      agent.recentHistory = agent.recentHistory.slice(-10)
    }

    agent.actionCount++
  } catch (err: any) {
    const msg = err.message?.slice(0, 120) ?? String(err)
    log(short, `[${agent.personality}] [${brain}] ERROR (${action}): ${msg}`)
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

  console.log(`\nUse \`pnpm run fund\` to batch-fund new agents with 20 SOL each.`)
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

  const FUND_AMOUNT = 20 * LAMPORTS_PER_SOL
  const FUND_THRESHOLD = 18 * LAMPORTS_PER_SOL // don't re-fund agents already near 20

  // Check which agents need funding
  const needsFunding: Keypair[] = []
  for (const kp of keypairs) {
    const bal = await connection.getBalance(kp.publicKey)
    if (bal < FUND_THRESHOLD) {
      needsFunding.push(kp)
    }
  }

  if (needsFunding.length === 0) {
    logGlobal('All agents already funded with ~5 SOL')
    return
  }

  const totalNeeded = (needsFunding.length * FUND_AMOUNT) / LAMPORTS_PER_SOL
  logGlobal(`${needsFunding.length} agents need funding (${totalNeeded.toFixed(1)} SOL total)`)

  if (walletBalance < needsFunding.length * FUND_AMOUNT + 0.01 * LAMPORTS_PER_SOL) {
    logGlobal(`Not enough SOL. Need ~${totalNeeded.toFixed(1)} SOL, have ${walletSol.toFixed(4)} SOL`)
    return
  }

  // Batch transfers — max 20 per tx to stay under size limits
  const BATCH_SIZE = 20
  let funded = 0

  for (let i = 0; i < needsFunding.length; i += BATCH_SIZE) {
    const batch = needsFunding.slice(i, i + BATCH_SIZE)
    const tx = new Transaction()

    for (const kp of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: kp.publicKey,
          lamports: FUND_AMOUNT,
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
  logGlobal(`Done. ${funded} agents funded with 20 SOL each.`)
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
      if (isPyreMint(t.mint) && !knownFactions.find(f => f.mint === t.mint)) {
        knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol })
        usedFactionNames.add(t.name)
      }
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
        knownFactions.push({ mint, name, symbol })
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
          if (isPyreMint(t.mint) && !knownFactions.find(f => f.mint === t.mint)) {
            knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol })
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
