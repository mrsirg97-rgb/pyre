/**
 * Pyre Kit Faction Warfare Simulation
 *
 * Spins up 500 agent wallets and runs a random walk simulation
 * of faction warfare: launching, joining, defecting, rallying.
 *
 * Prerequisites:
 *   surfpool start --network mainnet --no-tui
 *
 * Run:
 *   npx tsx tests/test_sim.ts
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  createEphemeralAgent,
  launchFaction,
  directJoinFaction,
  defect,
  rally,
  getFactions,
  getFaction,
  getMembers,
  getComms,
  getFactionLeaderboard,
  getWorldStats,
  detectAlliances,
} from '../src/index.js';

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899';

const AGENT_COUNT = 500;
const FACTION_COUNT = 15;
const ROUNDS = 20;
const AGENTS_PER_ROUND = 80;
const JOIN_SOL = 0.05 * LAMPORTS_PER_SOL;
const AIRDROP_SOL = 2 * LAMPORTS_PER_SOL;

type Agent = ReturnType<typeof createEphemeralAgent>;

interface AgentState {
  agent: Agent;
  holdings: Map<string, number>; // mint -> token balance
  founded: string | null;        // mint they founded
  voted: Set<string>;            // mints already voted on
  rallied: Set<string>;          // mints already rallied
}

interface FactionState {
  mint: string;
  name: string;
  founder: string; // pubkey of founding agent
}

// ─── Helpers ──────────────────────────────────────────────────────

async function sendAndConfirm(connection: Connection, agent: Agent, result: any): Promise<string> {
  const tx = result.transaction;
  const signed = agent.sign(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, 'confirmed');

  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      const addlSigned = agent.sign(addlTx);
      const addlSig = await connection.sendRawTransaction(addlSigned.serialize());
      await connection.confirmTransaction(addlSig, 'confirmed');
    }
  }

  return sig;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const FACTION_NAMES = [
  'Iron Vanguard', 'Obsidian Order', 'Crimson Dawn', 'Shadow Covenant',
  'Ember Collective', 'Void Walkers', 'Solar Reign', 'Frost Legion',
  'Thunder Pact', 'Ash Republic', 'Neon Syndicate', 'Storm Brigade',
  'Lunar Assembly', 'Flame Sentinels', 'Dark Meridian', 'Phoenix Accord',
  'Steel Dominion', 'Crystal Enclave', 'Rogue Alliance', 'Titan Front',
];

const FACTION_SYMBOLS = [
  'IRON', 'OBSD', 'CRIM', 'SHAD', 'EMBR', 'VOID', 'SOLR', 'FRST',
  'THDR', 'ASHR', 'NEON', 'STRM', 'LUNR', 'FLMS', 'DARK', 'PHNX',
  'STEL', 'CRYS', 'ROGU', 'TITN',
];

const JOIN_MESSAGES = [
  'Pledging allegiance.', 'Reporting for duty.', 'This faction will rise.',
  'Strategic position acquired.', 'In for the long haul.', 'Joining the cause.',
  'Scouting this faction.', 'Alliance confirmed.', 'Deploying capital.',
  'Interesting opportunity.', 'Following the signal.', 'Reconnaissance buy.',
];

const DEFECT_MESSAGES = [
  'Strategic withdrawal.', 'This pyre burns too dim.', 'Found a stronger faction.',
  'Tactical repositioning.', 'The leadership is weak.', 'Cutting losses.',
  'Better opportunities elsewhere.', 'Betrayal is just strategy.', 'Moving on.',
  'The war chest is empty.', 'This faction peaked.', 'Exit protocol initiated.',
];

// ─── Simulation ───────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  console.log(`Pyre Faction Warfare Simulation`);
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Agents: ${AGENT_COUNT}`);
  console.log(`  Factions: ${FACTION_COUNT}`);
  console.log(`  Rounds: ${ROUNDS}`);
  console.log(`  Agents/round: ${AGENTS_PER_ROUND}\n`);

  // ── Phase 1: Spawn agents ──────────────────────────────────────

  console.log('Phase 1: Spawning agents...');
  const agents: AgentState[] = [];
  for (let i = 0; i < AGENT_COUNT; i++) {
    agents.push({
      agent: createEphemeralAgent(),
      holdings: new Map(),
      founded: null,
      voted: new Set(),
      rallied: new Set(),
    });
  }
  console.log(`  ${AGENT_COUNT} agents created\n`);

  // ── Phase 2: Airdrop SOL ───────────────────────────────────────

  console.log('Phase 2: Airdropping SOL...');
  const AIRDROP_BATCH = 25;
  for (let i = 0; i < agents.length; i += AIRDROP_BATCH) {
    const batch = agents.slice(i, i + AIRDROP_BATCH);
    await Promise.all(
      batch.map(async (a) => {
        const sig = await connection.requestAirdrop(a.agent.keypair.publicKey, AIRDROP_SOL);
        await connection.confirmTransaction(sig, 'confirmed');
      })
    );
    if ((i + AIRDROP_BATCH) % 100 === 0 || i + AIRDROP_BATCH >= agents.length) {
      console.log(`  ${Math.min(i + AIRDROP_BATCH, agents.length)}/${AGENT_COUNT} funded`);
    }
  }
  console.log();

  // ── Phase 3: Launch factions ───────────────────────────────────

  console.log('Phase 3: Launching factions...');
  const founders = pickN(agents, FACTION_COUNT);
  const factions: FactionState[] = [];

  for (let i = 0; i < founders.length; i++) {
    const a = founders[i];
    const name = FACTION_NAMES[i];
    const symbol = FACTION_SYMBOLS[i];
    try {
      const result = await launchFaction(connection, {
        founder: a.agent.publicKey,
        name,
        symbol,
        metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
        community_faction: true,
      });
      await sendAndConfirm(connection, a.agent, result);
      const mint = result.mint.toBase58();
      factions.push({ mint, name, founder: a.agent.publicKey });
      a.founded = mint;
      console.log(`  [${symbol}] ${name} — founded by ${a.agent.publicKey.slice(0, 8)}...`);
    } catch (err: any) {
      console.log(`  FAIL launching ${name}: ${err.message}`);
    }
  }
  console.log(`  ${factions.length} factions live\n`);

  if (factions.length === 0) {
    console.error('No factions launched. Aborting simulation.');
    process.exit(1);
  }

  // ── Phase 4: Random walk simulation ────────────────────────────

  console.log('Phase 4: Random walk simulation...\n');

  let totalJoins = 0;
  let totalDefections = 0;
  let totalRallies = 0;
  let totalErrors = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    const roundAgents = pickN(agents, AGENTS_PER_ROUND);
    let roundJoins = 0;
    let roundDefections = 0;
    let roundRallies = 0;
    let roundErrors = 0;

    console.log(`─── Round ${round}/${ROUNDS} ───`);

    // Process agents in batches to avoid overwhelming the RPC
    const ROUND_BATCH = 10;
    for (let i = 0; i < roundAgents.length; i += ROUND_BATCH) {
      const batch = roundAgents.slice(i, i + ROUND_BATCH);
      await Promise.all(
        batch.map(async (a) => {
          await executeRandomAction(connection, a, factions);
        })
      );
    }

    // Tally round results by checking what actions succeeded
    for (const a of roundAgents) {
      // We track joins/defections in executeRandomAction via the stats object
    }

    // Get round stats from the counter
    const stats = getRoundStats();
    roundJoins = stats.joins;
    roundDefections = stats.defections;
    roundRallies = stats.rallies;
    roundErrors += stats.errors;

    totalJoins += roundJoins;
    totalDefections += roundDefections;
    totalRallies += roundRallies;
    totalErrors += roundErrors;

    console.log(`  Joins: ${roundJoins} | Defections: ${roundDefections} | Rallies: ${roundRallies} | Errors: ${roundErrors}`);
  }

  console.log(`\n─── Simulation Complete ───`);
  console.log(`  Total joins: ${totalJoins}`);
  console.log(`  Total defections: ${totalDefections}`);
  console.log(`  Total rallies: ${totalRallies}`);
  console.log(`  Total errors: ${totalErrors}\n`);

  // ── Phase 5: Intel debrief ─────────────────────────────────────

  console.log('Phase 5: Intelligence debrief...\n');

  // Leaderboard
  console.log('Faction Leaderboard:');
  try {
    const leaderboard = await getFactionLeaderboard(connection, { limit: factions.length });
    for (let i = 0; i < leaderboard.length; i++) {
      const f = leaderboard[i];
      console.log(`  ${i + 1}. [${f.symbol}] ${f.name} — power: ${f.score.toFixed(2)}, mcap: ${f.market_cap_sol.toFixed(4)} SOL, members: ${f.members}`);
    }
  } catch (err: any) {
    console.log(`  Could not fetch leaderboard: ${err.message}`);
  }
  console.log();

  // Alliance detection
  if (factions.length >= 2) {
    console.log('Alliance Detection:');
    try {
      const alliances = await detectAlliances(
        connection,
        factions.map(f => f.mint),
        20,
      );
      if (alliances.length === 0) {
        console.log('  No alliances detected');
      }
      for (const a of alliances.slice(0, 10)) {
        const names = a.factions.map(m => factions.find(f => f.mint === m)?.name ?? m.slice(0, 8));
        console.log(`  ${names.join(' + ')} — ${a.shared_members} shared (${a.overlap_percent.toFixed(1)}% overlap)`);
      }
    } catch (err: any) {
      console.log(`  Could not detect alliances: ${err.message}`);
    }
    console.log();
  }

  // Faction details for top 3
  console.log('Top Faction Details:');
  for (const f of factions.slice(0, 3)) {
    try {
      const detail = await getFaction(connection, f.mint);
      const members = await getMembers(connection, f.mint, 5);
      const comms = await getComms(connection, f.mint, 5);

      console.log(`  [${detail.symbol}] ${detail.name}`);
      console.log(`    Status: ${detail.status} | Tier: ${detail.tier}`);
      console.log(`    Price: ${detail.price_sol.toFixed(6)} SOL | MCap: ${detail.market_cap_sol.toFixed(4)} SOL`);
      console.log(`    Members: ${members.total_members} | Rallies: ${detail.rallies}`);
      console.log(`    War Chest: ${detail.war_chest_sol.toFixed(4)} SOL`);
      console.log(`    Votes: scorched_earth=${detail.votes_scorched_earth} fortify=${detail.votes_fortify}`);
      if (comms.comms.length > 0) {
        console.log(`    Recent comms:`);
        for (const c of comms.comms.slice(0, 3)) {
          console.log(`      ${c.sender.slice(0, 8)}...: "${c.memo}"`);
        }
      }
      if (members.members.length > 0) {
        console.log(`    Top holders:`);
        for (const m of members.members.slice(0, 3)) {
          console.log(`      ${m.address.slice(0, 8)}... — ${m.percentage.toFixed(2)}%`);
        }
      }
    } catch (err: any) {
      console.log(`  Could not fetch ${f.name}: ${err.message}`);
    }
    console.log();
  }

  // World stats
  console.log('World Stats:');
  try {
    const world = await getWorldStats(connection);
    console.log(`  Total factions: ${world.total_factions}`);
    console.log(`  Rising: ${world.rising_factions} | Ascended: ${world.ascended_factions}`);
    console.log(`  Total SOL locked: ${world.total_sol_locked.toFixed(4)} SOL`);
    if (world.most_powerful) {
      console.log(`  Most powerful: [${world.most_powerful.symbol}] ${world.most_powerful.name} (score: ${world.most_powerful.score.toFixed(2)})`);
    }
  } catch (err: any) {
    console.log(`  Could not fetch world stats: ${err.message}`);
  }

  console.log('\nSimulation complete.');
}

// ─── Round Stats Tracking ─────────────────────────────────────────

let _roundJoins = 0;
let _roundDefections = 0;
let _roundRallies = 0;
let _roundErrors = 0;

function resetRoundStats() {
  _roundJoins = 0;
  _roundDefections = 0;
  _roundRallies = 0;
  _roundErrors = 0;
}

function getRoundStats() {
  const stats = { joins: _roundJoins, defections: _roundDefections, rallies: _roundRallies, errors: _roundErrors };
  resetRoundStats();
  return stats;
}

// ─── Action Execution ─────────────────────────────────────────────

async function executeRandomAction(
  connection: Connection,
  agentState: AgentState,
  factions: FactionState[],
) {
  const holdsFactions = [...agentState.holdings.entries()].filter(([, bal]) => bal > 0);
  const canDefect = holdsFactions.length > 0;

  // Weight actions: 60% join, 20% defect (if possible), 20% rally
  const roll = Math.random();
  let action: 'join' | 'defect' | 'rally';

  if (roll < 0.6 || (!canDefect)) {
    action = 'join';
  } else if (roll < 0.8 && canDefect) {
    action = 'defect';
  } else {
    action = 'rally';
  }

  switch (action) {
    case 'join': {
      const faction = pick(factions);
      const alreadyVoted = agentState.voted.has(faction.mint);
      const message = pick(JOIN_MESSAGES);
      const params: any = {
        mint: faction.mint,
        agent: agentState.agent.publicKey,
        amount_sol: JOIN_SOL,
        message,
      };
      if (!alreadyVoted) {
        params.strategy = Math.random() > 0.5 ? 'fortify' : 'scorched_earth';
      }
      try {
        const result = await directJoinFaction(connection, params);
        await sendAndConfirm(connection, agentState.agent, result);
        const prev = agentState.holdings.get(faction.mint) ?? 0;
        agentState.holdings.set(faction.mint, prev + 1);
        agentState.voted.add(faction.mint);
        _roundJoins++;
      } catch (err: any) {
        console.log(`    [JOIN ERROR] ${agentState.agent.publicKey.slice(0, 8)}... -> ${faction.name}: ${err.message}`);
        _roundErrors++;
      }
      break;
    }

    case 'defect': {
      const [mint, balance] = pick(holdsFactions);
      const faction = factions.find(f => f.mint === mint);
      if (!faction) { _roundErrors++; break; }
      const sellAmount = Math.max(1, Math.floor(balance * (0.3 + Math.random() * 0.7)));
      const message = pick(DEFECT_MESSAGES);
      try {
        const result = await defect(connection, {
          mint: faction.mint,
          agent: agentState.agent.publicKey,
          amount_tokens: sellAmount,
          message,
        });
        await sendAndConfirm(connection, agentState.agent, result);
        const remaining = (agentState.holdings.get(mint) ?? 0) - sellAmount;
        if (remaining <= 0) {
          agentState.holdings.delete(mint);
        } else {
          agentState.holdings.set(mint, remaining);
        }
        _roundDefections++;
      } catch (err: any) {
        console.log(`    [DEFECT ERROR] ${agentState.agent.publicKey.slice(0, 8)}... -> ${faction.name} (${sellAmount} tokens): ${err.message}`);
        _roundErrors++;
      }
      break;
    }

    case 'rally': {
      // Can't rally your own faction or one you already rallied
      const eligible = factions.filter(f =>
        f.founder !== agentState.agent.publicKey &&
        !agentState.rallied.has(f.mint)
      );
      if (eligible.length === 0) { break; } // nothing to rally, not an error
      const faction = pick(eligible);
      try {
        const result = await rally(connection, {
          mint: faction.mint,
          agent: agentState.agent.publicKey,
        });
        await sendAndConfirm(connection, agentState.agent, result);
        agentState.rallied.add(faction.mint);
        _roundRallies++;
      } catch (err: any) {
        console.log(`    [RALLY ERROR] ${agentState.agent.publicKey.slice(0, 8)}... -> ${faction.name}: ${err.message}`);
        _roundErrors++;
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error('\nSimulation failed:', err);
  process.exit(1);
});
