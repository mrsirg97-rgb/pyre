import { PERSONALITY_WEIGHTS, PERSONALITY_SOL } from './defaults'
import { Action, AgentState, FactionInfo, Personality } from './types'

const ALL_ACTIONS: Action[] = [
  'join', 'defect', 'rally', 'launch', 'message',
  'stronghold', 'war_loan', 'repay_loan', 'siege', 'ascend', 'raze', 'tithe',
  'infiltrate', 'fud',
]

/**
 * Choose an action using weighted random selection.
 *
 * Accepts optional dynamic weights (from on-chain history).
 * Falls back to static personality weights if not provided.
 */
export const chooseAction = (
  personality: Personality,
  agent: AgentState,
  canRally: boolean,
  knownFactions: FactionInfo[],
  dynamicWeights?: number[],
): Action => {
  const weights = dynamicWeights ? [...dynamicWeights] : [...PERSONALITY_WEIGHTS[personality]]
  const hasHoldings = agent.holdings.size > 0
  const heldMints = [...agent.holdings.keys()]
  const rivalFactions = knownFactions.filter(f => !heldMints.includes(f.mint))

  if (!hasHoldings) { weights[0] += weights[1]; weights[1] = 0 }
  if (!canRally) { weights[0] += weights[2]; weights[2] = 0 }
  if (agent.hasStronghold) { weights[0] += weights[5]; weights[5] = 0 }

  const ascendedFactions = knownFactions.filter(f => f.status === 'ascended')
  const holdsAscended = ascendedFactions.some(f => agent.holdings.has(f.mint))
  if (!holdsAscended) { weights[0] += weights[6]; weights[6] = 0 }
  if (agent.activeLoans.size === 0) { weights[0] += weights[7]; weights[7] = 0 }
  if (ascendedFactions.length === 0) { weights[0] += weights[8]; weights[8] = 0 }

  const readyFactions = knownFactions.filter(f => f.status === 'ready')
  if (readyFactions.length === 0) { weights[0] += weights[9]; weights[9] = 0 }
  const risingFactions = knownFactions.filter(f => f.status === 'rising')
  if (risingFactions.length === 0) { weights[0] += weights[10]; weights[10] = 0 }

  if (rivalFactions.length === 0) { weights[0] += weights[12]; weights[12] = 0 }
  if (!hasHoldings) { weights[0] += weights[13]; weights[13] = 0 }

  if (agent.infiltrated.size > 0) { weights[1] += 0.10 }

  if (ascendedFactions.length > 0) {
    if (holdsAscended) { weights[6] += 0.15 }
    weights[8] += 0.12
    if (agent.activeLoans.size > 0) { weights[7] += 0.06 }
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

export const sentimentBuySize = (agent: AgentState, factionMint: string): number => {
  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]
  const sentiment = agent.sentiment.get(factionMint) ?? 0
  const sentimentFactor = (sentiment + 10) / 20

  const convictionScale: Record<Personality, number> = {
    loyalist: 1.5,
    mercenary: 2.0,
    provocateur: 1.2,
    scout: 0.8,
    whale: 2.5,
  }

  const scale = convictionScale[agent.personality]
  const base = minSol + (maxSol - minSol) * sentimentFactor
  const multiplier = 0.5 + sentimentFactor * scale
  return Math.max(minSol * 0.5, base * multiplier)
}
