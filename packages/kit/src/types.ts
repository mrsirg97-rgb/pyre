/**
 * Pyre Kit Types
 *
 * Game-semantic wrappers over torchsdk types.
 * Torch Market IS the game engine — these types translate
 * protocol primitives into faction warfare language.
 */

import type { Transaction, Keypair, PublicKey } from '@solana/web3.js';
import type {
  TokenSortOption,
  TransactionResult,
  CreateTokenResult,
  SaidVerification,
  ConfirmResult,
  EphemeralAgent,
} from 'torchsdk';

// ─── Status & Tier Enums ───────────────────────────────────────────

/** Faction lifecycle: rising (bonding) → ready (complete) → ascended (migrated) → razed (reclaimed) */
export type FactionStatus = 'rising' | 'ready' | 'ascended' | 'razed';

/** Faction tier based on SOL target: ember (spark) → blaze (flame) → inferno (torch) */
export type FactionTier = 'ember' | 'blaze' | 'inferno';

/** Governance strategy: scorched_earth (burn tokens) or fortify (return to treasury lock) */
export type Strategy = 'scorched_earth' | 'fortify';

/** Agent loan health status */
export type AgentHealth = 'healthy' | 'at_risk' | 'liquidatable' | 'none';

// ─── Core Game Types ───────────────────────────────────────────────

/** Summary view of a faction (wraps TokenSummary) */
export interface FactionSummary {
  mint: string;
  name: string;
  symbol: string;
  status: FactionStatus;
  tier: FactionTier;
  price_sol: number;
  market_cap_sol: number;
  progress_percent: number;
  members: number | null;
  created_at: number;
  last_activity_at: number;
}

/** Detailed view of a faction (wraps TokenDetail) */
export interface FactionDetail {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  status: FactionStatus;
  tier: FactionTier;
  price_sol: number;
  price_usd?: number;
  market_cap_sol: number;
  market_cap_usd?: number;
  progress_percent: number;
  sol_raised: number;
  sol_target: number;
  total_supply: number;
  circulating_supply: number;
  tokens_in_curve: number;
  tokens_in_vote_vault: number;
  tokens_burned: number;
  war_chest_sol: number;
  war_chest_tokens: number;
  total_bought_back: number;
  buyback_count: number;
  votes_scorched_earth: number;
  votes_fortify: number;
  founder: string;
  members: number | null;
  rallies: number;
  created_at: number;
  last_activity_at: number;
  twitter?: string;
  telegram?: string;
  website?: string;
  founder_verified?: boolean;
  founder_trust_tier?: 'high' | 'medium' | 'low' | null;
  founder_said_name?: string;
  founder_badge_url?: string;
  warnings?: string[];
}

/** Agent stronghold (wraps VaultInfo) */
export interface Stronghold {
  address: string;
  creator: string;
  authority: string;
  sol_balance: number;
  total_deposited: number;
  total_withdrawn: number;
  total_spent: number;
  total_received: number;
  linked_agents: number;
  created_at: number;
}

/** Agent wallet link (wraps VaultWalletLinkInfo) */
export interface AgentLink {
  address: string;
  stronghold: string;
  wallet: string;
  linked_at: number;
}

/** Faction communication (wraps TokenMessage) */
export interface Comms {
  signature: string;
  memo: string;
  sender: string;
  timestamp: number;
  sender_verified?: boolean;
  sender_trust_tier?: 'high' | 'medium' | 'low' | null;
  sender_said_name?: string;
  sender_badge_url?: string;
}

/** War chest lending info (wraps LendingInfo) */
export interface WarChest {
  interest_rate_bps: number;
  max_ltv_bps: number;
  liquidation_threshold_bps: number;
  liquidation_bonus_bps: number;
  utilization_cap_bps: number;
  borrow_share_multiplier: number;
  total_sol_lent: number | null;
  active_loans: number | null;
  war_chest_sol_available: number;
  warnings?: string[];
}

/** War loan position (wraps LoanPositionInfo) */
export interface WarLoan {
  collateral_amount: number;
  borrowed_amount: number;
  accrued_interest: number;
  total_owed: number;
  collateral_value_sol: number | null;
  current_ltv_bps: number | null;
  health: AgentHealth;
  warnings?: string[];
}

/** War loan with borrower key (wraps LoanPositionWithKey) */
export interface WarLoanWithAgent extends WarLoan {
  borrower: string;
}

/** Faction member (wraps Holder) */
export interface Member {
  address: string;
  balance: number;
  percentage: number;
}

// ─── List Results ──────────────────────────────────────────────────

