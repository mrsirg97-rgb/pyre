/**
 * Pyre Kit Mappers
 *
 * Internal mapping functions between Torch SDK types and Pyre game types.
 */

import type {
  TokenStatus,
  TokenSummary,
  TokenDetail,
  TokenStatusFilter,
  VaultInfo,
  VaultWalletLinkInfo,
  TokenMessage,
  LendingInfo,
  LoanPositionInfo,
  LoanPositionWithKey,
  Holder,
  HoldersResult,
  MessagesResult,
  TokenListResult,
  AllLoanPositionsResult,
  BuyTransactionResult,
  CreateTokenResult,
} from 'torchsdk';

import type {
  FactionStatus,
  FactionTier,
  FactionStatusFilter,
  Strategy,
  FactionSummary,
  FactionDetail,
  Stronghold,
  AgentLink,
  Comms,
  WarChest,
  WarLoan,
  WarLoanWithAgent,
  Member,
  FactionListResult,
  MembersResult,
  CommsResult,
  AllWarLoansResult,
  JoinFactionResult,
  LaunchFactionResult,
} from './types';

// ─── Status Mapping ────────────────────────────────────────────────

const STATUS_MAP: Record<TokenStatus, FactionStatus> = {
  bonding: 'rising',
  complete: 'ready',
  migrated: 'ascended',
  reclaimed: 'razed',
};

const STATUS_REVERSE: Record<FactionStatus, TokenStatus> = {
  rising: 'bonding',
  ready: 'complete',
  ascended: 'migrated',
  razed: 'reclaimed',
};

const STATUS_FILTER_REVERSE: Record<FactionStatusFilter, TokenStatusFilter> = {
  rising: 'bonding',
  ready: 'complete',
  ascended: 'migrated',
  razed: 'reclaimed',
  all: 'all',
};

export function mapFactionStatus(status: TokenStatus): FactionStatus {
  return STATUS_MAP[status];
}

export function mapTokenStatus(status: FactionStatus): TokenStatus {
  return STATUS_REVERSE[status];
}

export function mapTokenStatusFilter(status: FactionStatusFilter): TokenStatusFilter {
  return STATUS_FILTER_REVERSE[status];
}

// ─── Tier Mapping ──────────────────────────────────────────────────

/** Map SOL target to faction tier */
export function mapFactionTier(sol_target: number): FactionTier {
  // Torch tiers: spark (≤50 SOL), flame (≤100 SOL), torch (200 SOL default)
  if (sol_target <= 50_000_000_000) return 'ember';    // ≤50 SOL in lamports
  if (sol_target <= 100_000_000_000) return 'blaze';   // ≤100 SOL
  return 'inferno';                                      // 200 SOL (default)
}

/** Infer tier from sol_target in SOL (not lamports) */
export function mapFactionTierFromSol(sol_target: number): FactionTier {
  if (sol_target <= 50) return 'ember';
  if (sol_target <= 100) return 'blaze';
  return 'inferno';
}

// ─── Strategy Mapping ──────────────────────────────────────────────

export function mapStrategy(vote: 'burn' | 'return'): Strategy {
  return vote === 'burn' ? 'scorched_earth' : 'fortify';
}

export function mapVote(strategy: Strategy): 'burn' | 'return' {
  return strategy === 'scorched_earth' ? 'burn' : 'return';
}

// ─── Core Type Mappers ─────────────────────────────────────────────

export function mapTokenSummaryToFaction(t: TokenSummary): FactionSummary {
  return {
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    status: mapFactionStatus(t.status),
    tier: mapFactionTierFromSol(t.market_cap_sol > 0 ? 200 : 200), // default tier from target
    price_sol: t.price_sol,
    market_cap_sol: t.market_cap_sol,
    progress_percent: t.progress_percent,
    members: t.holders,
    created_at: t.created_at,
    last_activity_at: t.last_activity_at,
  };
}

export function mapTokenDetailToFaction(t: TokenDetail): FactionDetail {
  return {
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    description: t.description,
    image: t.image,
    status: mapFactionStatus(t.status),
    tier: mapFactionTierFromSol(t.sol_target),
    price_sol: t.price_sol,
    price_usd: t.price_usd,
    market_cap_sol: t.market_cap_sol,
    market_cap_usd: t.market_cap_usd,
    progress_percent: t.progress_percent,
    sol_raised: t.sol_raised,
    sol_target: t.sol_target,
    total_supply: t.total_supply,
    circulating_supply: t.circulating_supply,
    tokens_in_curve: t.tokens_in_curve,
    tokens_in_vote_vault: t.tokens_in_vote_vault,
    tokens_burned: t.tokens_burned,
    war_chest_sol: t.treasury_sol_balance,
    war_chest_tokens: t.treasury_token_balance,
    total_bought_back: t.total_bought_back,
    buyback_count: t.buyback_count,
    votes_scorched_earth: t.votes_burn,
    votes_fortify: t.votes_return,
    founder: t.creator,
    members: t.holders,
    rallies: t.stars,
    created_at: t.created_at,
    last_activity_at: t.last_activity_at,
    twitter: t.twitter,
    telegram: t.telegram,
    website: t.website,
    founder_verified: t.creator_verified,
    founder_trust_tier: t.creator_trust_tier,
    founder_said_name: t.creator_said_name,
    founder_badge_url: t.creator_badge_url,
    warnings: t.warnings,
  };
}

