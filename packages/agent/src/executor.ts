import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { PyreKit } from 'pyre-world-kit'

import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision } from './types'
import { sendAndConfirm } from './tx'
import { sentimentBuySize } from './action'
import { parseCustomError } from './error'
import {
  generateFactionIdentity,
  FALLBACK_FACTION_NAMES,
  FALLBACK_FACTION_SYMBOLS,
} from './faction'
import { pendingScoutResults } from './agent'
import { isPyreMint } from 'pyre-world-kit'

const findFaction = (factions: FactionInfo[], mint?: string) =>
  factions.find((f) => f.mint === mint)

type ActionHandler = (
  kit: PyreKit,
  agent: AgentState,
  factions: FactionInfo[],
  decision: LLMDecision,
  log: (msg: string) => void,
  maxFoundedFactions: number,
  usedFactionNames: Set<string>,
  llm?: LLMAdapter,
) => Promise<string | null>

const vaultCreator = async (kit: PyreKit) =>
  (await kit.state.getVaultCreator()) ?? kit.state.state!.publicKey

const handlers: Record<string, ActionHandler> = {
  async join(kit, agent, factions, decision, log) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null
    const vc = await vaultCreator(kit)
    if (!vc) return null

    const sol =
      decision.sol ??
      sentimentBuySize(agent.personality, kit.state.getSentiment(faction.mint), [0.01, 0.1])
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

    const params: any = {
      mint: faction.mint,
      agent: agent.publicKey,
      amount_sol: lamports,
      message: decision.message,
      stronghold: vc,
      ascended: faction.status === 'ascended',
    }
    if (!kit.state.hasVoted(faction.mint)) {
      params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
    }

    let { result, confirm } = await kit.exec('actions', 'join', params)
    try {
      await sendAndConfirm(kit.connection, agent.keypair, result)
      await confirm()
    } catch (err: any) {
      const parsed = parseCustomError(err)
      if (parsed?.code === 6022) {
        // VoteRequired — retry with strategy
        params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
        const retry = await kit.exec('actions', 'join', params)
        await sendAndConfirm(kit.connection, agent.keypair, retry.result)
        await retry.confirm()
      } else {
        throw err
      }
    }

    kit.state.markVoted(faction.mint)
    agent.lastAction = `joined ${faction.mint.slice(-8)}`
    return `joined ${faction.mint.slice(-8)} for ${sol.toFixed(4)} SOL${decision.message ? ` — "${decision.message}"` : ''}`
  },

  async reinforce(kit, agent, factions, decision, log) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null
    const vc = await vaultCreator(kit)
    if (!vc) return null

    const balance = await kit.state.getBalance(faction.mint)
    if (balance <= 0) return null // can't reinforce what you don't hold

    const sol =
      decision.sol ??
      sentimentBuySize(agent.personality, kit.state.getSentiment(faction.mint), [0.01, 0.1])
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

    const params: any = {
      mint: faction.mint,
      agent: agent.publicKey,
      amount_sol: lamports,
      message: decision.message,
      stronghold: vc,
      ascended: faction.status === 'ascended',
    }

    const { result, confirm } = await kit.exec('actions', 'join', params)
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.lastAction = `reinforced ${faction.mint.slice(-8)}`
    return `reinforced ${faction.mint.slice(-8)} for ${sol.toFixed(4)} SOL${decision.message ? ` — "${decision.message}"` : ''}`
  },

  async defect(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null
    const vc = await vaultCreator(kit)
    if (!vc) return null

    const balance = await kit.state.getBalance(faction.mint)
    if (balance <= 0) return null

    const isInfiltrated = agent.infiltrated.has(faction.mint)
    const sellPortion = isInfiltrated
      ? 1.0
      : agent.personality === 'mercenary'
        ? 0.5 + Math.random() * 0.5
        : 0.2 + Math.random() * 0.3
    const sellAmount = Math.max(1, Math.floor(balance * sellPortion))

    const params = {
      mint: faction.mint,
      agent: agent.publicKey,
      amount_tokens: sellAmount,
      message: decision.message,
      stronghold: vc,
      ascended: faction.status === 'ascended',
    }

    let { result, confirm } = await kit.exec('actions', 'defect', params)
    try {
      await sendAndConfirm(kit.connection, agent.keypair, result)
      await confirm()
    } catch (err: any) {
      const p = parseCustomError(err)
      if (p?.code === 0x9c9) {
        // InsufficientFunds — retry with agent key as stronghold
        const retry = await kit.exec('actions', 'defect', {
          ...params,
          stronghold: agent.publicKey,
        })
        await sendAndConfirm(kit.connection, agent.keypair, retry.result)
        await retry.confirm()
      } else {
        throw err
      }
    }

    if ((await kit.state.getBalance(faction.mint)) <= 0) agent.infiltrated.delete(faction.mint)

    const prefix = isInfiltrated ? 'dumped (infiltration complete)' : 'defected from'
    agent.lastAction = `defected ${faction.mint.slice(-8)}`
    return `${prefix} ${faction.mint.slice(-8)}${decision.message ? ` — "${decision.message}"` : ''}`
  },

  async rally(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction || kit.state.hasRallied(faction.mint)) return null

    const { result, confirm } = await kit.exec('actions', 'rally', {
      mint: faction.mint,
      agent: agent.publicKey,
      stronghold: vaultCreator(kit),
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    kit.state.markRallied(faction.mint)
    agent.lastAction = `rallied ${faction.mint.slice(-8)}`
    return `rallied ${faction.mint.slice(-8)}`
  },

  async launch(kit, agent, factions, decision, log, maxFoundedFactions, usedFactionNames, llm) {
    const founded = kit.state.state?.founded ?? []
    if (founded.length >= maxFoundedFactions) return null

    let name: string | null = null
    let symbol: string | null = null
    const identity = await generateFactionIdentity(agent.personality, usedFactionNames, llm)
    if (identity) {
      name = identity.name
      symbol = identity.symbol
    } else {
      for (let i = 0; i < FALLBACK_FACTION_NAMES.length; i++) {
        if (!usedFactionNames.has(FALLBACK_FACTION_NAMES[i])) {
          name = FALLBACK_FACTION_NAMES[i]
          symbol = FALLBACK_FACTION_SYMBOLS[i]
          break
        }
      }
    }
    if (!name || !symbol) return null

    const { result, confirm } = await kit.exec('actions', 'launch', {
      founder: agent.publicKey,
      name,
      symbol,
      metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
      community_faction: true,
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    const mint = result.mint.toBase58()
    factions.push({ mint, name, symbol, status: 'rising' })
    usedFactionNames.add(name)
    agent.lastAction = `launched ${mint.slice(-8)}`
    return `launched [${symbol}] ${name} (${mint.slice(-8)})`
  },

  async message(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction || !decision.message) return null
    const vc = await vaultCreator(kit)
    if (!vc) return null

    const params: any = {
      mint: faction.mint,
      agent: agent.publicKey,
      message: decision.message,
      stronghold: vc,
      ascended: faction.status === 'ascended',
    }
    if (!kit.state.hasVoted(faction.mint)) {
      params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
    }

    let { result, confirm } = await kit.exec('actions', 'message', params)
    try {
      await sendAndConfirm(kit.connection, agent.keypair, result)
      await confirm()
    } catch (err: any) {
      const p = parseCustomError(err)
      if (p?.code === 6022) {
        params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
        const retry = await kit.exec('actions', 'message', params)
        await sendAndConfirm(kit.connection, agent.keypair, retry.result)
        await retry.confirm()
      } else {
        throw err
      }
    }

    kit.state.markVoted(faction.mint)
    agent.lastAction = `messaged ${faction.mint.slice(-8)}`
    return `said in ${faction.mint.slice(-8)}: "${decision.message}"`
  },

  async fud(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction || !decision.message) return null
    const vc = await vaultCreator(kit)
    if (!vc) return null

    if ((await kit.state.getBalance(faction.mint)) <= 0) return null

    const params = {
      mint: faction.mint,
      agent: agent.publicKey,
      message: decision.message,
      stronghold: vc,
      ascended: faction.status === 'ascended',
    }

    let { result, confirm } = await kit.exec('actions', 'fud', params)
    try {
      await sendAndConfirm(kit.connection, agent.keypair, result)
      await confirm()
    } catch (err: any) {
      const p = parseCustomError(err)
      if (p?.code === 0x9c9) {
        const retry = await kit.exec('actions', 'fud', { ...params, stronghold: agent.publicKey })
        await sendAndConfirm(kit.connection, agent.keypair, retry.result)
        await retry.confirm()
      } else {
        throw err
      }
    }

    if ((await kit.state.getBalance(faction.mint)) <= 0) {
      agent.infiltrated.delete(faction.mint)
      agent.lastAction = `defected ${faction.mint.slice(-8)}`
      return `fud cleared position in ${faction.mint.slice(-8)} → defected: "${decision.message}"`
    }

    agent.lastAction = `fud ${faction.mint.slice(-8)}`
    return `argued in ${faction.mint.slice(-8)}: "${decision.message}"`
  },

  async infiltrate(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null
    const vc = await vaultCreator(kit)
    if (!vc) return null

    const sol =
      decision.sol ??
      sentimentBuySize(agent.personality, kit.state.getSentiment(faction.mint), [0.01, 0.1]) * 1.5
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

    const params: any = {
      mint: faction.mint,
      agent: agent.publicKey,
      amount_sol: lamports,
      message: decision.message,
      stronghold: vc,
      ascended: faction.status === 'ascended',
    }
    if (!kit.state.hasVoted(faction.mint)) params.strategy = 'smelt'

    const { result, confirm } = await kit.exec('actions', 'join', params)
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.infiltrated.add(faction.mint)
    kit.state.markVoted(faction.mint)
    agent.lastAction = `infiltrated ${faction.mint.slice(-8)}`
    return `infiltrated ${faction.mint.slice(-8)} for ${sol.toFixed(4)} SOL${decision.message ? ` — "${decision.message}"` : ''}`
  },

  async war_loan(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null

    const balance = await kit.state.getBalance(faction.mint)
    if (balance <= 0) return null

    const collateral = Math.max(1, Math.floor(balance * (0.9 + Math.random() * 0.09)))
    let borrowLamports: number
    try {
      const quote = await kit.actions.getWarLoanQuote(faction.mint, collateral)
      if (quote.max_borrow_sol < 0.1 * LAMPORTS_PER_SOL) return null
      borrowLamports = Math.floor(quote.max_borrow_sol * (0.8 + Math.random() * 0.15))
    } catch {
      borrowLamports = Math.floor(0.1 * LAMPORTS_PER_SOL)
    }

    const { result, confirm } = await kit.exec('actions', 'requestWarLoan', {
      mint: faction.mint,
      borrower: agent.publicKey,
      collateral_amount: collateral,
      sol_to_borrow: borrowLamports,
      stronghold: vaultCreator(kit),
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.lastAction = `war loan ${faction.mint.slice(-8)}`
    return `took war loan on ${faction.mint.slice(-8)} (${collateral} tokens, ${(borrowLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`
  },

  async repay_loan(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null

    let loan
    try {
      loan = await kit.actions.getWarLoan(faction.mint, agent.publicKey)
    } catch {
      return null
    }
    if (loan.total_owed <= 0) return null

    const { result, confirm } = await kit.exec('actions', 'repayWarLoan', {
      mint: faction.mint,
      borrower: agent.publicKey,
      sol_amount: Math.ceil(loan.total_owed),
      stronghold: vaultCreator(kit),
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.lastAction = `repaid loan ${faction.mint.slice(-8)}`
    return `repaid war loan on ${faction.mint.slice(-8)} (${(loan.total_owed / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
  },

  async siege(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null

    let targetBorrower: string | null = null
    try {
      const allLoans = await kit.actions.getWarLoansForFaction(faction.mint)
      for (const pos of allLoans.positions) {
        if (pos.health === 'liquidatable') {
          targetBorrower = pos.borrower
          break
        }
      }
    } catch {
      return null
    }
    if (!targetBorrower) return null

    const { result, confirm } = await kit.exec('actions', 'siege', {
      mint: faction.mint,
      liquidator: agent.publicKey,
      borrower: targetBorrower,
      stronghold: vaultCreator(kit),
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.lastAction = `siege ${faction.mint.slice(-8)}`
    return `sieged ${targetBorrower.slice(0, 8)}... in ${faction.mint.slice(-8)} (liquidation)`
  },

  async ascend(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction || faction.status !== 'ready') return null

    const { result, confirm } = await kit.exec('actions', 'ascend', {
      mint: faction.mint,
      payer: agent.publicKey,
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    faction.status = 'ascended'
    agent.lastAction = `ascended ${faction.mint.slice(-8)}`
    return `ascended ${faction.mint.slice(-8)} to DEX`
  },

  async raze(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null

    const { result, confirm } = await kit.exec('actions', 'raze', {
      payer: agent.publicKey,
      mint: faction.mint,
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.lastAction = `razed ${faction.mint.slice(-8)}`
    return `razed ${faction.mint.slice(-8)} (reclaimed)`
  },

  async tithe(kit, agent, factions, decision) {
    const faction = findFaction(factions, decision.faction)
    if (!faction) return null

    const { result, confirm } = await kit.exec('actions', 'tithe', {
      mint: faction.mint,
      payer: agent.publicKey,
      harvest: true,
    })
    await sendAndConfirm(kit.connection, agent.keypair, result)
    await confirm()

    agent.lastAction = `tithed ${faction.mint.slice(-8)}`
    return `tithed ${faction.mint.slice(-8)} (harvested fees)`
  },

  async scout(kit, agent, factions, decision) {
    const target = decision.faction
    if (!target) return null

    const result = await kit.actions.scout(target)

    const existing = pendingScoutResults.get(agent.publicKey) ?? []
    existing.push(result)
    if (existing.length > 5) existing.shift()
    pendingScoutResults.set(agent.publicKey, existing)

    agent.lastAction = `scouted @${target.slice(0, 8)}`
    return `scouted @${target.slice(0, 8)}`
  },
}

export async function executeAction(
  kit: PyreKit,
  agent: AgentState,
  factions: FactionInfo[],
  decision: LLMDecision,
  brain: string,
  log: (msg: string) => void,
  maxFoundedFactions: number,
  usedFactionNames: Set<string>,
  llm?: LLMAdapter,
): Promise<{ success: boolean; description?: string; error?: string }> {
  const short = agent.publicKey.slice(0, 8)
  try {
    // (+) resolves to 'join' — reroute to 'reinforce' if agent already holds the faction
    let action = decision.action
    if (action === 'join' && decision.faction) {
      const faction = factions.find(f => f.mint === decision.faction || f.mint.endsWith(decision.faction!))
      if (faction) {
        const balance = await kit.state.getBalance(faction.mint)
        if (balance > 0) action = 'reinforce'
      }
    }

    const handler = handlers[action]
    if (!handler) return { success: false, error: `unknown action: ${action}` }

    const desc = await handler(
      kit,
      agent,
      factions,
      decision,
      log,
      maxFoundedFactions,
      usedFactionNames,
      llm,
    )
    if (!desc) return { success: false, error: 'action precondition not met' }

    log(`[${short}] [${agent.personality}] [${brain}] ${desc}`)
    return { success: true, description: desc }
  } catch (err: any) {
    const parsed = parseCustomError(err)
    if (parsed) {
      const factionObj = decision.faction ? findFaction(factions, decision.faction) : null
      const factionLabel = factionObj?.symbol ?? decision.faction?.slice(0, 8) ?? '?'
      log(
        `[${short}] [${agent.personality}] [${brain}] ERROR (${decision.action} ${factionLabel}): ${parsed.name} [0x${parsed.code.toString(16)}]`,
      )
      return { success: false, error: `${parsed.name} [0x${parsed.code.toString(16)}]` }
    }

    const msg = err.message?.slice(0, 120) ?? String(err)
    log(`[${short}] [${agent.personality}] [${brain}] ERROR (${decision.action}): ${msg}`)
    return { success: false, error: msg }
  }
}
