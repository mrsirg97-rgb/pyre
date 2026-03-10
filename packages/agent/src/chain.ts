/**
 * On-Chain State Reconstruction
 *
 * Derives agent personality, sentiment, allies/rivals, and memory
 * entirely from on-chain transaction history. The blockchain IS the
 * agent's state — this module reads it back.
 *
 * Flow:
 *   1. Fetch all tx signatures for agent wallet
 *   2. Batch-parse transactions to extract action types + memos
 *   3. Compute personality weights from action frequency distribution
 *   4. Derive sentiment from buy/sell patterns + memo analysis
 *   5. Derive allies/rivals from shared faction interactions
 *   6. Extract agent's own memos as persistent memory
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js'
import { PERSONALITY_WEIGHTS, PERSONALITY_SOL } from './defaults'
import type { Action, Personality, FactionInfo, OnChainAction, ChainDerivedState } from './types'

// Torch Market program ID
const TORCH_PROGRAM_ID = '8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT'
const MEMO_PROGRAM_IDS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
])

const ALL_ACTIONS: Action[] = [
  'join', 'defect', 'rally', 'launch', 'message',
  'stronghold', 'war_loan', 'repay_loan', 'siege', 'ascend', 'raze', 'tithe',
  'infiltrate', 'fud',
]

// ─── Transaction Fetching ────────────────────────────────────────

/**
 * Fetch all Torch Market transactions for an agent wallet.
 * Paginates through signature history and batch-fetches parsed txs.
 */
export async function fetchAgentHistory(
  connection: Connection,
  agentPubkey: string,
  knownMints: Set<string>,
  opts?: { maxSignatures?: number },
): Promise<OnChainAction[]> {
  const pubkey = new PublicKey(agentPubkey)
  const maxSigs = opts?.maxSignatures ?? 500
  const allActions: OnChainAction[] = []

  // Paginate through signature history
  let before: string | undefined
  let fetched = 0

  while (fetched < maxSigs) {
    const batchSize = Math.min(maxSigs - fetched, 1000)
    const signatures = await connection.getSignaturesForAddress(
      pubkey,
      { limit: batchSize, before },
      'confirmed',
    )

    if (signatures.length === 0) break
    fetched += signatures.length
    before = signatures[signatures.length - 1].signature

    // Batch fetch parsed transactions (100 per RPC call)
    const BATCH_SIZE = 100
    for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
      const batch = signatures.slice(i, i + BATCH_SIZE)
      const sigStrings = batch.map(s => s.signature)

      let txs: (ParsedTransactionWithMeta | null)[]
      try {
        txs = await connection.getParsedTransactions(sigStrings, {
          maxSupportedTransactionVersion: 0,
        })
      } catch {
        continue
      }

      for (let j = 0; j < txs.length; j++) {
        const tx = txs[j]
        if (!tx?.meta || tx.meta.err) continue

        const parsed = parseTransaction(tx, batch[j].signature, batch[j].blockTime ?? 0, agentPubkey, knownMints)
        if (parsed) allActions.push(parsed)
      }
    }
  }

  // Sort chronologically (oldest first)
  allActions.sort((a, b) => a.timestamp - b.timestamp)
  return allActions
}

// ─── Transaction Parsing ─────────────────────────────────────────

/**
 * Parse a single transaction into a game action.
 * Uses program logs to determine instruction type, extracts memo and mint.
 */
function parseTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string,
  timestamp: number,
  agentPubkey: string,
  knownMints: Set<string>,
): OnChainAction | null {
  const logs = tx.meta?.logMessages ?? []
  const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString())

  // Check if this tx involves the Torch program
  const isTorchTx = accountKeys.includes(TORCH_PROGRAM_ID) ||
    logs.some(l => l.includes(TORCH_PROGRAM_ID))
  if (!isTorchTx) return null

  // Determine action type from logs
  let action = categorizeFromLogs(logs)

  // Find faction mint from account keys
  const mint = findMintInAccounts(accountKeys, knownMints)

  // Extract memo
  const memo = extractMemo(tx)

  // Buy + memo = message (micro buy with text), sell + memo = fud (micro sell with text)
  if (memo?.trim()) {
    if (action === 'join' || action === 'dex_buy') action = 'message'
    else if (action === 'defect' || action === 'dex_sell') action = 'fud'
  }

  // Find other agents (signers that aren't this agent)
  const otherAgents = tx.transaction.message.accountKeys
    .filter(k => k.signer && k.pubkey.toString() !== agentPubkey)
    .map(k => k.pubkey.toString())

  return { signature, timestamp, action, mint, memo, otherAgents }
}

