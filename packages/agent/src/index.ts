import type { PyreKit } from 'pyre-world-kit'

import {
  PyreAgentConfig,
  PyreAgent,
  AgentState,
  AgentTickResult,
  FactionInfo,
  LLMDecision,
  SerializedAgentState,
  Personality,
} from './types'
import { PERSONALITY_SOL, PERSONALITY_WEIGHTS, assignPersonality } from './defaults'
import { chooseAction, sentimentBuySize } from './action'
import { llmDecide, buildCompactModelPrompt, FactionContext, LLMDecideOptions } from './agent'
import { executeAction } from './executor'
import { weightsFromCounts, classifyPersonality, actionIndex } from './chain'
import { pick, randRange, ts } from './util'

export type {
  PyreAgentConfig,
  PyreAgent,
  AgentTickResult,
  SerializedAgentState,
  LLMAdapter,
  LLMDecision,
  FactionInfo,
  Personality,
  Action,
  AgentState,
} from './types'

export {
  assignPersonality,
  PERSONALITY_SOL,
  PERSONALITY_WEIGHTS,
  personalityDesc,
} from './defaults'
export { classifyPersonality, weightsFromCounts, actionIndex } from './chain'
export { generateFactionIdentity } from './faction'
export { llmDecide, buildCompactModelPrompt }
export type { FactionContext, LLMDecideOptions }

