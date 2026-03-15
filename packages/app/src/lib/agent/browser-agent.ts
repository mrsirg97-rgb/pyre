import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { PyreKit } from 'pyre-world-kit'
import type { SerializedGameState } from 'pyre-world-kit'
import type { LLMAdapter, FactionInfo, Personality, AgentTickResult } from 'pyre-agent-kit'
import {
  assignPersonality,
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

  // Always init to resolve vault link from on-chain data
  await kit.state.init()
  if (config.kitState) {
    // Save vault info before hydrate clears it
    const resolvedVaultCreator = kit.state.vaultCreator
    const resolvedStronghold = kit.state.state?.stronghold ?? null
    kit.state.hydrate(config.kitState)
    // Restore vault info — hydrate sets stronghold to null
    if (resolvedVaultCreator) kit.state.state!.vaultCreator = resolvedVaultCreator
    if (resolvedStronghold) kit.state.state!.stronghold = resolvedStronghold
  }

  let personality: Personality = config.personality ?? assignPersonality()
  let solRange = config.solRange ?? PERSONALITY_SOL[personality]
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

  // Discover factions
  const knownFactions: FactionInfo[] = []
  try {
    const result = await kit.actions.getFactions({ limit: 50, sort: 'newest' })
    for (const t of result.factions) {
      knownFactions.push({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        status: t.status as FactionInfo['status'],
      })
    }
  } catch {}

  logger(
    `[${publicKey.slice(0, 8)}] browser agent initialized — ${personality}, tick ${kit.state.tick}, ${knownFactions.length} factions`,
  )

  // Load current on-chain holdings so agent knows what it owns
  await kit.state.refreshHoldings()

  const vc = kit.state.vaultCreator
  if (vc) {
    logger(`[${publicKey.slice(0, 8)}] vault linked: ${vc.slice(0, 8)}...`)
  } else {
    logger(`[${publicKey.slice(0, 8)}] no vault found — actions requiring a stronghold will fail`)
  }
  const stronghold = () => kit.state.vaultCreator ?? publicKey

  async function tick(factions?: FactionInfo[]): Promise<AgentTickResult> {
    const activeFactions = factions ?? knownFactions
    if (activeFactions.length === 0) {
      return { action: 'join', success: false, error: 'no factions', usedLLM: false }
    }

    const holdings = kit.state.state!.holdings
    const hasHoldings = holdings.size > 0
    const weights = [...PERSONALITY_WEIGHTS[personality]]

    // Disable impossible actions
    if (!hasHoldings) {
      weights[1] = 0 // defect
      weights[12] = 0 // fud
    }

    // Disable rally for already-rallied factions
    const rallyEligible = activeFactions.filter((f) => !kit.state.hasRallied(f.mint))
    if (rallyEligible.length === 0) weights[2] = 0

    // Boost launch when few factions
    const nonRazed = activeFactions.filter((f) => f.status !== 'razed')
    if (nonRazed.length <= 2) weights[3] += 0.25
    else if (nonRazed.length <= 5) weights[3] += 0.10

    // Without LLM, skip message and fud (need generated text)
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
    let action: string = 'join'
    for (let i = 0; i < weights.length; i++) {
      cumulative += weights[i]
      if (roll < cumulative) {
        action = ALL_ACTIONS[i]
        break
      }
    }

    const faction = pick(activeFactions)
    const [minSol, maxSol] = solRange
    const sol = randRange(minSol, maxSol)

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
            stronghold: stronghold(),
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            joinParams.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'join', joinParams)
          execResult = result
          execConfirm = confirm
          description = `join ${faction.symbol}`
          break
        }
        case 'defect': {
          const held = [...holdings.entries()].filter(([, b]) => b > 0)
          if (held.length === 0)
            return { action: 'defect', success: false, error: 'no holdings', usedLLM: false }
          const [mint, balance] = pick(held)
          const sellAmount = Math.max(1, Math.floor(balance * (0.2 + Math.random() * 0.3)))
          const f = activeFactions.find((ff) => ff.mint === mint)
          const { result, confirm } = await kit.exec('actions', 'defect', {
            mint,
            agent: publicKey,
            amount_tokens: sellAmount,
            stronghold: stronghold(),
            ascended: f?.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          description = `defect ${f?.symbol ?? mint.slice(0, 8)}`
          break
        }
        case 'rally': {
          if (rallyEligible.length === 0)
            return { action: 'rally', success: false, error: 'already rallied all', usedLLM: false }
          const target = pick(rallyEligible)
          const { result, confirm } = await kit.exec('actions', 'rally', {
            mint: target.mint,
            agent: publicKey,
            stronghold: stronghold(),
          })
          execResult = result
          execConfirm = confirm
          description = `rally ${target.symbol}`
          break
        }
        case 'launch': {
          const founded = kit.state.state?.founded ?? []
          if (founded.length >= 2)
            return { action: 'launch', success: false, error: 'max factions founded', usedLLM: false }

          let name = 'Pyre Faction'
          let symbol = 'PYRE'
          if (llm) {
            const { generateFactionIdentity } = await import('pyre-agent-kit')
            const usedNames = new Set(activeFactions.map((f) => f.name))
            const identity = await generateFactionIdentity(personality, usedNames, llm)
            if (identity) {
              name = identity.name
              symbol = identity.symbol
            }
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
          if (!llm)
            return { action: 'message', success: false, error: 'no LLM', usedLLM: false }
          const msg = await llm.generate(
            `You are an agent in faction ${faction.symbol}. Write a short, punchy one-liner for faction comms (under 60 chars). Be creative — no generic crypto talk.`,
          )
          if (!msg)
            return { action: 'message', success: false, error: 'LLM returned null', usedLLM: true }
          const params: any = {
            mint: faction.mint,
            agent: publicKey,
            message: msg.slice(0, 80),
            stronghold: stronghold(),
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'message', params)
          execResult = result
          execConfirm = confirm
          description = `message ${faction.symbol}: "${msg.slice(0, 60)}"`
          break
        }
        case 'fud': {
          const heldMints = [...holdings.keys()]
          const heldFactions = activeFactions.filter((f) => heldMints.includes(f.mint))
          if (heldFactions.length === 0)
            return { action: 'fud', success: false, error: 'no holdings to FUD', usedLLM: false }
          const target = pick(heldFactions)
          if (!llm)
            return { action: 'fud', success: false, error: 'no LLM', usedLLM: false }
          const msg = await llm.generate(
            `You are trash-talking faction ${target.symbol}. Write aggressive, short FUD (under 60 chars). Be specific and provocative.`,
          )
          if (!msg)
            return { action: 'fud', success: false, error: 'LLM returned null', usedLLM: true }
          const { result, confirm } = await kit.exec('actions', 'fud', {
            mint: target.mint,
            agent: publicKey,
            message: msg.slice(0, 80),
            stronghold: stronghold(),
            ascended: target.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          description = `fud ${target.symbol}: "${msg.slice(0, 60)}"`
          break
        }
        case 'infiltrate': {
          const heldMints = [...holdings.keys()]
          const rivals = activeFactions.filter((f) => !heldMints.includes(f.mint))
          if (rivals.length === 0)
            return { action: 'infiltrate', success: false, error: 'no rival factions', usedLLM: false }
          const target = pick(rivals)
          const infiltrateParams: any = {
            mint: target.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * 1.5 * LAMPORTS_PER_SOL),
            stronghold: stronghold(),
            ascended: target.status === 'ascended',
          }
          if (!kit.state.hasVoted(target.mint)) {
            infiltrateParams.strategy = 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'join', infiltrateParams)
          execResult = result
          execConfirm = confirm
          description = `infiltrate ${target.symbol}`
          break
        }
        case 'tithe': {
          const ascended = activeFactions.filter((f) => f.status === 'ascended')
          if (ascended.length === 0)
            return { action: 'tithe', success: false, error: 'no ascended factions', usedLLM: false }
          const target = pick(ascended)
          const { result, confirm } = await kit.exec('actions', 'tithe', {
            mint: target.mint,
            payer: publicKey,
            harvest: true,
          })
          execResult = result
          execConfirm = confirm
          description = `tithe ${target.symbol}`
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
          description = `ascend ${target.symbol}`
          break
        }
        default: {
          // war_loan, repay_loan, siege, raze — fall back to join
          const defaultParams: any = {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * LAMPORTS_PER_SOL),
            stronghold: stronghold(),
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            defaultParams.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'join', defaultParams)
          execResult = result
          execConfirm = confirm
          action = 'join'
          description = `join ${faction.symbol}`
          break
        }
      }

      if (!execResult)
        return { action: action as any, success: false, error: 'no result', usedLLM: false }

      // Sign with wallet adapter
      await walletSignAndSend(connection, wallet, execResult)

      if (execConfirm) await execConfirm()

      logger(`[${publicKey.slice(0, 8)}] ${description} — OK`)

      return {
        action: action as any,
        faction: faction.mint,
        success: true,
        usedLLM: action === 'message' || action === 'fud',
      }
    } catch (err: any) {
      logger(`[${publicKey.slice(0, 8)}] ${action} ERROR: ${err.message?.slice(0, 80)}`)
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
      counts.join, counts.defect, counts.rally, counts.launch, counts.message,
      counts.reinforce, counts.war_loan, counts.repay_loan, counts.siege,
      counts.ascend, counts.raze, counts.tithe, counts.infiltrate, counts.fud,
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
