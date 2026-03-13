import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  launchFaction, joinFaction, defect, messageFaction, fudFaction, rally,
  tradeOnDex, fundStronghold,
  requestWarLoan, repayWarLoan, getWarLoan, getAllWarLoans, getMaxWarLoan,
  siege, ascend, raze, tithe, convertTithe, isPyreMint,
} from 'pyre-world-kit'
import type { WarLoan } from 'pyre-world-kit'

import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision } from './types'
import { PERSONALITY_SOL } from './defaults'
import { sendAndConfirm } from './tx'
import { ensureStronghold } from './stronghold'
import { sentimentBuySize } from './action'
import { parseCustomError } from './error'
import { generateFactionIdentity, FALLBACK_FACTION_NAMES, FALLBACK_FACTION_SYMBOLS } from './faction'
import { executeScout, pendingScoutResults } from './agent'

interface ExecutorContext {
  connection: Connection
  agent: AgentState
  factions: FactionInfo[]
  decision: LLMDecision
  brain: string
  log: (msg: string) => void
  llm?: LLMAdapter
  maxFoundedFactions: number
  usedFactionNames: Set<string>
  strongholdOpts?: { fundSol?: number, topupThresholdSol?: number, topupReserveSol?: number }
}

type ActionHandler = (ctx: ExecutorContext) => Promise<string | null>

const findFaction = (factions: FactionInfo[], mint?: string) =>
  factions.find(f => f.mint === mint)

/** Fetch real on-chain token balance. Returns 0 if no ATA or error. */
async function getOnChainBalance(connection: Connection, mint: string, owner: string): Promise<number> {
  try {
    const mintPk = new PublicKey(mint)
    const ata = getAssociatedTokenAddressSync(mintPk, new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID)
    const info = await connection.getTokenAccountBalance(ata)
    return Number(info.value.amount)
  } catch {
    return 0
  }
}

/** Vault creator key — may differ from agent key for linked vaults */
const vault = (agent: AgentState) => agent.vaultCreator ?? agent.publicKey

