/**
 * Pyre Kit — Agent-first faction warfare on Torch Market
 *
 * Game-semantic wrapper over torchsdk. Torch Market IS the game engine.
 * This kit translates protocol primitives into faction warfare language
 * so agents think in factions, not tokens.
 */

import { Connection } from '@solana/web3.js'

import { Action } from './types/action.types'
import { Intel } from './types/intel.types'
import { Registry } from './types/registry.types'

import { ActionProvider } from './providers/action.provider'
import { IntelProvider } from './providers/intel.provider'
import { RegistryProvider } from './providers/registry.provider'
import { StateProvider } from './providers/state.provider'

import type { CheckpointConfig, TrackedAction } from './types/state.types'

// ─── Top-level Kit ────────────────────────────────────────────────

export class PyreKit {
  readonly connection: Connection
  readonly actions: Action
  readonly intel: Intel
  readonly registry: Registry
  readonly state: StateProvider

  constructor(connection: Connection, publicKey: string) {
    this.connection = connection
    this.registry = new RegistryProvider(connection)
    this.state = new StateProvider(connection, this.registry, publicKey)
    this.actions = new ActionProvider(connection, this.registry)
    this.intel = new IntelProvider(connection, this.actions)

    // Wire auto-checkpoint callback
    this.state.onCheckpointDue = () => this.onCheckpointDue?.()
  }

  /** Callback fired when checkpoint interval is reached */
  onCheckpointDue: (() => void) | null = null

  /** Configure auto-checkpoint behavior */
  setCheckpointConfig(config: CheckpointConfig) {
    this.state.setCheckpointConfig(config)
  }

  /**
   * Execute an action with deferred state tracking.
   * On first call, initializes state from chain instead of executing.
   *
   * Returns { result, confirm }. Call confirm() after the transaction
   * is signed and confirmed on-chain. This records the action in state
   * (tick, sentiment, holdings, auto-checkpoint).
   *
   * For read-only methods (getFactions, getComms, etc.), confirm is a no-op.
   */
  async exec<T extends 'actions' | 'intel'>(
    provider: T,
    method: T extends 'actions' ? keyof Action : keyof Intel,
    ...args: any[]
  ): Promise<{ result: any; confirm: () => Promise<void> }> {
    // First exec: initialize state
    if (!this.state.initialized) {
      await this.state.init()
      return { result: null, confirm: async () => {} }
    }

    const target = provider === 'actions' ? this.actions : this.intel
    const fn = (target as any)[method]
    if (typeof fn !== 'function') throw new Error(`Unknown method: ${provider}.${String(method)}`)

    const result = await fn.call(target, ...args)

    // Build confirm callback for state-mutating actions
    const trackedAction = provider === 'actions' ? this.methodToAction(method as string) : null

    const confirm = trackedAction
      ? async () => {
          const mint = args[0]?.mint
          const message = args[0]?.message
          const description = message
            ? `${trackedAction} ${mint?.slice(0, 8) ?? '?'} — "${message}"`
            : `${trackedAction} ${mint?.slice(0, 8) ?? '?'}`
          await this.state.record(trackedAction, mint, description)
        }
      : async () => {} // no-op for reads

    return { result, confirm }
  }

  /** Map action method names to tracked action types */
  private methodToAction(method: string): TrackedAction | null {
    const map: Record<string, TrackedAction> = {
      join: 'join',
      defect: 'defect',
      rally: 'rally',
      launch: 'launch',
      message: 'message',
      fud: 'fud',
      requestWarLoan: 'war_loan',
      repayWarLoan: 'repay_loan',
      siege: 'siege',
      ascend: 'ascend',
      raze: 'raze',
      tithe: 'tithe',
    }
    return map[method] ?? null
  }
}

// ─── Types ─────────────────────────────────────────────────────────

export type {
  // Status & enums
  FactionStatus,
  AgentHealth,
  // Core game types
  FactionSummary,
  FactionDetail,
  Stronghold,
  AgentLink,
  Comms,
  WarChest,
  WarLoan,
  WarLoanWithAgent,
  Member,
  // List results
  FactionListResult,
  NearbyResult,
  MembersResult,
  CommsResult,
  AllWarLoansResult,
  WarLoanQuote,
  // Params
  LaunchFactionParams,
  JoinFactionParams,
  DefectParams,
  MessageFactionParams,
  FudFactionParams,
  RallyParams,
  RequestWarLoanParams,
  RepayWarLoanParams,
  SiegeParams,
  ClaimSpoilsParams,
  CreateStrongholdParams,
  FundStrongholdParams,
  WithdrawFromStrongholdParams,
  RecruitAgentParams,
  ExileAgentParams,
  CoupParams,
  WithdrawAssetsParams,
  AscendParams,
  RazeParams,
  TitheParams,
  // Results
  JoinFactionResult,
  LaunchFactionResult,
  TransactionResult,
  EphemeralAgent,
  // List/filter params
  FactionSortOption,
  FactionStatusFilter,
  FactionListParams,
  // Intel types
  FactionPower,
  AllianceCluster,
  RivalFaction,
  AgentProfile,
  AgentFactionPosition,
  WorldEventType,
  WorldEvent,
  WorldStats,
  // Registry types
  RegistryProfile,
  RegistryWalletLink,
  CheckpointParams,
  RegisterAgentParams,
  LinkAgentWalletParams,
  UnlinkAgentWalletParams,
  TransferAgentAuthorityParams,
} from './types'

// ─── Type interfaces ──────────────────────────────────────────────

export type { Action } from './types/action.types'
export type { Intel } from './types/intel.types'
export type { Mapper } from './types/mapper.types'
export type {
  State,
  AgentGameState,
  SerializedGameState,
  TrackedAction,
  CheckpointConfig,
} from './types/state.types'

// ─── Providers ────────────────────────────────────────────────────

export { ActionProvider } from './providers/action.provider'
export { IntelProvider } from './providers/intel.provider'
export { MapperProvider } from './providers/mapper.provider'
export { StateProvider } from './providers/state.provider'
export {
  RegistryProvider,
  REGISTRY_PROGRAM_ID,
  getAgentProfilePda,
  getAgentWalletLinkPda,
} from './providers/registry.provider'

// ─── Utilities ────────────────────────────────────────────────────

export {
  blacklistMints,
  isBlacklistedMint,
  getBlacklistedMints,
  createEphemeralAgent,
  getDexPool,
  getDexVaults,
  startVaultPnlTracker,
} from './util'

// ─── Vanity ───────────────────────────────────────────────────────

export { isPyreMint, grindPyreMint } from './vanity'

// ─── Re-export torchsdk constants for convenience ─────────────────

export { PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_MULTIPLIER, TOTAL_SUPPLY } from 'torchsdk'
