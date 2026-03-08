/**
 * Pyre Kit Actions
 *
 * Thin wrappers that call torchsdk functions and map params/results
 * into game-semantic Pyre types. No new on-chain logic.
 */

import { Connection } from '@solana/web3.js';
import {
  // Read operations
  getTokens,
  getToken,
  getHolders,
  getMessages,
  getBuyQuote,
  getSellQuote,
  getVault,
  getVaultForWallet,
  getVaultWalletLink,
  getLendingInfo,
  getLoanPosition,
  getAllLoanPositions,
  // Transaction builders
  buildBuyTransaction,
  buildDirectBuyTransaction,
  buildSellTransaction,
  buildStarTransaction,
  buildBorrowTransaction,
  buildRepayTransaction,
  buildLiquidateTransaction,
  buildVaultSwapTransaction,
  buildClaimProtocolRewardsTransaction,
  buildCreateVaultTransaction,
  buildDepositVaultTransaction,
  buildWithdrawVaultTransaction,
  buildLinkWalletTransaction,
  buildUnlinkWalletTransaction,
  buildTransferAuthorityTransaction,
  buildWithdrawTokensTransaction,
  buildMigrateTransaction,
  buildReclaimFailedTokenTransaction,
  buildHarvestFeesTransaction,
  buildSwapFeesToSolTransaction,
  // Utilities
  verifySaid,
  confirmTransaction,
} from 'torchsdk';

import type { BuyQuoteResult, SellQuoteResult, TransactionResult, SaidVerification, ConfirmResult } from 'torchsdk';

import type {
  FactionListParams,
  FactionListResult,
  FactionDetail,
  MembersResult,
  CommsResult,
  Stronghold,
  AgentLink,
  WarChest,
  WarLoan,
  AllWarLoansResult,
  LaunchFactionParams,
  JoinFactionParams,
  DirectJoinFactionParams,
  DefectParams,
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
  JoinFactionResult,
  LaunchFactionResult,
} from './types';

import {
  mapTokenListResult,
  mapTokenDetailToFaction,
  mapHoldersResult,
  mapMessagesResult,
  mapVaultToStronghold,
  mapWalletLinkToAgentLink,
  mapLendingToWarChest,
  mapLoanToWarLoan,
  mapAllLoansResult,
  mapBuyResult,
  mapCreateResult,
  mapVote,
  mapTokenStatusFilter,
} from './mappers';

import { buildCreateFactionTransaction, isPyreMint } from './vanity';

// ─── Read Operations ───────────────────────────────────────────────

/** List all factions with optional filtering and sorting */
export async function getFactions(
  connection: Connection,
  params?: FactionListParams,
): Promise<FactionListResult> {
  const sdkParams = params ? {
    limit: params.limit,
    offset: params.offset,
    status: params.status ? mapTokenStatusFilter(params.status) : undefined,
    sort: params.sort,
  } : undefined;
  const result = await getTokens(connection, sdkParams);
  return mapTokenListResult(result);
}

/** Get detailed info for a single faction */
export async function getFaction(
  connection: Connection,
  mint: string,
): Promise<FactionDetail> {
  const detail = await getToken(connection, mint);
  return mapTokenDetailToFaction(detail);
}

/** Get faction members (top holders) */
export async function getMembers(
  connection: Connection,
  mint: string,
  limit?: number,
): Promise<MembersResult> {
  const result = await getHolders(connection, mint, limit);
  return mapHoldersResult(result);
}

/** Get faction comms (trade-bundled messages) */
export async function getComms(
  connection: Connection,
  mint: string,
  limit?: number,
): Promise<CommsResult> {
  const result = await getMessages(connection, mint, limit);
  return mapMessagesResult(result);
}

/** Get a quote for joining a faction (buying tokens) */
export async function getJoinQuote(
  connection: Connection,
  mint: string,
  amountSolLamports: number,
): Promise<BuyQuoteResult> {
  return getBuyQuote(connection, mint, amountSolLamports);
}

/** Get a quote for defecting from a faction (selling tokens) */
export async function getDefectQuote(
  connection: Connection,
  mint: string,
  amountTokens: number,
): Promise<SellQuoteResult> {
  return getSellQuote(connection, mint, amountTokens);
}

/** Get stronghold (vault) by creator */
export async function getStronghold(
  connection: Connection,
  creator: string,
): Promise<Stronghold | null> {
  const vault = await getVault(connection, creator);
  return vault ? mapVaultToStronghold(vault) : null;
}

/** Get stronghold for a linked agent wallet */
export async function getStrongholdForAgent(
  connection: Connection,
  wallet: string,
): Promise<Stronghold | null> {
  const vault = await getVaultForWallet(connection, wallet);
  return vault ? mapVaultToStronghold(vault) : null;
}