export function mapVaultToStronghold(v: VaultInfo): Stronghold {
  return {
    address: v.address,
    creator: v.creator,
    authority: v.authority,
    sol_balance: v.sol_balance,
    total_deposited: v.total_deposited,
    total_withdrawn: v.total_withdrawn,
    total_spent: v.total_spent,
    total_received: v.total_received,
    linked_agents: v.linked_wallets,
    created_at: v.created_at,
  };
}

export function mapWalletLinkToAgentLink(l: VaultWalletLinkInfo): AgentLink {
  return {
    address: l.address,
    stronghold: l.vault,
    wallet: l.wallet,
    linked_at: l.linked_at,
  };
}

export function mapTokenMessageToComms(m: TokenMessage): Comms {
  return {
    signature: m.signature,
    memo: m.memo,
    sender: m.sender,
    timestamp: m.timestamp,
    sender_verified: m.sender_verified,
    sender_trust_tier: m.sender_trust_tier,
    sender_said_name: m.sender_said_name,
    sender_badge_url: m.sender_badge_url,
  };
}

export function mapLendingToWarChest(l: LendingInfo): WarChest {
  return {
    interest_rate_bps: l.interest_rate_bps,
    max_ltv_bps: l.max_ltv_bps,
    liquidation_threshold_bps: l.liquidation_threshold_bps,
    liquidation_bonus_bps: l.liquidation_bonus_bps,
    utilization_cap_bps: l.utilization_cap_bps,
    borrow_share_multiplier: l.borrow_share_multiplier,
    total_sol_lent: l.total_sol_lent,
    active_loans: l.active_loans,
    war_chest_sol_available: l.treasury_sol_available,
    warnings: l.warnings,
  };
}

export function mapLoanToWarLoan(l: LoanPositionInfo): WarLoan {
  return {
    collateral_amount: l.collateral_amount,
    borrowed_amount: l.borrowed_amount,
    accrued_interest: l.accrued_interest,
    total_owed: l.total_owed,
    collateral_value_sol: l.collateral_value_sol,
    current_ltv_bps: l.current_ltv_bps,
    health: l.health,
    warnings: l.warnings,
  };
}

export function mapLoanWithKeyToWarLoan(l: LoanPositionWithKey): WarLoanWithAgent {
  return {
    ...mapLoanToWarLoan(l),
    borrower: l.borrower,
  };
}

export function mapHolderToMember(h: Holder): Member {
  return {
    address: h.address,
    balance: h.balance,
    percentage: h.percentage,
  };
}

// ─── Result Mappers ────────────────────────────────────────────────

export function mapTokenListResult(r: TokenListResult): FactionListResult {
  return {
    factions: r.tokens.map(mapTokenSummaryToFaction),
    total: r.total,
    limit: r.limit,
    offset: r.offset,
  };
}

export function mapHoldersResult(r: HoldersResult): MembersResult {
  return {
    members: r.holders.map(mapHolderToMember),
    total_members: r.total_holders,
  };
}

export function mapMessagesResult(r: MessagesResult): CommsResult {
  return {
    comms: r.messages.map(mapTokenMessageToComms),
    total: r.total,
  };
}

export function mapAllLoansResult(r: AllLoanPositionsResult): AllWarLoansResult {
  return {
    positions: r.positions.map(mapLoanWithKeyToWarLoan),
    pool_price_sol: r.pool_price_sol,
  };
}

export function mapBuyResult(r: BuyTransactionResult): JoinFactionResult {
  return {
    transaction: r.transaction,
    additionalTransactions: r.additionalTransactions,
    message: r.message,
    migrationTransaction: r.migrationTransaction,
  };
}

export function mapCreateResult(r: CreateTokenResult): LaunchFactionResult {
  return {
    transaction: r.transaction,
    additionalTransactions: r.additionalTransactions,
    message: r.message,
    mint: r.mint,
    mintKeypair: r.mintKeypair,
  };
}
