import { Action, FactionInfo } from './types'

export interface ActionAvailability {
  enabled: boolean
  reason?: string
}

/**
 * Determine which actions are currently available given the player's state.
 * Mirrors the validation logic in chooseAction() but returns structured results
 * for UI consumption (lens page).
 */
export function getAvailableActions(
  holdings: Map<string, number>,
  factions: FactionInfo[],
  activeLoans: number,
): Map<Action, ActionAvailability> {
  const result = new Map<Action, ActionAvailability>()
  const hasHoldings = holdings.size > 0
  const heldMints = [...holdings.keys()]
  const ascendedFactions = factions.filter((f) => f.status === 'ascended')
  const readyFactions = factions.filter((f) => f.status === 'ready')
  const risingFactions = factions.filter((f) => f.status === 'rising')
  const rivalFactions = factions.filter((f) => !heldMints.includes(f.mint))
  const holdsAscended = ascendedFactions.some((f) => holdings.has(f.mint))
  const nonRazed = factions.filter((f) => f.status !== 'razed')

  // join — always available if factions exist
  result.set('join', nonRazed.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no factions' })

  // defect — requires holdings
  result.set('defect', hasHoldings
    ? { enabled: true }
    : { enabled: false, reason: 'no holdings' })

  // rally — always available if factions exist (server validates duplicates)
  result.set('rally', nonRazed.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no factions' })

  // launch — always available (server validates max)
  result.set('launch', { enabled: true })

  // message — always available if factions exist
  result.set('message', nonRazed.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no factions' })

  // reinforce — requires holdings
  result.set('reinforce', hasHoldings
    ? { enabled: true }
    : { enabled: false, reason: 'no holdings' })

  // war_loan — requires holding an ascended faction
  result.set('war_loan', holdsAscended
    ? { enabled: true }
    : { enabled: false, reason: 'no ascended holdings' })

  // repay_loan — requires active loans
  result.set('repay_loan', activeLoans > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no active loans' })

  // siege — requires ascended factions to exist
  result.set('siege', ascendedFactions.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no ascended factions' })

  // ascend — requires ready factions
  result.set('ascend', readyFactions.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no ready factions' })

  // raze — requires rising factions
  result.set('raze', risingFactions.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no rising factions' })

  // tithe — requires ascended factions
  result.set('tithe', ascendedFactions.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no ascended factions' })

  // infiltrate — requires factions not held
  result.set('infiltrate', rivalFactions.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no rival factions' })

  // fud — requires holdings
  result.set('fud', hasHoldings
    ? { enabled: true }
    : { enabled: false, reason: 'no holdings' })

  // scout — always available if factions exist
  result.set('scout', nonRazed.length > 0
    ? { enabled: true }
    : { enabled: false, reason: 'no factions' })

  // hold — always available
  result.set('hold', { enabled: true })

  return result
}

/** Actions that require a message/memo */
export const MESSAGE_ACTIONS: Set<Action> = new Set([
  'join', 'reinforce', 'defect', 'message', 'fud', 'infiltrate',
])

/** Actions that require a SOL amount input */
export const SOL_ACTIONS: Set<Action> = new Set([
  'join', 'reinforce', 'infiltrate',
])

/** Filter factions to valid targets for a given action */
export function getValidTargets(
  action: Action,
  factions: FactionInfo[],
  holdings: Map<string, number>,
): FactionInfo[] {
  const heldMints = [...holdings.keys()]
  const nonRazed = factions.filter((f) => f.status !== 'razed')

  switch (action) {
    case 'defect':
    case 'fud':
    case 'reinforce':
      return factions.filter((f) => holdings.has(f.mint))
    case 'infiltrate':
      return nonRazed.filter((f) => !heldMints.includes(f.mint))
    case 'ascend':
      return factions.filter((f) => f.status === 'ready')
    case 'raze':
      return factions.filter((f) => f.status === 'rising')
    case 'siege':
    case 'tithe':
    case 'war_loan':
      return factions.filter((f) => f.status === 'ascended')
    case 'repay_loan':
      return nonRazed // server validates loan exists
    case 'hold':
    case 'launch':
      return [] // no target needed
    default:
      return nonRazed
  }
}