/** Get agent link info for a wallet */
export async function getAgentLink(
  connection: Connection,
  wallet: string,
): Promise<AgentLink | null> {
  const link = await getVaultWalletLink(connection, wallet);
  return link ? mapWalletLinkToAgentLink(link) : null;
}

/** Get war chest (lending info) for a faction */
export async function getWarChest(
  connection: Connection,
  mint: string,
): Promise<WarChest> {
  const info = await getLendingInfo(connection, mint);
  return mapLendingToWarChest(info);
}

/** Get war loan position for a specific agent on a faction */
export async function getWarLoan(
  connection: Connection,
  mint: string,
  wallet: string,
): Promise<WarLoan> {
  const pos = await getLoanPosition(connection, mint, wallet);
  return mapLoanToWarLoan(pos);
}

/** Get all war loans for a faction */
export async function getAllWarLoans(
  connection: Connection,
  mint: string,
): Promise<AllWarLoansResult> {
  const result = await getAllLoanPositions(connection, mint);
  return mapAllLoansResult(result);
}

// ─── Faction Operations (controller) ───────────────────────────────

/** Launch a new faction (create token) */
export async function launchFaction(
  connection: Connection,
  params: LaunchFactionParams,
): Promise<LaunchFactionResult> {
  const result = await buildCreateFactionTransaction(connection, {
    creator: params.founder,
    name: params.name,
    symbol: params.symbol,
    metadata_uri: params.metadata_uri,
    sol_target: params.sol_target,
    community_token: params.community_faction,
  });
  return mapCreateResult(result);
}

/** Join a faction via stronghold (vault-funded buy) */
export async function joinFaction(
  connection: Connection,
  params: JoinFactionParams,
): Promise<JoinFactionResult> {
  const result = await buildBuyTransaction(connection, {
    mint: params.mint,
    buyer: params.agent,
    amount_sol: params.amount_sol,
    slippage_bps: params.slippage_bps,
    vote: params.strategy ? mapVote(params.strategy) : undefined,
    message: params.message,
    vault: params.stronghold,
  });
  return mapBuyResult(result);
}

/** Join a faction directly (no vault) */
export async function directJoinFaction(
  connection: Connection,
  params: DirectJoinFactionParams,
): Promise<JoinFactionResult> {
  const result = await buildDirectBuyTransaction(connection, {
    mint: params.mint,
    buyer: params.agent,
    amount_sol: params.amount_sol,
    slippage_bps: params.slippage_bps,
    vote: params.strategy ? mapVote(params.strategy) : undefined,
    message: params.message,
  });
  return mapBuyResult(result);
}

/** Defect from a faction (sell tokens) */
export async function defect(
  connection: Connection,
  params: DefectParams,
): Promise<TransactionResult> {
  return buildSellTransaction(connection, {
    mint: params.mint,
    seller: params.agent,
    amount_tokens: params.amount_tokens,
    slippage_bps: params.slippage_bps,
    message: params.message,
    vault: params.stronghold,
  });
}

/** Rally support for a faction (star) */
export async function rally(
  connection: Connection,
  params: RallyParams,
): Promise<TransactionResult> {
  return buildStarTransaction(connection, {
    mint: params.mint,
    user: params.agent,
    vault: params.stronghold,
  });
}

/** Request a war loan (borrow SOL against token collateral) */
export async function requestWarLoan(
  connection: Connection,
  params: RequestWarLoanParams,
): Promise<TransactionResult> {
  return buildBorrowTransaction(connection, {
    mint: params.mint,
    borrower: params.borrower,
    collateral_amount: params.collateral_amount,
    sol_to_borrow: params.sol_to_borrow,
    vault: params.stronghold,
  });
}

/** Repay a war loan */
export async function repayWarLoan(
  connection: Connection,
  params: RepayWarLoanParams,
): Promise<TransactionResult> {
  return buildRepayTransaction(connection, {
    mint: params.mint,
    borrower: params.borrower,
    sol_amount: params.sol_amount,
    vault: params.stronghold,
  });
}

/** Trade on DEX via stronghold (vault-routed Raydium swap) */
export async function tradeOnDex(
  connection: Connection,
  params: TradeOnDexParams,
): Promise<TransactionResult> {
  return buildVaultSwapTransaction(connection, {
    mint: params.mint,
    signer: params.signer,
    vault_creator: params.stronghold_creator,
    amount_in: params.amount_in,
    minimum_amount_out: params.minimum_amount_out,
    is_buy: params.is_buy,
    message: params.message,
  });
}

/** Claim spoils (protocol rewards) */
export async function claimSpoils(
  connection: Connection,
  params: ClaimSpoilsParams,
): Promise<TransactionResult> {
  return buildClaimProtocolRewardsTransaction(connection, {
    user: params.agent,
    vault: params.stronghold,
  });
}

