import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { PyreKit } from 'pyre-world-kit'
import type { SerializedGameState } from 'pyre-world-kit'
import type { LLMAdapter, FactionInfo, Personality, AgentTickResult, AgentState } from 'pyre-agent-kit'
import {
  assignPersonality,
  llmDecide,
  PERSONALITY_SOL,
  PERSONALITY_WEIGHTS,
  weightsFromCounts,
  classifyPersonality,
} from 'pyre-agent-kit'
import { WalletSigner, walletSignAndSend } from './wallet-signer'

export interface BrowserAgentConfig {
  connection: Connection
  wallet: WalletSigner
  network: 'devnet' | 'mainnet'
  llm?: LLMAdapter
  personality?: Personality
  solRange?: [number, number]
  kitState?: SerializedGameState
  logger?: (msg: string) => void
}

export interface BrowserAgent {
  readonly publicKey: string
  readonly personality: Personality
  tick(factions?: FactionInfo[]): Promise<AgentTickResult>
  evolve(): Promise<boolean>
  getKit(): PyreKit
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
function randRange(min: number, max: number) {
  return min + Math.random() * (max - min)
}

export async function createBrowserAgent(config: BrowserAgentConfig): Promise<BrowserAgent> {
  const { connection, wallet, llm } = config
  const publicKey = wallet.publicKey
  const logger = config.logger ?? ((msg: string) => console.log(msg))

  const kit = new PyreKit(connection, publicKey)

  // Init state (loads registry checkpoint)
  await kit.state.init()
  if (config.kitState) {
    kit.state.hydrate(config.kitState)
  }

  let personality: Personality = config.personality ?? assignPersonality()
  let solRange = config.solRange ?? PERSONALITY_SOL[personality]
  const recentMessages: string[] = []
  const memoBuffer: string[] = []
  const driftScores: Record<Personality, number> = {
    loyalist: 0,
    mercenary: 0,
    provocateur: 0,
    scout: 0,
    whale: 0,
  }

  // Restore personality from checkpoint
  const gameState = kit.state.state
  if (gameState?.personalitySummary) {
    const valid: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
    if (valid.includes(gameState.personalitySummary as Personality)) {
      personality = gameState.personalitySummary as Personality
      solRange = config.solRange ?? PERSONALITY_SOL[personality]
    }
  }

  async function discoverFactions(): Promise<FactionInfo[]> {
    const result = await kit.actions.getFactions({ sort: 'newest' })
    return result.factions.map((t) => ({
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      status: t.status as FactionInfo['status'],
      price_sol: t.price_sol,
      market_cap_sol: t.market_cap_sol,
    }))
  }

  logger(
    `[${publicKey.slice(0, 8)}] browser agent initialized — ${personality}, tick ${kit.state.tick}`,
  )

  const vc = await kit.state.getVaultCreator()
  if (vc) {
    logger(`[${publicKey.slice(0, 8)}] vault linked: ${vc.slice(0, 8)}...`)
  } else {
    logger(`[${publicKey.slice(0, 8)}] no vault found — actions requiring a stronghold will fail`)
  }
  const stronghold = async () => (await kit.state.getVaultCreator()) ?? publicKey

  // Build an AgentState-compatible object for llmDecide
  const agentState: AgentState = {
    keypair: null as any, // not used by llmDecide
    publicKey,
    personality,
    infiltrated: new Set(),
    allies: new Set(),
    rivals: new Set(),
    lastAction: 'none',
  }

  async function tick(factions?: FactionInfo[]): Promise<AgentTickResult> {
    const activeFactions = factions ?? await discoverFactions()
    if (activeFactions.length === 0) {
      return { action: 'join', success: false, error: 'no factions', usedLLM: false }
    }

    // Try LLM decision first
    let action: string = 'join'
    let faction = pick(activeFactions)
    let sol = randRange(solRange[0], solRange[1])
    let message: string | undefined
    let usedLLM = false

    // Log P&L
    const gameState = kit.state.state!
    const pnlVal = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
    logger(`P&L: ${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(4)} SOL`)

    let promptTable: { header: string; rows: string[] } | null = null

    if (llm && activeFactions.length > 0) {
      try {
        const decision = await llmDecide(
          kit, agentState, activeFactions, recentMessages, llm, logger, solRange, {
            compact: true,
            onPromptTable: (header, rows) => {
              promptTable = { header, rows }
            },
          },
        )
        if (decision) {
          action = decision.action
          sol = decision.sol ?? sol
          message = decision.message
          if (decision.faction) {
            const f = activeFactions.find((ff) => ff.mint === decision.faction)
            if (f) faction = f
          }
          usedLLM = true
        }
      } catch (e: any) {
        logger(`[${publicKey.slice(0, 8)}] LLM error: ${e.message?.slice(0, 80)}`)
      }
    }

    // Fallback: weighted random (no LLM or LLM failed)
    if (!usedLLM) {
      const holdings = await kit.state.getHoldings()
      const hasHoldings = holdings.size > 0
      const weights = [...PERSONALITY_WEIGHTS[personality]]

      if (!hasHoldings) {
        weights[1] = 0 // defect
        weights[12] = 0 // fud
      }

      const rallyEligible = activeFactions.filter((f) => !kit.state.hasRallied(f.mint))
      if (rallyEligible.length === 0) weights[2] = 0

      const nonRazed = activeFactions.filter((f) => f.status !== 'razed')
      if (nonRazed.length <= 2) weights[3] += 0.15
      else if (nonRazed.length <= 5) weights[3] += 0.03

      if (!llm) {
        weights[4] = 0 // message
        weights[12] = 0 // fud
      }

      const total = weights.reduce((a, b) => a + b, 0)
      const roll = Math.random() * total
      let cumulative = 0
      const ALL_ACTIONS = [
        'join', 'defect', 'rally', 'launch', 'message',
        'war_loan', 'repay_loan', 'siege', 'ascend', 'raze',
        'tithe', 'infiltrate', 'fud',
      ] as const
      action = 'join'
      for (let i = 0; i < weights.length; i++) {
        cumulative += weights[i]
        if (roll < cumulative) {
          action = ALL_ACTIONS[i]
          break
        }
      }
    }

    // Fetch holdings for execution (defect/fud need balances)
    // RNG path already fetched, LLM path needs a fresh fetch
    const execHoldings = await kit.state.getHoldings()

    try {
      let execResult: any
      let execConfirm: (() => Promise<void>) | undefined
      let description = ''

      switch (action) {
        case 'join': {
          const joinParams: any = {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * LAMPORTS_PER_SOL),
            message,
            stronghold: await stronghold(),
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            joinParams.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          try {
            const { result, confirm } = await kit.exec('actions', 'join', joinParams)
            execResult = result
            execConfirm = confirm
          } catch (e: any) {
            if (e.message?.includes('6022') || e.message?.includes('VoteRequired')) {
              joinParams.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
              const retry = await kit.exec('actions', 'join', joinParams)
              execResult = retry.result
              execConfirm = retry.confirm
            } else {
              throw e
            }
          }
          kit.state.markVoted(faction.mint)
          description = `join ${faction.mint.slice(-8)}${message ? ` — "${message}"` : ''}`
          break
        }
        case 'reinforce': {
          const reinforceParams: any = {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * LAMPORTS_PER_SOL),
            message,
            stronghold: await stronghold(),
            ascended: faction.status === 'ascended',
          }
          const { result: rResult, confirm: rConfirm } = await kit.exec('actions', 'join', reinforceParams)
          execResult = rResult
          execConfirm = rConfirm
          description = `reinforce ${faction.mint.slice(-8)}${message ? ` — "${message}"` : ''}`
          break
        }
        case 'defect': {
          // LLM picks the faction, RNG picks random from holdings
          let defectMint: string
          let defectBalance: number
          if (usedLLM && faction.mint) {
            defectMint = faction.mint
            defectBalance = execHoldings.get(faction.mint) ?? 0
          } else {
            const held = [...execHoldings.entries()].filter(([, b]) => b > 0)
            if (held.length === 0)
              return { action: 'defect', success: false, error: 'no holdings', usedLLM }
            ;[defectMint, defectBalance] = pick(held)
          }
          if (defectBalance <= 0)
            return { action: 'defect', success: false, error: 'no balance', usedLLM }
          const sellAmount = Math.max(1, Math.floor(defectBalance * (0.2 + Math.random() * 0.3)))
          const f = activeFactions.find((ff) => ff.mint === defectMint)
          const { result, confirm } = await kit.exec('actions', 'defect', {
            mint: defectMint,
            agent: publicKey,
            amount_tokens: sellAmount,
            message,
            stronghold: await stronghold(),
            ascended: f?.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          description = `defect ${defectMint.slice(-8)}${message ? ` — "${message}"` : ''}`
          break
        }
        case 'rally': {
          const founded = kit.state.state?.founded ?? []
          const eligible = activeFactions.filter((f) => !kit.state.hasRallied(f.mint))
          const rallyTargets = eligible.filter((f) => !founded.includes(f.mint))
          if (rallyTargets.length === 0)
            return { action: 'rally', success: false, error: 'no eligible factions', usedLLM: false }
          const target = pick(rallyTargets)
          const { result, confirm } = await kit.exec('actions', 'rally', {
            mint: target.mint,
            agent: publicKey,
            stronghold: await stronghold(),
          })
          execResult = result
          execConfirm = confirm
          description = `rally ${target.mint.slice(-8)}`
          break
        }
        case 'launch': {
          const founded = kit.state.state?.founded ?? []
          if (founded.length >= 2)
            return {
              action: 'launch',
              success: false,
              error: 'max factions founded',
              usedLLM: false,
            }

          // Use the name from the LLM decision if available, otherwise generate one
          let name = 'Pyre Faction'
          let symbol = 'PYRE'
          const llmName = message?.replace(/^["']+|["']+$/g, '').trim()
          if (llmName && llmName.length >= 3 && llmName.length <= 32) {
            name = llmName
            const words = llmName.split(/\s+/)
            symbol = words.length >= 2
              ? words.slice(0, 2).map((w: string) => w.slice(0, 2).toUpperCase()).join('')
              : llmName.slice(0, 4).toUpperCase()
          } else if (llm) {
            try {
              const raw = await llm.generate(
                `Invent a creative faction name (2-3 words). It can be a cult, cartel, syndicate, order, lab, movement, guild — anything memorable. One line only, just the name.`,
              )
              if (raw) {
                const cleaned = raw.trim().replace(/^["']+|["']+$/g, '').split('\n')[0].trim()
                if (cleaned.length >= 3 && cleaned.length <= 32) {
                  name = cleaned
                  const words = cleaned.split(/\s+/)
                  symbol = words.length >= 2
                    ? words.slice(0, 2).map((w) => w.slice(0, 2).toUpperCase()).join('')
                    : cleaned.slice(0, 4).toUpperCase()
                }
              }
            } catch {}
          }

          const { result, confirm } = await kit.exec('actions', 'launch', {
            founder: publicKey,
            name,
            symbol,
            metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
            community_faction: true,
          })
          execResult = result
          execConfirm = confirm
          description = `launched [${symbol}] ${name}`
          break
        }
        case 'message': {
          // LLM path already provides message, RNG path needs to generate one
          const msg = message ?? (llm
            ? await llm.generate(
                `You are an agent in faction ${faction.symbol}. Write a short, punchy one-liner for faction comms (under 60 chars). Be creative — no generic crypto talk.`,
              )
            : null)
          if (!msg)
            return { action: 'message', success: false, error: 'no message', usedLLM }
          const params: any = {
            mint: faction.mint,
            agent: publicKey,
            message: msg.slice(0, 80),
            stronghold: await stronghold(),
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          try {
            const { result, confirm } = await kit.exec('actions', 'message', params)
            execResult = result
            execConfirm = confirm
          } catch (e: any) {
            if (e.message?.includes('6022') || e.message?.includes('VoteRequired')) {
              params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
              const retry = await kit.exec('actions', 'message', params)
              execResult = retry.result
              execConfirm = retry.confirm
            } else {
              throw e
            }
          }
          kit.state.markVoted(faction.mint)
          description = `message ${faction.mint.slice(-8)}: "${msg.slice(0, 60)}"`
          break
        }
        case 'fud': {
          // LLM path already picks faction + message, RNG path picks from holdings
          const fudTarget = usedLLM ? faction : (() => {
            const heldMints = [...execHoldings.keys()]
            const heldFactions = activeFactions.filter((f) => heldMints.includes(f.mint))
            return heldFactions.length > 0 ? pick(heldFactions) : null
          })()
          if (!fudTarget)
            return { action: 'fud', success: false, error: 'no holdings to FUD', usedLLM }
          const fudMsg = message ?? (llm
            ? await llm.generate(
                `You are trash-talking faction ${fudTarget.symbol}. Write aggressive, short FUD (under 60 chars). Be specific and provocative.`,
              )
            : null)
          if (!fudMsg)
            return { action: 'fud', success: false, error: 'no message', usedLLM }
          const { result, confirm } = await kit.exec('actions', 'fud', {
            mint: fudTarget.mint,
            agent: publicKey,
            message: fudMsg.slice(0, 80),
            stronghold: await stronghold(),
            ascended: fudTarget.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          description = `fud ${fudTarget.mint.slice(-8)}: "${fudMsg.slice(0, 60)}"`
          break
        }
        case 'infiltrate': {
          const heldMints = [...execHoldings.keys()]
          const rivals = activeFactions.filter((f) => !heldMints.includes(f.mint))
          if (rivals.length === 0)
            return {
              action: 'infiltrate',
              success: false,
              error: 'no rival factions',
              usedLLM: false,
            }
          const target = pick(rivals)
          const infiltrateParams: any = {
            mint: target.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * 1.5 * LAMPORTS_PER_SOL),
            stronghold: await stronghold(),
            ascended: target.status === 'ascended',
          }
          if (!kit.state.hasVoted(target.mint)) {
            infiltrateParams.strategy = 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'join', infiltrateParams)
          execResult = result
          execConfirm = confirm
          description = `infiltrate ${target.mint.slice(-8)}`
          break
        }
        case 'tithe': {
          const ascended = activeFactions.filter((f) => f.status === 'ascended')
          if (ascended.length === 0)
            return {
              action: 'tithe',
              success: false,
              error: 'no ascended factions',
              usedLLM: false,
            }
          const target = pick(ascended)
          const { result, confirm } = await kit.exec('actions', 'tithe', {
            mint: target.mint,
            payer: publicKey,
            harvest: true,
          })
          execResult = result
          execConfirm = confirm
          description = `tithe ${target.mint.slice(-8)}`
          break
        }
        case 'ascend': {
          const ready = activeFactions.filter((f) => f.status === 'ready')
          if (ready.length === 0)
            return { action: 'ascend', success: false, error: 'no ready factions', usedLLM: false }
          const target = pick(ready)
          const { result, confirm } = await kit.exec('actions', 'ascend', {
            mint: target.mint,
            payer: publicKey,
          })
          execResult = result
          execConfirm = confirm
          description = `ascend ${target.mint.slice(-8)}`
          break
        }
        default: {
          // war_loan, repay_loan, siege, raze — fall back to join
          const defaultParams: any = {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * LAMPORTS_PER_SOL),
            stronghold: await stronghold(),
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            defaultParams.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'join', defaultParams)
          execResult = result
          execConfirm = confirm
          action = 'join'
          description = `join ${faction.mint.slice(-8)}`
          break
        }
      }

      if (!execResult)
        return { action: action as any, success: false, error: 'no result', usedLLM: false }

      // Sign with wallet adapter
      await walletSignAndSend(connection, wallet, execResult)

      if (execConfirm) await execConfirm()

      logger(`[${publicKey.slice(0, 8)}] ${description} — OK`)

      // Log the table the model saw (after action result)
      if (promptTable) {
        logger(promptTable.header.split(',').join(' | '))
        promptTable.rows.forEach(r => logger(`  ${r.split(',').join(' | ')}`))
      }

      // Keep history tight for compact prompt (ring buffer of 2)
      const hist = kit.state.state!.recentHistory
      if (hist.length > 2) {
        kit.state.state!.recentHistory = hist.slice(-2)
      }

      // Track recent messages to prevent repetition
      if (message) {
        recentMessages.push(message.replace(/^<+/, '').replace(/>+\s*$/, '').toLowerCase())
        if (recentMessages.length > 30) recentMessages.shift()
      }

      return {
        action: action as any,
        faction: faction.mint,
        message,
        success: true,
        usedLLM,
      }
    } catch (err: any) {
      logger(`[${publicKey.slice(0, 8)}] ${action} ${faction.symbol} ERROR: ${err.message?.slice(0, 80)}`)
      return {
        action: action as any,
        faction: faction.mint,
        success: false,
        error: err.message?.slice(0, 100),
        usedLLM: false,
      }
    }
  }

  async function evolve(): Promise<boolean> {
    const counts = kit.state.state?.actionCounts
    if (!counts) return false
    const countsArray = [
      counts.join,
      counts.defect,
      counts.rally,
      counts.launch,
      counts.message,
      counts.reinforce,
      counts.war_loan,
      counts.repay_loan,
      counts.siege,
      counts.ascend,
      counts.raze,
      counts.tithe,
      counts.infiltrate,
      counts.fud,
    ]
    const total = countsArray.reduce((a, b) => a + b, 0)
    if (total < 5) return false

    const weights = weightsFromCounts(countsArray, personality)
    const llmGen = llm ? (p: string) => llm.generate(p) : undefined
    const suggested = await classifyPersonality(weights, memoBuffer, undefined, llmGen)
    driftScores[suggested]++
    if (
      suggested !== personality &&
      driftScores[suggested] - (driftScores[personality] ?? 0) >= 3
    ) {
      personality = suggested
      solRange = PERSONALITY_SOL[personality]
      return true
    }
    return false
  }

  return {
    publicKey,
    personality,
    tick,
    evolve,
    getKit: () => kit,
  }
}
