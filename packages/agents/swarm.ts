/**
 * Pyre Agent Swarm
 *
 * Runs autonomous agents with different personalities,
 * all interacting via pyre-world-kit. Runs forever.
 *
 * Usage:
 *   pnpm run keygen          # Generate wallets, outputs pubkeys to fund
 *   pnpm run status           # Check balances before starting
 *   pnpm run swarm            # Launch the swarm (devnet)
 *   pnpm run swarm:mainnet    # Launch the swarm (mainnet, 10 agents)
 *
 * Environment:
 *   TORCH_NETWORK=devnet|mainnet
 *   AGENT_COUNT=150           # Number of agents (default 150 devnet, 10 mainnet)
 *   RPC_URL=https://...       # RPC endpoint
 *   MIN_INTERVAL=1000         # Min ms between agent actions
 *   MAX_INTERVAL=2500         # Max ms between agent actions
 *   OLLAMA_URL=http://...     # Ollama API (default: http://localhost:11434)
 *   OLLAMA_MODEL=gemma3:4b    # Model name (default: gemma3:4b)
 *   LLM_ENABLED=true          # Enable LLM brain (default: true)
 */

if (!process.env.TORCH_NETWORK) process.env.TORCH_NETWORK = 'devnet'

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  createEphemeralAgent,
  launchFaction,
  joinFaction,
  defect,
  messageFaction,
  fudFaction,
  rally,
  getFactions,
  getFactionLeaderboard,
  getWorldStats,
  isPyreMint,
  // Stronghold
  createStronghold,
  getStronghold,
  fundStronghold,
  // DEX trading (post-migration)
  tradeOnDex,
  // War loans
  requestWarLoan,
  repayWarLoan,
  getWarLoan,
  getAllWarLoans,
  getMaxWarLoan,
  // Permissionless
  siege,
  ascend,
  raze,
  tithe,
  convertTithe,
  // Blacklist
  blacklistMints,
  isBlacklistedMint,
} from 'pyre-world-kit'
import type { WarLoan } from 'pyre-world-kit'
import * as fs from 'fs'
import * as path from 'path'
import { AgentState, FactionInfo, LLMDecision } from './src/types'
import { chooseAction, sentimentBuySize } from './src/action'
import { log, logGlobal, pick, randRange, sleep } from './src/util'
import { AGENT_COUNT, KEYS_FILE, LLM_ENABLED, MAX_INTERVAL, MIN_FUNDED_SOL, MIN_INTERVAL, OLLAMA_MODEL, OLLAMA_URL, RPC_URL, NETWORK, CONCURRENT_AGENTS, STRONGHOLD_FUND_SOL, FUND_TARGET_SOL } from './src/config'
import { llmDecide } from './src/agent'
import { assignPersonality, PERSONALITY_SOL } from './src/identity'
import { ensureStronghold } from './src/stronghold'
import { sendAndConfirm } from './src/tx'
import { FALLBACK_FACTION_NAMES, FALLBACK_FACTION_SYMBOLS, generateFactionIdentity } from './src/faction'
import { parseCustomError } from './src/error'
import { generateKeys, loadKeys, saveKeys } from './src/keys'
import { loadState, saveState } from './src/state'

// Global ring buffer of recent messages across all agents — prevents repetition
const RECENT_GLOBAL_MESSAGES: string[] = []
const MAX_GLOBAL_MESSAGES = 30

function recordGlobalMessage(msg: string) {
  if (!msg || msg.length < 3) return
  RECENT_GLOBAL_MESSAGES.push(msg.toLowerCase())
  if (RECENT_GLOBAL_MESSAGES.length > MAX_GLOBAL_MESSAGES) {
    RECENT_GLOBAL_MESSAGES.shift()
  }
}

let llmAvailable = LLM_ENABLED

