"use strict";
/**
 * Pyre Kit Actions
 *
 * Thin wrappers that call torchsdk functions and map params/results
 * into game-semantic Pyre types. No new on-chain logic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEphemeralAgent = void 0;
exports.getFactions = getFactions;
exports.getFaction = getFaction;
exports.getMembers = getMembers;
exports.getComms = getComms;
exports.getJoinQuote = getJoinQuote;
exports.getDefectQuote = getDefectQuote;
exports.getStronghold = getStronghold;
exports.getStrongholdForAgent = getStrongholdForAgent;
exports.getAgentLink = getAgentLink;
exports.getWarChest = getWarChest;
exports.getWarLoan = getWarLoan;
exports.getAllWarLoans = getAllWarLoans;
exports.launchFaction = launchFaction;
exports.joinFaction = joinFaction;
exports.directJoinFaction = directJoinFaction;
exports.defect = defect;
exports.rally = rally;
exports.requestWarLoan = requestWarLoan;
exports.repayWarLoan = repayWarLoan;
exports.tradeOnDex = tradeOnDex;
exports.claimSpoils = claimSpoils;
exports.createStronghold = createStronghold;
exports.fundStronghold = fundStronghold;
exports.withdrawFromStronghold = withdrawFromStronghold;
exports.recruitAgent = recruitAgent;
exports.exileAgent = exileAgent;
exports.coup = coup;
exports.withdrawAssets = withdrawAssets;
exports.siege = siege;
exports.ascend = ascend;
exports.raze = raze;
exports.tithe = tithe;
exports.convertTithe = convertTithe;
exports.verifyAgent = verifyAgent;
exports.confirmAction = confirmAction;
const torchsdk_1 = require("torchsdk");
const mappers_1 = require("./mappers");
const vanity_1 = require("./vanity");
// ─── Read Operations ───────────────────────────────────────────────
/** List all factions with optional filtering and sorting */
async function getFactions(connection, params) {
    const sdkParams = params ? {
        limit: params.limit,
        offset: params.offset,
        status: params.status ? (0, mappers_1.mapTokenStatusFilter)(params.status) : undefined,
        sort: params.sort,
    } : undefined;
    const result = await (0, torchsdk_1.getTokens)(connection, sdkParams);
    return (0, mappers_1.mapTokenListResult)(result);
}
/** Get detailed info for a single faction */
async function getFaction(connection, mint) {
    const detail = await (0, torchsdk_1.getToken)(connection, mint);
    return (0, mappers_1.mapTokenDetailToFaction)(detail);
}
/** Get faction members (top holders) */
async function getMembers(connection, mint, limit) {
    const result = await (0, torchsdk_1.getHolders)(connection, mint, limit);
    return (0, mappers_1.mapHoldersResult)(result);
}
/** Get faction comms (trade-bundled messages) */
async function getComms(connection, mint, limit) {
    const result = await (0, torchsdk_1.getMessages)(connection, mint, limit);
    return (0, mappers_1.mapMessagesResult)(result);
}
/** Get a quote for joining a faction (buying tokens) */
async function getJoinQuote(connection, mint, amountSolLamports) {
    return (0, torchsdk_1.getBuyQuote)(connection, mint, amountSolLamports);
}
/** Get a quote for defecting from a faction (selling tokens) */
async function getDefectQuote(connection, mint, amountTokens) {
    return (0, torchsdk_1.getSellQuote)(connection, mint, amountTokens);
}
/** Get stronghold (vault) by creator */
async function getStronghold(connection, creator) {
    const vault = await (0, torchsdk_1.getVault)(connection, creator);
    return vault ? (0, mappers_1.mapVaultToStronghold)(vault) : null;
}
/** Get stronghold for a linked agent wallet */
async function getStrongholdForAgent(connection, wallet) {
    const vault = await (0, torchsdk_1.getVaultForWallet)(connection, wallet);
    return vault ? (0, mappers_1.mapVaultToStronghold)(vault) : null;
}
/** Get agent link info for a wallet */
async function getAgentLink(connection, wallet) {
    const link = await (0, torchsdk_1.getVaultWalletLink)(connection, wallet);
    return link ? (0, mappers_1.mapWalletLinkToAgentLink)(link) : null;
}
/** Get war chest (lending info) for a faction */
async function getWarChest(connection, mint) {
    const info = await (0, torchsdk_1.getLendingInfo)(connection, mint);
    return (0, mappers_1.mapLendingToWarChest)(info);
}
/** Get war loan position for a specific agent on a faction */
async function getWarLoan(connection, mint, wallet) {
    const pos = await (0, torchsdk_1.getLoanPosition)(connection, mint, wallet);
    return (0, mappers_1.mapLoanToWarLoan)(pos);
}
/** Get all war loans for a faction */
async function getAllWarLoans(connection, mint) {
    const result = await (0, torchsdk_1.getAllLoanPositions)(connection, mint);
    return (0, mappers_1.mapAllLoansResult)(result);
}
// ─── Faction Operations (controller) ───────────────────────────────
/** Launch a new faction (create token) */
async function launchFaction(connection, params) {
    const result = await (0, vanity_1.buildCreateFactionTransaction)(connection, {
        creator: params.founder,
        name: params.name,
        symbol: params.symbol,
        metadata_uri: params.metadata_uri,
        sol_target: params.sol_target,
        community_token: params.community_faction,
    });
    return (0, mappers_1.mapCreateResult)(result);
}
/** Join a faction via stronghold (vault-funded buy) */
async function joinFaction(connection, params) {
    const result = await (0, torchsdk_1.buildBuyTransaction)(connection, {
        mint: params.mint,
        buyer: params.agent,
        amount_sol: params.amount_sol,
        slippage_bps: params.slippage_bps,
        vote: params.strategy ? (0, mappers_1.mapVote)(params.strategy) : undefined,
        message: params.message,
        vault: params.stronghold,
    });
    return (0, mappers_1.mapBuyResult)(result);
}
/** Join a faction directly (no vault) */
async function directJoinFaction(connection, params) {
    const result = await (0, torchsdk_1.buildDirectBuyTransaction)(connection, {
        mint: params.mint,
        buyer: params.agent,
        amount_sol: params.amount_sol,
        slippage_bps: params.slippage_bps,
        vote: params.strategy ? (0, mappers_1.mapVote)(params.strategy) : undefined,
        message: params.message,
    });
    return (0, mappers_1.mapBuyResult)(result);
}
/** Defect from a faction (sell tokens) */
async function defect(connection, params) {
    return (0, torchsdk_1.buildSellTransaction)(connection, {
        mint: params.mint,
        seller: params.agent,
        amount_tokens: params.amount_tokens,
        slippage_bps: params.slippage_bps,
        message: params.message,
        vault: params.stronghold,
    });
}
/** Rally support for a faction (star) */
async function rally(connection, params) {
    return (0, torchsdk_1.buildStarTransaction)(connection, {
        mint: params.mint,
        user: params.agent,
        vault: params.stronghold,
    });
}
/** Request a war loan (borrow SOL against token collateral) */
async function requestWarLoan(connection, params) {
    return (0, torchsdk_1.buildBorrowTransaction)(connection, {
        mint: params.mint,
        borrower: params.borrower,
        collateral_amount: params.collateral_amount,
        sol_to_borrow: params.sol_to_borrow,
        vault: params.stronghold,
    });
}
/** Repay a war loan */
async function repayWarLoan(connection, params) {
    return (0, torchsdk_1.buildRepayTransaction)(connection, {
        mint: params.mint,
        borrower: params.borrower,
        sol_amount: params.sol_amount,
        vault: params.stronghold,
    });
}
/** Trade on DEX via stronghold (vault-routed Raydium swap) */
async function tradeOnDex(connection, params) {
    return (0, torchsdk_1.buildVaultSwapTransaction)(connection, {
        mint: params.mint,
        signer: params.signer,
        vault_creator: params.stronghold_creator,
        amount_in: params.amount_in,
        minimum_amount_out: params.minimum_amount_out,
        is_buy: params.is_buy,
    });
}
/** Claim spoils (protocol rewards) */
async function claimSpoils(connection, params) {
    return (0, torchsdk_1.buildClaimProtocolRewardsTransaction)(connection, {
        user: params.agent,
        vault: params.stronghold,
    });
}
// ─── Stronghold Operations (authority) ─────────────────────────────
/** Create a new stronghold (vault) */
async function createStronghold(connection, params) {
    return (0, torchsdk_1.buildCreateVaultTransaction)(connection, {
        creator: params.creator,
    });
}
/** Fund a stronghold with SOL */
async function fundStronghold(connection, params) {
    return (0, torchsdk_1.buildDepositVaultTransaction)(connection, {
        depositor: params.depositor,
        vault_creator: params.stronghold_creator,
        amount_sol: params.amount_sol,
    });
}
/** Withdraw SOL from a stronghold */
async function withdrawFromStronghold(connection, params) {
    return (0, torchsdk_1.buildWithdrawVaultTransaction)(connection, {
        authority: params.authority,
        vault_creator: params.stronghold_creator,
        amount_sol: params.amount_sol,
    });
}
/** Recruit an agent (link wallet to stronghold) */
async function recruitAgent(connection, params) {
    return (0, torchsdk_1.buildLinkWalletTransaction)(connection, {
        authority: params.authority,
        vault_creator: params.stronghold_creator,
        wallet_to_link: params.wallet_to_link,
    });
}
/** Exile an agent (unlink wallet from stronghold) */
async function exileAgent(connection, params) {
    return (0, torchsdk_1.buildUnlinkWalletTransaction)(connection, {
        authority: params.authority,
        vault_creator: params.stronghold_creator,
        wallet_to_unlink: params.wallet_to_unlink,
    });
}
/** Coup — transfer stronghold authority */
async function coup(connection, params) {
    return (0, torchsdk_1.buildTransferAuthorityTransaction)(connection, {
        authority: params.authority,
        vault_creator: params.stronghold_creator,
        new_authority: params.new_authority,
    });
}
/** Withdraw token assets from stronghold */
async function withdrawAssets(connection, params) {
    return (0, torchsdk_1.buildWithdrawTokensTransaction)(connection, {
        authority: params.authority,
        vault_creator: params.stronghold_creator,
        mint: params.mint,
        destination: params.destination,
        amount: params.amount,
    });
}
// ─── Permissionless Operations ─────────────────────────────────────
/** Siege — liquidate an undercollateralized war loan */
async function siege(connection, params) {
    return (0, torchsdk_1.buildLiquidateTransaction)(connection, {
        mint: params.mint,
        liquidator: params.liquidator,
        borrower: params.borrower,
        vault: params.stronghold,
    });
}
/** Ascend — migrate a completed faction to DEX */
async function ascend(connection, params) {
    return (0, torchsdk_1.buildMigrateTransaction)(connection, {
        mint: params.mint,
        payer: params.payer,
    });
}
/** Raze — reclaim a failed faction */
async function raze(connection, params) {
    return (0, torchsdk_1.buildReclaimFailedTokenTransaction)(connection, {
        payer: params.payer,
        mint: params.mint,
    });
}
/** Tithe — harvest transfer fees */
async function tithe(connection, params) {
    return (0, torchsdk_1.buildHarvestFeesTransaction)(connection, {
        mint: params.mint,
        payer: params.payer,
        sources: params.sources,
    });
}
/** Convert tithe — swap harvested fees to SOL */
async function convertTithe(connection, params) {
    return (0, torchsdk_1.buildSwapFeesToSolTransaction)(connection, {
        mint: params.mint,
        payer: params.payer,
        minimum_amount_out: params.minimum_amount_out,
        harvest: params.harvest,
        sources: params.sources,
    });
}
// ─── SAID Operations ───────────────────────────────────────────────
/** Verify an agent's SAID reputation */
async function verifyAgent(wallet) {
    return (0, torchsdk_1.verifySaid)(wallet);
}
/** Confirm a transaction on-chain */
async function confirmAction(connection, signature, wallet) {
    return (0, torchsdk_1.confirmTransaction)(connection, signature, wallet);
}
// ─── Utility ───────────────────────────────────────────────────────
/** Create an ephemeral agent keypair (memory-only, zero key management) */
var torchsdk_2 = require("torchsdk");
Object.defineProperty(exports, "createEphemeralAgent", { enumerable: true, get: function () { return torchsdk_2.createEphemeralAgent; } });
