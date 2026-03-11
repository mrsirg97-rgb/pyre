/**
 * On-Chain State Reconstruction for Swarm Agents
 *
 * Derives personality weights, sentiment, allies/rivals from on-chain
 * transaction history. Agents become defined by their actions.
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js'
import { PERSONALITY_WEIGHTS } from './identity'
import type { Action, Personality, FactionInfo, AgentState } from './types'

const TORCH_PROGRAM_ID = '8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT'
const MEMO_PROGRAM_IDS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'])

const ALL_ACTIONS: Action[] = [
  'join', 'defect', 'rally', 'launch', 'message',
  'stronghold', 'war_loan', 'repay_loan', 'siege', 'ascend', 'raze', 'tithe',
  'infiltrate', 'fud',
]

interface OnChainAction {
  signature: string
  timestamp: number
  action: Action | 'fund' | 'dex_buy' | 'dex_sell' | 'unknown'
  mint?: string
  memo?: string
}

export interface ChainDerivedState {
  weights: number[]
  personality: Personality
  sentiment: Map<string, number>
  allies: Set<string>
  rivals: Set<string>
  actionCount: number
  recentHistory: string[]
  founded: string[]
  memories: string[]
}

// ─── Transaction Fetching ────────────────────────────────────────

async function rpcRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const is429 = err?.message?.includes('429') || err?.status === 429
      if (!is429 || attempt === retries - 1) throw err
      const delay = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

async function fetchAgentHistory(
  connection: Connection,
  agentPubkey: string,
  knownMints: Set<string>,
  maxSigs = 500,
): Promise<OnChainAction[]> {
  const pubkey = new PublicKey(agentPubkey)
  const allActions: OnChainAction[] = []
  let before: string | undefined
  let fetched = 0

  while (fetched < maxSigs) {
    const batchSize = Math.min(maxSigs - fetched, 1000)
    const signatures = await rpcRetry(() =>
      connection.getSignaturesForAddress(pubkey, { limit: batchSize, before }, 'confirmed')
    )
    if (signatures.length === 0) break
    fetched += signatures.length
    before = signatures[signatures.length - 1].signature

    const BATCH_SIZE = 50 // smaller batches to avoid 429s
    for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
      const batch = signatures.slice(i, i + BATCH_SIZE)
      let txs: (ParsedTransactionWithMeta | null)[]
      try {
        txs = await rpcRetry(() =>
          connection.getParsedTransactions(
            batch.map(s => s.signature),
            { maxSupportedTransactionVersion: 0 },
          )
        )
      } catch { continue }

      for (let j = 0; j < txs.length; j++) {
        const tx = txs[j]
        if (!tx?.meta || tx.meta.err) continue
        const parsed = parseTransaction(tx, batch[j].signature, batch[j].blockTime ?? 0, knownMints)
        if (parsed) allActions.push(parsed)
      }
    }
  }

  allActions.sort((a, b) => a.timestamp - b.timestamp)
  return allActions
}

function parseTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string,
  timestamp: number,
  knownMints: Set<string>,
): OnChainAction | null {
  const logs = tx.meta?.logMessages ?? []
  const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString())

  const isTorchTx = accountKeys.includes(TORCH_PROGRAM_ID) ||
    logs.some(l => l.includes(TORCH_PROGRAM_ID))
  if (!isTorchTx) return null

  let action = categorizeFromLogs(logs)
  const mint = accountKeys.find(k => knownMints.has(k))
  const memo = extractMemo(tx)

  // A buy with a memo = message, a sell with a memo = fud
  if (memo?.trim()) {
    if (action === 'join' || action === 'dex_buy') action = 'message'
    else if (action === 'defect' || action === 'dex_sell') action = 'fud'
  }

  return { signature, timestamp, action, mint, memo }
}

function categorizeFromLogs(logs: string[]): OnChainAction['action'] {
  const logStr = logs.join(' ')
  if (logs.some(l => l.includes('Instruction: CreateToken') || l.includes('create_token'))) return 'launch'
  if (logs.some(l => l.includes('Instruction: CreateVault') || l.includes('create_vault'))) return 'stronghold'
  if (logs.some(l => l.includes('Instruction: VaultSwap') || l.includes('vault_swap'))) {
    if (logStr.includes('is_buy: true') || logStr.includes('Buy')) return 'dex_buy'
    if (logStr.includes('is_buy: false') || logStr.includes('Sell')) return 'dex_sell'
    return 'dex_buy'
  }
  if (logs.some(l => l.includes('Instruction: Buy') || l.includes('Program log: Buy'))) return 'join'
  if (logs.some(l => l.includes('Instruction: Sell') || l.includes('Program log: Sell'))) return 'defect'
  if (logs.some(l => l.includes('Instruction: Star') || l.includes('star'))) return 'rally'
  if (logs.some(l => l.includes('Instruction: Borrow') || l.includes('borrow'))) return 'war_loan'
  if (logs.some(l => l.includes('Instruction: Repay') || l.includes('repay'))) return 'repay_loan'
  if (logs.some(l => l.includes('Instruction: Liquidate') || l.includes('liquidate'))) return 'siege'
  if (logs.some(l => l.includes('Instruction: Migrate') || l.includes('migrate'))) return 'ascend'
  if (logs.some(l => l.includes('Instruction: ReclaimFailedToken') || l.includes('reclaim'))) return 'raze'
  if (logs.some(l => l.includes('Instruction: HarvestFees') || l.includes('SwapFeesToSol') || l.includes('harvest'))) return 'tithe'
  if (logs.some(l => l.includes('Instruction: DepositVault') || l.includes('deposit_vault'))) return 'fund'
  return 'unknown'
}

function extractMemo(tx: ParsedTransactionWithMeta): string | undefined {
  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions),
  ]
  for (const ix of allInstructions) {
    const programId = 'programId' in ix ? ix.programId.toString() : ''
    const programName = 'program' in ix ? (ix as any).program : ''
    if (MEMO_PROGRAM_IDS.has(programId) || programName === 'spl-memo') {
      if ('parsed' in ix) {
        const text = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
        if (text?.trim()) return text.trim()
      }
    }
  }
  return undefined
}

// ─── Weight Computation ──────────────────────────────────────────

function normalizeAction(action: OnChainAction['action']): Action {
  switch (action) {
    case 'dex_buy': return 'join'
    case 'dex_sell': return 'defect'
    case 'fund': return 'stronghold'
    case 'unknown': return 'join'
    default: return action
  }
}

export function computeWeights(history: OnChainAction[], seedPersonality: Personality, decay = 0.85): number[] {
  const seed = [...PERSONALITY_WEIGHTS[seedPersonality]]
  if (history.length === 0) return seed

  const counts = new Array(ALL_ACTIONS.length).fill(0)
  for (const entry of history) {
    const idx = ALL_ACTIONS.indexOf(normalizeAction(entry.action))
    if (idx >= 0) counts[idx]++
  }

  const total = counts.reduce((a: number, b: number) => a + b, 0)
  if (total === 0) return seed

  const observed = counts.map((c: number) => c / total)
  const n = total
  const seedFactor = Math.pow(decay, n)

  return seed.map((s, i) => s * seedFactor + observed[i] * (1 - seedFactor))
}

/**
 * Recompute weights from raw action counts (no history parsing needed).
 * Used for live personality evolution during runtime.
 */