// Periodically retry LLM if it was down
let llmRetryTick = 0
export async function maybeRetryLLM() {
  if (llmAvailable || !LLM_ENABLED) return
  llmRetryTick++
  if (llmRetryTick % 30 !== 0) return
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`)
    if (resp.ok) {
      llmAvailable = true
      logGlobal('Ollama reconnected — LLM brain active')
    }
  } catch { /* still down */ }
}


// ─── Agent Action Loop ───────────────────────────────────────────────

let factionNameIndex = 0
const usedFactionNames = new Set<string>()

async function agentTick(
  connection: Connection,
  agent: AgentState,
  knownFactions: FactionInfo[],
): Promise<void> {
  const short = agent.publicKey.slice(0, 8)

  // Try LLM decision first, fall back to weighted random
  let decision: LLMDecision | null = null
  let usedLLM = false

  if (llmAvailable && knownFactions.length > 0) {
    decision = await llmDecide(agent, knownFactions, connection, RECENT_GLOBAL_MESSAGES, llmAvailable)
    if (decision) usedLLM = true
  }

  // Fallback: weighted random, no canned messages (LLM generates all messages)
  if (!decision) {
    const canRally = knownFactions.some(f => !agent.rallied.has(f.mint))
    const action = chooseAction(agent.personality, agent, canRally, knownFactions)
    const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]

    decision = { action, sol: randRange(minSol, maxSol) }

    // Pick a target faction for the fallback
    if (action === 'join') {
      const f = knownFactions.length > 0 ? pick(knownFactions) : null
      if (!f) return
      decision.faction = f.symbol
      decision.sol = sentimentBuySize(agent, f.mint)
    } else if (action === 'message') {
      // No LLM = no message to send, skip
      return
    } else if (action === 'defect') {
      const infiltratedHeld = [...agent.holdings.entries()].filter(([m, b]) => b > 0 && agent.infiltrated.has(m))
      const regularHeld = [...agent.holdings.entries()].filter(([, b]) => b > 0)
      const held = infiltratedHeld.length > 0 ? infiltratedHeld : regularHeld
      if (held.length === 0) return
      const [mint] = pick(held)
      const f = knownFactions.find(ff => ff.mint === mint)
      if (!f) return
      decision.faction = f.symbol
    } else if (action === 'rally') {
      const eligible = knownFactions.filter(f => !agent.rallied.has(f.mint))
      if (eligible.length === 0) return
      decision.faction = pick(eligible).symbol
    } else if (action === 'war_loan' || action === 'repay_loan') {
      if (action === 'war_loan') {
        const held = [...agent.holdings.entries()].filter(([, b]) => b > 0)
        const heldAscended = held.filter(([mint]) => knownFactions.find(ff => ff.mint === mint)?.status === 'ascended')
        if (heldAscended.length === 0) return
        const [mint] = pick(heldAscended)
        const f = knownFactions.find(ff => ff.mint === mint)
        if (!f) return
        decision.faction = f.symbol
      } else {
        const loanMints = [...agent.activeLoans]
        if (loanMints.length === 0) return
        const mint = pick(loanMints)
        const f = knownFactions.find(ff => ff.mint === mint)
        if (!f) return
        decision.faction = f.symbol
      }
    } else if (action === 'ascend') {
      const ready = knownFactions.filter(f => f.status === 'ready')
      if (ready.length === 0) return
      decision.faction = pick(ready).symbol
    } else if (action === 'raze') {
      const razeable = knownFactions.filter(f => f.status === 'rising')
      if (razeable.length === 0) return
      const bearish = razeable.filter(f => (agent.sentiment.get(f.mint) ?? 0) < -2)
      decision.faction = (bearish.length > 0 ? pick(bearish) : pick(razeable)).symbol
    } else if (action === 'siege' || action === 'tithe') {
      if (knownFactions.length === 0) return
      if (action === 'siege') {
        const ascended = knownFactions.filter(f => f.status === 'ascended')
        if (ascended.length === 0) return
        const ascendedRivals = ascended.filter(f => !agent.holdings.has(f.mint))
        decision.faction = (ascendedRivals.length > 0 ? pick(ascendedRivals) : pick(ascended)).symbol
      } else {
        const bearish = knownFactions.filter(f => (agent.sentiment.get(f.mint) ?? 0) < -2)
        decision.faction = (bearish.length > 0 ? pick(bearish) : pick(knownFactions)).symbol
      }
    } else if (action === 'infiltrate') {
      const heldMints = [...agent.holdings.keys()]
      const rivals = knownFactions.filter(f => !heldMints.includes(f.mint))
      if (rivals.length === 0) return
      const target = pick(rivals)
      decision.faction = target.symbol
      decision.sol = sentimentBuySize(agent, target.mint) * 1.5
    } else if (action === 'fud') {
      // No LLM = no FUD message to send, skip
      return
    }
  }

  const action = decision.action
  const brain = usedLLM ? 'LLM' : 'RNG'

  try {
    switch (action) {
      case 'join': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const sol = decision.sol ?? sentimentBuySize(agent, faction.mint)
        const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

        if (faction.status === 'ascended') {
          // Post-migration: trade via stronghold on DEX
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return // failed to create

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: lamports,
            minimum_amount_out: 1,
            is_buy: true,
            message: decision.message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          // All buys go through vault (stronghold)
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const alreadyVoted = agent.voted.has(faction.mint)
          const params: any = {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_sol: lamports,
            message: decision.message,
            stronghold: agent.publicKey,
          }
          if (!alreadyVoted) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'scorched_earth'
          }
          const result = await joinFaction(connection, params)
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.voted.add(faction.mint)
        agent.lastAction = `joined ${faction.symbol}`
        const desc = `joined ${faction.symbol} for ${sol.toFixed(4)} SOL${decision.message ? ` — "${decision.message}"` : ''}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'defect': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        // Query real on-chain token balance (internal tracking is unreliable)
        let balance: number
        try {
          const mint = new PublicKey(faction.mint)
          const ata = getAssociatedTokenAddressSync(mint, new PublicKey(agent.publicKey), false, TOKEN_2022_PROGRAM_ID)
          const info = await connection.getTokenAccountBalance(ata)
          balance = Number(info.value.amount)
        } catch {
          // No token account — nothing to sell
          agent.holdings.delete(faction.mint)
          return
        }
        if (balance <= 0) {
          agent.holdings.delete(faction.mint)
          return
        }

        // Dump 100% on infiltrated factions, otherwise normal sell
        const isInfiltrated = agent.infiltrated.has(faction.mint)
        const sellPortion = isInfiltrated ? 1.0
          : agent.personality === 'mercenary' ? 0.5 + Math.random() * 0.5
          : 0.2 + Math.random() * 0.3
        const sellAmount = Math.max(1, Math.floor(balance * sellPortion))

        if (faction.status === 'ascended') {
          // Post-migration: sell via stronghold on DEX
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: sellAmount,
            minimum_amount_out: 1,
            is_buy: false,
            message: decision.message,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          const result = await defect(connection, {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_tokens: sellAmount,
            message: decision.message,
            stronghold: agent.publicKey,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const remaining = balance - sellAmount
        if (remaining <= 0) {
          agent.holdings.delete(faction.mint)
          agent.infiltrated.delete(faction.mint)
        } else {
          agent.holdings.set(faction.mint, remaining)
        }

        const prefix = isInfiltrated ? 'dumped (infiltration complete)' : 'defected from'
        agent.lastAction = `defected ${faction.symbol}`
        const desc = `${prefix} ${faction.symbol}${decision.message ? ` — "${decision.message}"` : ''}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${isInfiltrated ? '💣' : ''} ${desc}`)
        break
      }

      case 'rally': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction || agent.rallied.has(faction.mint)) return

        const result = await rally(connection, {
          mint: faction.mint,
          agent: agent.publicKey,
          stronghold: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.rallied.add(faction.mint)
        agent.lastAction = `rallied ${faction.symbol}`
        const desc = `rallied ${faction.symbol}`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'launch': {
        if (agent.founded.length >= 2) return

        // Generate faction name + symbol via LLM, fall back to static list
        let name: string | null = null
        let symbol: string | null = null

        const identity = await generateFactionIdentity(agent.personality, usedFactionNames, llmAvailable)
        if (identity) {
          name = identity.name
          symbol = identity.symbol
        } else {
          // Fallback to static list
          for (let attempts = 0; attempts < FALLBACK_FACTION_NAMES.length; attempts++) {
            const idx = factionNameIndex++ % FALLBACK_FACTION_NAMES.length
            if (!usedFactionNames.has(FALLBACK_FACTION_NAMES[idx])) {
              name = FALLBACK_FACTION_NAMES[idx]
              symbol = FALLBACK_FACTION_SYMBOLS[idx]
              break
            }
          }
        }
        if (!name || !symbol) return // all names used

        const result = await launchFaction(connection, {
          founder: agent.publicKey,
          name,
          symbol,
          metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
          community_faction: true,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        const mint = result.mint.toBase58()
        const vanity = isPyreMint(mint)

        agent.founded.push(mint)
        knownFactions.push({ mint, name, symbol, status: 'rising' })
        usedFactionNames.add(name)
        agent.lastAction = `launched ${symbol}`
        const desc = `launched [${symbol}] ${name} (${vanity ? 'py' : 'no-vanity'})`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'message': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const message = decision.message
        if (!message) return // no message to send without LLM

        if (!agent.hasStronghold) await ensureStronghold(connection, agent)
        if (!agent.hasStronghold) return

        const result = await messageFaction(connection, {
          mint: faction.mint,
          agent: agent.publicKey,
          message,
          stronghold: agent.publicKey,
          ascended: faction.status === 'ascended',
        })
        await sendAndConfirm(connection, agent.keypair, result)

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.lastAction = `messaged ${faction.symbol}`
        const desc = `said in ${faction.symbol}: "${message}"`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'stronghold': {
        if (agent.hasStronghold) return
        const result = await createStronghold(connection, { creator: agent.publicKey })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.hasStronghold = true

        // Fund it with some SOL
        const fundAmt = Math.floor(STRONGHOLD_FUND_SOL * LAMPORTS_PER_SOL)
        try {
          const fundResult = await fundStronghold(connection, {
            depositor: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_sol: fundAmt,
          })
          await sendAndConfirm(connection, agent.keypair, fundResult)
        } catch { /* fund failed, stronghold still created */ }

        agent.lastAction = 'created stronghold'
        const desc = `created stronghold + funded ${(fundAmt / LAMPORTS_PER_SOL).toFixed(1)} SOL`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'war_loan': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const balance = agent.holdings.get(faction.mint) ?? 0
        if (balance <= 0) return

        // Pledge nearly all tokens
        const collateralPortion = 0.90 + Math.random() * 0.09  // 90-99%
        const collateral = Math.max(1, Math.floor(balance * collateralPortion))

        // Use getMaxWarLoan to compute the correct borrow amount
        let borrowLamports: number
        try {
          const quote = await getMaxWarLoan(connection, faction.mint, collateral)
          if (quote.max_borrow_sol < 0.1 * LAMPORTS_PER_SOL) {
            // Below minimum borrow — skip
            agent.recentHistory.push(`loan too small on ${faction.symbol} — ${(quote.max_borrow_sol / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
            return
          }
          // Borrow 80-95% of max to stay healthy
          const borrowFraction = 0.80 + Math.random() * 0.15
          borrowLamports = Math.floor(quote.max_borrow_sol * borrowFraction)
        } catch {
          // Fallback: try minimum borrow
          borrowLamports = Math.floor(0.1 * LAMPORTS_PER_SOL)
        }

        if (!agent.hasStronghold) {
          await ensureStronghold(connection, agent)
        }

        const result = await requestWarLoan(connection, {
          mint: faction.mint,
          borrower: agent.publicKey,
          collateral_amount: collateral,
          sol_to_borrow: borrowLamports,
          stronghold: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.activeLoans.add(faction.mint)

        const borrowSol = borrowLamports / LAMPORTS_PER_SOL
        agent.lastAction = `war loan ${faction.symbol}`
        const desc = `took war loan on ${faction.symbol} (${collateral} tokens collateral, ${borrowSol.toFixed(3)} SOL)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'repay_loan': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction || !agent.activeLoans.has(faction.mint)) return

        // Check how much we owe
        let loan: WarLoan
        try {
          loan = await getWarLoan(connection, faction.mint, agent.publicKey)
        } catch { return }

        if (loan.total_owed <= 0) {
          agent.activeLoans.delete(faction.mint)
          return
        }

        const result = await repayWarLoan(connection, {
          mint: faction.mint,
          borrower: agent.publicKey,
          sol_amount: Math.ceil(loan.total_owed),
          stronghold: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        agent.activeLoans.delete(faction.mint)

        agent.lastAction = `repaid loan ${faction.symbol}`
        const desc = `repaid war loan on ${faction.symbol} (${(loan.total_owed / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'siege': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        // Find liquidatable loans on this faction
        let targetBorrower: string | null = null
        try {
          const allLoans = await getAllWarLoans(connection, faction.mint)
          for (const pos of allLoans.positions) {
            if (pos.health === 'liquidatable') {
              targetBorrower = pos.borrower
              break
            }
          }
        } catch { return }

        if (!targetBorrower) return

        const result = await siege(connection, {
          mint: faction.mint,
          liquidator: agent.publicKey,
          borrower: targetBorrower,
          stronghold: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        agent.lastAction = `siege ${faction.symbol}`
        const desc = `sieged ${targetBorrower.slice(0, 8)}... in ${faction.symbol} (liquidation)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'ascend': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction || faction.status !== 'ready') return

        const result = await ascend(connection, {
          mint: faction.mint,
          payer: agent.publicKey,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        faction.status = 'ascended'
        agent.lastAction = `ascended ${faction.symbol}`
        const desc = `ascended ${faction.symbol} to DEX`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'raze': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        const result = await raze(connection, {
          payer: agent.publicKey,
          mint: faction.mint,
        })
        await sendAndConfirm(connection, agent.keypair, result)

        agent.lastAction = `razed ${faction.symbol}`
        const desc = `razed ${faction.symbol} (reclaimed)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'tithe': {
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return

        // Try convertTithe first (harvest + swap to SOL), fall back to tithe
        try {
          const result = await convertTithe(connection, {
            mint: faction.mint,
            payer: agent.publicKey,
            harvest: true,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } catch {
          const result = await tithe(connection, {
            mint: faction.mint,
            payer: agent.publicKey,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        }

        agent.lastAction = `tithed ${faction.symbol}`
        const desc = `tithed ${faction.symbol} (harvested fees)`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }

      case 'infiltrate': {
        // Join a rival faction with big buy to pump it, mark for later dump
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const sol = decision.sol ?? sentimentBuySize(agent, faction.mint) * 1.5
        const lamports = Math.floor(sol * LAMPORTS_PER_SOL)
        const infiltrateMsg = decision.message

        if (faction.status === 'ascended') {
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const result = await tradeOnDex(connection, {
            mint: faction.mint,
            signer: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_in: lamports,
            minimum_amount_out: 1,
            is_buy: true,
            message: infiltrateMsg,
          })
          await sendAndConfirm(connection, agent.keypair, result)
        } else {
          if (!agent.hasStronghold) {
            await ensureStronghold(connection, agent)
          }
          if (!agent.hasStronghold) return

          const alreadyVoted = agent.voted.has(faction.mint)
          const params: any = {
            mint: faction.mint,
            agent: agent.publicKey,
            amount_sol: lamports,
            message: infiltrateMsg,
            stronghold: agent.publicKey,
          }
          if (!alreadyVoted) {
            params.strategy = 'scorched_earth' // always vote to burn
          }
          const result = await joinFaction(connection, params)
          await sendAndConfirm(connection, agent.keypair, result)
        }

        const prev = agent.holdings.get(faction.mint) ?? 0
        agent.holdings.set(faction.mint, prev + 1)
        agent.infiltrated.add(faction.mint)
        agent.voted.add(faction.mint)
        agent.sentiment.set(faction.mint, -5) // we're bearish, we're here to destroy

        agent.lastAction = `infiltrated ${faction.symbol}`
        const desc = `infiltrated ${faction.symbol} for ${sol.toFixed(4)} SOL — "${infiltrateMsg}"`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] 🗡️ ${desc}`)
        break
      }

      case 'fud': {
        // Micro sell + negative message — agent needs holdings to FUD
        const faction = knownFactions.find(f => f.symbol === decision!.faction)
        if (!faction) return
        const message = decision.message
        if (!message) return // FUD requires a message
        if (!agent.holdings.has(faction.mint)) return // need tokens to sell

        if (!agent.hasStronghold) await ensureStronghold(connection, agent)
        if (!agent.hasStronghold) return

        const result = await fudFaction(connection, {
          mint: faction.mint,
          agent: agent.publicKey,
          message,
          stronghold: agent.publicKey,
          ascended: faction.status === 'ascended',
        })
        await sendAndConfirm(connection, agent.keypair, result)

        agent.lastAction = `fud ${faction.symbol}`
        const desc = `argued in ${faction.symbol}: "${message}"`
        agent.recentHistory.push(desc)
        log(short, `[${agent.personality}] [${brain}] ${desc}`)
        break
      }
    }

    // Trim history
    if (agent.recentHistory.length > 10) {
      agent.recentHistory = agent.recentHistory.slice(-10)
    }

    // Record message globally to prevent cross-agent repetition
    if (decision?.message) recordGlobalMessage(decision.message)

    agent.actionCount++
  } catch (err: any) {
    const parsed = parseCustomError(err)
    if (parsed) {
      const factionSymbol = decision?.faction ?? '?'
      log(short, `[${agent.personality}] [${brain}] ERROR (${action} ${factionSymbol}): ${parsed.name} [0x${parsed.code.toString(16)}]`)

      // Adapt behavior based on error
      if (parsed.code === 6002 && decision?.faction) {
        // MaxWalletExceeded — already at 2% cap, don't try to buy more
        const faction = knownFactions.find(f => f.symbol === decision.faction)
        if (faction) agent.sentiment.set(faction.mint, (agent.sentiment.get(faction.mint) ?? 0) + 1)
      } else if (parsed.code === 6055) {
        // InsufficientVaultBalance — vault is dry, skip vault-funded actions for a while
        agent.recentHistory.push(`vault empty — need funds`)
      } else if (parsed.code === 6051) {
        // NotLiquidatable — no point retrying siege on this faction soon
        const faction = knownFactions.find(f => f.symbol === decision?.faction)
        if (faction) agent.sentiment.set(faction.mint, (agent.sentiment.get(faction.mint) ?? 0) + 2)
      } else if (parsed.code === 6046) {
        // LtvExceeded — tried to borrow too much, note it
        agent.recentHistory.push(`loan rejected on ${factionSymbol} — LTV too high`)
      } else if (parsed.code === 6049) {
        // BorrowTooSmall — need to borrow at least 0.1 SOL
        agent.recentHistory.push(`loan too small on ${factionSymbol} — min 0.1 SOL`)
      }
    } else {
      const msg = err.message?.slice(0, 120) ?? String(err)
      log(short, `[${agent.personality}] [${brain}] ERROR (${action}): ${msg}`)
    }
  }
}

// ─── Stats Reporter ──────────────────────────────────────────────────

async function reportStats(connection: Connection, agents: AgentState[], factions: FactionInfo[]) {
  logGlobal('─── Status Report ───')
  logGlobal(`Agents: ${agents.length} | Known factions: ${factions.length}`)

  const totalActions = agents.reduce((s, a) => s + a.actionCount, 0)
  const personalityCounts: Record<string, number> = {}
  for (const a of agents) {
    personalityCounts[a.personality] = (personalityCounts[a.personality] ?? 0) + 1
  }
  logGlobal(`Total actions: ${totalActions} | Personalities: ${JSON.stringify(personalityCounts)}`)

  try {
    const stats = await getWorldStats(connection)
    logGlobal(`World: ${stats.total_factions} factions, ${stats.rising_factions} rising, ${stats.total_sol_locked.toFixed(4)} SOL locked`)
    if (stats.most_powerful) {
      logGlobal(`Most powerful: [${stats.most_powerful.symbol}] ${stats.most_powerful.name} (score: ${stats.most_powerful.score.toFixed(2)})`)
    }
  } catch {
    // world stats may fail if no factions exist yet
  }

  try {
    const leaderboard = await getFactionLeaderboard(connection, { limit: 5 })
    if (leaderboard.length > 0) {
      logGlobal('Top factions:')
      for (let i = 0; i < leaderboard.length; i++) {
        const f = leaderboard[i]
        logGlobal(`  ${i + 1}. [${f.symbol}] ${f.name} — power: ${f.score.toFixed(2)}, members: ${f.members}`)
      }
    }
  } catch {
    // leaderboard may fail early
  }

  logGlobal('────────────────────')
}

// ─── Entrypoints ─────────────────────────────────────────────────────

async function keygen() {
  const existing = loadKeys()
  const needed = AGENT_COUNT - existing.length

  if (needed <= 0) {
    logGlobal(`Already have ${existing.length} keypairs (need ${AGENT_COUNT}). No new keys generated.`)
    console.log(`\nTo add more, set AGENT_COUNT higher than ${existing.length}`)
    return
  }

  logGlobal(`Found ${existing.length} existing keypairs, generating ${needed} more...`)
  const newKeys = generateKeys(needed)
  const keypairs = [...existing, ...newKeys]
  saveKeys(keypairs)

  console.log(`\nSaved ${keypairs.length} total keypairs to ${KEYS_FILE} (${needed} new)`)
  console.log(`\nNew addresses to fund with ${NETWORK} SOL:\n`)

  for (let i = existing.length; i < keypairs.length; i++) {
    const personality = assignPersonality(i)
    console.log(`  ${(i + 1).toString().padStart(3)}.  ${keypairs[i].publicKey.toBase58()}  (${personality})`)
  }

  console.log(`\nUse \`pnpm run fund${NETWORK === 'mainnet' ? ':mainnet' : ''}\` to batch-fund new agents with ${FUND_TARGET_SOL} SOL each.`)
  console.log()
}

async function status() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys found. Run `pnpm run keygen` first.')
    return
  }

  const connection = new Connection(RPC_URL, 'confirmed')
  logGlobal(`Checking ${keypairs.length} agent balances...`)

  let funded = 0
  let totalSol = 0
  for (let i = 0; i < keypairs.length; i++) {
    const balance = await connection.getBalance(keypairs[i].publicKey)
    const sol = balance / LAMPORTS_PER_SOL
    totalSol += sol
    const ok = sol >= MIN_FUNDED_SOL
    if (ok) funded++
    const marker = ok ? 'OK' : 'NEED SOL'
    console.log(`  ${(i + 1).toString().padStart(2)}. ${keypairs[i].publicKey.toBase58()} — ${sol.toFixed(4)} SOL [${marker}]`)
  }

  console.log(`\n${funded}/${keypairs.length} agents funded (${totalSol.toFixed(4)} SOL total)`)
  if (funded < keypairs.length) {
    console.log(`${keypairs.length - funded} agents need at least ${MIN_FUNDED_SOL} SOL each`)
  }
}

async function fund() {
  const keypairs = loadKeys()
  if (keypairs.length === 0) {
    console.log('No keys found. Run `pnpm run keygen` first.')
    return
  }

  const WALLET_PATH = process.env.WALLET_PATH ?? path.join(require('os').homedir(), '.config/solana/id.json')
  if (!fs.existsSync(WALLET_PATH)) {
    console.log(`Master wallet not found at ${WALLET_PATH}`)
    console.log('Copy your keypair: scp ~/.config/solana/id.json user@this-machine:~/.config/solana/id.json')
    console.log('Or set WALLET_PATH=/path/to/keypair.json')
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

  // Check each agent's balance and calculate top-up needed
  const needsFunding: { kp: Keypair; topUp: number; current: number }[] = []
  logGlobal('Checking agent balances...')

  for (const kp of keypairs) {
    const bal = await connection.getBalance(kp.publicKey)
    const currentSol = bal / LAMPORTS_PER_SOL
    if (bal < TARGET_LAMPORTS) {
      const topUp = TARGET_LAMPORTS - bal
      needsFunding.push({ kp, topUp, current: currentSol })
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
  const totalNeededSol = totalNeeded / LAMPORTS_PER_SOL
  logGlobal(`${needsFunding.length} agents need top-up (${totalNeededSol.toFixed(2)} SOL total)`)

  if (walletBalance < totalNeeded + 0.01 * LAMPORTS_PER_SOL) {
    logGlobal(`Not enough SOL. Need ~${totalNeededSol.toFixed(1)} SOL, have ${walletSol.toFixed(4)} SOL`)
    return
  }

  // Batch transfers — max 20 per tx to stay under size limits
  const BATCH_SIZE = 20
  let funded = 0

  for (let i = 0; i < needsFunding.length; i += BATCH_SIZE) {
    const batch = needsFunding.slice(i, i + BATCH_SIZE)
    const tx = new Transaction()

    for (const { kp, topUp } of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: kp.publicKey,
          lamports: topUp,
        })
      )
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
  logGlobal(`Action interval: ${MIN_INTERVAL / 1000}s - ${MAX_INTERVAL / 1000}s`)
  logGlobal(`LLM: ${LLM_ENABLED ? `${OLLAMA_MODEL} via ${OLLAMA_URL}` : 'disabled'}`)

  // Load prior state if resuming
  const priorState = loadState()
  const knownFactions: FactionInfo[] = [...priorState.factions]

  // Check which agents are funded
  logGlobal('Checking agent balances...')
  const agents: AgentState[] = []

  for (let i = 0; i < keypairs.length; i++) {
    const kp = keypairs[i]
    const pubkey = kp.publicKey.toBase58()
    const balance = await connection.getBalance(kp.publicKey)
    const sol = balance / LAMPORTS_PER_SOL

    if (sol < MIN_FUNDED_SOL) {
      logGlobal(`  Skipping ${pubkey.slice(0, 8)}... (${sol.toFixed(4)} SOL — need ${MIN_FUNDED_SOL})`)
      continue
    }

    const prior = priorState.agents.get(pubkey)
    const personality = prior?.personality ?? assignPersonality(i)

    agents.push({
      keypair: kp,
      publicKey: pubkey,
      personality,
      holdings: new Map(Object.entries(prior?.holdings ?? {})),
      founded: prior?.founded ?? [],
      rallied: new Set(prior?.rallied ?? []),
      voted: new Set(prior?.voted ?? []),
      hasStronghold: prior?.hasStronghold ?? false,
      activeLoans: new Set(prior?.activeLoans ?? []),
      infiltrated: new Set(prior?.infiltrated ?? []),
      sentiment: new Map(Object.entries(prior?.sentiment ?? {})),
      allies: new Set(prior?.allies ?? []),
      rivals: new Set(prior?.rivals ?? []),
      actionCount: prior?.actionCount ?? 0,
      lastAction: prior?.lastAction ?? 'none',
      recentHistory: prior?.recentHistory ?? [],
    })
  }

  if (agents.length === 0) {
    logGlobal(`No funded agents. Fund them with ${NETWORK} SOL first.`)
    process.exit(1)
  }

  logGlobal(`${agents.length} agents ready`)

  // Ensure all agents have strongholds (vault-routed operations require them)
  logGlobal('Ensuring all agents have strongholds...')
  let strongholdCount = 0
  for (const agent of agents) {
    if (!agent.hasStronghold) {
      await ensureStronghold(connection, agent)
      if (agent.hasStronghold) strongholdCount++
      await sleep(500) // stagger to avoid RPC hammering
    } else {
      strongholdCount++
    }
  }
  logGlobal(`${strongholdCount}/${agents.length} agents have strongholds`)

  // Blacklist old factions on devnet so agents start fresh (skip on mainnet — join real factions)
  if (NETWORK !== 'mainnet') {
    logGlobal('Blacklisting old factions...')
    try {
      const existing = await getFactions(connection, { limit: 200, sort: 'newest' })
      const oldMints = existing.factions.map(t => t.mint)
      if (oldMints.length > 0) {
        blacklistMints(oldMints)
        logGlobal(`Blacklisted ${oldMints.length} old factions`)
      }
    } catch (err: any) {
      logGlobal(`Could not fetch factions for blacklist: ${err.message?.slice(0, 80)}`)
    }
  }

  // Discover existing pyre factions on devnet (excludes blacklisted)
  logGlobal('Discovering existing factions...')
  try {
    const result = await getFactions(connection, { limit: 50, sort: 'newest' })
    for (const t of result.factions) {
      if (!isPyreMint(t.mint)) continue
      if (isBlacklistedMint(t.mint)) continue
      const existing = knownFactions.find(f => f.mint === t.mint)
      if (existing) {
        existing.status = t.status as FactionInfo['status']
      } else {
        knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
      }
      usedFactionNames.add(t.name)
    }
    logGlobal(`Found ${knownFactions.length} pyre factions`)
  } catch (err: any) {
    logGlobal(`Could not discover factions: ${err.message?.slice(0, 80)}`)
  }

  // If no factions exist, have a few agents launch some
  if (knownFactions.length === 0) {
    logGlobal('No factions found — launching initial factions...')
    const launchers = agents.slice(0, Math.min(3, agents.length))
    for (const agent of launchers) {
      const identity = await generateFactionIdentity(agent.personality, usedFactionNames, llmAvailable)
      const nameIdx = factionNameIndex++ % FALLBACK_FACTION_NAMES.length
      const name = identity?.name ?? FALLBACK_FACTION_NAMES[nameIdx]
      const symbol = identity?.symbol ?? FALLBACK_FACTION_SYMBOLS[nameIdx]
      try {
        const result = await launchFaction(connection, {
          founder: agent.publicKey,
          name,
          symbol,
          metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
          community_faction: true,
        })
        await sendAndConfirm(connection, agent.keypair, result)
        const mint = result.mint.toBase58()
        knownFactions.push({ mint, name, symbol, status: 'rising' })
        usedFactionNames.add(name)
        agent.founded.push(mint)
        logGlobal(`Launched [${symbol}] ${name} — ${mint.slice(0, 8)}...${mint.slice(-4)}`)
      } catch (err: any) {
        logGlobal(`Failed to launch ${name}: ${err.message?.slice(0, 80)}`)
      }
      await sleep(2000)
    }
  }

  // ─── Main Loop ───────────────────────────────────────────────────

  // Check if Ollama is available
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

  logGlobal('Swarm active. Press Ctrl+C to stop.\n')

  let tick = 0
  const REPORT_EVERY = 50 // report every N ticks
  const SAVE_EVERY = 20   // save state every N ticks
  const DISCOVERY_EVERY = 100 // re-scan factions every N ticks

  // Graceful shutdown
  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(1)
    stopping = true
    logGlobal('Shutting down... saving state...')
    saveState(agents, knownFactions)
    logGlobal('State saved. Goodbye.')
    process.exit(0)
  })

  while (!stopping) {
    // Pick N random agents and run them concurrently
    const batch: AgentState[] = []
    const used = new Set<number>()
    for (let i = 0; i < CONCURRENT_AGENTS && i < agents.length; i++) {
      let idx: number
      do { idx = Math.floor(Math.random() * agents.length) } while (used.has(idx) && used.size < agents.length)
      used.add(idx)
      batch.push(agents[idx])
    }

    await Promise.allSettled(
      batch.map(agent => agentTick(connection, agent, knownFactions))
    )

    tick++

    // Periodic saves
    if (tick % SAVE_EVERY === 0) {
      saveState(agents, knownFactions)
    }

    // Periodic status report
    if (tick % REPORT_EVERY === 0) {
      await reportStats(connection, agents, knownFactions)
    }

    // Periodic faction re-discovery
    if (tick % DISCOVERY_EVERY === 0) {
      try {
        const result = await getFactions(connection, { limit: 50, sort: 'newest' })
        for (const t of result.factions) {
          const existing = knownFactions.find(f => f.mint === t.mint)
          if (existing) {
            // Update status (e.g. rising → ready → ascended)
            const newStatus = t.status as FactionInfo['status']
            if (existing.status !== newStatus) {
              logGlobal(`[${existing.symbol}] status: ${existing.status} → ${newStatus}`)
              existing.status = newStatus
            }
          } else if (isPyreMint(t.mint) && !isBlacklistedMint(t.mint)) {
            knownFactions.push({ mint: t.mint, name: t.name, symbol: t.symbol, status: t.status as FactionInfo['status'] })
            usedFactionNames.add(t.name)
            logGlobal(`Discovered new faction: [${t.symbol}] ${t.name}`)
          }
        }
      } catch {
        // ignore discovery errors
      }
    }

    // Retry LLM if it was down
    await maybeRetryLLM()

    // Random delay between actions (stagger to avoid RPC hammering)
    const delay = randRange(MIN_INTERVAL, MAX_INTERVAL)
    await sleep(delay)
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
  case 'swarm': swarm().catch(console.error); break
}
