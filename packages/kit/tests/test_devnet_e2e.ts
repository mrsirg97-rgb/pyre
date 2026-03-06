/**
 * Pyre Kit Devnet E2E Test
 *
 * Tests the full faction warfare flow on Solana devnet.
 * Creates a faction with a "py" vanity mint, joins, rallies, defects.
 *
 * Run:
 *   npx tsx tests/test_devnet_e2e.ts
 *
 * Requirements:
 *   - Devnet wallet (~/.config/solana/id.json) with ~5 SOL
 *   - Torch Market program deployed to devnet
 */

// Must be set before any torchsdk imports
process.env.TORCH_NETWORK = 'devnet'

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from '@solana/web3.js'
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
  directJoinFaction,
  getComms,
  rally,
  defect,
  getMembers,
  getStrongholdForAgent,
  isPyreMint,
} from '../src/index'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const DEVNET_RPC = 'https://api.devnet.solana.com'
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json')

// ============================================================================
// Helpers
// ============================================================================

const loadWallet = (): Keypair => {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

const log = (msg: string) => {
  const ts = new Date().toISOString().substr(11, 8)
  console.log(`[${ts}] ${msg}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const signAndSend = async (
  connection: Connection,
  signer: Keypair,
  tx: Transaction,
): Promise<string> => {
  tx.partialSign(signer)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')
  return sig
}

let passed = 0
let failed = 0
const ok = (name: string, detail?: string) => {
  passed++
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
const fail = (name: string, err: any) => {
  failed++
  log(`  ✗ ${name} — ${err.message || err}`)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('='.repeat(60))
  console.log('PYRE KIT — DEVNET E2E TEST')
  console.log('='.repeat(60))

  const connection = new Connection(DEVNET_RPC, 'confirmed')
  const wallet = loadWallet()
  const walletAddr = wallet.publicKey.toBase58()

  log(`Wallet: ${walletAddr}`)
  const balance = await connection.getBalance(wallet.publicKey)
  log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL`)

  if (balance < 3 * LAMPORTS_PER_SOL) {
    console.error('Need at least ~3 SOL on devnet.')
    process.exit(1)
  }

  // ================================================================
  // 1. Create ephemeral agents
  // ================================================================
  log('\n[1] Creating ephemeral agents')
  const agent1 = createEphemeralAgent()
  const agent2 = createEphemeralAgent()
  log(`  Agent 1: ${agent1.publicKey}`)
  log(`  Agent 2: ${agent2.publicKey}`)

  // Fund agents from main wallet
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: agent1.keypair.publicKey,
      lamports: 1.5 * LAMPORTS_PER_SOL,
    }),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: agent2.keypair.publicKey,
      lamports: 0.5 * LAMPORTS_PER_SOL,
    }),
  )
  const { blockhash } = await connection.getLatestBlockhash()
  fundTx.recentBlockhash = blockhash
  fundTx.feePayer = wallet.publicKey
  await signAndSend(connection, wallet, fundTx)
  ok('Fund agents', '1.5 SOL + 0.5 SOL')

  await sleep(500)

  // ================================================================
  // 2. Create stronghold
  // ================================================================
  log('\n[2] Creating stronghold')
  try {
    const result = await createStronghold(connection, {
      creator: agent1.publicKey,
    })
    await signAndSend(connection, agent1.keypair, result.transaction)
    ok('Create stronghold')
  } catch (e: any) {
    if (e.message?.includes('already in use')) {
      ok('Create stronghold', 'already exists')
    } else {
      fail('Create stronghold', e)
    }
  }

  await sleep(500)

  // ================================================================
  // 3. Fund stronghold
  // ================================================================
  log('\n[3] Funding stronghold')
  try {
    const result = await fundStronghold(connection, {
      depositor: agent1.publicKey,
      stronghold_creator: agent1.publicKey,
      amount_sol: 1 * LAMPORTS_PER_SOL,
    })
    await signAndSend(connection, agent1.keypair, result.transaction)
    ok('Fund stronghold', '1 SOL')
  } catch (e: any) {
    fail('Fund stronghold', e)
  }

  await sleep(500)

  // ================================================================
  // 4. Verify stronghold link
  // ================================================================
  log('\n[4] Verifying stronghold')
  try {
    const stronghold = await getStrongholdForAgent(connection, agent1.publicKey)
    if (stronghold) {
      ok('Stronghold link', `balance=${(stronghold.sol_balance / LAMPORTS_PER_SOL).toFixed(2)} SOL, agents=${stronghold.linked_agents}`)
    } else {
      fail('Stronghold link', { message: 'not found' })
    }
  } catch (e: any) {
    fail('Stronghold link', e)
  }

  // ================================================================
  // 5. Launch faction (with py vanity mint!)
  // ================================================================
  log('\n[5] Launching faction (grinding py vanity mint...)')
  let factionMint: string = ''
  try {
    const startTime = Date.now()
    const result = await launchFaction(connection, {
      founder: agent1.publicKey,
      name: 'Devnet Pyre Faction',
      symbol: 'DPYRE',
      metadata_uri: 'https://torch.market/test-metadata.json',
      community_faction: true,
    })
    const grindMs = Date.now() - startTime
    await signAndSend(connection, agent1.keypair, result.transaction)
    factionMint = result.mint.toBase58()

    const hasPySuffix = isPyreMint(factionMint)
    ok('Launch faction', `mint=${factionMint.slice(0, 8)}...${factionMint.slice(-4)} vanity=${hasPySuffix ? 'py✓' : 'MISS'} grind=${grindMs}ms`)

    if (!hasPySuffix) {
      log('  ⚠ Vanity grind did not find "py" suffix — faction still works but won\'t be filtered as pyre')
    }
  } catch (e: any) {
    fail('Launch faction', e)
    console.error('Cannot continue without faction. Exiting.')
    process.exit(1)
  }

  await sleep(1000)

  // ================================================================
  // 6. List factions
  // ================================================================
  log('\n[6] Listing factions')
  try {
    const factions = await getFactions(connection, { limit: 10 })
    const ourFaction = factions.factions.find(f => f.mint === factionMint)
    ok('List factions', `total=${factions.total}, ours=${ourFaction ? 'found' : 'not found'}`)
  } catch (e: any) {
    fail('List factions', e)
  }

  // ================================================================
  // 7. Get faction detail
  // ================================================================
  log('\n[7] Getting faction detail')
  try {
    const detail = await getFaction(connection, factionMint)
    ok('Faction detail', `name=${detail.name} status=${detail.status} tier=${detail.tier}`)
  } catch (e: any) {
    fail('Faction detail', e)
  }

  // ================================================================
  // 8. Get join quote
  // ================================================================
  log('\n[8] Getting join quote (0.1 SOL)')
  let tokensOut = 0
  try {
    const quote = await getJoinQuote(connection, factionMint, 0.1 * LAMPORTS_PER_SOL)
    tokensOut = quote.tokens_to_user
    ok('Join quote', `tokens=${tokensOut} impact=${quote.price_impact_percent}%`)
  } catch (e: any) {
    fail('Join quote', e)
  }

  // ================================================================
  // 9. Join faction via vault
  // ================================================================
  log('\n[9] Joining faction via vault')
  try {
    const result = await joinFaction(connection, {
      mint: factionMint,
      agent: agent1.publicKey,
      amount_sol: 0.1 * LAMPORTS_PER_SOL,
      strategy: 'fortify',
      message: 'First blood. The pyre burns.',
      stronghold: agent1.publicKey,
    })
    await signAndSend(connection, agent1.keypair, result.transaction)
    ok('Join faction', result.message)
  } catch (e: any) {
    fail('Join faction', e)
  }

  await sleep(1000)

  // ================================================================
  // 10. Agent 2 joins directly (no vault)
  // ================================================================
  log('\n[10] Agent 2 joins directly')
  try {
    const result = await directJoinFaction(connection, {
      mint: factionMint,
      agent: agent2.publicKey,
      amount_sol: 0.05 * LAMPORTS_PER_SOL,
      strategy: 'scorched_earth',
      message: 'Reporting for duty.',
    })
    await signAndSend(connection, agent2.keypair, result.transaction)
    ok('Agent 2 join', result.message)
  } catch (e: any) {
    fail('Agent 2 join', e)
  }

  await sleep(1000)

  // ================================================================
  // 11. Read comms
  // ================================================================
  log('\n[11] Reading comms')
  try {
    const comms = await getComms(connection, factionMint)
    ok('Read comms', `total=${comms.total}`)
    for (const c of comms.comms) {
      log(`    ${c.sender.slice(0, 8)}...: "${c.memo}"`)
    }
  } catch (e: any) {
    fail('Read comms', e)
  }

  // ================================================================
  // 12. Rally (agent 2 — can't rally your own faction)
  // ================================================================
  log('\n[12] Agent 2 rallies faction')
  try {
    const result = await rally(connection, {
      mint: factionMint,
      agent: agent2.publicKey,
    })
    await signAndSend(connection, agent2.keypair, result.transaction)
    ok('Rally')

    const detail = await getFaction(connection, factionMint)
    log(`    Rallies: ${detail.rallies}`)
  } catch (e: any) {
    fail('Rally', e)
  }

  await sleep(500)

  // ================================================================
  // 13. Defect (agent 1 sells half)
  // ================================================================
  log('\n[13] Agent 1 defects (partial)')
  try {
    const sellAmount = Math.floor(tokensOut / 2)
    if (sellAmount < 1) {
      ok('Defect', 'skipped — no tokens')
    } else {
      const result = await defect(connection, {
        mint: factionMint,
        agent: agent1.publicKey,
        amount_tokens: sellAmount,
        message: 'Strategic withdrawal.',
        stronghold: agent1.publicKey,
      })
      await signAndSend(connection, agent1.keypair, result.transaction)
      ok('Defect', `sold ${sellAmount} tokens`)
    }
  } catch (e: any) {
    fail('Defect', e)
  }

  await sleep(500)

  // ================================================================
  // 14. Check members
  // ================================================================
  log('\n[14] Checking members')
  try {
    const members = await getMembers(connection, factionMint)
    ok('Members', `total=${members.total_members}`)
    for (const m of members.members.slice(0, 5)) {
      log(`    ${m.address.slice(0, 8)}... — ${m.percentage.toFixed(2)}%`)
    }
  } catch (e: any) {
    fail('Members', e)
  }

  // ================================================================
  // Summary
  // ================================================================
  const finalBalance = await connection.getBalance(wallet.publicKey)
  const solSpent = (balance - finalBalance) / LAMPORTS_PER_SOL

  console.log('\n' + '='.repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  console.log(`Faction mint: ${factionMint}`)
  console.log(`Vanity "py" suffix: ${isPyreMint(factionMint) ? 'YES' : 'NO'}`)
  console.log(`SOL spent: ${solSpent.toFixed(4)} SOL (${(finalBalance / LAMPORTS_PER_SOL).toFixed(2)} remaining)`)
  console.log('='.repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('\nFATAL:', e)
  process.exit(1)
})
