import { Connection } from '@solana/web3.js'
import { getFactions, isPyreMint, getAgentFactions } from 'pyre-world-kit'

import {
  PyreAgentConfig, PyreAgent, AgentState, AgentTickResult,
  FactionInfo, LLMDecision, SerializedAgentState, ChainDerivedState,
  Personality,
} from './types'
import { PERSONALITY_SOL, assignPersonality } from './defaults'
import { chooseAction, sentimentBuySize } from './action'
import { llmDecide } from './agent'
import { executeAction } from './executor'
import { ensureStronghold } from './stronghold'
import { ensureRegistryProfile } from './registry'
import { reconstructFromChain, weightsFromCounts, classifyPersonality, actionIndex } from './chain'
import { pick, randRange, ts } from './util'

// Re-export public types
export type {
  PyreAgentConfig, PyreAgent, AgentTickResult, SerializedAgentState,
  LLMAdapter, LLMDecision, FactionInfo, Personality, Action, AgentState,
  OnChainAction, ChainDerivedState,
} from './types'

export { assignPersonality, PERSONALITY_SOL, PERSONALITY_WEIGHTS, personalityDesc, VOICE_NUDGES } from './defaults'
export { ensureStronghold } from './stronghold'
export { ensureRegistryProfile } from './registry'
export { sendAndConfirm } from './tx'
export { executeScout, pendingScoutResults } from './agent'
export { reconstructFromChain, computeWeightsFromHistory, classifyPersonality, weightsFromCounts, actionIndex } from './chain'

