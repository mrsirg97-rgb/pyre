import { Connection } from '@solana/web3.js'
import { PyreKit, LAMPORTS_PER_SOL } from 'pyre-world-kit'
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

  // Hydrate or init state
  if (config.kitState) {
    kit.state.hydrate(config.kitState)
  } else {
    await kit.state.init()
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

  async function tick(factions?: FactionInfo[]): Promise<AgentTickResult> {
    const activeFactions = factions ?? knownFactions
    if (activeFactions.length === 0) {
      return { action: 'join', success: false, error: 'no factions', usedLLM: false }
    }

    // Simple weighted random action selection (LLM support via config.llm)
    const holdings = kit.state.state!.holdings
    const hasHoldings = holdings.size > 0
    const weights = [...PERSONALITY_WEIGHTS[personality]]

    // Disable impossible actions
    if (!hasHoldings) {
      weights[1] = 0
      weights[12] = 0
    } // defect, fud
    if (!kit.state.state!.rallied) {
      weights[2] = 0
    } // rally

    const total = weights.reduce((a, b) => a + b, 0)
    const roll = Math.random() * total
    let cumulative = 0
    const ALL_ACTIONS = [
      'join',
      'defect',
      'rally',
      'launch',
      'message',
      'war_loan',
      'repay_loan',
      'siege',
      'ascend',
      'raze',
      'tithe',
      'infiltrate',
      'fud',
    ] as const
    let action: string = 'join'
    for (let i = 0; i < weights.length; i++) {
      cumulative += weights[i]
      if (roll < cumulative) {
        action = ALL_ACTIONS[i]
        break
      }
    }

    // Pick a target faction
    const faction = pick(activeFactions)
    const [minSol, maxSol] = solRange
    const sol = randRange(minSol, maxSol)

    try {
      // Build params based on action
      let execResult: any
      let execConfirm: (() => Promise<void>) | undefined

      switch (action) {
        case 'join': {
          const { result, confirm } = await kit.exec('actions', 'join', {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * LAMPORTS_PER_SOL),
            stronghold: kit.state.vaultCreator ?? publicKey,
            ascended: faction.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          break
        }
        case 'defect': {
          const held = [...holdings.entries()].filter(([, b]) => b > 0)
          if (held.length === 0)
            return { action: 'defect', success: false, error: 'no holdings', usedLLM: false }
          const [mint, balance] = pick(held)
          const sellAmount = Math.max(1, Math.floor(balance * (0.2 + Math.random() * 0.3)))
          const { result, confirm } = await kit.exec('actions', 'defect', {
            mint,
            agent: publicKey,
            amount_tokens: sellAmount,
            stronghold: kit.state.vaultCreator ?? publicKey,
            ascended: activeFactions.find((f) => f.mint === mint)?.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          break
        }
        case 'rally': {
          const eligible = activeFactions.filter((f) => !kit.state.hasRallied(f.mint))
          if (eligible.length === 0)
            return { action: 'rally', success: false, error: 'already rallied all', usedLLM: false }
          const target = pick(eligible)
          const { result, confirm } = await kit.exec('actions', 'rally', {
            mint: target.mint,
            agent: publicKey,
            stronghold: kit.state.vaultCreator ?? publicKey,
          })
          execResult = result
          execConfirm = confirm
          break
        }
        default: {
          // For other actions, default to join
          const { result, confirm } = await kit.exec('actions', 'join', {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: Math.floor(sol * LAMPORTS_PER_SOL),
            stronghold: kit.state.vaultCreator ?? publicKey,
            ascended: faction.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          break
        }
      }

      if (!execResult)
        return { action: action as any, success: false, error: 'no result', usedLLM: false }

      // Sign with wallet adapter and send
      await walletSignAndSend(connection, wallet, execResult)

      // Confirm state update
      if (execConfirm) await execConfirm()

      logger(`[${publicKey.slice(0, 8)}] ${action} ${faction.symbol} — OK`)

      return {
        action: action as any,
        faction: faction.mint,
        success: true,
        usedLLM: false,
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