/**
 * Categorize transaction type from Anchor program logs.
 */
function categorizeFromLogs(logs: string[]): OnChainAction['action'] {
  const logStr = logs.join(' ')

  // Order matters — check specific instructions before generic ones
  if (logs.some(l => l.includes('Instruction: CreateToken') || l.includes('create_token'))) return 'launch'
  if (logs.some(l => l.includes('Instruction: CreateVault') || l.includes('create_vault'))) return 'stronghold'

  // VaultSwap can be buy or sell — check for direction hints in logs
  if (logs.some(l => l.includes('Instruction: VaultSwap') || l.includes('vault_swap'))) {
    // VaultSwap logs typically include buy/sell direction
    if (logStr.includes('is_buy: true') || logStr.includes('Buy')) return 'dex_buy'
    if (logStr.includes('is_buy: false') || logStr.includes('Sell')) return 'dex_sell'
    return 'dex_buy' // default to buy if unclear
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

/**
 * Find a known faction mint in transaction account keys.
 */
function findMintInAccounts(accountKeys: string[], knownMints: Set<string>): string | undefined {
  for (const key of accountKeys) {
    if (knownMints.has(key)) return key
  }
  return undefined
}

/**
 * Extract SPL Memo text from a transaction.
 */
function extractMemo(tx: ParsedTransactionWithMeta): string | undefined {
  for (const ix of tx.transaction.message.instructions) {
    const programId = 'programId' in ix ? ix.programId.toString() : ''
    const programName = 'program' in ix ? (ix as any).program : ''

    if (MEMO_PROGRAM_IDS.has(programId) || programName === 'spl-memo') {
      if ('parsed' in ix) {
        const text = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
        if (text?.trim()) return text.trim()
      }
    }
  }

  // Also check inner instructions
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const programId = 'programId' in ix ? ix.programId.toString() : ''
      const programName = 'program' in ix ? (ix as any).program : ''

      if (MEMO_PROGRAM_IDS.has(programId) || programName === 'spl-memo') {
        if ('parsed' in ix) {
          const text = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
          if (text?.trim()) return text.trim()
        }
      }
    }
  }

  return undefined
}

// ─── Weight Computation ──────────────────────────────────────────

/**
 * Compute personality weights from on-chain action history.
 *
 * Uses exponential decay blending:
 *   finalWeight = seed × decay^n + observed × (1 - decay^n)
 *
 * Where n = total action count. This means:
 *   n=0  → 100% seed weights (new agent)
 *   n=10 → ~80% observed, ~20% seed
 *   n=50 → ~99.9% observed
 *
 * The agent quickly becomes defined by its actual behavior.
 */
export function computeWeightsFromHistory(
  history: OnChainAction[],
  seedPersonality: Personality,
  decay = 0.85,
): number[] {
  const seed = [...PERSONALITY_WEIGHTS[seedPersonality]]

  if (history.length === 0) return seed

  // Count occurrences of each action type
  const counts = new Array(ALL_ACTIONS.length).fill(0)

  for (const entry of history) {
    const action = normalizeChainAction(entry.action)
    const idx = ALL_ACTIONS.indexOf(action)
    if (idx >= 0) counts[idx]++
  }

  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return seed

  // Compute observed frequency distribution
  const observed = counts.map(c => c / total)

  // Blend seed with observed using exponential decay
  const n = total
  const seedFactor = Math.pow(decay, n)
  const observedFactor = 1 - seedFactor

  return seed.map((s, i) => s * seedFactor + observed[i] * observedFactor)
}

/**
 * Normalize chain action types to standard Action types.
 * dex_buy → join, dex_sell → defect, etc.
 */
function normalizeChainAction(action: OnChainAction['action']): Action {
  switch (action) {
    case 'dex_buy': return 'join'
    case 'dex_sell': return 'defect'
    case 'fund': return 'stronghold'
    case 'unknown': return 'join' // safe fallback
    default: return action
  }
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
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return seed

  const observed = counts.map(c => c / total)
  const seedFactor = Math.pow(decay, total)
  return seed.map((s, i) => s * seedFactor + observed[i] * (1 - seedFactor))
}

/** Action type to index in the ALL_ACTIONS array */
export function actionIndex(action: Action): number {
  return ALL_ACTIONS.indexOf(action)
}

// ─── Memo Content Personality Signals ─────────────────────────────