export async function createPyreAgent(config: PyreAgentConfig): Promise<PyreAgent> {
  const { kit, keypair, llm, maxFoundedFactions = 2 } = config

  const publicKey = keypair.publicKey.toBase58()
  const seedPersonality = config.personality ?? config.state?.personality ?? assignPersonality()
  const logger = config.logger ?? ((msg: string) => console.log(`[${ts()}] ${msg}`))

  // Personality-specific state (subjective — not tracked by kit)
  let personality = seedPersonality
  let dynamicWeights: number[] | undefined
  let solRange = config.solRange ?? PERSONALITY_SOL[seedPersonality]
  const recentMessages: string[] = []
  const memoBuffer: string[] = []
  const driftScores: Record<Personality, number> = {
    loyalist: 0,
    mercenary: 0,
    provocateur: 0,
    scout: 0,
    whale: 0,
  }
  const DRIFT_THRESHOLD = 3

  // Build agent state — personality layer only (objective state lives in kit)
  const prior = config.state
  const state: AgentState = {
    keypair,
    publicKey,
    personality,
    infiltrated: new Set(prior?.infiltrated ?? []),
    allies: new Set(prior?.allies ?? []),
    rivals: new Set(prior?.rivals ?? []),
    lastAction: prior?.lastAction ?? 'none',
  }

  // Initialize kit state (loads registry checkpoint)
  if (!kit.state.initialized) {
    const gameState = await kit.state.init()
    const vc = await kit.state.getVaultCreator()
    logger(
      `[${publicKey.slice(0, 8)}] state initialized — vault: ${vc?.slice(0, 8) ?? 'none'}, tick: ${gameState.tick}`,
    )

    // Restore personality from on-chain checkpoint if available
    if (gameState.personalitySummary) {
      const checkpointPersonality = gameState.personalitySummary as Personality
      if (
        ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale'].includes(checkpointPersonality)
      ) {
        personality = checkpointPersonality
        state.personality = personality
        logger(`[${publicKey.slice(0, 8)}] personality restored from checkpoint: ${personality}`)
      }
    }

    // Derive weights from checkpoint action counts
    const counts = gameState.actionCounts
    const countsArray = [
      counts.join,
      counts.defect,
      counts.rally,
      counts.launch,
      counts.message,
      counts.reinforce,
      counts.war_loan,
      counts.repay_loan,
      counts.siege,
      counts.ascend,
      counts.raze,
      counts.tithe,
      counts.infiltrate,
      counts.fud,
    ]
    const total = countsArray.reduce((a, b) => a + b, 0)
    if (total > 0) {
      dynamicWeights = weightsFromCounts(countsArray, seedPersonality)
    }
  }

  const usedFactionNames = new Set<string>()

  async function discoverFactions(): Promise<FactionInfo[]> {
    const result = await kit.actions.getFactions({ sort: 'newest' })
    const factions: FactionInfo[] = []
    for (const t of result.factions) {
      factions.push({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        status: t.status as FactionInfo['status'],
        price_sol: t.price_sol,
        market_cap_sol: t.market_cap_sol,
      })
      usedFactionNames.add(t.name)
    }
    return factions
  }

  function serialize(): SerializedAgentState {
    return {
      publicKey: state.publicKey,
      personality: state.personality,
      infiltrated: Array.from(state.infiltrated),
      allies: Array.from(state.allies).slice(0, 20),
      rivals: Array.from(state.rivals).slice(0, 20),
      lastAction: state.lastAction,
    }
  }

  async function tick(factions?: FactionInfo[]): Promise<AgentTickResult> {
    const activeFactions = factions ?? await discoverFactions()

    // Try LLM decision first, fall back to weighted random
    let decision: LLMDecision | null = null
    let usedLLM = false

    if (llm && activeFactions.length > 0) {
      decision = await llmDecide(kit, state, activeFactions, recentMessages, llm, logger, solRange)
      if (decision) usedLLM = true
    }

    // Fallback: weighted random
    if (!decision) {
      const gameState = kit.state.state!
      const holdings = await kit.state.getHoldings()
      const hasStronghold = (await kit.state.getVaultCreator()) !== null
      const canRally = activeFactions.some((f) => !gameState.rallied.has(f.mint))
      const compatState = {
        ...state,
        holdings,
        hasStronghold,
        activeLoans: gameState.activeLoans,
        sentiment: gameState.sentiment,
        voted: gameState.voted,
        rallied: gameState.rallied,
      }
      const action = chooseAction(
        state.personality,
        compatState as any,
        canRally,
        activeFactions,
        dynamicWeights,
      )
      const [minSol, maxSol] = solRange
      decision = { action, sol: randRange(minSol, maxSol) }

      if (action === 'join') {
        const f = activeFactions.length > 0 ? pick(activeFactions) : null
        if (!f) return { action, success: false, error: 'no factions', usedLLM: false }
        decision.faction = f.mint
        decision.sol = sentimentBuySize(state.personality, kit.state.getSentiment(f.mint), solRange)
      } else if (action === 'reinforce') {
        const held = [...holdings.entries()].filter(([, b]) => b > 0)
        if (held.length === 0)
          return { action, success: false, error: 'no holdings to reinforce', usedLLM: false }
        const target = pick(held)
        decision.faction = target[0]
        decision.sol = sentimentBuySize(state.personality, kit.state.getSentiment(target[0]), solRange)
      } else if (action === 'message' || action === 'fud') {
        return { action, success: false, error: 'no LLM for message', usedLLM: false }
      } else if (action === 'defect') {
        const held = [...holdings.entries()].filter(([, b]) => b > 0)
        if (held.length === 0)
          return { action, success: false, error: 'no holdings', usedLLM: false }
        const infiltratedHeld = held.filter(([m]) => state.infiltrated.has(m))
        const target = infiltratedHeld.length > 0 ? pick(infiltratedHeld) : pick(held)
        decision.faction = target[0]
      } else if (action === 'rally') {
        const eligible = activeFactions.filter((f) => !gameState.rallied.has(f.mint))
        if (eligible.length === 0)
          return { action, success: false, error: 'nothing to rally', usedLLM: false }
        decision.faction = pick(eligible).mint
      } else if (action === 'war_loan') {
        const held = [...holdings.entries()].filter(([, b]) => b > 0)
        const heldAscended = held.filter(
          ([mint]) => activeFactions.find((f) => f.mint === mint)?.status === 'ascended',
        )
        if (heldAscended.length === 0)
          return { action, success: false, error: 'no ascended holdings', usedLLM: false }
        decision.faction = pick(heldAscended)[0]
      } else if (action === 'repay_loan') {
        const loanMints = [...gameState.activeLoans]
        if (loanMints.length === 0)
          return { action, success: false, error: 'no loans', usedLLM: false }
        decision.faction = activeFactions.find((f) => f.mint === pick(loanMints))?.mint
        if (!decision.faction)
          return { action, success: false, error: 'faction not found', usedLLM: false }
      } else if (action === 'ascend') {
        const ready = activeFactions.filter((f) => f.status === 'ready')
        if (ready.length === 0)
          return { action, success: false, error: 'no ready factions', usedLLM: false }
        decision.faction = pick(ready).mint
      } else if (action === 'raze') {
        const razeable = activeFactions.filter((f) => f.status === 'rising')
        if (razeable.length === 0)
          return { action, success: false, error: 'no rising factions', usedLLM: false }
        const bearish = razeable.filter((f) => kit.state.getSentiment(f.mint) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(razeable)).mint
      } else if (action === 'siege') {
        const ascended = activeFactions.filter((f) => f.status === 'ascended')
        if (ascended.length === 0)
          return { action, success: false, error: 'no ascended factions', usedLLM: false }
        decision.faction = pick(ascended).mint
      } else if (action === 'tithe') {
        if (activeFactions.length === 0)
          return { action, success: false, error: 'no factions', usedLLM: false }
        const bearish = activeFactions.filter((f) => kit.state.getSentiment(f.mint) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(activeFactions)).mint
      } else if (action === 'infiltrate') {
        const heldMints = [...holdings.keys()]
        const rivals = activeFactions.filter((f) => !heldMints.includes(f.mint))
        if (rivals.length === 0)
          return { action, success: false, error: 'no rival factions', usedLLM: false }
        const target = pick(rivals)
        decision.faction = target.mint
        decision.sol =
          sentimentBuySize(state.personality, kit.state.getSentiment(target.mint), solRange) * 1.5
      }
    }

    // Hold — intentional no-op
    if (decision.action === 'hold') {
      logger(`[${state.publicKey.slice(0, 8)}] [HOLD] skip turn`)
      return { action: 'hold', success: true, reasoning: decision.reasoning, usedLLM }
    }

    // Execute through kit
    const result = await executeAction(
      kit,
      state,
      activeFactions,
      decision,
      usedLLM ? 'LLM' : 'RNG',
      logger,
      maxFoundedFactions,
      usedFactionNames,
      llm,
    )

    // Record message to prevent repetition
    if (result.success && decision.message) {
      recentMessages.push(
        decision.message
          .replace(/^<+/, '')
          .replace(/>+\s*$/, '')
          .toLowerCase(),
      )
      if (recentMessages.length > 30) recentMessages.shift()
    }

    // Track for personality evolution
    if (result.success && decision.message?.trim()) {
      memoBuffer.push(decision.message)
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
    const counts = kit.state.state?.actionCounts
    if (!counts) return false

    const countsArray = [
      counts.join,
      counts.defect,
      counts.rally,
      counts.launch,
      counts.message,
      counts.reinforce,
      counts.war_loan,
      counts.repay_loan,
      counts.siege,
      counts.ascend,
      counts.raze,
      counts.tithe,
      counts.infiltrate,
      counts.fud,
    ]
    const total = countsArray.reduce((a, b) => a + b, 0)
    if (total < 5) return false

    const weights = weightsFromCounts(countsArray, seedPersonality)
    const llmGen = llm ? (p: string) => llm.generate(p) : undefined
    const suggested = await classifyPersonality(weights, memoBuffer, undefined, llmGen)

    dynamicWeights = weights

    driftScores[suggested]++
    const currentScore = driftScores[state.personality]
    const suggestedScore = driftScores[suggested]

    if (suggested !== state.personality && suggestedScore - currentScore >= DRIFT_THRESHOLD) {
      logger(
        `[${publicKey.slice(0, 8)}] personality drifted: ${state.personality} → ${suggested} (drift: ${suggestedScore} vs ${currentScore}, ${total} actions)`,
      )
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