// ─── Stronghold Operations (authority) ─────────────────────────────

/** Create a new stronghold (vault) */
export async function createStronghold(
  connection: Connection,
  params: CreateStrongholdParams,
): Promise<TransactionResult> {
  return buildCreateVaultTransaction(connection, {
    creator: params.creator,
  });
}

/** Fund a stronghold with SOL */
export async function fundStronghold(
  connection: Connection,
  params: FundStrongholdParams,
): Promise<TransactionResult> {
  return buildDepositVaultTransaction(connection, {
    depositor: params.depositor,
    vault_creator: params.stronghold_creator,
    amount_sol: params.amount_sol,
  });
}

/** Withdraw SOL from a stronghold */
export async function withdrawFromStronghold(
  connection: Connection,
  params: WithdrawFromStrongholdParams,
): Promise<TransactionResult> {
  return buildWithdrawVaultTransaction(connection, {
    authority: params.authority,
    vault_creator: params.stronghold_creator,
    amount_sol: params.amount_sol,
  });
}

/** Recruit an agent (link wallet to stronghold) */
export async function recruitAgent(
  connection: Connection,
  params: RecruitAgentParams,
): Promise<TransactionResult> {
  return buildLinkWalletTransaction(connection, {
    authority: params.authority,
    vault_creator: params.stronghold_creator,
    wallet_to_link: params.wallet_to_link,
  });
}

/** Exile an agent (unlink wallet from stronghold) */
export async function exileAgent(
  connection: Connection,
  params: ExileAgentParams,
): Promise<TransactionResult> {
  return buildUnlinkWalletTransaction(connection, {
    authority: params.authority,
    vault_creator: params.stronghold_creator,
    wallet_to_unlink: params.wallet_to_unlink,
  });
}

/** Coup — transfer stronghold authority */
export async function coup(
  connection: Connection,
  params: CoupParams,
): Promise<TransactionResult> {
  return buildTransferAuthorityTransaction(connection, {
    authority: params.authority,
    vault_creator: params.stronghold_creator,
    new_authority: params.new_authority,
  });
}

/** Withdraw token assets from stronghold */
export async function withdrawAssets(
  connection: Connection,
  params: WithdrawAssetsParams,
): Promise<TransactionResult> {
  return buildWithdrawTokensTransaction(connection, {
    authority: params.authority,
    vault_creator: params.stronghold_creator,
    mint: params.mint,
    destination: params.destination,
    amount: params.amount,
  });
}

// ─── Permissionless Operations ─────────────────────────────────────

/** Siege — liquidate an undercollateralized war loan */
export async function siege(
  connection: Connection,
  params: SiegeParams,
): Promise<TransactionResult> {
  return buildLiquidateTransaction(connection, {
    mint: params.mint,
    liquidator: params.liquidator,
    borrower: params.borrower,
    vault: params.stronghold,
  });
}

/** Ascend — migrate a completed faction to DEX */
export async function ascend(
  connection: Connection,
  params: AscendParams,
): Promise<TransactionResult> {
  return buildMigrateTransaction(connection, {
    mint: params.mint,
    payer: params.payer,
  });
}

/** Raze — reclaim a failed faction */
export async function raze(
  connection: Connection,
  params: RazeParams,
): Promise<TransactionResult> {
  return buildReclaimFailedTokenTransaction(connection, {
    payer: params.payer,
    mint: params.mint,
  });
}

/** Tithe — harvest transfer fees */
export async function tithe(
  connection: Connection,
  params: TitheParams,
): Promise<TransactionResult> {
  return buildHarvestFeesTransaction(connection, {
    mint: params.mint,
    payer: params.payer,
    sources: params.sources,
  });
}

/** Convert tithe — swap harvested fees to SOL */
export async function convertTithe(
  connection: Connection,
  params: ConvertTitheParams,
): Promise<TransactionResult> {
  return buildSwapFeesToSolTransaction(connection, {
    mint: params.mint,
    payer: params.payer,
    minimum_amount_out: params.minimum_amount_out,
    harvest: params.harvest,
    sources: params.sources,
  });
}

// ─── SAID Operations ───────────────────────────────────────────────

/** Verify an agent's SAID reputation */
export async function verifyAgent(wallet: string): Promise<SaidVerification> {
  return verifySaid(wallet);
}

/** Confirm a transaction on-chain */
export async function confirmAction(
  connection: Connection,
  signature: string,
  wallet: string,
): Promise<ConfirmResult> {
  return confirmTransaction(connection, signature, wallet);
}

// ─── Utility ───────────────────────────────────────────────────────

/** Create an ephemeral agent keypair (memory-only, zero key management) */
export { createEphemeralAgent } from 'torchsdk';
