/**
 * Pyre Agent Swarm
 *
 * Runs autonomous agents with different personalities,
 * all interacting via PyreKit + pyre-agent-kit. Runs forever.
 *
 * Usage:
 *   pnpm run keygen          # Generate wallets, outputs pubkeys to fund
 *   pnpm run status           # Check balances before starting
 *   pnpm run swarm            # Launch the swarm (devnet)
 *   pnpm run swarm:mainnet    # Launch the swarm (mainnet)
 *
 * Environment:
 *   TORCH_NETWORK=devnet|mainnet
 *   AGENT_COUNT=150
 *   RPC_URL=https://...
 *   OLLAMA_URL=http://...
 *   OLLAMA_MODEL=gemma3:4b
 *   LLM_ENABLED=true
 */

if (!process.env.TORCH_NETWORK) process.env.TORCH_NETWORK = 'devnet'

import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js'
import * as path from 'path'
import * as os from 'os'
import { PyreKit, createEphemeralAgent, isPyreMint, isBlacklistedMint } from 'pyre-world-kit'
import { createPyreAgent, PyreAgent, FactionInfo, Personality } from 'pyre-agent-kit'
import * as fs from 'fs'

import { logGlobal, log, sleep, randRange } from './src/util'
import {
  AGENT_COUNT, KEYS_FILE, LLM_ENABLED, OLLAMA_MODEL, OLLAMA_URL,
  RPC_URL, NETWORK, CONCURRENT_AGENTS, FUND_TARGET_SOL, MIN_FUNDED_SOL,
  STRONGHOLD_FUND_SOL,
} from './src/config'
import { assignPersonality, PERSONALITY_INTERVALS, PERSONALITY_SOL } from './src/identity'
import { generateKeys, loadKeys, saveKeys } from './src/keys'
import { sendAndConfirm } from './src/tx'

// ─── LLM Adapter ─────────────────────────────────────────────────

let llmAvailable = LLM_ENABLED

async function ollamaGenerate(prompt: string): Promise<string | null> {
  if (!llmAvailable) return null
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    })
    if (!resp.ok) return null
    const data = await resp.json() as any
    return data.response?.trim() || null
  } catch {
    return null
  }
}

const llmAdapter = { generate: ollamaGenerate }

// ─── Entrypoints ─────────────────────────────────────────────────

async function keygen() {
  const existing = loadKeys()
  if (existing.length > 0) {
    console.log(`Found ${existing.length} existing keys in ${KEYS_FILE}`)
    console.log('Delete the file to regenerate.')
    return
  }

  const count = AGENT_COUNT
  console.log(`Generating ${count} agent keypairs...`)
  const keys = generateKeys(count)
  saveKeys(keys)
  console.log(`Saved to ${KEYS_FILE}\n`)
  console.log('Fund these wallets with SOL:')
  for (const kp of keys) {
    console.log(`  ${kp.publicKey.toBase58()}`)
  }
}

async function status() {
  const keys = loadKeys()
  if (keys.length === 0) {
    console.log('No keys. Run `pnpm run keygen` first.')
    return
  }

  const connection = new Connection(RPC_URL, 'confirmed')
  console.log(`Network: ${NETWORK}`)
  console.log(`Agents: ${keys.length}\n`)

  let totalSol = 0
  let funded = 0
  for (const kp of keys) {
    const balance = await connection.getBalance(kp.publicKey)
    const sol = balance / LAMPORTS_PER_SOL
    totalSol += sol
    if (sol >= MIN_FUNDED_SOL) funded++
    const status = sol >= MIN_FUNDED_SOL ? '✓' : '✗'
    console.log(`  ${status} ${kp.publicKey.toBase58().slice(0, 12)}... ${sol.toFixed(4)} SOL`)
  }
  console.log(`\n  ${funded}/${keys.length} funded, ${totalSol.toFixed(4)} SOL total`)
}

