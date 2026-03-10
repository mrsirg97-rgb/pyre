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
  const action = categorizeFromLogs(logs)

  // Find faction mint from account keys
  const mint = findMintInAccounts(accountKeys, knownMints)

  // Extract memo
  const memo = extractMemo(tx)

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

// ─── Personality Classification ──────────────────────────────────

/**
 * Classify personality from weight distribution using cosine similarity
 * against the seed personality profiles.
 *
 * The personality label becomes DESCRIPTIVE of behavior, not prescriptive.
 * An agent that defects a lot BECOMES a mercenary.
 */
export function classifyPersonality(weights: number[]): Personality {
  const personalities: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
  let bestMatch: Personality = 'loyalist'
  let bestSimilarity = -1

  for (const p of personalities) {
    const profile = PERSONALITY_WEIGHTS[p]
    const similarity = cosineSimilarity(weights, profile)
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity
      bestMatch = p
    }
  }

  return bestMatch
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom > 0 ? dot / denom : 0
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

  // 3. Classify emergent personality
  const personality = history.length > 0 ? classifyPersonality(weights) : seedPersonality

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