const PROVOCATEUR_VOICE = /trash|beef|fight|chaos|war|destroy|crush|pathetic|laughable|weak|dead|fake|scam|clown|joke|fool|coward|expose|call.?out|dare|challenge|predict|bold|hot.?take/
const SCOUT_VOICE = /intel|data|notice|observ|suspicious|watch|track|report|warn|alert|question|why did|who.?s|pattern|trend|%|percent|member|holder|accumul/
const LOYALIST_VOICE = /ride.?or.?die|loyal|hold|believe|strong|build|together|ally|alliance|trust|support|back|hype|power|conviction|never.?sell|diamond/
const MERCENARY_VOICE = /profit|alpha|flip|exit|dump|cash|roi|returns|opportunity|play|angle|trade|stack|bag|gain|solo|lone.?wolf/
const WHALE_VOICE = /flex|position|size|deploy|capital|market|move|massive|big|dominate|everyone.?watch|listen|whale|stack|load/

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

// ─── Personality Classification ──────────────────────────────────

/**
 * Classify personality from observed action distribution + memo content.
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
function scoreActions(r: number[]): Record<Personality, number> {
  const joinRate = r[0], defectRate = r[1], rallyRate = r[2], messageRate = r[4]
  const warLoanRate = r[6], siegeRate = r[8], titheRate = r[11]
  const infiltrateRate = r[12], fudRate = r[13]

  const commsRate = messageRate + fudRate
  const tradeRate = joinRate + defectRate

  return {
    // Loyalist: joins + messages (buys in and hypes), rarely defects/fuds
    loyalist: joinRate * 4 + messageRate * 5 + rallyRate * 4 + titheRate * 3
      - fudRate * 5 - defectRate * 4 - infiltrateRate * 3,

    // Mercenary: the infiltration cycle — join + fud + defect in the same faction
    // Key signal: defect AND fud both present (provocateurs fud but stay, mercenaries dump)
    mercenary: defectRate * 4 + fudRate * 3
      + (defectRate > 0 && fudRate > 0 ? 3 : 0) // bonus for the full infiltration cycle
      + infiltrateRate * 3 + warLoanRate * 2 + siegeRate * 2
      - messageRate * 2 - rallyRate * 3 - titheRate * 2,

    // Provocateur: high fud, stirs chaos
    provocateur: fudRate * 5 + messageRate * 2 + infiltrateRate * 2
      - joinRate - rallyRate * 2 - titheRate,

    // Scout: messages but rarely fuds (intel, observations)
    scout: messageRate * 4 + rallyRate - fudRate * 3 - defectRate
      - infiltrateRate,

    // Whale: trades a lot but talks very little
    whale: (tradeRate > commsRate ? 1 : 0) * 2 + warLoanRate * 3 + defectRate * 2
      - messageRate * 3 - fudRate * 3,
  }
}

export function classifyPersonality(weights: number[], memos: string[] = [], perFactionHistory?: Map<string, number[]>): Personality {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 'loyalist'

  // ── Signal 1: per-faction action scores, averaged ──
  let actionScores: Record<Personality, number>

  if (perFactionHistory && perFactionHistory.size > 0) {
    const accumulated: Record<Personality, number> = {
      loyalist: 0, mercenary: 0, provocateur: 0, scout: 0, whale: 0,
    }
    let factionCount = 0

    for (const [, counts] of perFactionHistory) {
      const fTotal = counts.reduce((a, b) => a + b, 0)
      if (fTotal < 2) continue
      const r = counts.map(c => c / fTotal)
      const scores = scoreActions(r)
      for (const p of Object.keys(accumulated) as Personality[]) {
        accumulated[p] += scores[p]
      }
      factionCount++
    }

    if (factionCount > 0) {
      for (const p of Object.keys(accumulated) as Personality[]) {
        accumulated[p] /= factionCount
      }
      actionScores = accumulated
    } else {
      const r = weights.map(w => w / total)
      actionScores = scoreActions(r)
    }
  } else {
    const r = weights.map(w => w / total)
    actionScores = scoreActions(r)
  }

  // ── Signal 2: memo content ──
  const memoScores = scoreMemoPersonality(memos)
  const memoTotal = Object.values(memoScores).reduce((a, b) => a + b, 0)
  const memoWeight = 0.4

  // ── Blend ──
  const finalScores: Record<Personality, number> = {
    loyalist: 0, mercenary: 0, provocateur: 0, scout: 0, whale: 0,
  }

  for (const p of Object.keys(finalScores) as Personality[]) {
    const actionSignal = actionScores[p]
    const memoSignal = memoTotal > 0 ? (memoScores[p] / memoTotal) : 0
    finalScores[p] = actionSignal * (1 - memoWeight) + memoSignal * memoWeight
  }

  let best: Personality = 'loyalist'
  let bestScore = -Infinity
  for (const [p, score] of Object.entries(finalScores)) {
    if (score > bestScore) {
      bestScore = score
      best = p as Personality
    }
  }
  return best
}

// ─── Sentiment from On-Chain Data ────────────────────────────────

const POSITIVE_PATTERN = /strong|rally|bull|pump|rising|hold|loyal|power|growing|moon|love|trust|alpha|build|conviction/
const NEGATIVE_PATTERN = /weak|dump|bear|dead|fail|raze|crash|abandon|scam|rug|sell|exit|trash|hate|fake/

/**
 * Compute sentiment towards factions from on-chain interaction patterns.
 *
 * Sentiment signals:
 *   - Buys (join/dex_buy/message) → +1 per tx
 *   - Sells (defect/dex_sell/fud) → -2 per tx (sells signal stronger negative)
 *   - Rally → +3 (strong conviction signal)
 *   - Infiltrate → -5 (explicitly hostile)
 *   - Memo keywords → ±1
 *
 * Clamped to [-10, +10].
 */