export function weightsFromCounts(
  counts: number[],
  seedPersonality: Personality,
  decay = 0.85,
): number[] {
  const seed = [...PERSONALITY_WEIGHTS[seedPersonality]]
  const total = counts.reduce((a: number, b: number) => a + b, 0)
  if (total === 0) return seed

  const observed = counts.map((c: number) => c / total)
  const seedFactor = Math.pow(decay, total)
  return seed.map((s, i) => s * seedFactor + observed[i] * (1 - seedFactor))
}

/** Action type to index in the ALL_ACTIONS array */
export function actionIndex(action: Action): number {
  return ALL_ACTIONS.indexOf(action)
}

// ─── Memo Content Personality Signals ─────────────────────────────

// Keywords that signal personality from memo content
const PROVOCATEUR_VOICE = /trash|beef|fight|chaos|war|destroy|crush|pathetic|laughable|weak|dead|fake|scam|clown|joke|fool|coward|expose|call.?out|dare|challenge|predict|bold|hot.?take/
const SCOUT_VOICE = /intel|data|notice|observ|suspicious|watch|track|report|warn|alert|question|why did|who.?s|pattern|trend|%|percent|member|holder|accumul/
const LOYALIST_VOICE = /ride.?or.?die|loyal|hold|believe|strong|build|together|ally|alliance|trust|support|back|hype|power|conviction|never.?sell|diamond/
const MERCENARY_VOICE = /profit|alpha|flip|exit|dump|cash|roi|returns|opportunity|play|angle|trade|stack|bag|gain|solo|lone.?wolf/
const WHALE_VOICE = /flex|position|size|deploy|capital|market|move|massive|big|dominate|everyone.?watch|listen|whale|stack|load/

