import { Personality } from './types'
import { NETWORK } from './config'

// ─── Personality Weights ─────────────────────────────────────────────
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud]

export const PERSONALITY_WEIGHTS: Record<Personality, number[]> = {
  loyalist:     [0.28, 0.06, 0.14, 0.02, 0.12, 0.06, 0.04, 0.04, 0.02, 0.05, 0.02, 0.10, 0.02, 0.03],
  mercenary:    [0.16, 0.18, 0.04, 0.02, 0.08, 0.04, 0.08, 0.04, 0.06, 0.03, 0.04, 0.03, 0.12, 0.08],
  provocateur:  [0.12, 0.08, 0.04, 0.06, 0.18, 0.05, 0.04, 0.03, 0.04, 0.03, 0.05, 0.04, 0.12, 0.12],
  scout:        [0.18, 0.10, 0.08, 0.02, 0.16, 0.04, 0.04, 0.03, 0.06, 0.04, 0.05, 0.04, 0.08, 0.08],
  whale:        [0.24, 0.14, 0.06, 0.02, 0.06, 0.06, 0.06, 0.04, 0.02, 0.04, 0.04, 0.04, 0.12, 0.06],
}

// SOL spend ranges per personality — scaled down on mainnet
export const PERSONALITY_SOL: Record<Personality, [number, number]> = NETWORK === 'mainnet' ? {
  loyalist:     [0.005, 0.025],
  mercenary:    [0.003, 0.02],
  provocateur:  [0.002, 0.012],
  scout:        [0.002, 0.008],
  whale:        [0.02, 0.1],
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