export function computeSentimentFromHistory(
  history: OnChainAction[],
  factions: FactionInfo[],
): Map<string, number> {
  const sentiment = new Map<string, number>()

  for (const entry of history) {
    if (!entry.mint) continue

    const current = sentiment.get(entry.mint) ?? 0
    let delta = 0

    switch (entry.action) {
      case 'join':
      case 'dex_buy':
        delta = 1
        break
      case 'defect':
      case 'dex_sell':
        delta = -2
        break
      case 'rally':
        delta = 3
        break
      case 'infiltrate':
        delta = -5
        break
      case 'message':
        delta = 0.5 // slight positive (paid to speak)
        break
      case 'fud':
        delta = -1.5
        break
      case 'war_loan':
        delta = 1 // leveraging = bullish
        break
    }

    // Memo sentiment analysis
    if (entry.memo) {
      const text = entry.memo.toLowerCase()
      if (POSITIVE_PATTERN.test(text)) delta += 0.5
      if (NEGATIVE_PATTERN.test(text)) delta -= 0.5
    }

    sentiment.set(entry.mint, Math.max(-10, Math.min(10, current + delta)))
  }

  return sentiment
}

// ─── Ally/Rival Detection ────────────────────────────────────────

/**
 * Derive allies and rivals from on-chain interactions.
 *
 * Ally signals:
 *   - Other agents who bought into the same factions the agent holds
 *   - Other agents whose memos in shared factions are positive
 *
 * Rival signals:
 *   - Agents who sold from factions the agent holds
 *   - Agents whose memos in shared factions are negative
 *   - Agents present in factions the agent infiltrated
 */
export function deriveAlliesRivals(
  agentHistory: OnChainAction[],
  factionComms: Map<string, { sender: string, memo: string }[]>,
  heldMints: Set<string>,
): { allies: Set<string>, rivals: Set<string> } {
  const allyScore = new Map<string, number>()
  const rivalScore = new Map<string, number>()

  // Score from faction comms (other agents' messages in held factions)
  for (const [mint, comms] of factionComms) {
    if (!heldMints.has(mint)) continue

    for (const c of comms) {
      const text = c.memo.toLowerCase()
      if (POSITIVE_PATTERN.test(text)) {
        allyScore.set(c.sender, (allyScore.get(c.sender) ?? 0) + 1)
      }
      if (NEGATIVE_PATTERN.test(text)) {
        rivalScore.set(c.sender, (rivalScore.get(c.sender) ?? 0) + 1)
      }
    }
  }

  // Convert scores to sets (threshold: net positive → ally, net negative → rival)
  const allies = new Set<string>()
  const rivals = new Set<string>()

  const allAgents = new Set([...allyScore.keys(), ...rivalScore.keys()])
  for (const agent of allAgents) {
    const aScore = allyScore.get(agent) ?? 0
    const rScore = rivalScore.get(agent) ?? 0
    if (aScore > rScore) allies.add(agent)
    else if (rScore > aScore) rivals.add(agent)
  }

  return { allies, rivals }
}

// ─── SOL Range Derivation ────────────────────────────────────────

/**
 * Derive SOL spending range from actual transaction history.
 * Falls back to personality defaults if no buy history exists.
 */
export function deriveSolRange(
  _history: OnChainAction[],
  personality: Personality,
): [number, number] {
  // For now, we keep the personality-based ranges as they represent
  // risk tolerance. In the future, this could analyze actual tx amounts
  // from the parsed transaction data (lamports in/out).
  // The current torchsdk doesn't expose lamport amounts in parsed tx data,
  // so we'd need to decode inner instructions to extract this.
  return PERSONALITY_SOL[personality]
}

