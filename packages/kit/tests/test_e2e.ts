/**
 * Pyre Kit E2E Test
 *
 * Tests the full faction warfare flow against a surfpool fork.
 *
 * Prerequisites:
 *   surfpool start --network mainnet --no-tui
 *
 * Run:
 *   pnpm test  (or: npx tsx tests/test_e2e.ts)
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  createEphemeralAgent,
  createStronghold,
  fundStronghold,
  recruitAgent,
  launchFaction,
  getFactions,
  getFaction,
  getJoinQuote,
  joinFaction,
  getComms,
  rally,
  defect,
  getMembers,
  getStrongholdForAgent,
} from '../src/index.js';

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899';

async function sendAndConfirm(connection: Connection, agent: ReturnType<typeof createEphemeralAgent>, result: any) {
  const tx = result.transaction;
  const signed = agent.sign(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`  tx: ${sig}`);

  // Handle additional transactions
  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      const addlSigned = agent.sign(addlTx);
      const addlSig = await connection.sendRawTransaction(addlSigned.serialize());
      await connection.confirmTransaction(addlSig, 'confirmed');
      console.log(`  additional tx: ${addlSig}`);
    }
  }

  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  console.log(`Pyre Kit E2E Test — RPC: ${RPC_URL}\n`);

  // 1. Create ephemeral agents
  console.log('1. Creating ephemeral agents...');
  const agent = createEphemeralAgent();
  const agent2 = createEphemeralAgent();
  console.log(`   Agent 1: ${agent.publicKey}`);
  console.log(`   Agent 2: ${agent2.publicKey}`);

  // Airdrop SOL for testing
  console.log('   Requesting airdrops...');
  const [airdropSig, airdropSig2] = await Promise.all([
    connection.requestAirdrop(agent.keypair.publicKey, 10 * LAMPORTS_PER_SOL),
    connection.requestAirdrop(agent2.keypair.publicKey, 1 * LAMPORTS_PER_SOL),
  ]);
  await Promise.all([
    connection.confirmTransaction(airdropSig, 'confirmed'),
    connection.confirmTransaction(airdropSig2, 'confirmed'),
  ]);
  console.log('   Airdrops confirmed');

  // 2. Create stronghold (vault)
  console.log('\n2. Creating stronghold...');
  const strongholdResult = await createStronghold(connection, {
    creator: agent.publicKey,
  });
  await sendAndConfirm(connection, agent, strongholdResult);
  console.log('   Stronghold created');

  // 3. Fund stronghold
  console.log('\n3. Funding stronghold...');
  const fundResult = await fundStronghold(connection, {
    depositor: agent.publicKey,
    stronghold_creator: agent.publicKey,
    amount_sol: 5 * LAMPORTS_PER_SOL,
  });
  await sendAndConfirm(connection, agent, fundResult);
  console.log('   Funded 5 SOL');

  // 4. Recruit agent (link wallet)
  console.log('\n4. Recruiting agent (self-link)...');
  // Agent is already linked as creator, but let's verify
  const agentLink = await getStrongholdForAgent(connection, agent.publicKey);
  console.log(`   Stronghold found: ${agentLink ? 'yes' : 'no'}`);
  if (agentLink) {
    console.log(`   SOL balance: ${agentLink.sol_balance / LAMPORTS_PER_SOL} SOL`);
  }

  // 5. Launch faction
  console.log('\n5. Launching faction...');
  const launchResult = await launchFaction(connection, {
    founder: agent.publicKey,
    name: 'Pyre Test Faction',
    symbol: 'PYRE',
    metadata_uri: 'https://torch.market/test-metadata.json',
    community_faction: true,
  });
  await sendAndConfirm(connection, agent, launchResult);
  const factionMint = launchResult.mint.toBase58();
  console.log(`   Faction launched: ${factionMint}`);

  // 6. List factions
  console.log('\n6. Listing factions...');
  const factions = await getFactions(connection, { limit: 10 });
  console.log(`   Total factions: ${factions.total}`);
  const ourFaction = factions.factions.find(f => f.mint === factionMint);
  console.log(`   Our faction found: ${ourFaction ? 'yes' : 'no'}`);
  if (ourFaction) {
    console.log(`   Status: ${ourFaction.status}, Members: ${ourFaction.members}`);
  }

  // 7. Get faction detail
  console.log('\n7. Getting faction detail...');
  const detail = await getFaction(connection, factionMint);
  console.log(`   Name: ${detail.name}`);
  console.log(`   Status: ${detail.status}`);
  console.log(`   Tier: ${detail.tier}`);
  console.log(`   Founder: ${detail.founder}`);
  console.log(`   War chest SOL: ${detail.war_chest_sol}`);

  // 8. Get join quote
  console.log('\n8. Getting join quote (0.1 SOL)...');
  const quote = await getJoinQuote(connection, factionMint, 0.1 * LAMPORTS_PER_SOL);
  console.log(`   Tokens out: ${quote.tokens_to_user}`);
  console.log(`   Price impact: ${quote.price_impact_percent}%`);

  // 9. Join faction with message (comms)
  console.log('\n9. Joining faction...');
  const joinResult = await joinFaction(connection, {
    mint: factionMint,
    agent: agent.publicKey,
    amount_sol: 0.1 * LAMPORTS_PER_SOL,
    strategy: 'fortify',
    message: 'For the faction! First to join.',
    stronghold: agent.publicKey,
  });
  await sendAndConfirm(connection, agent, joinResult);
  console.log('   Joined faction');

  // 10. Read comms
  console.log('\n10. Reading faction comms...');
  const comms = await getComms(connection, factionMint);
  console.log(`   Total comms: ${comms.total}`);
  for (const c of comms.comms) {
    console.log(`   [${new Date(c.timestamp * 1000).toISOString()}] ${c.sender.slice(0, 8)}...: ${c.memo}`);
  }

  // 11. Rally support (different agent — can't rally your own faction)
  console.log('\n11. Rallying faction (agent 2)...');
  const rallyResult = await rally(connection, {
    mint: factionMint,
    agent: agent2.publicKey,
  });
  await sendAndConfirm(connection, agent2, rallyResult);
  console.log('   Rally sent');

  // Verify rally
  const detailAfterRally = await getFaction(connection, factionMint);
  console.log(`   Rallies: ${detailAfterRally.rallies}`);

  // 12. Defect with message
  console.log('\n12. Defecting from faction...');
  // Sell half of what we bought
  const sellAmount = Math.floor(quote.tokens_to_user / 2);
  const defectResult = await defect(connection, {
    mint: factionMint,
    agent: agent.publicKey,
    amount_tokens: sellAmount,
    message: 'Strategic withdrawal. Will return.',
    stronghold: agent.publicKey,
  });
  await sendAndConfirm(connection, agent, defectResult);
  console.log(`   Defected ${sellAmount} tokens`);

  // 13. Check members
  console.log('\n13. Checking members...');
  const members = await getMembers(connection, factionMint);
  console.log(`   Total members: ${members.total_members}`);
  for (const m of members.members.slice(0, 5)) {
    console.log(`   ${m.address.slice(0, 8)}... — ${m.balance} (${m.percentage.toFixed(2)}%)`);
  }

  // 14. Verify stronghold for agent
  console.log('\n14. Verifying stronghold link...');
  const stronghold = await getStrongholdForAgent(connection, agent.publicKey);
  if (stronghold) {
    console.log(`   Stronghold: ${stronghold.address}`);
    console.log(`   Authority: ${stronghold.authority}`);
    console.log(`   SOL balance: ${stronghold.sol_balance / LAMPORTS_PER_SOL} SOL`);
    console.log(`   Linked agents: ${stronghold.linked_agents}`);
  }

  console.log('\n✓ All steps completed successfully');
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err);
  process.exit(1);
});
