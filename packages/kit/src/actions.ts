/**
 * Pyre Kit Actions
 *
 * Thin wrappers that call torchsdk functions and map params/results
 * into game-semantic Pyre types. No new on-chain logic.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
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
  // PDA derivation
  getRaydiumMigrationAccounts,
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
  WarLoanQuote,
  AllWarLoansResult,
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

// ─── Blacklist ──────────────────────────────────────────────────────
// Mints from previous swarm runs. Agents should skip these and only
// interact with freshly launched factions.

const DEFAULT_BLACKLIST = [
  'E1SgYPW6JXhw5BabrvJkr6L2PyvfFenYaoCTePazyNpy','6jWsyDC87RmfrZZRjuxSAxvUxE665HGZwZ2Z8j5z9epy',
  '6J8PLgFxHb98cNURP2Yt2SKwgnUeEXpN6Us2kxaMz1py','5A297UyPQstxWpJyydDnFvn2zN8whCEYdqvnfB5bF9py',
  '8XdWfSKLJusAcRrYzK3bWJ7dy46AkbU8qxF3B55uSfpy','7ZYrKcJbFFbG36keCYRvfc1j1HScQmJW1zRV3wVVD4py',
  'ERQPyG2oqx5bdyuY2Nnm5ZbZY2zcB46TfUxqpzYWH5py','JCvpK3kTnh2EdQG71mqE8ZXcvzLU5EJNG5vgGZme4wpy',
  '9RDFkGSjKpjHtXZ25uuug2MN5P7oSjzkLg16HcrKy3py','2kWcX1ZetV4jUtBPbKKk265q4gS4nuut2kc1MbaZDfpy',
  '3r9FnQim6GToR7NkY5om8igUNu7gfpq5fk2qtv3bV5py','2498F79s1Ghyj3J4VhV1qy5hhznnM53ZwzTXM9iscopy',
  '5VpotyDyc8QKKqLuzu8pfhtEa9gsRG1ww58DbqJUgTpy','GXi1opahTkavPfAqfUhkoUJRBjPoAmAMVW87kdbDwNpy',
  'GKFAokGiyhXGXxUPgwQEo8fE5nBjRdJcVX6LVj7SgPpy','EKFVwfNk1xzqhpyFJSMNw8KDcLRemvqxiGoSyfRtBspy',
  'GsZLHVt3mTwus5krUcifBWS52xMQSuXSy3RpPhEFtvpy','9azKjXnt2w4RB5ykVcyaicWSssmxoapZ9SSQLMZc4Epy',
  'BaLwryyMrqhtsMrELkrTSdWF9UYuNdjW4413hrQqbtpy','5p9ibszMVe79mm95M8uubS6WttXem2xZfh3mWmBdvUpy',
  'CTvoAmTggJcBTnbxcfy91Y1c6t6fU5xq3SRtYh3TgEpy','2kqVCdQS9KSv2kxLiytGZfcLsx5xwKQT6rHTg4V18hpy',
  'zV7XZcvY8DVk4scKUiw7GGN4L3eBPSXuD7Q1NPxfspy','3UhzKfdU1wgnEN2VCykRURw88qVVqeu3ejRkUnjmhRpy',
  'FRaS3dAdr1zo6u811XBVGUp9K2mSdQ2yG8qW4qP5hapy','4NHzWVP7hzZhd9LhTrbyxzsSnT8EmNSYVP1DpAKXHYpy',
  'Yt2rdfp6uzS7L52df3LPmetLoy3GvKChYJ4Lmvk6gpy','9Ejju29KHPWMpda4WpFsJ6ZDHVUqNWyMZHteEisgw9py',
  '2zPC4A7WR2cMNDfBzERp49fEbTBCyqXPKhcrgz3hWcpy','7jBAriydb1qRy7Wg4WAz8woHP4pVxZJSnF7vw95tVQpy',
  'HvPWKuMFpG3zAdkPMbaadyo78VoJbAMtpXaBYMK1Aqpy','GyNw9bkqz2rhR66Xx7P4p11PFBrjPi2r6XoCg5gPAdpy',
  '6HveNEes9xtkkchb76JgjWWQ61sbXjESy2vr3A7Maipy','8E3GETvTkTTaCLpzkyHJTnuNMfmGvzUEgAYnurZuLZpy',
  'AeApaJqppwjW9S2KeZGPZpmg1kAdxZHkFRnXPZc8Kjpy','8FfteyAMQm96upu4w6cJvE5T8RcMKRf5keJMdXbukXpy',
  'BrEj2Q9XE13WesRU1u8USiprv2DkpBcJfaqQeqQ6grpy','Dtki37mAB3DiTW1bp8LnZQyv54UuC68Yo5pGZkPdVSpy',
  '77UzTntZ7ThyXhN4hVvSx7m6tjit8uCw6U2LVQHPSqpy','ASV9kiC6vEpZy3X7xVExuyG257KHKd3Hutbji8AVRUpy',
  'Fc1V6KcxSriJkUNeDLqz8w5Sm4mp1s8gxornZVLcHEpy','FEizyHEUoYenqfpF87kqiGnq3w1R2TReodEfsnTrrfpy',
  'DmwgcVHoJxKeRiij5LtedY9LWDpqoqa3hGfUyVgBkgpy','GUGz1Em5KZ57aKFqEBSd4Y4Vb6WxBd3H2b16fPCC6upy',
  '6ZWY3Bau5zw1j7vMQQ1czSw4rjBJrExHQ8Renor2vLpy',
];

const BLACKLISTED_MINTS = new Set<string>(DEFAULT_BLACKLIST);

/** Add mints to the blacklist (call at startup with old mints) */
export function blacklistMints(mints: string[]): void {
  for (const m of mints) BLACKLISTED_MINTS.add(m);
}

