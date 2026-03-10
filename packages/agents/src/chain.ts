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
    const signatures = await connection.getSignaturesForAddress(
      pubkey, { limit: batchSize, before }, 'confirmed',
    )
    if (signatures.length === 0) break
    fetched += signatures.length
    before = signatures[signatures.length - 1].signature

    const BATCH_SIZE = 100
    for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
      const batch = signatures.slice(i, i + BATCH_SIZE)
      let txs: (ParsedTransactionWithMeta | null)[]
      try {
        txs = await connection.getParsedTransactions(
          batch.map(s => s.signature),
          { maxSupportedTransactionVersion: 0 },
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

  const action = categorizeFromLogs(logs)
  const mint = accountKeys.find(k => knownMints.has(k))
  const memo = extractMemo(tx)

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

function computeWeights(history: OnChainAction[], seedPersonality: Personality, decay = 0.85): number[] {
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

function classifyPersonality(weights: number[]): Personality {
  const personalities: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
  let best: Personality = 'loyalist'
  let bestSim = -1

  for (const p of personalities) {
    const profile = PERSONALITY_WEIGHTS[p]
    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < weights.length; i++) {
      dot += weights[i] * profile[i]
      magA += weights[i] * weights[i]
      magB += profile[i] * profile[i]
    }
    const sim = Math.sqrt(magA) * Math.sqrt(magB) > 0
      ? dot / (Math.sqrt(magA) * Math.sqrt(magB))
      : 0
    if (sim > bestSim) { bestSim = sim; best = p }
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
): Promise<ChainDerivedState> {
  const knownMints = new Set(factions.map(f => f.mint))
  const history = await fetchAgentHistory(connection, agentPubkey, knownMints, maxSignatures)

  const weights = computeWeights(history, seedPersonality)
  const personality = history.length > 0 ? classifyPersonality(weights) : seedPersonality
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