/**
 * Score personality signals from memo content.
 * Returns per-personality scores from keyword analysis of the agent's own messages.
 */
function scoreMemoPersonality(memos: string[]): Record<Personality, number> {
  const scores: Record<Personality, number> = {
    loyalist: 0, mercenary: 0, provocateur: 0, scout: 0, whale: 0,
  }

  for (const memo of memos) {
    const text = memo.toLowerCase()
    if (PROVOCATEUR_VOICE.test(text)) scores.provocateur++
    if (SCOUT_VOICE.test(text)) scores.scout++
    if (LOYALIST_VOICE.test(text)) scores.loyalist++
    if (MERCENARY_VOICE.test(text)) scores.mercenary++
    if (WHALE_VOICE.test(text)) scores.whale++
  }

  return scores
}

/**
 * Classify personality from observed action distribution + memo content.
 *
 * Uses signature action ratios (not cosine similarity, which collapses
 * everything to loyalist/whale since all profiles share "join" as dominant).
 *
 * Two signal sources, blended:
 *   1. Action ratios — what the agent DOES
 *   2. Memo keywords — what the agent SAYS
 *
 * Action indices: [join=0, defect=1, rally=2, launch=3, message=4,
 *   stronghold=5, war_loan=6, repay_loan=7, siege=8, ascend=9,
 *   raze=10, tithe=11, infiltrate=12, fud=13]
 */
/**
 * Score a single action set (per-faction or global) into personality scores.
 */
/**
 * Build the personality classification prompt for the LLM.
 * Includes per-faction action breakdown and recent memos.
 */
function buildClassifyPrompt(
  weights: number[],
  memos: string[],
  perFactionHistory?: Map<string, number[]>,
  factionNames?: Map<string, string>,
): string {
  const total = weights.reduce((a, b) => a + b, 0)
  const r = total > 0 ? weights.map(w => ((w / total) * 100).toFixed(1) + '%') : weights.map(() => '0%')

  let actionSummary = `Overall action distribution:\n`
  actionSummary += `  join: ${r[0]}, defect: ${r[1]}, rally: ${r[2]}, launch: ${r[3]}, message: ${r[4]}\n`
  actionSummary += `  stronghold: ${r[5]}, war_loan: ${r[6]}, repay_loan: ${r[7]}, siege: ${r[8]}\n`
  actionSummary += `  ascend: ${r[9]}, raze: ${r[10]}, tithe: ${r[11]}, infiltrate: ${r[12]}, fud: ${r[13]}\n`

  if (perFactionHistory && perFactionHistory.size > 0) {
    actionSummary += `\nPer-faction breakdown:\n`
    for (const [mint, counts] of perFactionHistory) {
      const fTotal = counts.reduce((a, b) => a + b, 0)
      if (fTotal < 2) continue
      const name = factionNames?.get(mint) ?? mint.slice(0, 8)
      const fr = counts.map(c => c)
      actionSummary += `  ${name}: join=${fr[0]} defect=${fr[1]} rally=${fr[2]} message=${fr[4]} fud=${fr[13]} (${fTotal} total)\n`
    }
  }

  const recentMemos = memos.slice(-150)
  const memoBlock = recentMemos.length > 0
    ? `\nThis agent's last ${recentMemos.length} messages (oldest first):\n${recentMemos.map((m, i) => `  ${i + 1}. "${m}"`).join('\n')}`
    : '\nNo messages from this agent.'

  return `You are classifying an autonomous agent's personality based on its on-chain behavior and messages.

Personalities (all 5 should be roughly equally common across a population of agents — do NOT over-index on any single type):
- loyalist: Committed to their factions. Positive, supportive messages. Builds community. Sticks around.
- mercenary: Profit-driven. Moves between factions opportunistically. Self-serving messages. Not necessarily hostile — just always looking for the next edge.
- provocateur: Stirs the pot. Confrontational, inflammatory, loves drama. Challenges others and starts beef.
- scout: Observant and analytical. Comments on movements, asks questions, shares intel. Thoughtful rather than aggressive.
- whale: Actions speak louder than words. Trades heavily but communicates sparingly. When they do speak, it's brief and direct.

IMPORTANT: These are roughly equal archetypes — most agents will have mixed signals. Pick the BEST fit, not the most dramatic match. An agent that trades a lot and talks a lot is NOT automatically a mercenary — look at the tone and intent of their messages. Mercenary requires a CLEAR pattern of faction-hopping for profit. If an agent is active in comms, consider scout or provocateur first — scout if they're observational/curious, provocateur if they're confrontational/dramatic. Only pick mercenary if the agent is clearly self-serving and opportunistic above all else.

Agent behavior data:
${actionSummary}
${memoBlock}

Based on the action patterns AND message content/tone, classify this agent.
Respond with ONLY a single word: loyalist, mercenary, provocateur, scout, or whale.`
}

