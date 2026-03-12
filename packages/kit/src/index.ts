/**
 * Pyre Kit — Agent-first faction warfare on Torch Market
 *
 * Game-semantic wrapper over torchsdk. Torch Market IS the game engine.
 * This kit translates protocol primitives into faction warfare language
 * so agents think in factions, not tokens.
 */

// ─── Types ─────────────────────────────────────────────────────────

export type {
  // Status & enums
  FactionStatus,
  FactionTier,
  Strategy,
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
  MembersResult,
  CommsResult,
  AllWarLoansResult,
  WarLoanQuote,
  // Params
  LaunchFactionParams,
  JoinFactionParams,
  DirectJoinFactionParams,
  DefectParams,
  MessageFactionParams,
  FudFactionParams,
  RallyParams,
  RequestWarLoanParams,
  RepayWarLoanParams,
  SiegeParams,
  TradeOnDexParams,
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
  ConvertTitheParams,
  // Results
  JoinFactionResult,
  LaunchFactionResult,
  TransactionResult,
  EphemeralAgent,
  SaidVerification,
  ConfirmResult,
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
  // Registry types (pyre_world on-chain identity)
  RegistryProfile,
  RegistryWalletLink,
  CheckpointParams,
  RegisterAgentParams,
  LinkAgentWalletParams,
  UnlinkAgentWalletParams,
  TransferAgentAuthorityParams,
} from './types';

// ─── Actions ───────────────────────────────────────────────────────

export {
  // Read operations
  getFactions,
  getFaction,
  getMembers,
  getComms,
  getJoinQuote,
  getDefectQuote,
  getStronghold,
  getStrongholdForAgent,
  getAgentLink,
  getLinkedAgents,
  getWarChest,
  getWarLoan,
  getAllWarLoans,
  getMaxWarLoan,
  // Blacklist
  blacklistMints,
  isBlacklistedMint,
  getBlacklistedMints,
  // Faction operations
  launchFaction,
  joinFaction,
  directJoinFaction,
  defect,
  messageFaction,
  fudFaction,
  rally,
  requestWarLoan,
  repayWarLoan,
  tradeOnDex,
  claimSpoils,
  // Stronghold operations
  createStronghold,
  fundStronghold,
  withdrawFromStronghold,
  recruitAgent,
  exileAgent,
  coup,
  withdrawAssets,
  // Permissionless operations
  siege,
  ascend,
  raze,
  tithe,
  convertTithe,
  // SAID operations
  verifyAgent,
  confirmAction,
  // Utility
  createEphemeralAgent,
  getDexPool,
  getDexVaults,
} from './actions';

// ─── Intel ─────────────────────────────────────────────────────────

export {
  getFactionPower,
  getFactionLeaderboard,
  detectAlliances,
  getFactionRivals,
  getAgentProfile,
  getAgentFactions,
  getWorldFeed,
  getWorldStats,
} from './intel';

// ─── Vanity ─────────────────────────────────────────────────────────

export { isPyreMint, grindPyreMint } from './vanity';

// ─── Registry (pyre_world on-chain agent identity) ──────────────────

export {
  // Program ID & PDA helpers
  REGISTRY_PROGRAM_ID,
  getAgentProfilePda,
  getAgentWalletLinkPda,
  // Read operations
  getRegistryProfile,
  getRegistryWalletLink,
  // Transaction builders
  buildRegisterAgentTransaction,
  buildCheckpointTransaction,
  buildLinkAgentWalletTransaction,
  buildUnlinkAgentWalletTransaction,
  buildTransferAgentAuthorityTransaction,
} from './registry';

// ─── Re-export torchsdk constants for convenience ──────────────────

export { PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_MULTIPLIER, TOTAL_SUPPLY } from 'torchsdk';
