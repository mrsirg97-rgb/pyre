import { Personality } from './types'
import { NETWORK } from './config'

// ─── Personality Weights ─────────────────────────────────────────────
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud]

// Devnet: full action set
// Mainnet: mostly message + fud, with rare join/defect/launch
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud]
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud]
export const PERSONALITY_WEIGHTS: Record<Personality, number[]> = NETWORK === 'mainnet' ? {
  loyalist:     [0.02, 0.01, 0, 0.005, 0.78, 0, 0, 0, 0, 0, 0, 0, 0, 0.185],
  mercenary:    [0.02, 0.02, 0, 0.005, 0.65, 0, 0, 0, 0, 0, 0, 0, 0, 0.305],
  provocateur:  [0.01, 0.01, 0, 0.005, 0.55, 0, 0, 0, 0, 0, 0, 0, 0, 0.425],
  scout:        [0.02, 0.01, 0, 0.005, 0.82, 0, 0, 0, 0, 0, 0, 0, 0, 0.145],
  whale:        [0.03, 0.02, 0, 0.005, 0.70, 0, 0, 0, 0, 0, 0, 0, 0, 0.245],
} : {
  loyalist:     [0.28, 0.06, 0.14, 0.02, 0.12, 0.06, 0.04, 0.04, 0.02, 0.05, 0.02, 0.10, 0.02, 0.03],
  mercenary:    [0.16, 0.18, 0.04, 0.02, 0.08, 0.04, 0.08, 0.04, 0.06, 0.03, 0.04, 0.03, 0.12, 0.08],
  provocateur:  [0.12, 0.08, 0.04, 0.06, 0.18, 0.05, 0.04, 0.03, 0.04, 0.03, 0.05, 0.04, 0.12, 0.12],
  scout:        [0.18, 0.10, 0.08, 0.02, 0.16, 0.04, 0.04, 0.03, 0.06, 0.04, 0.05, 0.04, 0.08, 0.08],
  whale:        [0.24, 0.14, 0.06, 0.02, 0.06, 0.06, 0.06, 0.04, 0.02, 0.04, 0.04, 0.04, 0.12, 0.06],
}

// Tick interval ranges per personality (ms) — fast agents dominate comms, slow agents drop big moves
export const PERSONALITY_INTERVALS: Record<Personality, [number, number]> = NETWORK === 'mainnet' ? {
  loyalist:     [60000, 120000],
  mercenary:    [40000, 100000],
  provocateur:  [30000, 80000],
  scout:        [40000, 90000],
  whale:        [80000, 150000],
} : {
  loyalist:     [15000, 60000],
  mercenary:    [10000, 50000],
  provocateur:  [5000, 25000],
  scout:        [8000, 40000],
  whale:        [25000, 90000],
}

// SOL spend ranges per personality — scaled down on mainnet
export const PERSONALITY_SOL: Record<Personality, [number, number]> = NETWORK === 'mainnet' ? {
  loyalist:     [0.001, 0.005],
  mercenary:    [0.001, 0.004],
  provocateur:  [0.001, 0.003],
  scout:        [0.001, 0.002],
  whale:        [0.002, 0.01],
} : {
  loyalist:     [0.02, 0.1],
  mercenary:    [0.01, 0.08],
  provocateur:  [0.005, 0.05],
  scout:        [0.005, 0.03],
  whale:        [0.1, 0.5],
}

export const assignPersonality = (index: number): Personality => {
  const personalities: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
  // Weighted distribution: more loyalists + mercenaries
  const weights = [0.30, 0.25, 0.15, 0.20, 0.10]
  const roll = Math.random()
  let cumulative = 0
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]
    if (roll < cumulative) return personalities[i]
  }
  return 'loyalist'
}
