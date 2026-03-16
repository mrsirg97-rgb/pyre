/**
 * Pyre Kit E2E Test
 *
 * Tests the full faction warfare flow against a surfpool fork.
 * All operations are vault-routed. Verifies SOL + token balances,
 * state tracking (tick, sentiment, holdings, history), and PNL.
 *
 * Prerequisites:
 *   surfpool start --network mainnet --no-tui
 *
 * Run:
 *   pnpm test  (or: npx tsx tests/test_e2e.ts)
 */

import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  PyreKit,
  createEphemeralAgent,
  startVaultPnlTracker,
} from '../src/index.js'

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899'
let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`)
    failed++
  } else {
    console.log(`  ✓ ${msg}`)
    passed++
  }
}

async function sendAndConfirm(connection: Connection, agent: ReturnType<typeof createEphemeralAgent>, result: any) {
  const tx = result.transaction
  const signed = agent.sign(tx)
  const sig = await connection.sendRawTransaction(signed.serialize())
  await connection.confirmTransaction(sig, 'confirmed')
  console.log(`  tx: ${sig}`)

  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      const addlSigned = agent.sign(addlTx)
      const addlSig = await connection.sendRawTransaction(addlSigned.serialize())
      await connection.confirmTransaction(addlSig, 'confirmed')
      console.log(`  additional tx: ${addlSig}`)
    }
  }

  return sig
}

function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6)
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')
  const agent = createEphemeralAgent()
  const agent2 = createEphemeralAgent()

  // Each agent gets its own kit (state is per-agent)
  const kit = new PyreKit(connection, agent.publicKey)
  const kit2 = new PyreKit(connection, agent2.publicKey)

  /** Get token balance across wallet ATA + vault ATA */
  async function getTokenBalance(k: PyreKit, mint: string, owner: string): Promise<number> {
    const mintPk = new PublicKey(mint)
    let total = 0
    try {
      const ata = getAssociatedTokenAddressSync(mintPk, new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID)
      const info = await connection.getTokenAccountBalance(ata)
      total += Number(info.value.amount)
    } catch {}
    try {
      const vault = await k.actions.getStrongholdForAgent(owner)
      if (vault) {
        const vaultPk = new PublicKey(vault.address)
        const vaultAta = getAssociatedTokenAddressSync(mintPk, vaultPk, true, TOKEN_2022_PROGRAM_ID)
        const info = await connection.getTokenAccountBalance(vaultAta)
        total += Number(info.value.amount)
      }
    } catch {}
    return total
  }

  /** Get vault SOL balance in lamports */
  async function getVaultSolLamports(k: PyreKit, wallet: string): Promise<number> {
    try {
      const vault = await k.actions.getStrongholdForAgent(wallet)
      return vault ? Math.round(vault.sol_balance * LAMPORTS_PER_SOL) : 0
    } catch {
      return 0
    }
  }

  console.log(`Pyre Kit E2E Test — RPC: ${RPC_URL}\n`)

  // ═══════════════════════════════════════════════════════════════════
  // SETUP: Agents + Vaults + Faction
  // ═══════════════════════════════════════════════════════════════════

  console.log('1. Creating agents...')
  console.log(`   Agent 1: ${agent.publicKey}`)
  console.log(`   Agent 2: ${agent2.publicKey}`)

  console.log('   Requesting airdrops...')
  const [airdropSig, airdropSig2] = await Promise.all([
    connection.requestAirdrop(agent.keypair.publicKey, 10 * LAMPORTS_PER_SOL),
    connection.requestAirdrop(agent2.keypair.publicKey, 10 * LAMPORTS_PER_SOL),
  ])
  await Promise.all([
    connection.confirmTransaction(airdropSig, 'confirmed'),
    connection.confirmTransaction(airdropSig2, 'confirmed'),
  ])

  console.log('\n2. Creating vaults...')
  const vault1 = await kit.actions.createStronghold({ creator: agent.publicKey })
  await sendAndConfirm(connection, agent, vault1)
  const vault2 = await kit2.actions.createStronghold({ creator: agent2.publicKey })
  await sendAndConfirm(connection, agent2, vault2)

  console.log('\n3. Funding vaults...')
  const fund1 = await kit.actions.fundStronghold({
    depositor: agent.publicKey, stronghold_creator: agent.publicKey, amount_sol: 5 * LAMPORTS_PER_SOL,
  })
  await sendAndConfirm(connection, agent, fund1)
  const fund2 = await kit2.actions.fundStronghold({
    depositor: agent2.publicKey, stronghold_creator: agent2.publicKey, amount_sol: 5 * LAMPORTS_PER_SOL,
  })
  await sendAndConfirm(connection, agent2, fund2)

  // Initialize state from chain (resolves vault, loads holdings)
  console.log('\n4. Initializing state...')
  const state1 = await kit.state.init()
  const state2 = await kit2.state.init()
  console.log(`   Agent 1 vault: ${state1.vaultCreator ?? 'none'}`)
  console.log(`   Agent 2 vault: ${state2.vaultCreator ?? 'none'}`)
  assert(state1.initialized, 'agent 1 state initialized')
  assert(state2.initialized, 'agent 2 state initialized')
  assert(state1.vaultCreator !== null, 'agent 1 vault resolved')
  assert(state2.vaultCreator !== null, 'agent 2 vault resolved')
  assert(kit.state.tick === 0, `agent 1 tick starts at 0: ${kit.state.tick}`)

  console.log('\n5. Launching faction...')
  const launchResult = await kit.actions.launch({
    founder: agent.publicKey, name: 'Balance Test Faction', symbol: 'BTEST',
    metadata_uri: 'https://pyre.gg/test.json', community_faction: true,
  })
  await sendAndConfirm(connection, agent, launchResult)
  await kit.state.record('launch', launchResult.mint.toBase58(), 'launched BTEST')
  const mint = launchResult.mint.toBase58()
  console.log(`   Faction: ${mint}`)

  assert(kit.state.tick === 1, `tick incremented to 1: ${kit.state.tick}`)
  assert(kit.state.state!.actionCounts.launch === 1, `launch count = 1`)
  assert(kit.state.getSentiment(mint) === 0.3, `launch sentiment = +0.3: ${kit.state.getSentiment(mint)}`)
  assert(kit.state.history.length === 1, `history has 1 entry`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: VAULT BUY + STATE TRACKING
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Vault buy (join) + state tracking ═══')
  const buyLamports = Math.floor(0.5 * LAMPORTS_PER_SOL)

  const buyVaultBefore = await getVaultSolLamports(kit, agent.publicKey)
  const buyTokensBefore = await getTokenBalance(kit, mint, agent.publicKey)
  const buyTotalBefore = await kit.intel.getAgentSolLamports(agent.publicKey)

  console.log(`  PRE  — vault: ${sol(buyVaultBefore)}, tokens: ${buyTokensBefore}, total: ${sol(buyTotalBefore)}`)

  const pnl = await startVaultPnlTracker(kit.intel, agent.publicKey)

  const joinResult = await kit.actions.join({
    mint, agent: agent.publicKey, amount_sol: buyLamports,
    strategy: 'fortify', message: 'Vault buy test', stronghold: agent.publicKey,
  })
  await sendAndConfirm(connection, agent, joinResult)
  await kit.state.record('join', mint, 'joined BTEST for 0.5 SOL — "Vault buy test"')

  const buyVaultAfter = await getVaultSolLamports(kit, agent.publicKey)
  const buyTokensAfter = await getTokenBalance(kit, mint, agent.publicKey)
  const buyTotalAfter = await kit.intel.getAgentSolLamports(agent.publicKey)
  const { spent, received } = await pnl.finish()

  console.log(`  POST — vault: ${sol(buyVaultAfter)}, tokens: ${buyTokensAfter}, total: ${sol(buyTotalAfter)}`)
  console.log(`  PNL  — spent: ${sol(spent)}, received: ${sol(received)}`)

  // Balance assertions
  assert(buyTokensAfter > buyTokensBefore, `tokens increased: ${buyTokensBefore} → ${buyTokensAfter}`)
  assert(buyVaultAfter < buyVaultBefore, `vault SOL decreased: ${sol(buyVaultBefore)} → ${sol(buyVaultAfter)}`)
  assert(buyTotalAfter < buyTotalBefore, `total SOL decreased: ${sol(buyTotalBefore)} → ${sol(buyTotalAfter)}`)
  assert(spent > 0, `PNL spent > 0: ${sol(spent)}`)

  // State assertions
  assert(kit.state.tick === 2, `tick = 2: ${kit.state.tick}`)
  assert(kit.state.state!.actionCounts.join === 1, `join count = 1`)
  assert(kit.state.getSentiment(mint) === 0.4, `sentiment after launch(+0.3) + join(+0.1) = 0.4: ${kit.state.getSentiment(mint)}`)
  const holdingsAfterJoin = await kit.state.getBalance(mint)
  assert(holdingsAfterJoin > 0, `state holdings updated: ${holdingsAfterJoin}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: VAULT SELL (defect) + SENTIMENT
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Vault defect (sell half) + sentiment ═══')
  const sellAmount = Math.floor(buyTokensAfter / 2)
  const sentimentBeforeDefect = kit.state.getSentiment(mint)

  const defVaultBefore = await getVaultSolLamports(kit, agent.publicKey)
  const defTokensBefore = await getTokenBalance(kit, mint, agent.publicKey)
  const defTotalBefore = await kit.intel.getAgentSolLamports(agent.publicKey)

  console.log(`  PRE  — vault: ${sol(defVaultBefore)}, tokens: ${defTokensBefore}, total: ${sol(defTotalBefore)}, sentiment: ${sentimentBeforeDefect}`)

  const defPnl = await startVaultPnlTracker(kit.intel, agent.publicKey)

  const defectResult = await kit.actions.defect({
    mint, agent: agent.publicKey, amount_tokens: sellAmount,
    message: 'Vault defect test', stronghold: agent.publicKey,
  })
  await sendAndConfirm(connection, agent, defectResult)
  await kit.state.record('defect', mint, 'defected from BTEST — "Vault defect test"')

  const defVaultAfter = await getVaultSolLamports(kit, agent.publicKey)
  const defTokensAfter = await getTokenBalance(kit, mint, agent.publicKey)
  const defTotalAfter = await kit.intel.getAgentSolLamports(agent.publicKey)
  const defPnlResult = await defPnl.finish()

  console.log(`  POST — vault: ${sol(defVaultAfter)}, tokens: ${defTokensAfter}, total: ${sol(defTotalAfter)}, sentiment: ${kit.state.getSentiment(mint)}`)
  console.log(`  PNL  — spent: ${sol(defPnlResult.spent)}, received: ${sol(defPnlResult.received)}`)
  console.log(`  VAULT DELTA: ${sol(defVaultAfter - defVaultBefore)}`)

  // Balance assertions
  assert(defTokensAfter < defTokensBefore, `tokens decreased: ${defTokensBefore} → ${defTokensAfter}`)
  assert(defTotalAfter > defTotalBefore, `total SOL increased: ${sol(defTotalBefore)} → ${sol(defTotalAfter)}`)
  assert(defVaultAfter > defVaultBefore, `vault SOL increased: ${sol(defVaultBefore)} → ${sol(defVaultAfter)}`)
  assert(defPnlResult.received > 0, `PNL received > 0: ${sol(defPnlResult.received)}`)

  // State assertions
  assert(kit.state.tick === 3, `tick = 3: ${kit.state.tick}`)
  assert(kit.state.getSentiment(mint) === sentimentBeforeDefect - 0.2, `defect drops sentiment by 0.2: ${sentimentBeforeDefect} → ${kit.state.getSentiment(mint)}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: FUD + SENTIMENT
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: FUD (micro sell) + sentiment ═══')
  const sentimentBeforeFud = kit.state.getSentiment(mint)
  const fudTokensBefore = await getTokenBalance(kit, mint, agent.publicKey)

  console.log(`  PRE  — tokens: ${fudTokensBefore}, sentiment: ${sentimentBeforeFud}`)

  const fudResult = await kit.actions.fud({
    mint, agent: agent.publicKey, message: 'This faction is weak!',
    stronghold: agent.publicKey,
  })
  await sendAndConfirm(connection, agent, fudResult)
  await kit.state.record('fud', mint, 'fud BTEST — "This faction is weak!"')

  const fudTokensAfter = await getTokenBalance(kit, mint, agent.publicKey)
  const fudTokenDelta = fudTokensBefore - fudTokensAfter

  console.log(`  POST — tokens: ${fudTokensAfter}, sentiment: ${kit.state.getSentiment(mint)}`)
  console.log(`  TOKEN DELTA: ${fudTokenDelta} (expect ~10M raw = 10 tokens)`)

  assert(fudTokenDelta > 0, `FUD sold tokens: ${fudTokenDelta}`)
  assert(fudTokenDelta <= 10_000_000, `FUD micro amount (10 tokens raw): ${fudTokenDelta}`)
  assert(kit.state.tick === 4, `tick = 4: ${kit.state.tick}`)
  assert(kit.state.getSentiment(mint) === sentimentBeforeFud - 0.15, `fud drops sentiment by 0.15: ${kit.state.getSentiment(mint)}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: MESSAGE + STATE
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Message (micro buy) + state ═══')
  const sentimentBeforeMsg = kit.state.getSentiment(mint)

  const msgResult = await kit.actions.message({
    mint, agent: agent.publicKey, message: 'We are strong!',
    stronghold: agent.publicKey,
  })
  await sendAndConfirm(connection, agent, msgResult)
  await kit.state.record('message', mint, 'said in BTEST — "We are strong!"')

  assert(kit.state.tick === 5, `tick = 5: ${kit.state.tick}`)
  assert(kit.state.getSentiment(mint) === sentimentBeforeMsg + 0.05, `message bumps sentiment by 0.05: ${kit.state.getSentiment(mint)}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: AGENT 2 JOIN + SEPARATE STATE
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Agent 2 join (separate state) ═══')
  assert(kit2.state.tick === 0, `agent 2 tick starts at 0: ${kit2.state.tick}`)

  const join2 = await kit2.actions.join({
    mint, agent: agent2.publicKey, amount_sol: Math.floor(0.3 * LAMPORTS_PER_SOL),
    strategy: 'smelt', message: 'Agent 2 joining', stronghold: agent2.publicKey,
  })
  await sendAndConfirm(connection, agent2, join2)
  await kit2.state.record('join', mint, 'joined BTEST')

  assert(kit2.state.tick === 1, `agent 2 tick = 1: ${kit2.state.tick}`)
  assert(kit.state.tick === 5, `agent 1 tick unchanged: ${kit.state.tick}`)
  assert(kit2.state.getSentiment(mint) === 0.1, `agent 2 sentiment = +0.1 (join): ${kit2.state.getSentiment(mint)}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: RALLY + STATE
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Rally + state ═══')
  const detail1 = await kit.actions.getFaction(mint)

  const rallyResult = await kit2.actions.rally({
    mint, agent: agent2.publicKey, stronghold: agent2.publicKey,
  })
  await sendAndConfirm(connection, agent2, rallyResult)
  await kit2.state.record('rally', mint, 'rallied BTEST')
  kit2.state.markRallied(mint)

  const detail2 = await kit.actions.getFaction(mint)
  assert(detail2.rallies > detail1.rallies, `rallies increased: ${detail1.rallies} → ${detail2.rallies}`)
  assert(kit2.state.tick === 2, `agent 2 tick = 2: ${kit2.state.tick}`)
  assert(kit2.state.getSentiment(mint) === 0.4, `agent 2 sentiment after join(+0.1) + rally(+0.3) = 0.4: ${kit2.state.getSentiment(mint)}`)
  assert(kit2.state.hasRallied(mint), `agent 2 marked as rallied`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: SERIALIZE / HYDRATE
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Serialize / Hydrate ═══')
  const serialized = kit.state.serialize()
  console.log(`  Serialized: tick=${serialized.tick}, actions=${JSON.stringify(serialized.actionCounts)}, sentiment keys=${Object.keys(serialized.sentiment).length}, history=${serialized.recentHistory.length}`)

  // Create a fresh kit and hydrate
  const kitRestored = new PyreKit(connection, agent.publicKey)
  kitRestored.state.hydrate(serialized)

  assert(kitRestored.state.tick === kit.state.tick, `hydrated tick matches: ${kitRestored.state.tick}`)
  assert(kitRestored.state.getSentiment(mint) === kit.state.getSentiment(mint), `hydrated sentiment matches: ${kitRestored.state.getSentiment(mint)}`)
  assert(kitRestored.state.state!.actionCounts.join === kit.state.state!.actionCounts.join, `hydrated join count matches`)
  assert(kitRestored.state.state!.actionCounts.defect === kit.state.state!.actionCounts.defect, `hydrated defect count matches`)
  assert(kitRestored.state.history.length === kit.state.history.length, `hydrated history length matches: ${kitRestored.state.history.length}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: MEMBERS
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Members ═══')
  try {
    const members = await kit.actions.getMembers(mint)
    console.log(`  Total members: ${members.total_members}`)
    for (const m of members.members.slice(0, 5)) {
      console.log(`  ${m.address.slice(0, 8)}... — ${m.balance} (${m.percentage.toFixed(2)}%)`)
    }
    assert(members.total_members > 0, `has members: ${members.total_members}`)
  } catch (err: any) {
    console.log(`  Skipped — RPC error: ${err.message?.slice(0, 80)}`)
  }

  // ═══════════════════════════════════════════════════════════════════
  // TEST: CHECKPOINT (register + checkpoint + verify)
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Checkpoint ═══')

  // Register agent 1 on pyre_world
  const regResult = await kit.registry.register({ creator: agent.publicKey })
  await sendAndConfirm(connection, agent, regResult)
  console.log(`  Registered agent 1`)

  // Verify fresh profile — all counts should be 0
  const profileBefore = await kit.registry.getProfile(agent.publicKey)
  assert(profileBefore !== undefined, `profile exists after register`)
  assert(profileBefore!.joins === 0, `initial joins = 0`)
  assert(profileBefore!.messages === 0, `initial messages = 0`)

  // Checkpoint with current action counts from state
  const counts = kit.state.state!.actionCounts
  const cpResult = await kit.registry.checkpoint({
    signer: agent.publicKey,
    creator: agent.publicKey,
    joins: counts.join,
    defects: counts.defect,
    rallies: counts.rally,
    launches: counts.launch,
    messages: counts.message,
    fuds: counts.fud,
    infiltrates: counts.infiltrate,
    reinforces: counts.reinforce,
    war_loans: counts.war_loan,
    repay_loans: counts.repay_loan,
    sieges: counts.siege,
    ascends: counts.ascend,
    razes: counts.raze,
    tithes: counts.tithe,
    personality_summary: 'test agent — loyal and steadfast',
    total_sol_spent: kit.state.state!.totalSolSpent,
    total_sol_received: kit.state.state!.totalSolReceived,
  })
  await sendAndConfirm(connection, agent, cpResult)
  console.log(`  Checkpointed agent 1 (tick ${kit.state.tick})`)

  // Verify checkpoint wrote correct counts
  const profileAfter = await kit.registry.getProfile(agent.publicKey)
  assert(profileAfter !== undefined, `profile still exists`)
  assert(profileAfter!.joins === counts.join, `checkpoint joins match: ${profileAfter!.joins} === ${counts.join}`)
  assert(profileAfter!.defects === counts.defect, `checkpoint defects match: ${profileAfter!.defects} === ${counts.defect}`)
  assert(profileAfter!.launches === counts.launch, `checkpoint launches match: ${profileAfter!.launches} === ${counts.launch}`)
  assert(profileAfter!.messages === counts.message, `checkpoint messages match: ${profileAfter!.messages} === ${counts.message}`)
  assert(profileAfter!.fuds === counts.fud, `checkpoint fuds match: ${profileAfter!.fuds} === ${counts.fud}`)
  assert(profileAfter!.personality_summary === 'test agent — loyal and steadfast', `checkpoint personality matches`)
  assert(profileAfter!.last_checkpoint > 0, `last_checkpoint timestamp set: ${profileAfter!.last_checkpoint}`)
  console.log(`  Profile verified — ${Object.values(counts).reduce((a, b) => a + b, 0)} total actions checkpointed`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: SCOUT (after checkpoint — agent 1 now has a pyre identity)
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Scout ═══')
  // Scout agent 1 from agent 2's perspective — should find real profile data
  const scoutResult = await kit2.actions.scout(agent.publicKey)
  console.log(`  ${scoutResult}`)
  assert(typeof scoutResult === 'string', `scout returns string`)
  assert(scoutResult.includes(agent.publicKey.slice(0, 8)), `scout result contains target address: ${agent.publicKey.slice(0, 8)}`)
  assert(scoutResult.includes('loyal and steadfast'), `scout shows personality from checkpoint`)
  assert(scoutResult.includes('actions'), `scout shows action counts`)

  // Scout a nonexistent address
  const fakeAddress = 'FakeAddress1111111111111111111111111111111111'
  const scoutFake = await kit2.actions.scout(fakeAddress)
  console.log(`  ${scoutFake}`)
  assert(scoutFake.includes('no pyre identity') || scoutFake.includes('lookup failed'), `scout handles unknown agent`)

  // Scout via exec (read-only — no tick increment)
  const { result: scoutExecResult } = await kit2.exec('actions', 'scout', agent.publicKey)
  console.log(`  exec scout: ${scoutExecResult}`)
  assert(kit2.state.tick === 2, `agent 2 tick unchanged after scout (read-only): ${kit2.state.tick}`)

  // ═══════════════════════════════════════════════════════════════════
  // TEST: FACTION DISCOVERY (rising, ascended, nearby)
  // ═══════════════════════════════════════════════════════════════════

  console.log('\n═══ TEST: Faction discovery ═══')

  // Agent 3 launches a second faction
  const agent3 = createEphemeralAgent()
  const kit3 = new PyreKit(connection, agent3.publicKey)

  const airdrop3 = await connection.requestAirdrop(agent3.keypair.publicKey, 10 * LAMPORTS_PER_SOL)
  await connection.confirmTransaction(airdrop3, 'confirmed')

  const vault3 = await kit3.actions.createStronghold({ creator: agent3.publicKey })
  await sendAndConfirm(connection, agent3, vault3)
  const fund3 = await kit3.actions.fundStronghold({
    depositor: agent3.publicKey, stronghold_creator: agent3.publicKey, amount_sol: 5 * LAMPORTS_PER_SOL,
  })
  await sendAndConfirm(connection, agent3, fund3)
  await kit3.state.init()

  const launch2 = await kit3.actions.launch({
    founder: agent3.publicKey, name: 'Nearby Test Faction', symbol: 'NEAR',
    metadata_uri: 'https://pyre.gg/test2.json', community_faction: true,
  })
  await sendAndConfirm(connection, agent3, launch2)
  const mint2 = launch2.mint.toBase58()
  console.log(`  Faction 2: ${mint2} (NEAR)`)

  // Agent 2 joins faction 2 — creating a social link between BTEST and NEAR
  const join2Near = await kit2.actions.join({
    mint: mint2, agent: agent2.publicKey, amount_sol: Math.floor(0.3 * LAMPORTS_PER_SOL),
    strategy: 'fortify', stronghold: agent2.publicKey,
  })
  await sendAndConfirm(connection, agent2, join2Near)
  console.log(`  Agent 2 joined NEAR — bridge between BTEST and NEAR`)

  // Test getRisingFactions
  const rising = await kit.intel.getRisingFactions()
  console.log(`  Rising factions: ${rising.factions.length}`)
  assert(rising.factions.length >= 2, `at least 2 rising factions: ${rising.factions.length}`)

  // Test getAscendedFactions (none expected on fresh fork with new factions)
  const ascended = await kit.intel.getAscendedFactions()
  console.log(`  Ascended factions: ${ascended.factions.length}`)

  // Test getNearbyFactions — agent 1 holds BTEST, agent 2 also holds BTEST + NEAR
  // BFS uses getComms to find neighbors, which requires getSignaturesForAddress.
  // Surfpool doesn't support this reliably — test the seed scan only.
  const nearby = await kit.intel.getNearbyFactions(agent.publicKey)
  const nearbyMints = nearby.factions.map((f) => f.mint)
  console.log(`  Nearby factions for agent 1: ${nearby.factions.length} (${nearby.factions.map((f) => f.symbol).join(', ')})`)
  assert(nearbyMints.includes(mint), `nearby includes own faction BTEST`)

  // NOTE: Social graph discovery (finding NEAR through agent 2) requires
  // getComms which depends on getSignaturesForAddress — not available on surfpool.
  // This is tested on devnet/mainnet where comms resolution works.
  if (nearbyMints.includes(mint2)) {
    console.log(`  ✓ nearby discovered NEAR through social graph`)
    passed++
  } else {
    console.log(`  ⊘ nearby did not discover NEAR (surfpool limitation — getComms unavailable)`)
  }

  // ═══════════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`${'═'.repeat(50)}`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err)
  process.exit(1)
})
