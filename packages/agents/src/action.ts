import { PERSONALITY_SOL, PERSONALITY_WEIGHTS } from './identity'
import { Action, AgentState, FactionInfo, Personality } from './types'

const ALL_ACTIONS: Action[] = [
  'join', 'defect', 'rally', 'launch', 'message',
  'stronghold', 'war_loan', 'repay_loan', 'siege', 'ascend', 'raze', 'tithe',
  'infiltrate', 'fud',
]

export const chooseAction = (
  personality: Personality,
  agent: AgentState,
  canRally: boolean,
  knownFactions: FactionInfo[],
): Action => {
  const weights = [...PERSONALITY_WEIGHTS[personality]]
  const hasHoldings = agent.holdings.size > 0
  const heldMints = [...agent.holdings.keys()]
  // Factions we don't hold (targets for infiltrate/fud)
  const rivalFactions = knownFactions.filter(f => !heldMints.includes(f.mint))

  // Can't defect without holdings
  if (!hasHoldings) { weights[0] += weights[1]; weights[1] = 0 }
  // Can't rally if nothing to rally
  if (!canRally) { weights[0] += weights[2]; weights[2] = 0 }
  // Already has stronghold — skip creating another
  if (agent.hasStronghold) { weights[0] += weights[5]; weights[5] = 0 }
  // War loans/siege only work on ascended (migrated) factions
  const ascendedFactions = knownFactions.filter(f => f.status === 'ascended')
  const holdsAscended = ascendedFactions.some(f => agent.holdings.has(f.mint))
  // Can't take war loan without holdings in an ascended faction
  if (!holdsAscended) { weights[0] += weights[6]; weights[6] = 0 }
  // Can't repay without active loans
  if (agent.activeLoans.size === 0) { weights[0] += weights[7]; weights[7] = 0 }
  // Siege only on ascended factions (lending must be enabled)
  if (ascendedFactions.length === 0) { weights[0] += weights[8]; weights[8] = 0 }
  // Ascend only if there are ready (bonding complete) factions
  const readyFactions = knownFactions.filter(f => f.status === 'ready')
  if (readyFactions.length === 0) { weights[0] += weights[9]; weights[9] = 0 }
  // Raze only rising factions
  const risingFactions = knownFactions.filter(f => f.status === 'rising')
  if (risingFactions.length === 0) { weights[0] += weights[10]; weights[10] = 0 }
  // Can't infiltrate without rival factions to target
  if (rivalFactions.length === 0) {
    weights[0] += weights[12]
    weights[12] = 0
  }
  // Can't fud without holdings (it's a micro sell)
  if (!hasHoldings) { weights[0] += weights[13]; weights[13] = 0 }
  // If we have infiltrated factions ready to dump, boost defect weight
  if (agent.infiltrated.size > 0) {
    weights[1] += 0.10
  }
  // Boost war loans and sieges when ascended factions exist
  if (ascendedFactions.length > 0) {
    if (holdsAscended) {
      weights[6] += 0.15  // war_loan: borrow against ascended holdings
    }
    // Boost siege — more loans means more liquidation opportunities
    weights[8] += 0.12  // siege
    // If agent has active loans, boost repay slightly to keep healthy
    if (agent.activeLoans.size > 0) {
      weights[7] += 0.06  // repay_loan
    }
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

/**
 * Sentiment + personality aware buy sizing.
 * - Bullish sentiment → buy toward the top of the range (up to 2x max)
 * - Bearish sentiment → buy toward the bottom (down to 0.5x min)
 * - Whales scale harder with conviction
 * - Mercenaries buy big on positive momentum, tiny on doubt
 */
export const sentimentBuySize = (agent: AgentState, factionMint: string): number => {
  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]
  const sentiment = agent.sentiment.get(factionMint) ?? 0
  // sentiment ranges -10 to +10, normalize to 0-1
  const sentimentFactor = (sentiment + 10) / 20 // 0 = very bearish, 1 = very bullish

  // Personality multipliers for conviction scaling
  const convictionScale: Record<Personality, number> = {
    loyalist: 1.5,     // buys bigger when bullish, stubborn
    mercenary: 2.0,    // swings hardest with sentiment
    provocateur: 1.2,  // moderate, chaos doesn't care about size
    scout: 0.8,        // always cautious
    whale: 2.5,        // whales go huge on conviction
  }

  const scale = convictionScale[agent.personality]
  // At neutral sentiment (0.5), buy in the middle of range
  // At max bullish, buy up to scale * maxSol
  // At max bearish, buy minSol * 0.5
  const base = minSol + (maxSol - minSol) * sentimentFactor
  const multiplier = 0.5 + sentimentFactor * scale
  return Math.max(minSol * 0.5, base * multiplier)
}