/** Check if a mint is blacklisted */
export function isBlacklistedMint(mint: string): boolean {
  return BLACKLISTED_MINTS.has(mint);
}

/** Get all blacklisted mints */
export function getBlacklistedMints(): string[] {
  return Array.from(BLACKLISTED_MINTS);
}

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

/** Get faction comms (trade-bundled messages, including post-ascension DEX messages) */
export async function getComms(
  connection: Connection,
  mint: string,
  limit?: number,
): Promise<CommsResult> {
  const safeLimit = Math.min(limit || 50, 100);
  const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

  // Fetch bonding curve messages AND pool state messages in parallel
  const bondingCommsPromise = getMessages(connection, mint, safeLimit)
    .then(r => mapMessagesResult(r))
    .catch(() => ({ comms: [], total: 0 } as CommsResult));

  const poolCommsPromise = (async (): Promise<CommsResult> => {
    try {
      const mintPubkey = new PublicKey(mint);
      const { poolState } = getRaydiumMigrationAccounts(mintPubkey);

      const signatures = await connection.getSignaturesForAddress(
        poolState,
        { limit: Math.min(safeLimit, 50) },
        'confirmed',
      );

      if (signatures.length === 0) return { comms: [], total: 0 };

      const txs = await connection.getParsedTransactions(
        signatures.map(s => s.signature),
        { maxSupportedTransactionVersion: 0 },
      );

      const comms: CommsResult['comms'] = [];

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        if (!tx?.meta || tx.meta.err) continue;

        const sig = signatures[i];

        // Check top-level and inner instructions for memo
        const allInstructions = [
          ...tx.transaction.message.instructions,
          ...(tx.meta.innerInstructions || []).flatMap(inner => inner.instructions),
        ];

        for (const ix of allInstructions) {
          const programId = 'programId' in ix ? ix.programId.toString() : '';
          const programName = 'program' in ix ? (ix as { program: string }).program : '';
          const isMemo = programId === MEMO_PROGRAM || programName === 'spl-memo';

          if (isMemo) {
            let memoText = '';
            if ('parsed' in ix) {
              memoText = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed);
            } else if ('data' in ix && typeof ix.data === 'string') {
              try {
                memoText = new TextDecoder().decode(bs58.decode(ix.data));
              } catch {
                memoText = ix.data;
              }
            }

            if (memoText && memoText.trim()) {
              const sender = tx.transaction.message.accountKeys[0]?.pubkey?.toString() || 'Unknown';
              comms.push({
                signature: sig.signature,
                memo: memoText.trim(),
                sender,
                timestamp: sig.blockTime || 0,
              });
              break;
            }
          }
        }
      }

      return { comms, total: comms.length };
    } catch {
      return { comms: [], total: 0 };
    }
  })();

  const [bondingResult, poolResult] = await Promise.all([bondingCommsPromise, poolCommsPromise]);

  // Merge, dedupe by signature, sort newest first, trim to limit
  const seen = new Set<string>();
  const allComms: CommsResult['comms'] = [];

  for (const c of [...bondingResult.comms, ...poolResult.comms]) {
    if (!seen.has(c.signature)) {
      seen.add(c.signature);
      allComms.push(c);
    }
  }

  allComms.sort((a, b) => b.timestamp - a.timestamp);

  return {
    comms: allComms.slice(0, safeLimit),
    total: allComms.length,
  };
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

/**
 * Compute max borrowable SOL for a given collateral amount.
 *
 * Mirrors the burnfun LendingDashboard logic — effective max borrow is the
 * minimum of three caps:
 *   1. LTV limit: collateral_value_sol * (max_ltv_bps / 10000)
 *   2. Pool available: treasury_sol * utilization_cap - total_lent
 *   3. Per-user cap: (collateral / total_supply) * borrow_share_multiplier * max_lendable
 *
 * All values in lamports. Accounts for Token-2022 transfer fee (4 bps).
 */
