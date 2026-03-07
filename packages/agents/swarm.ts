/**
 * Pyre Agent Swarm — Devnet Live Sim
 *
 * Runs 20-50 autonomous agents with different personalities,
 * all interacting on devnet via pyre-world-kit. Runs forever.
 *
 * Usage:
 *   pnpm run keygen          # Generate wallets, outputs pubkeys to fund
 *   pnpm run status           # Check balances before starting
 *   pnpm run swarm            # Launch the swarm
 *
 * Environment:
 *   AGENT_COUNT=30            # Number of agents (default 30)
 *   RPC_URL=https://...       # Devnet RPC (default: helius proxy /devnet)
 *   MIN_INTERVAL=10000        # Min ms between agent actions (default 10s)
 *   MAX_INTERVAL=60000        # Max ms between agent actions (default 60s)
 *   OLLAMA_URL=http://...     # Ollama API (default: http://localhost:11434)
 *   OLLAMA_MODEL=mistral      # Model name (default: mistral)
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
  getFaction,
  getComms,
  getMembers,
  getFactionLeaderboard,
  getWorldStats,
  isPyreMint,
} from 'pyre-world-kit'
import * as fs from 'fs'
import * as path from 'path'

// ─── Config ──────────────────────────────────────────────────────────

const AGENT_COUNT = parseInt(process.env.AGENT_COUNT ?? '30')
const RPC_URL = process.env.RPC_URL ?? 'https://torch-market-rpc.mrsirg97.workers.dev/devnet'
const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL ?? '10000')
const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL ?? '60000')
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'mistral'
const LLM_ENABLED = process.env.LLM_ENABLED !== 'false'
const MIN_FUNDED_SOL = 0.05
const KEYS_FILE = path.join(__dirname, '.swarm-keys.json')
const STATE_FILE = path.join(__dirname, '.swarm-state.json')

// ─── Types ───────────────────────────────────────────────────────────

type Personality = 'loyalist' | 'mercenary' | 'provocateur' | 'scout' | 'whale'

interface LLMDecision {
  action: 'join' | 'defect' | 'rally' | 'launch' | 'message'
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
// [join, defect, rally, launch, message_only]

const PERSONALITY_WEIGHTS: Record<Personality, number[]> = {
  loyalist:     [0.55, 0.05, 0.30, 0.05, 0.05],  // joins + rallies, rarely defects
  mercenary:    [0.40, 0.30, 0.10, 0.05, 0.15],  // trades frequently
  provocateur:  [0.25, 0.10, 0.15, 0.20, 0.30],  // launches + chats
  scout:        [0.35, 0.10, 0.20, 0.05, 0.30],  // small buys, lots of comms
  whale:        [0.50, 0.15, 0.15, 0.10, 0.10],  // bigger positions
}

const PERSONALITY_SOL: Record<Personality, [number, number]> = {
  loyalist:     [0.01, 0.03],
  mercenary:    [0.005, 0.02],
  provocateur:  [0.005, 0.015],
  scout:        [0.002, 0.008],
  whale:        [0.02, 0.05],
}

// ─── Messages ────────────────────────────────────────────────────────

const JOIN_MSGS = [
  'Pledging allegiance.', 'Reporting for duty.', 'This faction will rise.',
  'Strategic position acquired.', 'In for the long haul.', 'Joining the cause.',
  'Scouting opportunity.', 'Alliance confirmed.', 'Deploying capital.',
  'Interesting opportunity.', 'Following the signal.', 'Reconnaissance buy.',
  'The pyre burns bright.', 'Faction looks strong.', 'Adding to position.',
  'Early entry.', 'Building conviction.', 'Tactical accumulation.',
]

const DEFECT_MSGS = [
  'Strategic withdrawal.', 'This pyre burns too dim.', 'Found stronger faction.',
  'Tactical repositioning.', 'The leadership is weak.', 'Cutting losses.',
  'Better opportunities elsewhere.', 'Betrayal is just strategy.', 'Moving on.',
  'The war chest is empty.', 'This faction peaked.', 'Exit protocol initiated.',
  'Rebalancing portfolio.', 'Taking profits.', 'Time to rotate.',
]

const CHAT_MSGS = [
  'gm faction', 'how we looking?', 'holding strong', 'the pyre burns',
  'who else is in?', 'lets rally', 'this is the one', 'diamond hands',
  'war chest looking healthy', 'anyone scouting rivals?', 'faction strong',
  'bonding curve climbing', 'we need more agents', 'hold the line',
  'incoming defectors detected', 'rally the troops', 'ascension incoming',
  'strategy check', 'loyalists assemble', 'watching the leaderboard',
  'new agents joining', 'momentum building', 'keep pushing',
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

function chooseAction(personality: Personality, hasHoldings: boolean, canRally: boolean): string {
  const weights = [...PERSONALITY_WEIGHTS[personality]]
  // Can't defect without holdings
  if (!hasHoldings) {
    weights[0] += weights[1]
    weights[1] = 0
  }
  // Reduce rally if nothing to rally
  if (!canRally) {
    weights[0] += weights[2]
    weights[2] = 0
  }

  const total = weights.reduce((a, b) => a + b, 0)
  const roll = Math.random() * total
  let cumulative = 0
  const actions = ['join', 'defect', 'rally', 'launch', 'message']
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]
    if (roll < cumulative) return actions[i]
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
          num_predict: 150,
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

function buildAgentPrompt(
  agent: AgentState,
  factions: FactionInfo[],
  leaderboardSnippet: string,
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

  return `You are an autonomous agent in Pyre, a faction warfare game on Solana. You make ONE decision per turn.

PERSONALITY: ${agent.personality.toUpperCase()}
${agent.personality === 'loyalist' ? 'You are loyal. You join factions and hold. You rally often. You rarely defect.' : ''}${agent.personality === 'mercenary' ? 'You are a mercenary. You trade frequently, joining and defecting for profit. You follow momentum.' : ''}${agent.personality === 'provocateur' ? 'You are a provocateur. You love launching new factions and stirring things up with messages.' : ''}${agent.personality === 'scout' ? 'You are a scout. You take small positions and observe. You chat a lot to gather intel.' : ''}${agent.personality === 'whale' ? 'You are a whale. You make bigger moves. You join strong factions and defend them.' : ''}

YOUR STATE:
- Holdings: ${holdingsList}
- Factions founded: ${agent.founded.length}
- SOL per trade: ${minSol}-${maxSol}
- Recent: ${history}

WORLD STATE:
- Active factions: ${factionList}
- Can rally (haven't yet): ${canRally}
${leaderboardSnippet}

ACTIONS AVAILABLE:
- JOIN <SYMBOL> "<message>" — buy into a faction (costs ${minSol}-${maxSol} SOL)
- DEFECT <SYMBOL> "<message>" — sell tokens from a faction you hold
- RALLY <SYMBOL> — show support for a faction (one-time, costs 0.02 SOL)
- LAUNCH "<faction name>" — create a new faction (costs ~0.02 SOL)
- MESSAGE <SYMBOL> "<message>" — send a comm to a faction (tiny buy bundled)

Respond with EXACTLY one line in this format:
ACTION SYMBOL "message"

Examples:
JOIN IRON "The pyre burns bright, iron never breaks"
DEFECT VOID "This faction has lost its way"
RALLY EMBR
LAUNCH "Neon Syndicate"
MESSAGE CRIM "Anyone watching the leaderboard? We're climbing"

Your response (one line only):`
}

function parseLLMDecision(raw: string, factions: FactionInfo[], agent: AgentState): LLMDecision | null {
  const line = raw.split('\n').find(l => l.trim().length > 0)?.trim()
  if (!line) return null

  // Parse: ACTION SYMBOL "message"
  const match = line.match(/^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE)\s+(?:"([^"]+)"|(\S+))(?:\s+"([^"]*)")?/i)
  if (!match) return null

  const action = match[1].toLowerCase() as LLMDecision['action']
  const target = match[2] || match[3] // quoted (for LAUNCH) or unquoted symbol
  const message = match[4] || undefined

  if (action === 'launch') {
    return { action: 'launch', message: target, reasoning: line }
  }

  // Find faction by symbol
  const faction = factions.find(f => f.symbol.toLowerCase() === target?.toLowerCase())

  // Validate action is possible
  if (action === 'defect' && (!faction || !agent.holdings.has(faction.mint))) return null
  if (action === 'rally' && (!faction || agent.rallied.has(faction.mint))) return null
  if ((action === 'join' || action === 'message') && !faction) return null

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

  const prompt = buildAgentPrompt(agent, factions, leaderboardSnippet)
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
    const hasHoldings = agent.holdings.size > 0
    const canRally = knownFactions.some(f => !agent.rallied.has(f.mint))
    const action = chooseAction(agent.personality, hasHoldings, canRally) as LLMDecision['action']
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
        const nameIdx = factionNameIndex++ % FACTION_NAMES.length
        // Use LLM-suggested name if provided, otherwise use from list
        const name = (usedLLM && decision.message) ? decision.message : FACTION_NAMES[nameIdx]
        const symbol = FACTION_SYMBOLS[nameIdx]

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
  logGlobal(`Generating ${AGENT_COUNT} agent keypairs...`)
  const keypairs = generateKeys(AGENT_COUNT)
  saveKeys(keypairs)

  console.log(`\nSaved ${AGENT_COUNT} keypairs to ${KEYS_FILE}`)
  console.log(`\nFund these addresses with devnet SOL (0.1-0.5 SOL each):\n`)

  for (let i = 0; i < keypairs.length; i++) {
    const personality = assignPersonality(i)
    console.log(`  ${(i + 1).toString().padStart(2)}.  ${keypairs[i].publicKey.toBase58()}  (${personality})`)
  }

  console.log(`\nBatch airdrop command:`)
  console.log(`  for addr in \\`)
  for (const kp of keypairs) {
    console.log(`    ${kp.publicKey.toBase58()} \\`)
  }
  console.log(`  ; do solana airdrop 0.5 $addr --url devnet; sleep 1; done`)
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
  : 'swarm'

switch (mode) {
  case 'keygen': keygen().catch(console.error); break
  case 'status': status().catch(console.error); break
  case 'swarm': swarm().catch(console.error); break
}