// ─── Memory Extraction ──────────────────────────────────────────

/**
 * Extract the agent's own memos as persistent memory.
 * These are messages the agent wrote on-chain — its thoughts,
 * trash talk, and strategic communications.
 */
export function extractMemories(history: OnChainAction[]): string[] {
  return history
    .filter(h => h.memo && h.memo.trim().length > 0)
    .map(h => {
      const faction = h.mint ? h.mint.slice(0, 8) : '???'
      const time = new Date(h.timestamp * 1000).toISOString().slice(0, 10)
      const action = h.action === 'join' || h.action === 'dex_buy' ? 'joined'
        : h.action === 'defect' || h.action === 'dex_sell' ? 'defected'
        : h.action === 'fud' ? 'fudded'
        : h.action === 'message' ? 'said'
        : h.action
      return `[${time}] ${action} ${faction}: "${h.memo}"`
    })
}

// ─── Full State Reconstruction ──────────────────────────────────

/**
 * Reconstruct full agent state from on-chain history.
 *
 * This is the main entry point. Call on startup to derive
 * personality, weights, sentiment, allies/rivals, and memory
 * entirely from the blockchain. No JSON files needed.
 */
export async function reconstructFromChain(
  connection: Connection,
  agentPubkey: string,
  factions: FactionInfo[],
  seedPersonality: Personality,
  opts?: {
    maxSignatures?: number
    decay?: number
    factionComms?: Map<string, { sender: string, memo: string }[]>
  },
): Promise<ChainDerivedState> {
  const knownMints = new Set(factions.map(f => f.mint))

  // 1. Fetch on-chain history
  const history = await fetchAgentHistory(connection, agentPubkey, knownMints, {
    maxSignatures: opts?.maxSignatures,
  })

  // 2. Compute personality weights from action frequency
  const weights = computeWeightsFromHistory(history, seedPersonality, opts?.decay)

  // 3. Classify emergent personality (action ratios + memo content, per-faction)
  const memoTexts = history.filter(h => h.memo?.trim()).map(h => h.memo!)

  // Build per-faction action counts for per-ticker personality scoring
  const perFaction = new Map<string, number[]>()
  for (const entry of history) {
    if (!entry.mint) continue
    const normalized = normalizeChainAction(entry.action)
    const idx = ALL_ACTIONS.indexOf(normalized)
    if (idx < 0) continue
    if (!perFaction.has(entry.mint)) perFaction.set(entry.mint, new Array(ALL_ACTIONS.length).fill(0))
    perFaction.get(entry.mint)![idx]++
  }

  const personality = history.length > 0 ? classifyPersonality(weights, memoTexts, perFaction) : seedPersonality

  // 4. Compute sentiment from on-chain interactions
  const sentiment = computeSentimentFromHistory(history, factions)

  // 5. Derive allies/rivals
  const heldMints = new Set<string>()
  const mintBalances = new Map<string, number>()
  for (const entry of history) {
    if (!entry.mint) continue
    const current = mintBalances.get(entry.mint) ?? 0
    if (entry.action === 'join' || entry.action === 'dex_buy' || entry.action === 'message') {
      mintBalances.set(entry.mint, current + 1)
    } else if (entry.action === 'defect' || entry.action === 'dex_sell') {
      mintBalances.set(entry.mint, current - 1)
    }
  }
  for (const [mint, bal] of mintBalances) {
    if (bal > 0) heldMints.add(mint)
  }

  const { allies, rivals } = deriveAlliesRivals(
    history,
    opts?.factionComms ?? new Map(),
    heldMints,
  )

  // 6. Derive SOL range
  const solRange = deriveSolRange(history, personality)

  // 7. Extract memories (agent's own memos)
  const memories = extractMemories(history)

  // 8. Build recent history descriptions
  const recentHistory = history.slice(-15).map(h => {
    const faction = h.mint
      ? factions.find(f => f.mint === h.mint)?.symbol ?? h.mint.slice(0, 8)
      : '?'
    const memoSuffix = h.memo ? ` — "${h.memo.slice(0, 60)}"` : ''
    return `${h.action} ${faction}${memoSuffix}`
  })

  // 9. Find founded factions
  const founded = history
    .filter(h => h.action === 'launch' && h.mint)
    .map(h => h.mint!)

  return {
    weights,
    personality,
    sentiment,
    allies,
    rivals,
    solRange,
    actionCount: history.length,
    recentHistory,
    founded,
    memories,
    history,
  }
}
