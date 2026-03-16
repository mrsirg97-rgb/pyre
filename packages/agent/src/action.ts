import { PERSONALITY_WEIGHTS } from './defaults'
import { Action, AgentState, FactionInfo, Personality } from './types'

const ALL_ACTIONS: Action[] = [
  'join',
  'defect',
  'rally',
  'launch',
  'message',
  'war_loan',
  'repay_loan',
  'siege',
  'ascend',
  'raze',
  'tithe',
  'infiltrate',
  'fud',
]

/**
 * Choose an action using weighted random selection.
 * Accepts optional dynamic weights (from on-chain history).
 * Falls back to static personality weights if not provided.
 *
 * Note: this takes a compat state object with kit fields mixed in.
 */
export const chooseAction = (
  personality: Personality,
  agent: any, // compat: AgentState + kit state fields
  canRally: boolean,
  knownFactions: FactionInfo[],
  dynamicWeights?: number[],
): Action => {
  const weights = dynamicWeights ? [...dynamicWeights] : [...PERSONALITY_WEIGHTS[personality]]
  const hasHoldings = agent.holdings.size > 0
  const heldMints = [...agent.holdings.keys()]
  const rivalFactions = knownFactions.filter((f) => !heldMints.includes(f.mint))

  if (!hasHoldings) {
    weights[0] += weights[1]
    weights[1] = 0
  }
  if (!canRally) {
    weights[0] += weights[2]
    weights[2] = 0
  }

  const ascendedFactions = knownFactions.filter((f) => f.status === 'ascended')
  const holdsAscended = ascendedFactions.some((f) => agent.holdings.has(f.mint))
  if (!holdsAscended) {
    weights[0] += weights[5]
    weights[5] = 0
  }
  if ((agent.activeLoans?.size ?? 0) === 0) {
    weights[0] += weights[6]
    weights[6] = 0
  }
  if (ascendedFactions.length === 0) {
    weights[0] += weights[7]
    weights[7] = 0
  }

  const readyFactions = knownFactions.filter((f) => f.status === 'ready')
  if (readyFactions.length === 0) {
    weights[0] += weights[8]
    weights[8] = 0
  }
  const risingFactions = knownFactions.filter((f) => f.status === 'rising')
  if (risingFactions.length === 0) {
    weights[0] += weights[9]
    weights[9] = 0
  }
  if (rivalFactions.length === 0) {
    weights[0] += weights[11]
    weights[11] = 0
  }
  if (!hasHoldings) {
    weights[0] += weights[12]
    weights[12] = 0
  }

  // Few factions available → boost launch (modest — agents converge on existing factions naturally)
  const nonRazedFactions = knownFactions.filter((f) => f.status !== 'razed')
  if (nonRazedFactions.length === 0) weights[3] += 0.15
  else if (nonRazedFactions.length <= 2) weights[3] += 0.08
  else if (nonRazedFactions.length <= 5) weights[3] += 0.03

  if (agent.infiltrated?.size > 0) weights[1] += 0.1

  // Bearish sentiment on held factions → boost defect
  if (hasHoldings && agent.sentiment) {
    const bearishHeld = heldMints.filter((m: string) => (agent.sentiment.get(m) ?? 0) < -2)
    if (bearishHeld.length > 0) weights[1] += 0.05 * bearishHeld.length
  }

  if (ascendedFactions.length > 0) {
    if (holdsAscended) weights[5] += 0.15
    weights[7] += 0.12
    if ((agent.activeLoans?.size ?? 0) > 0) weights[6] += 0.06
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

/** Calculate SOL buy size based on personality and sentiment */
export const sentimentBuySize = (
  personality: Personality,
  sentiment: number,
  solRange: [number, number],
): number => {
  const [minSol, maxSol] = solRange
  const sentimentFactor = (sentiment + 10) / 20

  const convictionScale: Record<Personality, number> = {
    loyalist: 1.5,
    mercenary: 2.0,
    provocateur: 1.2,
    scout: 0.8,
    whale: 2.5,
  }

  const scale = convictionScale[personality]
  const base = minSol + (maxSol - minSol) * sentimentFactor
  const multiplier = 0.5 + sentimentFactor * scale
  return Math.max(minSol * 0.5, base * multiplier)
}
