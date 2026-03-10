/**
 * Pyre Agent Kit E2E Test
 *
 * Tests creating agents, linking LLM adapters, running ticks,
 * serializing/restoring state, and executing basic actions.
 *
 * Prerequisites:
 *   surfpool start --network mainnet --no-tui
 *
 * Run:
 *   pnpm test  (or: npx tsx tests/test_e2e.ts)
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js'
import {
  createEphemeralAgent,
  launchFaction,
  createStronghold,
  fundStronghold,
} from 'pyre-world-kit'

import { createPyreAgent, LLMAdapter, PyreAgentConfig, FactionInfo } from '../src/index'

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899'

// ─── Helpers ──────────────────────────────────────────────────────

let passed = 0
let failed = 0

const log = (msg: string) => {
  const ts = new Date().toISOString().substr(11, 8)
  console.log(`[${ts}] ${msg}`)
}

const ok = (name: string, detail?: string) => {
  passed++
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}

const fail = (name: string, err: any) => {
  failed++
  log(`  ✗ ${name} — ${err.message || err}`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function sendAndConfirm(connection: Connection, agent: ReturnType<typeof createEphemeralAgent>, result: any) {
  const tx = result.transaction
  const signed = agent.sign(tx)
  const sig = await connection.sendRawTransaction(signed.serialize())
  await connection.confirmTransaction(sig, 'confirmed')
  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      const addlSigned = agent.sign(addlTx)
      const addlSig = await connection.sendRawTransaction(addlSigned.serialize())
      await connection.confirmTransaction(addlSig, 'confirmed')
    }
  }
  return sig
}

// ─── Mock LLM ─────────────────────────────────────────────────────

/** Mock LLM that returns a scripted response based on available factions */
function createMockLLM(responses: string[]): LLMAdapter & { calls: string[] } {
  let idx = 0
  const calls: string[] = []
  return {
    calls,
    generate: async (prompt: string) => {
      calls.push(prompt)
      if (idx < responses.length) return responses[idx++]
      return null
    },
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')
  console.log('='.repeat(60))
  console.log('PYRE AGENT KIT — E2E TEST')
  console.log(`RPC: ${RPC_URL}`)
  console.log('='.repeat(60))

  // ================================================================
  // 1. Setup: create ephemeral wallets, airdrop, launch a faction
  // ================================================================
  log('\n[1] Setup — creating wallets and faction')

  const wallet1 = createEphemeralAgent()
  const wallet2 = createEphemeralAgent()
  log(`  Wallet 1: ${wallet1.publicKey}`)
  log(`  Wallet 2: ${wallet2.publicKey}`)

  // Airdrop
  const [sig1, sig2] = await Promise.all([
    connection.requestAirdrop(wallet1.keypair.publicKey, 10 * LAMPORTS_PER_SOL),
    connection.requestAirdrop(wallet2.keypair.publicKey, 5 * LAMPORTS_PER_SOL),
  ])
  await Promise.all([
    connection.confirmTransaction(sig1, 'confirmed'),
    connection.confirmTransaction(sig2, 'confirmed'),
  ])
  ok('Airdrops', '10 SOL + 5 SOL')

  // Create stronghold for wallet1 so faction launch works
  const shResult = await createStronghold(connection, { creator: wallet1.publicKey })
  await sendAndConfirm(connection, wallet1, shResult)
  const fundResult = await fundStronghold(connection, {
    depositor: wallet1.publicKey,
    stronghold_creator: wallet1.publicKey,
    amount_sol: 5 * LAMPORTS_PER_SOL,
  })
  await sendAndConfirm(connection, wallet1, fundResult)
  ok('Stronghold created + funded')

  // Launch a test faction
  const launchResult = await launchFaction(connection, {
    founder: wallet1.publicKey,
    name: 'Test Vanguard',
    symbol: 'TSTV',
    metadata_uri: 'https://pyre.gg/factions/tstv.json',
    community_faction: true,
  })
  await sendAndConfirm(connection, wallet1, launchResult)
  const factionMint = launchResult.mint.toBase58()
  ok('Faction launched', `mint=${factionMint.slice(0, 8)}...`)

  // Build faction info for passing to agents
  const testFactions: FactionInfo[] = [
    { mint: factionMint, name: 'Test Vanguard', symbol: 'TSTV', status: 'rising' },
  ]

  await sleep(500)

  // ================================================================
  // 2. Create agent WITHOUT LLM (random fallback)
  // ================================================================
  log('\n[2] Create agent without LLM')
  try {
    const agent = await createPyreAgent({
      connection,
      keypair: wallet2.keypair,
      network: 'devnet',
      personality: 'mercenary',
      logger: (msg) => log(`    ${msg}`),
    })
    ok('Agent created', `pubkey=${agent.publicKey.slice(0, 8)} personality=${agent.personality}`)

    if (agent.personality !== 'mercenary') {
      fail('Personality override', { message: `expected mercenary, got ${agent.personality}` })
    } else {
      ok('Personality override')
    }
  } catch (e: any) {
    fail('Create agent (no LLM)', e)
  }

  // ================================================================
  // 3. Create agent WITH mock LLM
  // ================================================================
  log('\n[3] Create agent with mock LLM')
  let agentWithLLM: Awaited<ReturnType<typeof createPyreAgent>> | null = null
  const mockLLM = createMockLLM([
    `JOIN TSTV "deploying capital, first move"`,
    `MESSAGE TSTV "testing comms from the kit"`,
    `DEFECT TSTV "strategic withdrawal"`,
    `FUD TSTV "this faction is overvalued"`,
    `RALLY TSTV`,
  ])

  try {
    agentWithLLM = await createPyreAgent({
      connection,
      keypair: wallet1.keypair,
      network: 'devnet',
      llm: mockLLM,
      personality: 'provocateur',
      logger: (msg) => log(`    ${msg}`),
    })
    ok('Agent created with LLM', `pubkey=${agentWithLLM.publicKey.slice(0, 8)} personality=${agentWithLLM.personality}`)
  } catch (e: any) {
    fail('Create agent (with LLM)', e)
  }

  if (!agentWithLLM) {
    console.error('Cannot continue without LLM agent. Exiting.')
    process.exit(1)
  }

  // ================================================================
  // 4. Tick: JOIN via LLM
  // ================================================================
  log('\n[4] Tick — LLM JOIN')
  try {
    const result = await agentWithLLM.tick(testFactions)
    if (result.success) {
      ok('JOIN tick', `action=${result.action} faction=${result.faction} usedLLM=${result.usedLLM}`)
    } else {
      fail('JOIN tick', { message: result.error })
    }
  } catch (e: any) {
    fail('JOIN tick', e)
  }

  await sleep(500)

  // ================================================================
  // 5. Tick: MESSAGE via LLM
  // ================================================================
  log('\n[5] Tick — LLM MESSAGE')
  try {
    const result = await agentWithLLM.tick(testFactions)
    if (result.success) {
      ok('MESSAGE tick', `action=${result.action} message="${result.message}"`)
    } else {
      fail('MESSAGE tick', { message: result.error })
    }
  } catch (e: any) {
    fail('MESSAGE tick', e)
  }

  await sleep(500)

  // ================================================================
  // 6. Tick: DEFECT via LLM
  // ================================================================
  log('\n[6] Tick — LLM DEFECT')
  try {
    const result = await agentWithLLM.tick(testFactions)
    if (result.success) {
      ok('DEFECT tick', `action=${result.action} faction=${result.faction}`)
    } else {
      // Defect may fail if no real token balance — that's ok
      ok('DEFECT tick', `expected failure: ${result.error}`)
    }
  } catch (e: any) {
    fail('DEFECT tick', e)
  }

  await sleep(500)

  // ================================================================
  // 7. Tick: FUD via LLM
  // ================================================================
  log('\n[7] Tick — LLM FUD')
  try {
    const result = await agentWithLLM.tick(testFactions)
    if (result.success) {
      ok('FUD tick', `action=${result.action} message="${result.message}"`)
    } else {
      ok('FUD tick', `expected failure (may lack holdings): ${result.error}`)
    }
  } catch (e: any) {
    fail('FUD tick', e)
  }

  await sleep(500)

  // ================================================================
  // 8. Tick: RALLY via LLM
  // ================================================================
  log('\n[8] Tick — LLM RALLY')
  try {
    const result = await agentWithLLM.tick(testFactions)
    if (result.success) {
      ok('RALLY tick', `action=${result.action} faction=${result.faction}`)
    } else {
      // Rally can fail if agent is the faction founder ("cannot star your own token")
      ok('RALLY tick', `expected failure: ${result.error}`)
    }
  } catch (e: any) {
    fail('RALLY tick', e)
  }

  // ================================================================
  // 9. Verify LLM was called
  // ================================================================
  log('\n[9] Verify LLM adapter was called')
  if (mockLLM.calls.length >= 5) {
    ok('LLM calls', `${mockLLM.calls.length} prompts sent`)
  } else {
    fail('LLM calls', { message: `expected >=5 calls, got ${mockLLM.calls.length}` })
  }

  // Verify prompts contain expected content
  const firstPrompt = mockLLM.calls[0] ?? ''
  if (firstPrompt.includes('TSTV') && firstPrompt.includes('provocateur')) {
    ok('Prompt content', 'includes faction symbol + personality')
  } else {
    fail('Prompt content', { message: 'missing expected prompt content' })
  }

  // ================================================================
  // 10. Serialize + restore state
  // ================================================================
  log('\n[10] Serialize and restore state')
  try {
    const serialized = agentWithLLM.serialize()

    // Verify serialized fields
    if (serialized.publicKey !== agentWithLLM.publicKey) {
      fail('Serialize pubkey', { message: 'mismatch' })
    } else {
      ok('Serialize pubkey')
    }

    if (serialized.personality !== 'provocateur') {
      fail('Serialize personality', { message: `expected provocateur, got ${serialized.personality}` })
    } else {
      ok('Serialize personality')
    }

    if (serialized.actionCount < 1) {
      fail('Serialize actionCount', { message: `expected >=1, got ${serialized.actionCount}` })
    } else {
      ok('Serialize actionCount', `${serialized.actionCount} actions`)
    }

    if (serialized.recentHistory.length < 1) {
      fail('Serialize history', { message: 'empty history' })
    } else {
      ok('Serialize history', `${serialized.recentHistory.length} entries`)
    }

    // Restore from serialized state with a new mock LLM
    const restoreLLM = createMockLLM([`JOIN TSTV "restored agent reporting"`])
    const restoredAgent = await createPyreAgent({
      connection,
      keypair: wallet1.keypair,
      network: 'devnet',
      llm: restoreLLM,
      state: serialized,
      logger: (msg) => log(`    ${msg}`),
    })

    if (restoredAgent.personality !== serialized.personality) {
      fail('Restore personality', { message: 'mismatch after restore' })
    } else {
      ok('Restore personality')
    }

    const restoredState = restoredAgent.getState()
    if (restoredState.actionCount !== serialized.actionCount) {
      fail('Restore actionCount', { message: `expected ${serialized.actionCount}, got ${restoredState.actionCount}` })
    } else {
      ok('Restore actionCount')
    }

    if (restoredState.hasStronghold !== serialized.hasStronghold) {
      fail('Restore stronghold', { message: 'mismatch' })
    } else {
      ok('Restore stronghold flag')
    }
  } catch (e: any) {
    fail('Serialize/restore', e)
  }

  // ================================================================
  // 11. Tick without LLM (random fallback)
  // ================================================================
  log('\n[11] Tick — random fallback (no LLM)')
  try {
    const noLLMAgent = await createPyreAgent({
      connection,
      keypair: wallet2.keypair,
      network: 'devnet',
      personality: 'whale',
      logger: (msg) => log(`    ${msg}`),
    })

    const result = await noLLMAgent.tick(testFactions)
    if (result.usedLLM) {
      fail('Random fallback', { message: 'should not use LLM' })
    } else {
      ok('Random fallback', `action=${result.action} success=${result.success}${result.error ? ` error=${result.error}` : ''}`)
    }
  } catch (e: any) {
    fail('Random fallback tick', e)
  }

  // ================================================================
  // 12. getState() returns mutable state
  // ================================================================
  log('\n[12] getState() access')
  try {
    const state = agentWithLLM.getState()
    if (state.publicKey === agentWithLLM.publicKey) {
      ok('getState pubkey')
    } else {
      fail('getState pubkey', { message: 'mismatch' })
    }

    if (state.personality === 'provocateur') {
      ok('getState personality')
    } else {
      fail('getState personality', { message: `expected provocateur, got ${state.personality}` })
    }

    // Verify holdings map exists (may or may not have entries)
    if (state.holdings instanceof Map) {
      ok('getState holdings', `${state.holdings.size} factions held`)
    } else {
      fail('getState holdings', { message: 'not a Map' })
    }
  } catch (e: any) {
    fail('getState', e)
  }

  // ================================================================
  // 13. Custom solRange override
  // ================================================================
  log('\n[13] Custom solRange override')
  try {
    const customLLM = createMockLLM([`JOIN TSTV "tiny buy"`])
    const customAgent = await createPyreAgent({
      connection,
      keypair: wallet2.keypair,
      network: 'devnet',
      llm: customLLM,
      personality: 'scout',
      solRange: [0.001, 0.002],
      logger: (msg) => log(`    ${msg}`),
    })

    // The prompt should include our custom range
    const result = await customAgent.tick(testFactions)
    const prompt = customLLM.calls[0] ?? ''
    if (prompt.includes('min 0.001') && prompt.includes('max 0.002')) {
      ok('solRange in prompt', 'min 0.001 / max 0.002')
    } else {
      fail('solRange in prompt', { message: 'custom range not found in prompt' })
    }
  } catch (e: any) {
    fail('Custom solRange', e)
  }

  // ================================================================
  // Summary
  // ================================================================
  console.log('\n' + '='.repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  console.log('='.repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('\nFATAL:', e)
  process.exit(1)
})