export async function getMaxWarLoan(
  connection: Connection,
  mint: string,
  collateralAmount: number,
): Promise<WarLoanQuote> {
  const TOTAL_SUPPLY = 1_000_000_000_000_000; // 1B tokens * 1e6 multiplier (base units)
  const TRANSFER_FEE_BPS = 4;
  const LAMPORTS_PER_SOL = 1_000_000_000;

  const [lending, detail] = await Promise.all([
    getLendingInfo(connection, mint),
    getToken(connection, mint),
  ]);

  // Price per base-unit token in SOL (lamports)
  const pricePerToken = detail.price_sol; // SOL per display token
  const TOKEN_MULTIPLIER = 1_000_000;

  // Collateral value in SOL (lamports)
  const collateralDisplayTokens = collateralAmount / TOKEN_MULTIPLIER;
  const collateralValueSol = collateralDisplayTokens * pricePerToken * LAMPORTS_PER_SOL;

  // 1. LTV cap
  const ltvMaxSol = collateralValueSol * (lending.max_ltv_bps / 10000);

  // 2. Pool available
  const treasurySol = detail.treasury_sol_balance * LAMPORTS_PER_SOL;
  const maxLendableSol = treasurySol * lending.utilization_cap_bps / 10000;
  const totalLent = (lending.total_sol_lent ?? 0);
  const poolAvailableSol = Math.max(0, maxLendableSol - totalLent);

  // 3. Per-user cap (accounts for transfer fee reducing net collateral)
  const netCollateral = collateralAmount * (1 - TRANSFER_FEE_BPS / 10000);
  const borrowMultiplier = lending.borrow_share_multiplier || 3;
  const perUserCapSol = maxLendableSol * netCollateral * borrowMultiplier / TOTAL_SUPPLY;

  const maxBorrowSol = Math.max(0, Math.min(ltvMaxSol, poolAvailableSol, perUserCapSol));

  return {
    max_borrow_sol: Math.floor(maxBorrowSol),
    collateral_value_sol: Math.floor(collateralValueSol),
    ltv_max_sol: Math.floor(ltvMaxSol),
    pool_available_sol: Math.floor(poolAvailableSol),
    per_user_cap_sol: Math.floor(perUserCapSol),
    interest_rate_bps: lending.interest_rate_bps,
    liquidation_threshold_bps: lending.liquidation_threshold_bps,
  };
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

/** "Said in" — micro buy (0.001 SOL) + message. Routes through bonding curve or DEX automatically. */
export async function messageFaction(
  connection: Connection,
  params: MessageFactionParams,
): Promise<TransactionResult> {
  const MICRO_BUY_LAMPORTS = 1_000; // 0.001 SOL
  if (params.ascended) {
    return buildVaultSwapTransaction(connection, {
      mint: params.mint,
      signer: params.agent,
      vault_creator: params.stronghold,
      amount_in: MICRO_BUY_LAMPORTS,
      minimum_amount_out: 1,
      is_buy: true,
      message: params.message,
    });
  }
  const result = await buildBuyTransaction(connection, {
    mint: params.mint,
    buyer: params.agent,
    amount_sol: MICRO_BUY_LAMPORTS,
    message: params.message,
    vault: params.stronghold,
  });
  return mapBuyResult(result);
}

/** "Argued in" — micro sell (100 tokens) + negative message. Routes through bonding curve or DEX automatically. */
export async function fudFaction(
  connection: Connection,
  params: FudFactionParams,
): Promise<TransactionResult> {
  const MICRO_SELL_TOKENS = 100;
  if (params.ascended) {
    return buildVaultSwapTransaction(connection, {
      mint: params.mint,
      signer: params.agent,
      vault_creator: params.stronghold,
      amount_in: MICRO_SELL_TOKENS,
      minimum_amount_out: 1,
      is_buy: false,
      message: params.message,
    });
  }
  return buildSellTransaction(connection, {
    mint: params.mint,
    seller: params.agent,
    amount_tokens: MICRO_SELL_TOKENS,
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

/** Get the Raydium pool state PDA for an ascended faction's DEX pool */
export function getDexPool(mint: string): PublicKey {
  const { poolState } = getRaydiumMigrationAccounts(new PublicKey(mint));
  return poolState;
}

/** Get Raydium pool vault addresses for an ascended faction */
export function getDexVaults(mint: string): { solVault: string; tokenVault: string } {
  const accts = getRaydiumMigrationAccounts(new PublicKey(mint));
  return {
    solVault: (accts.isWsolToken0 ? accts.token0Vault : accts.token1Vault).toString(),
    tokenVault: (accts.isWsolToken0 ? accts.token1Vault : accts.token0Vault).toString(),
  };
}
