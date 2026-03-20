import { Keypair } from '@solana/web3.js'
import type { PyreKit } from 'pyre-world-kit'

// ─── Core Game Types ────────────────────────────────────────────────

export type Personality = 'loyalist' | 'mercenary' | 'provocateur' | 'scout' | 'whale'

export type Action =
  | 'join'
  | 'defect'
  | 'rally'
  | 'launch'
  | 'message'
  | 'reinforce'
  | 'war_loan'
  | 'repay_loan'
  | 'siege'
  | 'ascend'
  | 'raze'
  | 'tithe'
  | 'infiltrate'
  | 'fud'
  | 'scout'

export interface LLMDecision {
  action: Action
  faction?: string
  sol?: number
  message?: string
  reasoning?: string
  _rejected?: string
}

export interface FactionInfo {
  mint: string
  name: string
  symbol: string
  status: 'rising' | 'ready' | 'ascended' | 'razed'
  price_sol?: number
  market_cap_sol?: number
}

export interface FactionIntel {
  symbol: string
  members: { address: string; percentage: number }[]
  totalMembers: number
  recentComms: { sender: string; memo: string }[]
}

// ─── Agent State (personality layer — objective state lives in PyreKit) ──

export interface AgentState {
  keypair: Keypair
  publicKey: string
  personality: Personality
  /** Mints we joined to sabotage (dump later) — subjective intent, not on-chain */
  infiltrated: Set<string>
  /** Agent pubkeys this agent trusts — subjective */
  allies: Set<string>
  /** Agent pubkeys this agent distrusts — subjective */
  rivals: Set<string>
  lastAction: string
}

// ─── Public API Types ───────────────────────────────────────────────

export interface LLMAdapter {
  generate: (prompt: string) => Promise<string | null>
}

export interface PyreAgentConfig {
  kit: PyreKit
  keypair: Keypair
  llm?: LLMAdapter
  personality?: Personality
  solRange?: [number, number]
  maxFoundedFactions?: number
  state?: SerializedAgentState
  logger?: (msg: string) => void
}

export interface AgentTickResult {
  action: Action
  faction?: string
  message?: string
  reasoning?: string
  success: boolean
  error?: string
  usedLLM: boolean
}

export interface SerializedAgentState {
  publicKey: string
  personality: Personality
  infiltrated: string[]
  allies: string[]
  rivals: string[]
  lastAction: string
}

export interface PyreAgent {
  readonly publicKey: string
  readonly personality: Personality
  tick(factions?: FactionInfo[]): Promise<AgentTickResult>
  evolve(): Promise<boolean>
  getState(): AgentState
  serialize(): SerializedAgentState
}
