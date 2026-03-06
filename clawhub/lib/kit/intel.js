"use strict";
/**
 * Pyre Kit Intel
 *
 * Game-specific utility functions that compose torchsdk reads into
 * strategic intelligence. Agents use these to reason about the world.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFactionPower = getFactionPower;
exports.getFactionLeaderboard = getFactionLeaderboard;
exports.detectAlliances = detectAlliances;
exports.getFactionRivals = getFactionRivals;
exports.getAgentProfile = getAgentProfile;
exports.getAgentFactions = getAgentFactions;
exports.getWorldFeed = getWorldFeed;
exports.getWorldStats = getWorldStats;
const torchsdk_1 = require("torchsdk");
const mappers_1 = require("./mappers");
// ─── Faction Power & Rankings ──────────────────────────────────────
/**
 * Calculate a faction's power score.
 *
 * Score = (market_cap_sol * 0.4) + (members * 0.2) + (war_chest_sol * 0.2)
 *       + (rallies * 0.1) + (progress * 0.1)
 *
 * Normalized to make comparison easy. Higher = stronger.
 */
async function getFactionPower(connection, mint) {
    const t = await (0, torchsdk_1.getToken)(connection, mint);
    const score = computePowerScore(t);
    return {
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        score,
        market_cap_sol: t.market_cap_sol,
        members: t.holders ?? 0,
        war_chest_sol: t.treasury_sol_balance,
        rallies: t.stars,
        progress_percent: t.progress_percent,
        status: (0, mappers_1.mapFactionStatus)(t.status),
    };
}
/**
 * Ranked leaderboard of all factions by power score.
 */
async function getFactionLeaderboard(connection, opts) {
    // Fetch all tokens (up to 1000)
    const statusMap = {
        rising: 'bonding',
        ready: 'complete',
        ascended: 'migrated',
        razed: 'reclaimed',
    };
    const sdkStatus = opts?.status ? statusMap[opts.status] : 'all';
    const result = await (0, torchsdk_1.getTokens)(connection, { limit: opts?.limit ?? 100, status: sdkStatus });
    const powers = result.tokens.map((t) => ({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        score: computePowerScoreFromSummary(t),
        market_cap_sol: t.market_cap_sol,
        members: t.holders ?? 0,
        war_chest_sol: 0, // Not available in summary
        rallies: 0, // Not available in summary
        progress_percent: t.progress_percent,
        status: (0, mappers_1.mapFactionStatus)(t.status),
    }));
    powers.sort((a, b) => b.score - a.score);
    return powers;
}
// ─── Alliance & Rivalry Detection ──────────────────────────────────
/**
 * Detect alliances: factions with shared members.
 *
 * Given a set of faction mints, finds wallets holding multiple faction tokens.
 * Returns alliance clusters showing which factions share members.
 */