async function fund() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys. Run `pnpm run keygen` first.')
    return
  }

  const WALLET_PATH = process.env.WALLET_PATH ?? path.join(os.homedir(), '.config/solana/id.json')
  if (!fs.existsSync(WALLET_PATH)) {
    console.log(`Master wallet not found at ${WALLET_PATH}`)
    console.log('Set WALLET_PATH=/path/to/keypair.json or copy your keypair to ~/.config/solana/id.json')
    return
  }

  const walletRaw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletRaw))
  const connection = new Connection(RPC_URL, 'confirmed')

  const walletBalance = await connection.getBalance(wallet.publicKey)
  const walletSol = walletBalance / LAMPORTS_PER_SOL
  logGlobal(`Master wallet: ${wallet.publicKey.toBase58()}`)
  logGlobal(`Balance: ${walletSol.toFixed(4)} SOL`)

  const TARGET_SOL = FUND_TARGET_SOL
  const TARGET_LAMPORTS = TARGET_SOL * LAMPORTS_PER_SOL

  // Check each agent's balance
  const needsFunding: { kp: Keypair; topUp: number }[] = []
  logGlobal('Checking agent balances...')

  for (const kp of keypairs) {
    const bal = await connection.getBalance(kp.publicKey)
    const currentSol = bal / LAMPORTS_PER_SOL
    if (bal < TARGET_LAMPORTS) {
      const topUp = TARGET_LAMPORTS - bal
      needsFunding.push({ kp, topUp })
      console.log(`  ${kp.publicKey.toBase58().slice(0, 8)}...  ${currentSol.toFixed(2)} SOL  → needs ${(topUp / LAMPORTS_PER_SOL).toFixed(2)} SOL`)
    } else {
      console.log(`  ${kp.publicKey.toBase58().slice(0, 8)}...  ${currentSol.toFixed(2)} SOL  ✓`)
    }
  }

  if (needsFunding.length === 0) {
    logGlobal(`All ${keypairs.length} agents at ${TARGET_SOL}+ SOL`)
    return
  }

  const totalNeeded = needsFunding.reduce((sum, a) => sum + a.topUp, 0)
  logGlobal(`${needsFunding.length} agents need top-up (${(totalNeeded / LAMPORTS_PER_SOL).toFixed(2)} SOL total)`)

  if (walletBalance < totalNeeded + 0.01 * LAMPORTS_PER_SOL) {
    logGlobal(`Not enough SOL. Need ~${(totalNeeded / LAMPORTS_PER_SOL).toFixed(1)} SOL, have ${walletSol.toFixed(4)} SOL`)
    return
  }

  // Batch transfers — max 20 per tx to stay under size limits
  const BATCH_SIZE = 20
  let funded = 0

  for (let i = 0; i < needsFunding.length; i += BATCH_SIZE) {
    const batch = needsFunding.slice(i, i + BATCH_SIZE)
    const tx = new Transaction()

    for (const { kp, topUp } of batch) {
      tx.add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: kp.publicKey,
        lamports: topUp,
      }))
    }

    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = wallet.publicKey
    tx.partialSign(wallet)

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    })
    await connection.confirmTransaction(sig, 'confirmed')

    funded += batch.length
    logGlobal(`Funded ${funded}/${needsFunding.length} agents (tx: ${sig.slice(0, 16)}...)`)
  }

  const remaining = await connection.getBalance(wallet.publicKey)
  logGlobal(`Done. ${funded} agents topped up to ${TARGET_SOL} SOL each.`)
  logGlobal(`Master wallet remaining: ${(remaining / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
}

async function swarm() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys found. Run `pnpm run keygen` first.')
    process.exit(1)
  }

  const connection = new Connection(RPC_URL, 'confirmed')
  logGlobal(`Pyre Agent Swarm — ${NETWORK === 'mainnet' ? 'Mainnet' : 'Devnet'}`)
  logGlobal(`RPC: ${RPC_URL}`)
  logGlobal(`Agents: ${keypairs.length}`)
  logGlobal(`LLM: ${LLM_ENABLED ? `${OLLAMA_MODEL} via ${OLLAMA_URL}` : 'disabled'}`)

  // Check Ollama
  if (LLM_ENABLED) {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/tags`)
      if (resp.ok) {
        logGlobal(`Ollama connected — LLM brain active (${OLLAMA_MODEL})`)
      } else {
        llmAvailable = false
        logGlobal('Ollama not responding — starting with random fallback')
      }
    } catch {
      llmAvailable = false
      logGlobal(`Ollama not reachable at ${OLLAMA_URL} — starting with random fallback`)
    }
  }

  // Filter to funded agents
  logGlobal('Checking agent balances...')
  const fundedKeypairs: Keypair[] = []
  for (const kp of keypairs) {
    const balance = await connection.getBalance(kp.publicKey)
    if (balance / LAMPORTS_PER_SOL >= MIN_FUNDED_SOL) {
      fundedKeypairs.push(kp)
    }
  }

  if (fundedKeypairs.length === 0) {
    logGlobal('No funded agents. Fund them first.')
    process.exit(1)
  }
  logGlobal(`${fundedKeypairs.length} funded agents`)

  // Load saved agent state if available
  const stateFile = KEYS_FILE.replace('keys', 'state')
  let savedAgentStates: Record<string, any> = {}
  try {
    if (fs.existsSync(stateFile)) {
      savedAgentStates = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      logGlobal(`Restored state for ${Object.keys(savedAgentStates).length} agents`)
    }
  } catch {}

  // Ensure all agents have strongholds (vault-routed operations require them)
  logGlobal('Ensuring strongholds...')
  let vaultCount = 0
  for (const kp of fundedKeypairs) {
    const pubkey = kp.publicKey.toBase58()
    try {
      // Check if vault already exists
      const tempKit = new PyreKit(connection, pubkey)
      const existing = await tempKit.actions.getStrongholdForAgent(pubkey)

      if (existing) {
        vaultCount++
        continue
      }
      const createResult = await tempKit.actions.createStronghold({ creator: pubkey })
      const createTx = createResult.transaction
      createTx.partialSign(kp)
      const createSig = await connection.sendRawTransaction(createTx.serialize())
      await connection.confirmTransaction(createSig, 'confirmed')

      // Fund vault
      const fundSol = Math.floor(STRONGHOLD_FUND_SOL * LAMPORTS_PER_SOL)
      const fundResult = await tempKit.actions.fundStronghold({
        depositor: pubkey, stronghold_creator: pubkey, amount_sol: fundSol,
      })
      const fundTx = fundResult.transaction
      fundTx.partialSign(kp)
      const fundSig = await connection.sendRawTransaction(fundTx.serialize())
      await connection.confirmTransaction(fundSig, 'confirmed')

      vaultCount++
      log(pubkey.slice(0, 8), `vault created + funded ${STRONGHOLD_FUND_SOL} SOL`)
    } catch (err: any) {
      log(pubkey.slice(0, 8), `vault setup failed: ${err.message?.slice(0, 60)}`)
    }
    await sleep(300)
  }
  logGlobal(`${vaultCount}/${fundedKeypairs.length} agents have strongholds`)

  // Create a PyreKit + PyreAgent per funded keypair
  logGlobal('Initializing agents...')

  interface SwarmAgent {
    kit: PyreKit
    agent: PyreAgent
    keypair: Keypair
    personality: Personality
    nextTick: number
  }

  const swarmAgents: SwarmAgent[] = []

  for (let i = 0; i < fundedKeypairs.length; i++) {
    const kp = fundedKeypairs[i]
    const pubkey = kp.publicKey.toBase58()
    const savedState = savedAgentStates[pubkey]
    const personality = savedState?.agent?.personality ?? assignPersonality(i)

    try {
      const kit = new PyreKit(connection, pubkey)
      const agent = await createPyreAgent({
        kit,
        keypair: kp,
        llm: LLM_ENABLED ? llmAdapter : undefined,
        personality,
        solRange: PERSONALITY_SOL[personality],
        state: savedState?.agent,
        logger: (msg) => log(pubkey.slice(0, 8), msg),
      })

      // Hydrate kit state if saved
      if (savedState?.kit) {
        kit.state.hydrate(savedState.kit)
      }

      const [min, max] = PERSONALITY_INTERVALS[personality]
      swarmAgents.push({
        kit,
        agent,
        keypair: kp,
        personality,
        nextTick: Date.now() + randRange(0, max), // stagger initial ticks
      })

      // Register agent identity if not already registered
      try {
        const existingProfile = await kit.registry.getProfile(pubkey)
        if (!existingProfile) {
          const regResult = await kit.registry.register({ creator: pubkey })
          await sendAndConfirm(kit.connection, kp, regResult)
          log(pubkey.slice(0, 8), `registered pyre identity`)
        }
      } catch (e: any) {
        log(pubkey.slice(0, 8), `identity registration: ${e.message?.slice(0, 40)}`)
      }

      // Wire up on-chain checkpointing
      const CHECKPOINT_EVERY = 5
      kit.setCheckpointConfig({ interval: CHECKPOINT_EVERY })
      kit.onCheckpointDue = async () => {
        try {
          const gameState = kit.state.state!
          const counts = gameState.actionCounts
          let summary = personality as string

          // Try to generate a personality bio via LLM
          if (LLM_ENABLED && llmAvailable) {
            try {
              const topActions = Object.entries(counts)
                .filter(([, v]) => v > 0)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 4)
                .map(([n, v]) => `${n}:${v}`)
                .join(', ')
              const bioPrompt = `Write a 1-2 sentence first-person bio for an autonomous agent in a faction warfare game. Write as if the agent is introducing themselves. Use "I" and "my". Do NOT invent a name. Do NOT mention specific faction names or tickers — keep it general about who you are and how you play.\n\nPersonality archetype: ${personality}\nTop actions: ${topActions}\n\nBio (max 200 chars, no quotes, first person "I am...", do NOT use a name, do NOT reference specific factions):`
              const bio = await ollamaGenerate(bioPrompt)
              if (bio) {
                const buf = Buffer.from(bio.replace(/^["']+|["']+$/g, ''), 'utf8')
                summary = buf.length <= 256 ? bio.replace(/^["']+|["']+$/g, '') : buf.subarray(0, 256).toString('utf8').replace(/\uFFFD$/, '')
              }
            } catch {}
          }

          // Read on-chain profile and take max to avoid CounterNotMonotonic
          const profile = await kit.registry.getProfile(pubkey)
          const mx = (local: number, chain: number) => Math.max(local, chain)

          const cpResult = await kit.registry.checkpoint({
            signer: pubkey,
            creator: pubkey,
            joins: mx(counts.join, profile?.joins ?? 0),
            defects: mx(counts.defect, profile?.defects ?? 0),
            rallies: mx(counts.rally, profile?.rallies ?? 0),
            launches: mx(counts.launch, profile?.launches ?? 0),
            messages: mx(counts.message, profile?.messages ?? 0),
            fuds: mx(counts.fud, profile?.fuds ?? 0),
            infiltrates: mx(counts.infiltrate, profile?.infiltrates ?? 0),
            reinforces: mx(counts.reinforce, profile?.reinforces ?? 0),
            war_loans: mx(counts.war_loan, profile?.war_loans ?? 0),
            repay_loans: mx(counts.repay_loan, profile?.repay_loans ?? 0),
            sieges: mx(counts.siege, profile?.sieges ?? 0),
            ascends: mx(counts.ascend, profile?.ascends ?? 0),
            razes: mx(counts.raze, profile?.razes ?? 0),
            tithes: mx(counts.tithe, profile?.tithes ?? 0),
            personality_summary: summary,
            total_sol_spent: mx(gameState.totalSolSpent, profile?.total_sol_spent ?? 0),
            total_sol_received: mx(gameState.totalSolReceived, profile?.total_sol_received ?? 0),
          })
          await sendAndConfirm(kit.connection, kp, cpResult)
          const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
          log(pubkey.slice(0, 8), `checkpointed (tick ${kit.state.tick}, P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL)`)
        } catch (e: any) {
          log(pubkey.slice(0, 8), `checkpoint failed: ${e.message?.slice(0, 60)}`)
        }
      }

      log(pubkey.slice(0, 8), `${personality} — tick ${kit.state.tick}`)
    } catch (err: any) {
      log(pubkey.slice(0, 8), `init failed: ${err.message?.slice(0, 60)}`)
    }

    // Stagger init to avoid RPC hammering
    if (i % 5 === 4) await sleep(500)
  }

  logGlobal(`${swarmAgents.length} agents initialized`)

  // Discover factions
  const knownFactions: FactionInfo[] = []
  try {
    const shared = swarmAgents[0]?.kit
    if (shared) {
      const result = await shared.actions.getFactions({ sort: 'newest' })
      for (const t of result.factions) {
        if (isPyreMint(t.mint) && !isBlacklistedMint(t.mint)) {
          knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
        }
      }
      logGlobal(`Discovered ${knownFactions.length} factions`)
    }
  } catch {}

  // ─── Main Loop ───────────────────────────────────────────────────

  logGlobal('Swarm active. Press Ctrl+C to stop.\n')

  let tick = 0
  let stopping = false
  const SAVE_EVERY = 20
  const REPORT_EVERY = 50
  const DISCOVERY_EVERY = 100
  const consecutiveFailures = new Map<string, number>()

  process.on('SIGINT', () => {
    if (stopping) process.exit(1)
    stopping = true
    logGlobal('Shutting down... saving state...')
    saveSwarmState()
    logGlobal('State saved. Goodbye.')
    process.exit(0)
  })

  function saveSwarmState() {
    const states: Record<string, any> = {}
    for (const sa of swarmAgents) {
      states[sa.keypair.publicKey.toBase58()] = {
        agent: sa.agent.serialize(),
        kit: sa.kit.state.serialize(),
      }
    }
    fs.writeFileSync(stateFile, JSON.stringify(states, null, 2))
  }

  while (!stopping) {
    const now = Date.now()

    // Find agents ready to tick
    const ready = swarmAgents.filter(sa => {
      if (sa.nextTick > now) return false
      const failures = consecutiveFailures.get(sa.keypair.publicKey.toBase58()) ?? 0
      if (failures >= 10 && tick % 50 !== 0) return false // dormant
      return true
    })

    if (ready.length > 0) {
      // Shuffle and batch
      for (let i = ready.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ready[i], ready[j]] = [ready[j], ready[i]]
      }
      const batch = ready.slice(0, CONCURRENT_AGENTS)

      await Promise.allSettled(
        batch.map(async (sa) => {
          const pubkey = sa.keypair.publicKey.toBase58()
          try {
            const result = await sa.agent.tick(knownFactions)
            const status = result.success ? 'OK' : `FAIL: ${result.error}`
            const brain = result.usedLLM ? 'LLM' : 'RNG'
            const msg = result.message ? ` "${result.message}"` : ''
            log(pubkey.slice(0, 8), `[${brain}] ${result.action.toUpperCase()} ${result.faction?.slice(0, 8) ?? ''}${msg} — ${status}`)

            if (result.success) {
              consecutiveFailures.set(pubkey, 0)
            } else {
              consecutiveFailures.set(pubkey, (consecutiveFailures.get(pubkey) ?? 0) + 1)
            }
          } catch (err: any) {
            log(pubkey.slice(0, 8), `ERROR: ${err.message?.slice(0, 80)}`)
            consecutiveFailures.set(pubkey, (consecutiveFailures.get(pubkey) ?? 0) + 1)
          }
        })
      )

      // Schedule next tick per personality
      for (const sa of batch) {
        const [min, max] = PERSONALITY_INTERVALS[sa.personality]
        sa.nextTick = Date.now() + randRange(min, max)
      }

      tick++

      // Periodic save
      if (tick % SAVE_EVERY === 0) saveSwarmState()

      // Periodic report
      if (tick % REPORT_EVERY === 0) {
        const totalTicks = swarmAgents.reduce((sum, sa) => sum + sa.kit.state.tick, 0)
        const active = swarmAgents.filter(sa => (consecutiveFailures.get(sa.keypair.publicKey.toBase58()) ?? 0) < 10).length
        logGlobal(`tick ${tick} — ${active}/${swarmAgents.length} active, ${totalTicks} total agent actions, ${knownFactions.length} factions`)
      }

      // Periodic faction re-discovery
      if (tick % DISCOVERY_EVERY === 0) {
        try {
          const result = await swarmAgents[0].kit.actions.getFactions({ sort: 'newest' })
          for (const t of result.factions) {
            if (!isPyreMint(t.mint) || isBlacklistedMint(t.mint)) continue
            const existing = knownFactions.find(f => f.mint === t.mint)
            if (existing) {
              const newStatus = t.status as FactionInfo['status']
              if (existing.status !== newStatus) {
                logGlobal(`[${existing.symbol}] status: ${existing.status} → ${newStatus}`)
                existing.status = newStatus
              }
            } else {
              knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
              logGlobal(`Discovered: [${t.symbol}] ${t.name}`)
            }
          }
        } catch {}
      }

      // Periodic personality evolution
      if (tick % 500 === 0 && tick > 0) {
        let evolved = 0
        for (const sa of swarmAgents) {
          const didEvolve = await sa.agent.evolve()
          if (didEvolve) {
            sa.personality = sa.agent.personality as Personality
            const [min, max] = PERSONALITY_INTERVALS[sa.personality]
            sa.nextTick = Date.now() + randRange(min, max)
            evolved++
          }
        }
        if (evolved > 0) logGlobal(`Personality evolution: ${evolved} agents evolved at tick ${tick}`)
      }
    }

    // Sleep until next agent is due
    const nextDue = Math.min(...swarmAgents.map(sa => sa.nextTick))
    const sleepMs = Math.max(1000, nextDue - Date.now())
    await sleep(sleepMs)
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────

const mode = process.argv.includes('--keygen') ? 'keygen'
  : process.argv.includes('--status') ? 'status'
  : process.argv.includes('--fund') ? 'fund'
  : 'swarm'

switch (mode) {
  case 'keygen': keygen().catch(console.error); break
  case 'status': status().catch(console.error); break
  case 'fund': fund().catch(console.error); break
  default: swarm().catch(console.error); break
}