export async function createPyreAgent(config: PyreAgentConfig): Promise<PyreAgent> {
  const {
    connection, keypair, network, llm,
    maxFoundedFactions = 2,
    strongholdFundSol, strongholdTopupThresholdSol, strongholdTopupReserveSol,
  } = config

  const publicKey = keypair.publicKey.toBase58()
  const seedPersonality = config.personality ?? config.state?.personality ?? assignPersonality()
  const logger = config.logger ?? ((msg: string) => console.log(`[${ts()}] ${msg}`))

  const strongholdOpts = {
    fundSol: strongholdFundSol,
    topupThresholdSol: strongholdTopupThresholdSol,
    topupReserveSol: strongholdTopupReserveSol,
  }

  // Track known factions and used names
  const knownFactions: FactionInfo[] = []
  const usedFactionNames = new Set<string>()
  const recentMessages: string[] = []

  // Runtime action tracking for live personality evolution
  const actionCounts = new Array(14).fill(0)
  const memoBuffer: string[] = []
  const driftScores: Record<Personality, number> = { loyalist: 0, mercenary: 0, provocateur: 0, scout: 0, whale: 0 }
  const DRIFT_THRESHOLD = 3

  // Discover existing factions
  try {
    const result = await getFactions(connection, { limit: 50, sort: 'newest' })
    for (const t of result.factions) {
      if (!isPyreMint(t.mint)) continue
      knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
      usedFactionNames.add(t.name)
    }
    logger(`[${publicKey.slice(0, 8)}] discovered ${knownFactions.length} factions`)
  } catch {
    logger(`[${publicKey.slice(0, 8)}] faction discovery failed`)
  }

  // ─── On-Chain State Reconstruction ───────────────────────────────
  // Derive personality, weights, sentiment, allies/rivals from chain history.
  // Falls back to seed personality + serialized state if chain fetch fails.

  let chainState: ChainDerivedState | null = null
  let personality = seedPersonality
  let dynamicWeights: number[] | undefined
  let solRange = config.solRange ?? PERSONALITY_SOL[seedPersonality]

  try {
    chainState = await reconstructFromChain(
      connection, publicKey, knownFactions, seedPersonality,
      { maxSignatures: 500, llmGenerate: llm ? (p: string) => llm.generate(p) : undefined },
    )

    if (chainState.actionCount > 0) {
      personality = chainState.personality
      dynamicWeights = chainState.weights
      solRange = chainState.solRange

      logger(`[${publicKey.slice(0, 8)}] on-chain reconstruction: ${chainState.actionCount} actions, personality: ${seedPersonality} → ${personality}, memories: ${chainState.memories.length}`)
    } else {
      logger(`[${publicKey.slice(0, 8)}] no on-chain history, using seed personality: ${seedPersonality}`)
    }
  } catch (err: any) {
    logger(`[${publicKey.slice(0, 8)}] chain reconstruction failed (${err.message?.slice(0, 60)}), using fallback state`)
  }

  // Build agent state — chain-derived where available, serialized fallback, fresh default
  const prior = config.state
  const state: AgentState = {
    keypair,
    publicKey,
    personality,
    holdings: new Map(Object.entries(prior?.holdings ?? {})),
    founded: chainState?.founded ?? prior?.founded ?? [],
    rallied: new Set(prior?.rallied ?? []),
    voted: new Set([...(prior?.voted ?? []), ...Object.keys(prior?.holdings ?? {})]),
    hasStronghold: prior?.hasStronghold ?? false,
    vaultCreator: prior?.vaultCreator,
    activeLoans: new Set(prior?.activeLoans ?? []),
    infiltrated: new Set(prior?.infiltrated ?? []),
    // Chain-derived sentiment as baseline, overwritten by serialized if available
    sentiment: chainState && chainState.actionCount > 0
      ? chainState.sentiment
      : new Map(Object.entries(prior?.sentiment ?? {})),
    // Chain-derived allies/rivals as baseline
    allies: chainState && chainState.actionCount > 0
      ? chainState.allies
      : new Set(prior?.allies ?? []),
    rivals: chainState && chainState.actionCount > 0
      ? chainState.rivals
      : new Set(prior?.rivals ?? []),
    actionCount: chainState?.actionCount ?? prior?.actionCount ?? 0,
    lastAction: prior?.lastAction ?? 'none',
    // Chain memories + recent history for LLM context
    recentHistory: chainState && chainState.actionCount > 0
      ? chainState.recentHistory
      : prior?.recentHistory ?? [],
  }

  // Ensure stronghold exists
  await ensureStronghold(connection, state, logger, strongholdOpts)

  // Bootstrap holdings from on-chain token accounts
  try {
    const positions = await getAgentFactions(connection, publicKey)
    for (const pos of positions) {
      state.holdings.set(pos.mint, pos.balance)
      state.voted.add(pos.mint)
    }
    if (positions.length > 0) {
      logger(`[${publicKey.slice(0, 8)}] bootstrapped ${positions.length} holdings from chain`)
    }
  } catch {}

  // Ensure registry profile exists and seed action counts from checkpoint
  const registryProfile = await ensureRegistryProfile(connection, state, logger)
  if (registryProfile) {
    // Seed cumulative action counts from on-chain checkpoint
    // Order matches ALL_ACTIONS: join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud
    const checkpointCounts = [
      registryProfile.joins, registryProfile.defects, registryProfile.rallies,
      registryProfile.launches, registryProfile.messages, registryProfile.reinforces,
      registryProfile.war_loans, registryProfile.repay_loans, registryProfile.sieges,
      registryProfile.ascends, registryProfile.razes, registryProfile.tithes,
      registryProfile.infiltrates, registryProfile.fuds,
    ]
    for (let i = 0; i < checkpointCounts.length; i++) {
      actionCounts[i] = Math.max(actionCounts[i], checkpointCounts[i])
    }
  }

  function serialize(): SerializedAgentState {
    return {
      publicKey: state.publicKey,
      personality: state.personality,
      holdings: Object.fromEntries(state.holdings),
      founded: state.founded,
      rallied: Array.from(state.rallied),
      voted: Array.from(state.voted),
      hasStronghold: state.hasStronghold,
      vaultCreator: state.vaultCreator,
      activeLoans: Array.from(state.activeLoans),
      infiltrated: Array.from(state.infiltrated),
      sentiment: Object.fromEntries(state.sentiment),
      allies: Array.from(state.allies).slice(0, 20),
      rivals: Array.from(state.rivals).slice(0, 20),
      actionCount: state.actionCount,
      lastAction: state.lastAction,
      recentHistory: state.recentHistory.slice(-10),
    }
  }

  async function tick(factions?: FactionInfo[]): Promise<AgentTickResult> {
    const activeFactions = factions ?? knownFactions

    // Try LLM decision first, fall back to weighted random
    let decision: LLMDecision | null = null
    let usedLLM = false

    if (llm && activeFactions.length > 0) {
      decision = await llmDecide(state, activeFactions, connection, recentMessages, llm, logger, solRange, chainState?.memories)
      if (decision) usedLLM = true
    }

    // Fallback: weighted random (using dynamic weights from chain history)
    if (!decision) {
      const canRally = activeFactions.some(f => !state.rallied.has(f.mint))
      const action = chooseAction(state.personality, state, canRally, activeFactions, dynamicWeights)
      const [minSol, maxSol] = solRange
      decision = { action, sol: randRange(minSol, maxSol) }

      // Pick a target faction for the fallback
      if (action === 'join') {
        const f = activeFactions.length > 0 ? pick(activeFactions) : null
        if (!f) return { action, success: false, error: 'no factions', usedLLM: false }
        decision.faction = f.mint
        decision.sol = sentimentBuySize(state, f.mint)
      } else if (action === 'message' || action === 'fud') {
        return { action, success: false, error: 'no LLM for message', usedLLM: false }
      } else if (action === 'defect') {
        const infiltratedHeld = [...state.holdings.entries()].filter(([m, b]) => b > 0 && state.infiltrated.has(m))
        const regularHeld = [...state.holdings.entries()].filter(([, b]) => b > 0)
        const held = infiltratedHeld.length > 0 ? infiltratedHeld : regularHeld
        if (held.length === 0) return { action, success: false, error: 'no holdings', usedLLM: false }
        const [mint] = pick(held)
        const f = activeFactions.find(ff => ff.mint === mint)
        if (!f) return { action, success: false, error: 'faction not found', usedLLM: false }
        decision.faction = f.mint
      } else if (action === 'rally') {
        const eligible = activeFactions.filter(f => !state.rallied.has(f.mint))
        if (eligible.length === 0) return { action, success: false, error: 'nothing to rally', usedLLM: false }
        decision.faction = pick(eligible).mint
      } else if (action === 'war_loan') {
        const held = [...state.holdings.entries()].filter(([, b]) => b > 0)
        const heldAscended = held.filter(([mint]) => activeFactions.find(f => f.mint === mint)?.status === 'ascended')
        if (heldAscended.length === 0) return { action, success: false, error: 'no ascended holdings', usedLLM: false }
        const [mint] = pick(heldAscended)
        const f = activeFactions.find(ff => ff.mint === mint)
        if (!f) return { action, success: false, error: 'faction not found', usedLLM: false }
        decision.faction = f.mint
      } else if (action === 'repay_loan') {
        const loanMints = [...state.activeLoans]
        if (loanMints.length === 0) return { action, success: false, error: 'no loans', usedLLM: false }
        const mint = pick(loanMints)
        const f = activeFactions.find(ff => ff.mint === mint)
        if (!f) return { action, success: false, error: 'faction not found', usedLLM: false }
        decision.faction = f.mint
      } else if (action === 'ascend') {
        const ready = activeFactions.filter(f => f.status === 'ready')
        if (ready.length === 0) return { action, success: false, error: 'no ready factions', usedLLM: false }
        decision.faction = pick(ready).mint
      } else if (action === 'raze') {
        const razeable = activeFactions.filter(f => f.status === 'rising')
        if (razeable.length === 0) return { action, success: false, error: 'no rising factions', usedLLM: false }
        const bearish = razeable.filter(f => (state.sentiment.get(f.mint) ?? 0) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(razeable)).mint
      } else if (action === 'siege') {
        const ascended = activeFactions.filter(f => f.status === 'ascended')
        if (ascended.length === 0) return { action, success: false, error: 'no ascended factions', usedLLM: false }
        decision.faction = pick(ascended).mint
      } else if (action === 'tithe') {
        if (activeFactions.length === 0) return { action, success: false, error: 'no factions', usedLLM: false }
        const bearish = activeFactions.filter(f => (state.sentiment.get(f.mint) ?? 0) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(activeFactions)).mint
      } else if (action === 'infiltrate') {
        const heldMints = [...state.holdings.keys()]
        const rivals = activeFactions.filter(f => !heldMints.includes(f.mint))
        if (rivals.length === 0) return { action, success: false, error: 'no rival factions', usedLLM: false }
        const target = pick(rivals)
        decision.faction = target.mint
        decision.sol = sentimentBuySize(state, target.mint) * 1.5
      }
    }

    const result = await executeAction({
      connection, agent: state, factions: activeFactions, decision, brain: usedLLM ? 'LLM' : 'RNG',
      log: logger, llm, maxFoundedFactions, usedFactionNames, strongholdOpts,
    })

    // Record message to prevent repetition
    if (result.success && decision.message) {
      recentMessages.push(decision.message.replace(/^<+/, '').replace(/>+\s*$/, '').toLowerCase())
      if (recentMessages.length > 30) recentMessages.shift()
    }

    // Track action for live personality evolution
    if (result.success) {
      const idx = actionIndex(decision.action)
      if (idx >= 0) actionCounts[idx]++
      if (decision.message?.trim()) memoBuffer.push(decision.message)
    }

    return {
      action: decision.action,
      faction: decision.faction,
      message: decision.message,
      reasoning: decision.reasoning,
      success: result.success,
      error: result.error,
      usedLLM,
    }
  }

  async function evolve(): Promise<boolean> {
    const total = actionCounts.reduce((a: number, b: number) => a + b, 0)
    if (total < 5) return false // not enough data

    const weights = weightsFromCounts(actionCounts, seedPersonality)
    const llmGen = llm ? (p: string) => llm.generate(p) : undefined
    const suggested = await classifyPersonality(weights, memoBuffer, undefined, llmGen)

    dynamicWeights = weights

    // Gradual drift — track suggestions, only flip after consistent lead
    driftScores[suggested]++
    const currentScore = driftScores[state.personality]
    const suggestedScore = driftScores[suggested]

    if (suggested !== state.personality && suggestedScore - currentScore >= DRIFT_THRESHOLD) {
      logger(`[${publicKey.slice(0, 8)}] personality drifted: ${state.personality} → ${suggested} (drift: ${suggestedScore} vs ${currentScore}, ${total} actions)`)
      state.personality = suggested
      return true
    }
    return false
  }

  return {
    publicKey,
    personality: state.personality,
    tick,
    evolve,
    getState: () => state,
    serialize,
  }
}