async function detectAlliances(connection, mints, holderLimit = 50) {
    // Fetch holders for each faction in parallel
    const holdersPerFaction = await Promise.all(mints.map(async (mint) => {
        const result = await (0, torchsdk_1.getHolders)(connection, mint, holderLimit);
        return { mint, holders: new Set(result.holders.map(h => h.address)) };
    }));
    // Find overlapping holders between faction pairs
    const clusters = [];
    for (let i = 0; i < holdersPerFaction.length; i++) {
        for (let j = i + 1; j < holdersPerFaction.length; j++) {
            const a = holdersPerFaction[i];
            const b = holdersPerFaction[j];
            const shared = [...a.holders].filter(h => b.holders.has(h));
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
/**
 * Find rival factions based on recent defection activity.
 *
 * Looks at recent sell messages to detect agents who have defected
 * from or to this faction.
 */
async function getFactionRivals(connection, mint, limit = 50) {
    // Get recent messages (sells include defection messages)
    const msgs = await (0, torchsdk_1.getMessages)(connection, mint, limit);
    const defectors = new Set(msgs.messages.map(m => m.sender));
    // For each defector, check what other factions they hold
    // This is a heuristic — we look at the messages to find patterns
    // In practice, agents would track this over time
    const rivalCounts = new Map();
    // Get all factions to cross-reference
    const allFactions = await (0, torchsdk_1.getTokens)(connection, { limit: 20, sort: 'volume' });
    for (const faction of allFactions.tokens) {
        if (faction.mint === mint)
            continue;
        const holders = await (0, torchsdk_1.getHolders)(connection, faction.mint, 50);
        const holderAddrs = new Set(holders.holders.map(h => h.address));
        const overlap = [...defectors].filter(d => holderAddrs.has(d)).length;
        if (overlap > 0) {
            rivalCounts.set(faction.mint, {
                in: overlap, // Agents from this faction who also hold rival
                out: overlap,
                ...(rivalCounts.get(faction.mint) ?? {}),
            });
        }
    }
    const rivals = [];
    for (const [rivalMint, counts] of rivalCounts) {
        const faction = allFactions.tokens.find(t => t.mint === rivalMint);
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
    rivals.sort((a, b) => (b.defections_in + b.defections_out) - (a.defections_in + a.defections_out));
    return rivals;
}
// ─── Agent Intelligence ────────────────────────────────────────────
/**
 * Build an aggregate profile for an agent wallet.
 */
async function getAgentProfile(connection, wallet) {
    // Fetch stronghold and SAID verification in parallel
    const [vault, said] = await Promise.all([
        (0, torchsdk_1.getVaultForWallet)(connection, wallet).catch(() => null),
        (0, torchsdk_1.verifySaid)(wallet).catch(() => null),
    ]);
    // Get factions this agent holds — requires scanning
    // For now, check top factions for this holder
    const factions = await getAgentFactions(connection, wallet);
    // Find factions this wallet created
    const allFactions = await (0, torchsdk_1.getTokens)(connection, { limit: 100 });
    const founded = allFactions.tokens
        .filter(t => t.mint) // TokenSummary doesn't have creator, so we skip for now
        .map(t => t.mint);
    const totalValue = factions.reduce((sum, f) => sum + f.value_sol, 0);
    return {
        wallet,
        stronghold: vault ? {
            address: vault.address,
            creator: vault.creator,
            authority: vault.authority,
            sol_balance: vault.sol_balance,
            total_deposited: vault.total_deposited,
            total_withdrawn: vault.total_withdrawn,
            total_spent: vault.total_spent,
            total_received: vault.total_received,
            linked_agents: vault.linked_wallets,
            created_at: vault.created_at,
        } : null,
        factions_joined: factions,
        factions_founded: [], // Would need per-token creator lookup
        said_verification: said,
        total_value_sol: totalValue + (vault?.sol_balance ?? 0),
    };
}
/**
 * List all factions an agent holds tokens in.
 *
 * Checks top factions for this wallet's holdings.
 */
async function getAgentFactions(connection, wallet, factionLimit = 50) {
    const allFactions = await (0, torchsdk_1.getTokens)(connection, { limit: factionLimit });
    const positions = [];
    // Check each faction for this holder
    await Promise.all(allFactions.tokens.map(async (faction) => {
        try {
            const holders = await (0, torchsdk_1.getHolders)(connection, faction.mint, 100);
            const holding = holders.holders.find(h => h.address === wallet);
            if (holding && holding.balance > 0) {
                positions.push({
                    mint: faction.mint,
                    name: faction.name,
                    symbol: faction.symbol,
                    balance: holding.balance,
                    percentage: holding.percentage,
                    value_sol: holding.balance * faction.price_sol,
                });
            }
        }
        catch {
            // Skip factions we can't read
        }
    }));
    positions.sort((a, b) => b.value_sol - a.value_sol);
    return positions;
}
// ─── World State ───────────────────────────────────────────────────
/**
 * Aggregated recent activity across ALL factions.
 *
 * The "Bloomberg terminal" feed — launches, joins, defections, rallies.
 */
async function getWorldFeed(connection, opts) {
    const factionLimit = opts?.factionLimit ?? 20;
    const msgLimit = opts?.limit ?? 5;
    const allFactions = await (0, torchsdk_1.getTokens)(connection, { limit: factionLimit, sort: 'newest' });
    const events = [];
    // Add launch events for each faction
    for (const faction of allFactions.tokens) {
        events.push({
            type: 'launch',
            faction_mint: faction.mint,
            faction_name: faction.name,
            timestamp: faction.created_at,
        });
        // Map status to events
        if (faction.status === 'migrated') {
            events.push({
                type: 'ascend',
                faction_mint: faction.mint,
                faction_name: faction.name,
                timestamp: faction.last_activity_at,
            });
        }
        else if (faction.status === 'reclaimed') {
            events.push({
                type: 'raze',
                faction_mint: faction.mint,
                faction_name: faction.name,
                timestamp: faction.last_activity_at,
            });
        }
    }
    // Get recent messages from top factions (messages = trade activity)
    const topFactions = allFactions.tokens.slice(0, 10);
    await Promise.all(topFactions.map(async (faction) => {
        try {
            const msgs = await (0, torchsdk_1.getMessages)(connection, faction.mint, msgLimit);
            for (const msg of msgs.messages) {
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
    return events.slice(0, opts?.limit ?? 100);
}
/**
 * Global stats: total factions, total agents, total SOL locked.
 */
async function getWorldStats(connection) {
    const [all, rising, ascended] = await Promise.all([
        (0, torchsdk_1.getTokens)(connection, { limit: 1, status: 'all' }),
        (0, torchsdk_1.getTokens)(connection, { limit: 100, status: 'bonding' }),
        (0, torchsdk_1.getTokens)(connection, { limit: 100, status: 'migrated' }),
    ]);
    const allFactions = [...rising.tokens, ...ascended.tokens];
    const totalSolLocked = allFactions.reduce((sum, t) => sum + t.market_cap_sol, 0);
    // Find most powerful
    let mostPowerful = null;
    let maxScore = 0;
    for (const t of allFactions) {
        const score = computePowerScoreFromSummary(t);
        if (score > maxScore) {
            maxScore = score;
            mostPowerful = {
                mint: t.mint,
                name: t.name,
                symbol: t.symbol,
                score,
                market_cap_sol: t.market_cap_sol,
                members: t.holders ?? 0,
                war_chest_sol: 0,
                rallies: 0,
                progress_percent: t.progress_percent,
                status: (0, mappers_1.mapFactionStatus)(t.status),
            };
        }
    }
    return {
        total_factions: all.total,
        rising_factions: rising.total,
        ascended_factions: ascended.total,
        total_sol_locked: totalSolLocked,
        most_powerful: mostPowerful,
    };
}
// ─── Internal Helpers ──────────────────────────────────────────────
function computePowerScore(t) {
    const mcWeight = 0.4;
    const memberWeight = 0.2;
    const chestWeight = 0.2;
    const rallyWeight = 0.1;
    const progressWeight = 0.1;
    return ((t.market_cap_sol * mcWeight) +
        ((t.holders ?? 0) * memberWeight) +
        (t.treasury_sol_balance * chestWeight) +
        (t.stars * rallyWeight) +
        (t.progress_percent * progressWeight));
}
function computePowerScoreFromSummary(t) {
    const mcWeight = 0.4;
    const memberWeight = 0.2;
    const progressWeight = 0.1;
    return ((t.market_cap_sol * mcWeight) +
        ((t.holders ?? 0) * memberWeight) +
        (t.progress_percent * progressWeight));
}
