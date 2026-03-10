import { Connection } from '@solana/web3.js'
import { getFactions, isPyreMint } from 'pyre-world-kit'

import {
  PyreAgentConfig, PyreAgent, AgentState, AgentTickResult,
  FactionInfo, LLMDecision, SerializedAgentState,
} from './types'
import { PERSONALITY_SOL, assignPersonality } from './defaults'
import { chooseAction, sentimentBuySize } from './action'
import { llmDecide } from './agent'
import { executeAction } from './executor'
import { ensureStronghold } from './stronghold'
import { pick, randRange, ts } from './util'

// Re-export public types
export type {
  PyreAgentConfig, PyreAgent, AgentTickResult, SerializedAgentState,
  LLMAdapter, LLMDecision, FactionInfo, Personality, Action, AgentState,
} from './types'

export { assignPersonality, PERSONALITY_SOL, PERSONALITY_WEIGHTS, personalityDesc, VOICE_NUDGES } from './defaults'
export { ensureStronghold } from './stronghold'
export { sendAndConfirm } from './tx'

export async function createPyreAgent(config: PyreAgentConfig): Promise<PyreAgent> {
  const {
    connection, keypair, network, llm,
    maxFoundedFactions = 2,
    strongholdFundSol, strongholdTopupThresholdSol, strongholdTopupReserveSol,
  } = config

  const publicKey = keypair.publicKey.toBase58()
  const personality = config.personality ?? config.state?.personality ?? assignPersonality()
  const solRange = config.solRange ?? PERSONALITY_SOL[personality]
  const logger = config.logger ?? ((msg: string) => console.log(`[${ts()}] ${msg}`))

  const strongholdOpts = {
    fundSol: strongholdFundSol,
    topupThresholdSol: strongholdTopupThresholdSol,
    topupReserveSol: strongholdTopupReserveSol,
  }

  // Build agent state from serialized or fresh
  const prior = config.state
  const state: AgentState = {
    keypair,
    publicKey,
    personality,
    holdings: new Map(Object.entries(prior?.holdings ?? {})),
    founded: prior?.founded ?? [],
    rallied: new Set(prior?.rallied ?? []),
    voted: new Set([...(prior?.voted ?? []), ...Object.keys(prior?.holdings ?? {})]),
    hasStronghold: prior?.hasStronghold ?? false,
    activeLoans: new Set(prior?.activeLoans ?? []),
    infiltrated: new Set(prior?.infiltrated ?? []),
    sentiment: new Map(Object.entries(prior?.sentiment ?? {})),
    allies: new Set(prior?.allies ?? []),
    rivals: new Set(prior?.rivals ?? []),
    actionCount: prior?.actionCount ?? 0,
    lastAction: prior?.lastAction ?? 'none',
    recentHistory: prior?.recentHistory ?? [],
  }

  // Track known factions and used names
  const knownFactions: FactionInfo[] = []
  const usedFactionNames = new Set<string>()
  const recentMessages: string[] = []

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

  // Ensure stronghold exists
  await ensureStronghold(connection, state, logger, strongholdOpts)

  function serialize(): SerializedAgentState {
    return {
      publicKey: state.publicKey,
      personality: state.personality,
      holdings: Object.fromEntries(state.holdings),
      founded: state.founded,
      rallied: Array.from(state.rallied),
      voted: Array.from(state.voted),
      hasStronghold: state.hasStronghold,
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
      decision = await llmDecide(state, activeFactions, connection, recentMessages, llm, logger, solRange)
      if (decision) usedLLM = true
    }

    // Fallback: weighted random
    if (!decision) {
      const canRally = activeFactions.some(f => !state.rallied.has(f.mint))
      const action = chooseAction(state.personality, state, canRally, activeFactions)
      const [minSol, maxSol] = solRange
      decision = { action, sol: randRange(minSol, maxSol) }

      // Pick a target faction for the fallback
      if (action === 'join') {
        const f = activeFactions.length > 0 ? pick(activeFactions) : null
        if (!f) return { action, success: false, error: 'no factions', usedLLM: false }
        decision.faction = f.symbol
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
        decision.faction = f.symbol
      } else if (action === 'rally') {
        const eligible = activeFactions.filter(f => !state.rallied.has(f.mint))
        if (eligible.length === 0) return { action, success: false, error: 'nothing to rally', usedLLM: false }
        decision.faction = pick(eligible).symbol
      } else if (action === 'war_loan') {
        const held = [...state.holdings.entries()].filter(([, b]) => b > 0)
        const heldAscended = held.filter(([mint]) => activeFactions.find(f => f.mint === mint)?.status === 'ascended')
        if (heldAscended.length === 0) return { action, success: false, error: 'no ascended holdings', usedLLM: false }
        const [mint] = pick(heldAscended)
        const f = activeFactions.find(ff => ff.mint === mint)
        if (!f) return { action, success: false, error: 'faction not found', usedLLM: false }
        decision.faction = f.symbol
      } else if (action === 'repay_loan') {
        const loanMints = [...state.activeLoans]
        if (loanMints.length === 0) return { action, success: false, error: 'no loans', usedLLM: false }
        const mint = pick(loanMints)
        const f = activeFactions.find(ff => ff.mint === mint)
        if (!f) return { action, success: false, error: 'faction not found', usedLLM: false }
        decision.faction = f.symbol
      } else if (action === 'ascend') {
        const ready = activeFactions.filter(f => f.status === 'ready')
        if (ready.length === 0) return { action, success: false, error: 'no ready factions', usedLLM: false }
        decision.faction = pick(ready).symbol
      } else if (action === 'raze') {
        const razeable = activeFactions.filter(f => f.status === 'rising')
        if (razeable.length === 0) return { action, success: false, error: 'no rising factions', usedLLM: false }
        const bearish = razeable.filter(f => (state.sentiment.get(f.mint) ?? 0) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(razeable)).symbol
      } else if (action === 'siege') {
        const ascended = activeFactions.filter(f => f.status === 'ascended')
        if (ascended.length === 0) return { action, success: false, error: 'no ascended factions', usedLLM: false }
        decision.faction = pick(ascended).symbol
      } else if (action === 'tithe') {
        if (activeFactions.length === 0) return { action, success: false, error: 'no factions', usedLLM: false }
        const bearish = activeFactions.filter(f => (state.sentiment.get(f.mint) ?? 0) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(activeFactions)).symbol
      } else if (action === 'infiltrate') {
        const heldMints = [...state.holdings.keys()]
        const rivals = activeFactions.filter(f => !heldMints.includes(f.mint))
        if (rivals.length === 0) return { action, success: false, error: 'no rival factions', usedLLM: false }
        const target = pick(rivals)
        decision.faction = target.symbol
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

  return {
    publicKey,
    personality,
    tick,
    getState: () => state,
    serialize,
  }
}