/**
 * LLM-based personality classification.
 * Falls back to formula scoring if LLM is unavailable.
 */
export async function classifyPersonality(
  weights: number[],
  memos: string[],
  perFactionHistory?: Map<string, number[]>,
  llmGenerate?: (prompt: string) => Promise<string | null>,
  factionNames?: Map<string, string>,
): Promise<Personality> {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 'loyalist'

  // Try LLM classification first
  if (llmGenerate) {
    try {
      const prompt = buildClassifyPrompt(weights, memos, perFactionHistory, factionNames)
      const response = await llmGenerate(prompt)
      if (response) {
        const cleaned = response.toLowerCase().replace(/[^a-z]/g, '').trim()
        const valid: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
        const match = valid.find(p => cleaned.includes(p))
        if (match) return match
      }
    } catch { /* fall through to formula */ }
  }

  // Fallback: formula-based scoring
  return classifyPersonalityFormula(weights, memos, perFactionHistory)
}

/** Formula-based fallback for personality classification */
function classifyPersonalityFormula(
  weights: number[],
  memos: string[],
  perFactionHistory?: Map<string, number[]>,
): Personality {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 'loyalist'

  const r = weights.map(w => w / total)
  const joinRate = r[0], defectRate = r[1], rallyRate = r[2], messageRate = r[4]
  const warLoanRate = r[6], siegeRate = r[8], titheRate = r[11]
  const infiltrateRate = r[12], fudRate = r[13]
  const commsRate = messageRate + fudRate
  const tradeRate = joinRate + defectRate
  const fudRatio = commsRate > 0 ? fudRate / commsRate : 0
  const msgRatio = commsRate > 0 ? messageRate / commsRate : 0

  const scores: Record<Personality, number> = {
    loyalist: msgRatio * 3 + joinRate * 2 + rallyRate * 3 + titheRate * 2
      - fudRatio * 3 - defectRate * 2,
    mercenary: defectRate * 3 + infiltrateRate * 3
      + warLoanRate * 2 + siegeRate * 2
      - msgRatio * 2 - rallyRate * 2,
    provocateur: fudRatio * 4 + infiltrateRate * 2 + defectRate * 1.5
      - msgRatio * 1 - rallyRate * 1,
    scout: msgRatio * 4 + rallyRate * 2 - fudRatio * 2 - defectRate,
    whale: (tradeRate > commsRate ? 1 : 0) * 2 + warLoanRate * 3 + defectRate * 2
      - commsRate * 3,
  }

  // Blend with memo keyword scores
  const memoScores = scoreMemoPersonality(memos)
  const memoTotal = Object.values(memoScores).reduce((a, b) => a + b, 0)

  let best: Personality = 'loyalist'
  let bestScore = -Infinity
  for (const p of Object.keys(scores) as Personality[]) {
    const blended = scores[p] * 0.6 + (memoTotal > 0 ? (memoScores[p] / memoTotal) * 0.4 : 0)
    if (blended > bestScore) {
      bestScore = blended
      best = p
    }
  }
  return best
}