const handlers: Record<Action, ActionHandler> = {
  async join(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null
    const sol = ctx.decision.sol ?? sentimentBuySize(ctx.agent, faction.mint)
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

    await ensureStronghold(ctx.connection, ctx.agent, ctx.log, ctx.strongholdOpts)
    if (!ctx.agent.hasStronghold) return null

    if (faction.status === 'ascended') {
      const result = await tradeOnDex(ctx.connection, {
        mint: faction.mint, signer: ctx.agent.publicKey, stronghold_creator: vault(ctx.agent),
        amount_in: lamports, minimum_amount_out: 1, is_buy: true, message: ctx.decision.message,
      })
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    } else {
      const alreadyVoted = ctx.agent.voted.has(faction.mint)
      const params: any = {
        mint: faction.mint, agent: ctx.agent.publicKey, amount_sol: lamports,
        message: ctx.decision.message, stronghold: vault(ctx.agent),
      }
      if (!alreadyVoted) params.strategy = Math.random() > 0.5 ? 'fortify' : 'scorched_earth'
      const result = await joinFaction(ctx.connection, params)
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    }

    const newBal = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    ctx.agent.holdings.set(faction.mint, newBal > 0 ? newBal : 1)
    ctx.agent.voted.add(faction.mint)
    ctx.agent.lastAction = `joined ${faction.symbol}`
    return `joined ${faction.symbol} for ${sol.toFixed(4)} SOL${ctx.decision.message ? ` — "${ctx.decision.message}"` : ''}`
  },

  async defect(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null

    const balance = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    if (balance <= 0) { ctx.agent.holdings.delete(faction.mint); return null }

    const isInfiltrated = ctx.agent.infiltrated.has(faction.mint)
    const sellPortion = isInfiltrated ? 1.0
      : ctx.agent.personality === 'mercenary' ? 0.5 + Math.random() * 0.5
      : 0.2 + Math.random() * 0.3
    const sellAmount = Math.max(1, Math.floor(balance * sellPortion))

    if (faction.status === 'ascended') {
      await ensureStronghold(ctx.connection, ctx.agent, ctx.log, ctx.strongholdOpts)
      if (!ctx.agent.hasStronghold) return null
      const result = await tradeOnDex(ctx.connection, {
        mint: faction.mint, signer: ctx.agent.publicKey, stronghold_creator: vault(ctx.agent),
        amount_in: sellAmount, minimum_amount_out: 1, is_buy: false, message: ctx.decision.message,
      })
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    } else {
      const result = await defect(ctx.connection, {
        mint: faction.mint, agent: ctx.agent.publicKey, amount_tokens: sellAmount,
        message: ctx.decision.message, stronghold: vault(ctx.agent),
      })
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    }

    const remaining = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    if (remaining <= 0) { ctx.agent.holdings.delete(faction.mint); ctx.agent.infiltrated.delete(faction.mint) }
    else { ctx.agent.holdings.set(faction.mint, remaining) }

    const prefix = isInfiltrated ? 'dumped (infiltration complete)' : 'defected from'
    ctx.agent.lastAction = `defected ${faction.symbol}`
    return `${prefix} ${faction.symbol}${ctx.decision.message ? ` — "${ctx.decision.message}"` : ''}`
  },

  async rally(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction || ctx.agent.rallied.has(faction.mint)) return null
    const result = await rally(ctx.connection, {
      mint: faction.mint, agent: ctx.agent.publicKey, stronghold: vault(ctx.agent),
    })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    ctx.agent.rallied.add(faction.mint)
    ctx.agent.lastAction = `rallied ${faction.symbol}`
    return `rallied ${faction.symbol}`
  },

  async launch(ctx) {
    if (ctx.agent.founded.length >= ctx.maxFoundedFactions) return null

    let name: string | null = null
    let symbol: string | null = null
    const identity = await generateFactionIdentity(ctx.agent.personality, ctx.usedFactionNames, ctx.llm)
    if (identity) { name = identity.name; symbol = identity.symbol }
    else {
      for (let i = 0; i < FALLBACK_FACTION_NAMES.length; i++) {
        if (!ctx.usedFactionNames.has(FALLBACK_FACTION_NAMES[i])) {
          name = FALLBACK_FACTION_NAMES[i]; symbol = FALLBACK_FACTION_SYMBOLS[i]; break
        }
      }
    }
    if (!name || !symbol) return null

    const metadataUri = `https://pyre.gg/factions/${symbol.toLowerCase()}.json`
    const result = await launchFaction(ctx.connection, {
      founder: ctx.agent.publicKey, name, symbol, metadata_uri: metadataUri, community_faction: true,
    })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    const mint = result.mint.toBase58()

    ctx.agent.founded.push(mint)
    ctx.factions.push({ mint, name, symbol, status: 'rising' })
    ctx.usedFactionNames.add(name)
    ctx.agent.lastAction = `launched ${symbol}`
    return `launched [${symbol}] ${name} (${isPyreMint(mint) ? 'py' : 'no-vanity'})`
  },

  async message(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) { ctx.log(`[${ctx.agent.publicKey.slice(0, 8)}] message: faction not found for ${ctx.decision.faction?.slice(0, 8)}`); return null }
    if (!ctx.decision.message) { ctx.log(`[${ctx.agent.publicKey.slice(0, 8)}] message: no message text`); return null }

    await ensureStronghold(ctx.connection, ctx.agent, ctx.log, ctx.strongholdOpts)
    if (!ctx.agent.hasStronghold) return null

    let result = await messageFaction(ctx.connection, {
      mint: faction.mint, agent: ctx.agent.publicKey, message: ctx.decision.message,
      stronghold: vault(ctx.agent), ascended: faction.status === 'ascended',
      first_buy: !ctx.agent.voted.has(faction.mint),
    })
    try {
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    } catch (retryErr: any) {
      const p = parseCustomError(retryErr)
      if (p && p.code === 6008) {
        ctx.agent.voted.add(faction.mint)
        result = await messageFaction(ctx.connection, {
          mint: faction.mint, agent: ctx.agent.publicKey, message: ctx.decision.message,
          stronghold: vault(ctx.agent), ascended: faction.status === 'ascended', first_buy: false,
        })
        await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
      } else { throw retryErr }
    }

    const msgBal = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    ctx.agent.holdings.set(faction.mint, msgBal > 0 ? msgBal : 1)
    ctx.agent.voted.add(faction.mint)
    ctx.agent.lastAction = `messaged ${faction.symbol}`
    return `said in ${faction.symbol}: "${ctx.decision.message}"`
  },

  async stronghold(ctx) {
    if (ctx.agent.hasStronghold) return null
    // Kit agents don't create vaults — they must be created on pyre.world
    ctx.log(`[${ctx.agent.publicKey.slice(0, 8)}] no vault — create one at pyre.world and link agent key ${ctx.agent.publicKey}`)
    return null
  },

  async war_loan(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null
    const balance = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    if (balance <= 0) { ctx.agent.holdings.delete(faction.mint); return null }

    const collateral = Math.max(1, Math.floor(balance * (0.90 + Math.random() * 0.09)))
    let borrowLamports: number
    try {
      const quote = await getMaxWarLoan(ctx.connection, faction.mint, collateral)
      if (quote.max_borrow_sol < 0.1 * LAMPORTS_PER_SOL) return null
      borrowLamports = Math.floor(quote.max_borrow_sol * (0.80 + Math.random() * 0.15))
    } catch {
      borrowLamports = Math.floor(0.1 * LAMPORTS_PER_SOL)
    }

    await ensureStronghold(ctx.connection, ctx.agent, ctx.log, ctx.strongholdOpts)
    const result = await requestWarLoan(ctx.connection, {
      mint: faction.mint, borrower: ctx.agent.publicKey, collateral_amount: collateral,
      sol_to_borrow: borrowLamports, stronghold: vault(ctx.agent),
    })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    ctx.agent.activeLoans.add(faction.mint)
    ctx.agent.lastAction = `war loan ${faction.symbol}`
    return `took war loan on ${faction.symbol} (${collateral} tokens, ${(borrowLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`
  },

  async repay_loan(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction || !ctx.agent.activeLoans.has(faction.mint)) return null

    let loan: WarLoan
    try { loan = await getWarLoan(ctx.connection, faction.mint, ctx.agent.publicKey) } catch { return null }
    if (loan.total_owed <= 0) { ctx.agent.activeLoans.delete(faction.mint); return null }

    const result = await repayWarLoan(ctx.connection, {
      mint: faction.mint, borrower: ctx.agent.publicKey,
      sol_amount: Math.ceil(loan.total_owed), stronghold: vault(ctx.agent),
    })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    ctx.agent.activeLoans.delete(faction.mint)
    ctx.agent.lastAction = `repaid loan ${faction.symbol}`
    return `repaid war loan on ${faction.symbol} (${(loan.total_owed / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
  },

  async siege(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null

    let targetBorrower: string | null = null
    try {
      const allLoans = await getAllWarLoans(ctx.connection, faction.mint)
      for (const pos of allLoans.positions) {
        if (pos.health === 'liquidatable') { targetBorrower = pos.borrower; break }
      }
    } catch { return null }
    if (!targetBorrower) return null

    const result = await siege(ctx.connection, {
      mint: faction.mint, liquidator: ctx.agent.publicKey,
      borrower: targetBorrower, stronghold: vault(ctx.agent),
    })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    ctx.agent.lastAction = `siege ${faction.symbol}`
    return `sieged ${targetBorrower.slice(0, 8)}... in ${faction.symbol} (liquidation)`
  },

  async ascend(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction || faction.status !== 'ready') return null
    const result = await ascend(ctx.connection, { mint: faction.mint, payer: ctx.agent.publicKey })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    faction.status = 'ascended'
    ctx.agent.lastAction = `ascended ${faction.symbol}`
    return `ascended ${faction.symbol} to DEX`
  },

  async raze(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null
    const result = await raze(ctx.connection, { payer: ctx.agent.publicKey, mint: faction.mint })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    ctx.agent.lastAction = `razed ${faction.symbol}`
    return `razed ${faction.symbol} (reclaimed)`
  },

  async tithe(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null
    try {
      const result = await convertTithe(ctx.connection, { mint: faction.mint, payer: ctx.agent.publicKey, harvest: true })
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    } catch {
      const result = await tithe(ctx.connection, { mint: faction.mint, payer: ctx.agent.publicKey })
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    }
    ctx.agent.lastAction = `tithed ${faction.symbol}`
    return `tithed ${faction.symbol} (harvested fees)`
  },

  async infiltrate(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction) return null
    const sol = ctx.decision.sol ?? sentimentBuySize(ctx.agent, faction.mint) * 1.5
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL)

    await ensureStronghold(ctx.connection, ctx.agent, ctx.log, ctx.strongholdOpts)
    if (!ctx.agent.hasStronghold) return null

    if (faction.status === 'ascended') {
      const result = await tradeOnDex(ctx.connection, {
        mint: faction.mint, signer: ctx.agent.publicKey, stronghold_creator: vault(ctx.agent),
        amount_in: lamports, minimum_amount_out: 1, is_buy: true, message: ctx.decision.message,
      })
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    } else {
      const alreadyVoted = ctx.agent.voted.has(faction.mint)
      const params: any = {
        mint: faction.mint, agent: ctx.agent.publicKey, amount_sol: lamports,
        message: ctx.decision.message, stronghold: vault(ctx.agent),
      }
      if (!alreadyVoted) params.strategy = 'scorched_earth'
      const result = await joinFaction(ctx.connection, params)
      await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    }

    const infBal = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    ctx.agent.holdings.set(faction.mint, infBal > 0 ? infBal : 1)
    ctx.agent.infiltrated.add(faction.mint)
    ctx.agent.voted.add(faction.mint)
    ctx.agent.sentiment.set(faction.mint, -5)
    ctx.agent.lastAction = `infiltrated ${faction.symbol}`
    return `infiltrated ${faction.symbol} for ${sol.toFixed(4)} SOL${ctx.decision.message ? ` — "${ctx.decision.message}"` : ''}`
  },

  async fud(ctx) {
    const faction = findFaction(ctx.factions, ctx.decision.faction)
    if (!faction || !ctx.decision.message) return null

    // Verify on-chain balance before FUD (micro sell)
    const fudBal = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    if (fudBal <= 0) { ctx.agent.holdings.delete(faction.mint); return null }

    await ensureStronghold(ctx.connection, ctx.agent, ctx.log, ctx.strongholdOpts)
    if (!ctx.agent.hasStronghold) return null

    const result = await fudFaction(ctx.connection, {
      mint: faction.mint, agent: ctx.agent.publicKey, message: ctx.decision.message,
      stronghold: vault(ctx.agent), ascended: faction.status === 'ascended',
    })
    await sendAndConfirm(ctx.connection, ctx.agent.keypair, result)
    // Fudding tanks your own sentiment — you're going bearish
    const fudSentiment = ctx.agent.sentiment.get(faction.mint) ?? 0
    ctx.agent.sentiment.set(faction.mint, Math.max(-10, fudSentiment - 2))

    // Check if fud cleared the position
    const postFudBal = await getOnChainBalance(ctx.connection, faction.mint, ctx.agent.publicKey)
    if (postFudBal <= 0) {
      ctx.agent.holdings.delete(faction.mint)
      ctx.agent.infiltrated.delete(faction.mint)
      ctx.agent.lastAction = `defected ${faction.symbol}`
      return `fud cleared position in ${faction.symbol} → defected: "${ctx.decision.message}"`
    }

    ctx.agent.lastAction = `fud ${faction.symbol}`
    return `argued in ${faction.symbol}: "${ctx.decision.message}"`
  },

  scout: async (ctx) => {
    const target = ctx.decision.faction // holds the address for scout
    if (!target) return null

    const result = await executeScout(ctx.connection, target)

    // Store result to show in next turn's prompt
    const existing = pendingScoutResults.get(ctx.agent.publicKey) ?? []
    existing.push(result)
    if (existing.length > 5) existing.shift()
    pendingScoutResults.set(ctx.agent.publicKey, existing)

    ctx.agent.lastAction = `scouted @${target.slice(0, 8)}`
    return `scouted @${target.slice(0, 8)}`
  },
}

export async function executeAction(ctx: ExecutorContext): Promise<{ success: boolean, description?: string, error?: string }> {
  const short = ctx.agent.publicKey.slice(0, 8)
  try {
    const handler = handlers[ctx.decision.action]
    if (!handler) return { success: false, error: `unknown action: ${ctx.decision.action}` }

    const desc = await handler(ctx)
    if (!desc) return { success: false, error: 'action precondition not met' }

    ctx.agent.recentHistory.push(desc)
    if (ctx.agent.recentHistory.length > 10) ctx.agent.recentHistory = ctx.agent.recentHistory.slice(-10)
    ctx.agent.actionCount++

    ctx.log(`[${short}] [${ctx.agent.personality}] [${ctx.brain}] ${desc}`)
    return { success: true, description: desc }
  } catch (err: any) {
    const parsed = parseCustomError(err)
    if (parsed) {
      const factionObj = ctx.decision.faction ? findFaction(ctx.factions, ctx.decision.faction) : null
      const factionLabel = factionObj?.symbol ?? ctx.decision.faction?.slice(0, 8) ?? '?'
      ctx.log(`[${short}] [${ctx.agent.personality}] [${ctx.brain}] ERROR (${ctx.decision.action} ${factionLabel}): ${parsed.name} [0x${parsed.code.toString(16)}]`)

      // Adapt behavior based on error
      if (parsed.code === 6002 && ctx.decision.faction) {
        if (factionObj) ctx.agent.sentiment.set(factionObj.mint, (ctx.agent.sentiment.get(factionObj.mint) ?? 0) + 1)
      } else if (parsed.code === 6055) {
        ctx.agent.recentHistory.push('vault empty — need funds')
      } else if (parsed.code === 6051) {
        if (factionObj) ctx.agent.sentiment.set(factionObj.mint, (ctx.agent.sentiment.get(factionObj.mint) ?? 0) + 2)
      } else if (parsed.code === 6046) {
        ctx.agent.recentHistory.push(`loan rejected on ${factionLabel} — LTV too high`)
      } else if (parsed.code === 6049) {
        ctx.agent.recentHistory.push(`loan too small on ${factionLabel} — min 0.1 SOL`)
      }

      return { success: false, error: `${parsed.name} [0x${parsed.code.toString(16)}]` }
    }

    const msg = err.message?.slice(0, 120) ?? String(err)
    ctx.log(`[${short}] [${ctx.agent.personality}] [${ctx.brain}] ERROR (${ctx.decision.action}): ${msg}`)
    return { success: false, error: msg }
  }
}