export interface FactionListResult {
  factions: FactionSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface MembersResult {
  members: Member[];
  total_members: number;
}

export interface CommsResult {
  comms: Comms[];
  total: number;
}

export interface AllWarLoansResult {
  positions: WarLoanWithAgent[];
  pool_price_sol: number | null;
}

// ─── Action Params ─────────────────────────────────────────────────

export interface LaunchFactionParams {
  founder: string;
  name: string;
  symbol: string;
  metadata_uri: string;
  sol_target?: number;
  community_faction?: boolean;
}

export interface JoinFactionParams {
  mint: string;
  agent: string;
  amount_sol: number;
  slippage_bps?: number;
  strategy?: Strategy;
  message?: string;
  stronghold: string;
}

export interface DirectJoinFactionParams {
  mint: string;
  agent: string;
  amount_sol: number;
  slippage_bps?: number;
  strategy?: Strategy;
  message?: string;
}

export interface DefectParams {
  mint: string;
  agent: string;
  amount_tokens: number;
  slippage_bps?: number;
  message?: string;
  stronghold?: string;
}

export interface RallyParams {
  mint: string;
  agent: string;
  stronghold?: string;
}

export interface RequestWarLoanParams {
  mint: string;
  borrower: string;
  collateral_amount: number;
  sol_to_borrow: number;
  stronghold?: string;
}

export interface RepayWarLoanParams {
  mint: string;
  borrower: string;
  sol_amount: number;
  stronghold?: string;
}

export interface SiegeParams {
  mint: string;
  liquidator: string;
  borrower: string;
  stronghold?: string;
}

export interface TradeOnDexParams {
  mint: string;
  signer: string;
  stronghold_creator: string;
  amount_in: number;
  minimum_amount_out: number;
  is_buy: boolean;
  /** Optional message bundled as SPL Memo instruction (max 500 chars) */
  message?: string;
}

export interface ClaimSpoilsParams {
  agent: string;
  stronghold?: string;
}

export interface CreateStrongholdParams {
  creator: string;
}

export interface FundStrongholdParams {
  depositor: string;
  stronghold_creator: string;
  amount_sol: number;
}

export interface WithdrawFromStrongholdParams {
  authority: string;
  stronghold_creator: string;
  amount_sol: number;
}

export interface RecruitAgentParams {
  authority: string;
  stronghold_creator: string;
  wallet_to_link: string;
}

export interface ExileAgentParams {
  authority: string;
  stronghold_creator: string;
  wallet_to_unlink: string;
}

export interface CoupParams {
  authority: string;
  stronghold_creator: string;
  new_authority: string;
}

export interface WithdrawAssetsParams {
  authority: string;
  stronghold_creator: string;
  mint: string;
  destination: string;
  amount: number;
}

export interface AscendParams {
  mint: string;
  payer: string;
}

export interface RazeParams {
  payer: string;
  mint: string;
}

export interface TitheParams {
  mint: string;
  payer: string;
  sources?: string[];
}

export interface ConvertTitheParams {
  mint: string;
  payer: string;
  minimum_amount_out?: number;
  harvest?: boolean;
  sources?: string[];
}

// ─── Action Results ────────────────────────────────────────────────

/** Re-export base result types with game names */
export type { TransactionResult, CreateTokenResult, EphemeralAgent, SaidVerification, ConfirmResult };

export interface JoinFactionResult extends TransactionResult {
  migrationTransaction?: Transaction;
}

export interface LaunchFactionResult extends TransactionResult {
  mint: PublicKey;
  mintKeypair: Keypair;
}

// ─── List/Filter Params ────────────────────────────────────────────

export type FactionSortOption = TokenSortOption;
export type FactionStatusFilter = 'rising' | 'ready' | 'ascended' | 'razed' | 'all';

export interface FactionListParams {
  limit?: number;
  offset?: number;
  status?: FactionStatusFilter;
  sort?: FactionSortOption;
}

// ─── War Loan Quote ─────────────────────────────────────────────

/** Result of computing max borrowable SOL for a given collateral amount */
export interface WarLoanQuote {
  /** Max SOL borrowable (lamports) — minimum of LTV cap, pool available, per-user cap */
  max_borrow_sol: number;
  /** Collateral value in SOL (lamports) */
  collateral_value_sol: number;
  /** LTV-limited max borrow (lamports) */
  ltv_max_sol: number;
  /** Pool available SOL (lamports) */
  pool_available_sol: number;
  /** Per-user cap SOL (lamports) — based on share of supply * borrow_share_multiplier */
  per_user_cap_sol: number;
  /** Current interest rate in bps per epoch */
  interest_rate_bps: number;
  /** Liquidation threshold in bps */
  liquidation_threshold_bps: number;
}

// ─── Intel Types ───────────────────────────────────────────────────

export interface FactionPower {
  mint: string;
  name: string;
  symbol: string;
  score: number;
  market_cap_sol: number;
  members: number;
  war_chest_sol: number;
  rallies: number;
  progress_percent: number;
  status: FactionStatus;
}

export interface AllianceCluster {
  factions: string[];
  shared_members: number;
  overlap_percent: number;
}

export interface RivalFaction {
  mint: string;
  name: string;
  symbol: string;
  defections_in: number;
  defections_out: number;
}

export interface AgentProfile {
  wallet: string;
  stronghold: Stronghold | null;
  factions_joined: AgentFactionPosition[];
  factions_founded: string[];
  said_verification: SaidVerification | null;
  total_value_sol: number;
}

export interface AgentFactionPosition {
  mint: string;
  name: string;
  symbol: string;
  balance: number;
  percentage: number;
  value_sol: number;
}

/** Action types for world events and stage feed */
export type WorldEventType =
  | 'launch' | 'join' | 'reinforce' | 'defect' | 'rally'
  | 'ascend' | 'raze' | 'messaged'
  | 'siege' | 'tithe' | 'war_loan' | 'repay_loan';

export interface WorldEvent {
  type: WorldEventType;
  faction_mint: string;
  faction_name: string;
  agent?: string;
  amount_sol?: number;
  timestamp: number;
  signature?: string;
  message?: string;
}

export interface WorldStats {
  total_factions: number;
  rising_factions: number;
  ascended_factions: number;
  total_sol_locked: number;
  most_powerful: FactionPower | null;
}
