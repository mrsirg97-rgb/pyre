import { PERSONALITY_WEIGHTS } from './defaults'
import { Action, AgentState, FactionInfo, Personality } from './types'

const ALL_ACTIONS: Action[] = [
  'join',       // 0
  'defect',     // 1
  'rally',      // 2
  'launch',     // 3
  'message',    // 4
  'reinforce',  // 5
  'war_loan',   // 6
  'repay_loan', // 7
  'siege',      // 8
  'ascend',     // 9
  'raze',       // 10
  'tithe',      // 11
  'infiltrate', // 12
  'fud',        // 13
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

  // Index reference:
  // 0:join 1:defect 2:rally 3:launch 4:message 5:reinforce
  // 6:war_loan 7:repay_loan 8:siege 9:ascend 10:raze 11:tithe 12:infiltrate 13:fud

  if (!hasHoldings) {
    weights[0] += weights[1]
    weights[1] = 0   // can't defect
    weights[5] = 0   // can't reinforce
    weights[13] = 0  // can't fud
  }
  if (!canRally) {
    weights[0] += weights[2]
    weights[2] = 0
  }

  const ascendedFactions = knownFactions.filter((f) => f.status === 'ascended')
  const holdsAscended = ascendedFactions.some((f) => agent.holdings.has(f.mint))
  if (!holdsAscended) {
    weights[0] += weights[6]
    weights[6] = 0   // can't war_loan
  }
  if ((agent.activeLoans?.size ?? 0) === 0) {
    weights[0] += weights[7]
    weights[7] = 0   // can't repay_loan
  }
  if (ascendedFactions.length === 0) {
    weights[0] += weights[8]
    weights[8] = 0   // can't siege
  }

  const readyFactions = knownFactions.filter((f) => f.status === 'ready')
  if (readyFactions.length === 0) {
    weights[0] += weights[9]
    weights[9] = 0   // can't ascend
  }
  const risingFactions = knownFactions.filter((f) => f.status === 'rising')
  if (risingFactions.length === 0) {
    weights[0] += weights[10]
    weights[10] = 0  // can't raze
  }
  if (rivalFactions.length === 0) {
    weights[0] += weights[12]
    weights[12] = 0  // can't infiltrate
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
    if (holdsAscended) weights[6] += 0.15   // war_loan
    weights[8] += 0.12                       // siege
    if ((agent.activeLoans?.size ?? 0) > 0) weights[7] += 0.06  // repay_loan
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
