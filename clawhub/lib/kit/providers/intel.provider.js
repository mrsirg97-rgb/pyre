"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntelProvider = void 0;
const web3_js_1 = require("@solana/web3.js");
const vanity_1 = require("../vanity");
const util_1 = require("../util");
class IntelProvider {
    connection;
    actionProvider;
    constructor(connection, actionProvider) {
        this.connection = connection;
        this.actionProvider = actionProvider;
    }
    async getAgentFactions(wallet, factionLimit = 50) {
        const { TOKEN_2022_PROGRAM_ID } = await Promise.resolve().then(() => __importStar(require('@solana/spl-token')));
        const walletPk = new web3_js_1.PublicKey(wallet);
        // Scan wallet token accounts
        const walletAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPk, {
            programId: TOKEN_2022_PROGRAM_ID,
        });
        // Scan vault token accounts if a vault exists
        let vaultAccounts = { context: walletAccounts.context, value: [] };
        try {
            const vault = await this.actionProvider.getStrongholdForAgent(wallet);
            if (!vault)
                throw new Error('no vault');
            const vaultPk = new web3_js_1.PublicKey(vault.address);
            vaultAccounts = await this.connection.getParsedTokenAccountsByOwner(vaultPk, {
                programId: TOKEN_2022_PROGRAM_ID,
            });
        }
        catch { }
        // Merge balances from both sources (wallet + vault)
        const balanceMap = new Map();
        for (const a of [...walletAccounts.value, ...vaultAccounts.value]) {
            const mint = a.account.data.parsed.info.mint;
            const balance = Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0);
            if (balance > 0 && (0, vanity_1.isPyreMint)(mint) && !(0, util_1.isBlacklistedMint)(mint)) {
                balanceMap.set(mint, (balanceMap.get(mint) ?? 0) + balance);
            }
        }
        if (balanceMap.size === 0)
            return [];
        // Fetch faction metadata for held mints
        const allFactions = await this.actionProvider.getFactions({ limit: factionLimit });
        const factionMap = new Map(allFactions.factions.map((t) => [t.mint, t]));
        const positions = [];
        for (const [mint, balance] of balanceMap) {
            const faction = factionMap.get(mint);
            if (!faction)
                continue;
            // balance / 1B total supply
            const percentage = (balance / 1_000_000_000) * 100;
            positions.push({
                mint,
                name: faction.name,
                symbol: faction.symbol,
                balance,
                percentage,
                value_sol: balance * faction.price_sol,
            });
        }
        positions.sort((a, b) => b.value_sol - a.value_sol);
        return positions;
    }
    async getAgentProfile(wallet) {
        const vault = await this.actionProvider.getStrongholdForAgent(wallet);
        const factions = await this.getAgentFactions(wallet);
        const totalValue = factions.reduce((sum, f) => sum + f.value_sol, 0);
        return {
            wallet,
            stronghold: vault
                ? {
                    address: vault.address,
                    creator: vault.creator,
                    authority: vault.authority,
                    sol_balance: vault.sol_balance,
                    total_deposited: vault.total_deposited,
                    total_withdrawn: vault.total_withdrawn,
                    total_spent: vault.total_spent,
                    total_received: vault.total_received,
                    linked_agents: vault.linked_agents,
                    created_at: vault.created_at,
                }
                : null,
            factions_joined: factions,
            factions_founded: [], // Would need per-token creator lookup
            total_value_sol: totalValue + (vault?.sol_balance ?? 0),
        };
    }
    async getAgentSolLamports(wallet) {
        const walletPk = new web3_js_1.PublicKey(wallet);
        let total = 0;
        try {
            total += await this.connection.getBalance(walletPk);
        }
        catch { }
        try {
            const vault = await this.actionProvider.getStrongholdForAgent(wallet);
            if (vault)
                total += Math.round(vault.sol_balance * 1e9);
        }
        catch { }
        return total;
    }
    async getAllies(mints, holderLimit = 50) {
        const holdersPerFaction = await Promise.all(mints.map(async (mint) => {
            const result = await this.getPyreHolders(mint, holderLimit);
            return { mint, holders: new Set(result.members.map((h) => h.address)) };
        }));
        // Find overlapping holders between faction pairs
        const clusters = [];
        for (let i = 0; i < holdersPerFaction.length; i++) {
            for (let j = i + 1; j < holdersPerFaction.length; j++) {
                const a = holdersPerFaction[i];
                const b = holdersPerFaction[j];
                const shared = [...a.holders].filter((h) => b.holders.has(h));
                if (shared.length > 0) {
                    const minSize = Math.min(a.holders.size, b.holders.size);
                    clusters.push({
                        factions: [a.mint, b.mint],
                        shared_members: shared.length,
                        overlap_percent: minSize > 0 ? (shared.length / minSize) * 100 : 0,
                    });
                }
            }
        }
        clusters.sort((a, b) => b.shared_members - a.shared_members);
        return clusters;
    }
    async getFactionPower(mint) {
        const t = await this.actionProvider.getFaction(mint);
        const score = this.computePowerScore(t);
        return {
            mint: t.mint,
            name: t.name,
            symbol: t.symbol,
            score,
            market_cap_sol: t.market_cap_sol,
            members: t.members ?? 0,
            war_chest_sol: t.war_chest_sol,
            rallies: t.rallies,
            progress_percent: t.progress_percent,
            status: t.status,
        };
    }
    async getFactionLeaderboard({ status, limit, }) {
        const statusMap = {
            rising: 'bonding',
            ready: 'complete',
            ascended: 'migrated',
            razed: 'reclaimed',
        };
        const fetchLimit = Math.min((limit ?? 20) * 3, 100);
        const { factions } = await this.actionProvider.getFactions({
            limit: fetchLimit,
            status: status,
        });
        const powers = factions.map((t) => ({
            mint: t.mint,
            name: t.name,
            symbol: t.symbol,
            score: this.computePowerScoreFromSummary(t),
            market_cap_sol: t.market_cap_sol,
            members: t.members ?? 0,
            war_chest_sol: 0, // Not available in summary
            rallies: 0, // Not available in summary
            progress_percent: t.progress_percent,
            status: t.status,
        }));
        powers.sort((a, b) => b.score - a.score);
        return powers;
    }
    async getFactionRivals(mint, { limit = 50 }) {
        const { comms } = await this.actionProvider.getComms(mint, { limit });
        const defectors = new Set(comms.map((m) => m.sender));
        const rivalCounts = new Map();
        const { factions } = await this.actionProvider.getFactions({ limit: 20, sort: 'volume' });
        for (const faction of factions) {
            if (faction.mint === mint)
                continue;
            const { members } = await this.getPyreHolders(faction.mint, 50);
            const holderAddrs = new Set(members.map((h) => h.address));
            const overlap = [...defectors].filter((d) => holderAddrs.has(d)).length;
            if (overlap > 0) {
                rivalCounts.set(faction.mint, {
                    in: overlap,
                    out: overlap,
                    ...(rivalCounts.get(faction.mint) ?? {}),
                });
            }
        }
        const rivals = [];
        for (const [rivalMint, counts] of rivalCounts) {
            const faction = factions.find((t) => t.mint === rivalMint);
            if (faction) {
                rivals.push({
                    mint: rivalMint,
                    name: faction.name,
                    symbol: faction.symbol,
                    defections_in: counts.in,
                    defections_out: counts.out,
                });
            }
        }
        rivals.sort((a, b) => b.defections_in + b.defections_out - (a.defections_in + a.defections_out));
        return rivals;
    }
    async getWorldFeed({ limit, factionLimit, }) {
        const fLimit = factionLimit ?? 20;
        const msgLimit = limit ?? 5;
        const allFactions = await this.actionProvider.getFactions({ limit: fLimit, sort: 'newest' });
        const events = [];
        for (const faction of allFactions.factions) {
            events.push({
                type: 'launch',
                faction_mint: faction.mint,
                faction_name: faction.name,
                timestamp: faction.created_at,
            });
            if (faction.status === 'ascended') {
                events.push({
                    type: 'ascend',
                    faction_mint: faction.mint,
                    faction_name: faction.name,
                    timestamp: faction.last_activity_at,
                });
            }
            else if (faction.status === 'razed') {
                events.push({
                    type: 'raze',
                    faction_mint: faction.mint,
                    faction_name: faction.name,
                    timestamp: faction.last_activity_at,
                });
            }
        }
        const topFactions = allFactions.factions.slice(0, 10);
        await Promise.all(topFactions.map(async (faction) => {
            try {
                const { comms } = await this.actionProvider.getComms(faction.mint, { limit: msgLimit });
                for (const msg of comms) {
                    events.push({
                        type: 'join', // Messages are trade-bundled, most are buys
                        faction_mint: faction.mint,
                        faction_name: faction.name,
                        agent: msg.sender,
                        timestamp: msg.timestamp,
                        signature: msg.signature,
                        message: msg.memo,
                    });
                }
            }
            catch {
                // Skip factions with no messages
            }
        }));
        events.sort((a, b) => b.timestamp - a.timestamp);
        return events.slice(0, limit ?? 100);
    }
    async getWorldStats() {
        const { factions } = await this.actionProvider.getFactions({ limit: 200, status: 'all' });
        const pyreRising = factions.filter((t) => t.status === 'rising');
        const pyreAscended = factions.filter((t) => t.status === 'ascended');
        const allFactions = [...pyreRising, ...pyreAscended];
        const totalSolLocked = allFactions.reduce((sum, t) => sum + t.market_cap_sol, 0);
        let mostPowerful = null;
        let maxScore = 0;
        for (const t of allFactions) {
            const score = this.computePowerScoreFromSummary(t);
            if (score > maxScore) {
                maxScore = score;
                mostPowerful = {
                    mint: t.mint,
                    name: t.name,
                    symbol: t.symbol,
                    score,
                    market_cap_sol: t.market_cap_sol,
                    members: t.members ?? 0,
                    war_chest_sol: 0,
                    rallies: 0,
                    progress_percent: t.progress_percent,
                    status: t.status,
                };
            }
        }
        return {
            total_factions: factions.length,
            rising_factions: pyreRising.length,
            ascended_factions: pyreAscended.length,
            total_sol_locked: totalSolLocked,
            most_powerful: mostPowerful,
        };
    }
    computePowerScore(t) {
        const mcWeight = 0.4;
        const memberWeight = 0.2;
        const chestWeight = 0.2;
        const rallyWeight = 0.1;
        const progressWeight = 0.1;
        return (t.market_cap_sol * mcWeight +
            (t.members ?? 0) * memberWeight +
            t.war_chest_sol * chestWeight +
            t.rallies * rallyWeight +
            t.progress_percent * progressWeight);
    }
    computePowerScoreFromSummary(t) {
        const mcWeight = 0.4;
        const memberWeight = 0.2;
        const progressWeight = 0.1;
        return (t.market_cap_sol * mcWeight +
            (t.members ?? 0) * memberWeight +
            t.progress_percent * progressWeight);
    }
    async getPyreHolders(mint, limit) {
        const mintPk = new web3_js_1.PublicKey(mint);
        const [bondingCurve] = (0, vanity_1.getBondingCurvePda)(mintPk);
        const [treasury] = (0, vanity_1.getTokenTreasuryPda)(mintPk);
        const [treasuryLock] = (0, vanity_1.getTreasuryLockPda)(mintPk);
        const excluded = new Set([
            bondingCurve.toString(),
            treasury.toString(),
            treasuryLock.toString(),
        ]);
        const result = await this.actionProvider.getMembers(mint, limit + 5);
        result.members = result.members.filter((h) => !excluded.has(h.address)).slice(0, limit);
        return result;
    }
}
exports.IntelProvider = IntelProvider;
