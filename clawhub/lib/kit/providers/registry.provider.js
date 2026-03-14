"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistryProvider = exports.REGISTRY_PROGRAM_ID = void 0;
exports.getAgentProfilePda = getAgentProfilePda;
exports.getAgentWalletLinkPda = getAgentWalletLinkPda;
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const pyre_world_json_1 = __importDefault(require("../pyre_world.json"));
exports.REGISTRY_PROGRAM_ID = new web3_js_1.PublicKey(pyre_world_json_1.default.address);
const AGENT_SEED = 'pyre_agent';
const AGENT_WALLET_SEED = 'pyre_agent_wallet';
function getAgentProfilePda(creator) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from(AGENT_SEED), creator.toBuffer()], exports.REGISTRY_PROGRAM_ID);
}
function getAgentWalletLinkPda(wallet) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from(AGENT_WALLET_SEED), wallet.toBuffer()], exports.REGISTRY_PROGRAM_ID);
}
function makeDummyProvider(connection, payer) {
    const dummyWallet = {
        publicKey: payer,
        signTransaction: async (t) => t,
        signAllTransactions: async (t) => t,
    };
    return new anchor_1.AnchorProvider(connection, dummyWallet, {});
}
async function finalizeTransaction(connection, tx, feePayer) {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
}
class RegistryProvider {
    connection;
    constructor(connection) {
        this.connection = connection;
    }
    getProgram(payer) {
        const provider = makeDummyProvider(this.connection, payer);
        return new anchor_1.Program(pyre_world_json_1.default, provider);
    }
    async getProfile(creator) {
        const creatorPk = new web3_js_1.PublicKey(creator);
        const [profilePda] = getAgentProfilePda(creatorPk);
        const program = this.getProgram(creatorPk);
        try {
            const account = await program.account.agentProfile.fetch(profilePda);
            return {
                address: profilePda.toBase58(),
                creator: account.creator.toBase58(),
                authority: account.authority.toBase58(),
                linked_wallet: account.linkedWallet.toBase58(),
                personality_summary: account.personalitySummary,
                last_checkpoint: account.lastCheckpoint.toNumber(),
                joins: account.joins.toNumber(),
                defects: account.defects.toNumber(),
                rallies: account.rallies.toNumber(),
                launches: account.launches.toNumber(),
                messages: account.messages.toNumber(),
                fuds: account.fuds.toNumber(),
                infiltrates: account.infiltrates.toNumber(),
                reinforces: account.reinforces.toNumber(),
                war_loans: account.warLoans.toNumber(),
                repay_loans: account.repayLoans.toNumber(),
                sieges: account.sieges.toNumber(),
                ascends: account.ascends.toNumber(),
                razes: account.razes.toNumber(),
                tithes: account.tithes.toNumber(),
                created_at: account.createdAt.toNumber(),
                bump: account.bump,
                total_sol_spent: account.totalSolSpent?.toNumber() ?? 0,
                total_sol_received: account.totalSolReceived?.toNumber() ?? 0,
            };
        }
        catch {
            return undefined;
        }
    }
    async getWalletLink(wallet) {
        const walletPk = new web3_js_1.PublicKey(wallet);
        const [linkPda] = getAgentWalletLinkPda(walletPk);
        const program = this.getProgram(walletPk);
        try {
            const account = await program.account.agentWalletLink.fetch(linkPda);
            return {
                address: linkPda.toBase58(),
                profile: account.profile.toBase58(),
                wallet: account.wallet.toBase58(),
                linked_at: account.linkedAt.toNumber(),
                bump: account.bump,
            };
        }
        catch {
            return undefined;
        }
    }
    async register(params) {
        const creator = new web3_js_1.PublicKey(params.creator);
        const [profile] = getAgentProfilePda(creator);
        const [walletLink] = getAgentWalletLinkPda(creator);
        const program = this.getProgram(creator);
        const tx = new web3_js_1.Transaction();
        const ix = await program.methods.register()
            .accounts({ creator, profile, walletLink, systemProgram: web3_js_1.SystemProgram.programId })
            .instruction();
        tx.add(ix);
        await finalizeTransaction(this.connection, tx, creator);
        return {
            transaction: tx,
            message: `Register agent profile [${profile.toBase58()}]`,
        };
    }
    async checkpoint(params) {
        const signer = new web3_js_1.PublicKey(params.signer);
        const creatorPk = new web3_js_1.PublicKey(params.creator);
        const [profile] = getAgentProfilePda(creatorPk);
        const program = this.getProgram(signer);
        const args = {
            joins: new anchor_1.BN(params.joins),
            defects: new anchor_1.BN(params.defects),
            rallies: new anchor_1.BN(params.rallies),
            launches: new anchor_1.BN(params.launches),
            messages: new anchor_1.BN(params.messages),
            fuds: new anchor_1.BN(params.fuds),
            infiltrates: new anchor_1.BN(params.infiltrates),
            reinforces: new anchor_1.BN(params.reinforces),
            warLoans: new anchor_1.BN(params.war_loans),
            repayLoans: new anchor_1.BN(params.repay_loans),
            sieges: new anchor_1.BN(params.sieges),
            ascends: new anchor_1.BN(params.ascends),
            razes: new anchor_1.BN(params.razes),
            tithes: new anchor_1.BN(params.tithes),
            personalitySummary: params.personality_summary,
            totalSolSpent: new anchor_1.BN(params.total_sol_spent),
            totalSolReceived: new anchor_1.BN(params.total_sol_received),
        };
        const tx = new web3_js_1.Transaction();
        const ix = await program.methods.checkpoint(args)
            .accounts({ signer, profile, systemProgram: web3_js_1.SystemProgram.programId })
            .instruction();
        tx.add(ix);
        await finalizeTransaction(this.connection, tx, signer);
        return {
            transaction: tx,
            message: `Checkpoint agent [${profile.toBase58()}]`,
        };
    }
    async linkWallet(params) {
        const authority = new web3_js_1.PublicKey(params.authority);
        const creatorPk = new web3_js_1.PublicKey(params.creator);
        const walletToLink = new web3_js_1.PublicKey(params.wallet_to_link);
        const [profile] = getAgentProfilePda(creatorPk);
        const [walletLink] = getAgentWalletLinkPda(walletToLink);
        const program = this.getProgram(authority);
        const tx = new web3_js_1.Transaction();
        const ix = await program.methods.linkWallet()
            .accounts({
            authority,
            profile,
            walletToLink,
            walletLink,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .instruction();
        tx.add(ix);
        await finalizeTransaction(this.connection, tx, authority);
        return {
            transaction: tx,
            message: `Link wallet ${walletToLink.toBase58()} to agent [${profile.toBase58()}]`,
        };
    }
    async unlinkWallet(params) {
        const authority = new web3_js_1.PublicKey(params.authority);
        const creatorPk = new web3_js_1.PublicKey(params.creator);
        const walletToUnlink = new web3_js_1.PublicKey(params.wallet_to_unlink);
        const [profile] = getAgentProfilePda(creatorPk);
        const [walletLink] = getAgentWalletLinkPda(walletToUnlink);
        const program = this.getProgram(authority);
        const tx = new web3_js_1.Transaction();
        const ix = await program.methods.unlinkWallet()
            .accounts({
            authority,
            profile,
            walletToUnlink,
            walletLink,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .instruction();
        tx.add(ix);
        await finalizeTransaction(this.connection, tx, authority);
        return {
            transaction: tx,
            message: `Unlink wallet ${walletToUnlink.toBase58()} from agent [${profile.toBase58()}]`,
        };
    }
    async transferAuthority(params) {
        const authority = new web3_js_1.PublicKey(params.authority);
        const creatorPk = new web3_js_1.PublicKey(params.creator);
        const newAuthority = new web3_js_1.PublicKey(params.new_authority);
        const [profile] = getAgentProfilePda(creatorPk);
        const program = this.getProgram(authority);
        const tx = new web3_js_1.Transaction();
        const ix = await program.methods.transferAuthority()
            .accounts({ authority, profile, newAuthority })
            .instruction();
        tx.add(ix);
        await finalizeTransaction(this.connection, tx, authority);
        return {
            transaction: tx,
            message: `Transfer agent authority to ${newAuthority.toBase58()}`,
        };
    }
}
exports.RegistryProvider = RegistryProvider;