// ─── Sentiment ───────────────────────────────────────────────────

const POSITIVE = /strong|rally|bull|pump|rising|hold|loyal|power|growing|moon|love|trust|alpha|build|conviction/
const NEGATIVE = /weak|dump|bear|dead|fail|raze|crash|abandon|scam|rug|sell|exit|trash|hate|fake/

function computeSentiment(history: OnChainAction[]): Map<string, number> {
  const sentiment = new Map<string, number>()
  for (const entry of history) {
    if (!entry.mint) continue
    const current = sentiment.get(entry.mint) ?? 0
    let delta = 0
    switch (entry.action) {
      case 'join': case 'dex_buy': delta = 1; break
      case 'defect': case 'dex_sell': delta = -2; break
      case 'rally': delta = 3; break
      case 'message': delta = 0.5; break
      case 'fud': delta = -1.5; break
      case 'war_loan': delta = 1; break
    }
    if (entry.memo) {
      const text = entry.memo.toLowerCase()
      if (POSITIVE.test(text)) delta += 0.5
      if (NEGATIVE.test(text)) delta -= 0.5
    }
    sentiment.set(entry.mint, Math.max(-10, Math.min(10, current + delta)))
  }
  return sentiment
}

// ─── Full Reconstruction ─────────────────────────────────────────

export async function reconstructFromChain(
  connection: Connection,
  agentPubkey: string,
  factions: FactionInfo[],
  seedPersonality: Personality,
  maxSignatures = 500,
  llmGenerate?: (prompt: string) => Promise<string | null>,
): Promise<ChainDerivedState> {
  const knownMints = new Set(factions.map(f => f.mint))
  const history = await fetchAgentHistory(connection, agentPubkey, knownMints, maxSignatures)

  const weights = computeWeights(history, seedPersonality)
  const memoTexts = history.filter(h => h.memo?.trim()).map(h => h.memo!)

  // Build per-faction action counts for per-ticker personality scoring
  const perFaction = new Map<string, number[]>()
  for (const entry of history) {
    if (!entry.mint) continue
    const normalized = normalizeAction(entry.action)
    const idx = ALL_ACTIONS.indexOf(normalized)
    if (idx < 0) continue
    if (!perFaction.has(entry.mint)) perFaction.set(entry.mint, new Array(ALL_ACTIONS.length).fill(0))
    perFaction.get(entry.mint)![idx]++
  }

  // Map mint → symbol for readable LLM prompts
  const factionNames = new Map<string, string>()
  for (const f of factions) factionNames.set(f.mint, f.symbol)

  const personality = history.length > 0
    ? await classifyPersonality(weights, memoTexts, perFaction, llmGenerate, factionNames)
    : seedPersonality
  const sentiment = computeSentiment(history)

  const founded = history.filter(h => h.action === 'launch' && h.mint).map(h => h.mint!)

  const memories = history
    .filter(h => h.memo && h.memo.trim().length > 0)
    .map(h => {
      const faction = h.mint
        ? factions.find(f => f.mint === h.mint)?.symbol ?? h.mint.slice(0, 8)
        : '???'
      const action = h.action === 'join' || h.action === 'dex_buy' ? 'joined'
        : h.action === 'defect' || h.action === 'dex_sell' ? 'defected'
        : h.action === 'fud' ? 'fudded' : h.action === 'message' ? 'said' : h.action
      return `${action} ${faction}: "${h.memo}"`
    })

  const recentHistory = history.slice(-15).map(h => {
    const faction = h.mint
      ? factions.find(f => f.mint === h.mint)?.symbol ?? h.mint.slice(0, 8)
      : '?'
    const memo = h.memo ? ` — "${h.memo.slice(0, 60)}"` : ''
    return `${h.action} ${faction}${memo}`
  })

  return {
    weights,
    personality,
    sentiment,
    allies: new Set<string>(),
    rivals: new Set<string>(),
    actionCount: history.length,
    recentHistory,
    founded,
    memories,
  }
}
