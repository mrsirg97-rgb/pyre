import { Connection, Keypair } from '@solana/web3.js'

// ─── Core Game Types ────────────────────────────────────────────────

export type Personality = 'loyalist' | 'mercenary' | 'provocateur' | 'scout' | 'whale'

export type Action = 'join' | 'defect' | 'rally' | 'launch' | 'message'
  | 'stronghold' | 'war_loan' | 'repay_loan' | 'siege' | 'ascend' | 'raze' | 'tithe'
  | 'infiltrate' | 'fud' | 'scout'

export interface LLMDecision {
  action: Action
  faction?: string       // mint of target faction
  sol?: number           // SOL amount for join
  message?: string       // comms message
  reasoning?: string     // why (for logging)
  _rejected?: string     // rejection reason (set when action parsed but validation failed)
}

export interface FactionInfo {
  mint: string
  name: string
  symbol: string
  status: 'rising' | 'ready' | 'ascended' | 'razed'
}

export interface FactionIntel {
  symbol: string
  members: { address: string, percentage: number }[]
  totalMembers: number
  recentComms: { sender: string, memo: string }[]
}

// ─── Agent State ────────────────────────────────────────────────────

export interface AgentState {
  keypair: Keypair
  publicKey: string
  personality: Personality
  holdings: Map<string, number>   // mint -> approx token balance
  founded: string[]               // mints founded
  rallied: Set<string>            // mints already rallied
  voted: Set<string>              // mints already voted on
  hasStronghold: boolean
  vaultCreator?: string           // creator pubkey of linked vault (if different from agent)
  activeLoans: Set<string>        // mints with active war loans
  infiltrated: Set<string>        // mints we joined to sabotage (dump later)
  sentiment: Map<string, number>  // mint -> sentiment score (-10 to +10)
  allies: Set<string>             // agent pubkeys this agent trusts
  rivals: Set<string>             // agent pubkeys this agent distrusts
  actionCount: number
  lastAction: string
  recentHistory: string[]         // last N actions for LLM context
}

// ─── Public API Types ───────────────────────────────────────────────

/** Pluggable LLM interface — bring your own model */
export interface LLMAdapter {
  generate: (prompt: string) => Promise<string | null>
}

/** Configuration for creating a Pyre agent */
export interface PyreAgentConfig {
  /** Solana RPC connection */
  connection: Connection
  /** Agent's keypair (use createEphemeralAgent from torchsdk to generate one) */
  keypair: Keypair
  /** Network to operate on */
  network: 'devnet' | 'mainnet'
  /** LLM adapter for intelligent decisions (omit for random fallback) */
  llm?: LLMAdapter
  /** Override personality (auto-assigned if omitted) */
  personality?: Personality
  /** Override SOL spend range [min, max] per action */
  solRange?: [number, number]
  /** Max factions this agent can found (default: 2) */
  maxFoundedFactions?: number
  /** SOL to fund stronghold vault when topping up */
  strongholdFundSol?: number
  /** Vault balance threshold below which to top up */
  strongholdTopupThresholdSol?: number
  /** SOL reserve to keep in wallet (don't spend below this) */
  strongholdTopupReserveSol?: number
  /** Restore from a previously serialized state */
  state?: SerializedAgentState
  /** Logger function (defaults to console.log) */
  logger?: (msg: string) => void
}

/** Result of a single agent tick */
export interface AgentTickResult {
  action: Action
  faction?: string
  message?: string
  reasoning?: string
  success: boolean
  error?: string
  usedLLM: boolean
}

/** Serializable agent state for persistence */
export interface SerializedAgentState {
  publicKey: string
  personality: Personality
  holdings: Record<string, number>
  founded: string[]
  rallied: string[]
  voted: string[]
  hasStronghold: boolean
  vaultCreator?: string
  activeLoans: string[]
  infiltrated: string[]
  sentiment: Record<string, number>
  allies: string[]
  rivals: string[]
  actionCount: number
  lastAction: string
  recentHistory: string[]
}

/** The Pyre agent instance */
export interface PyreAgent {
  /** Agent's public key */
  readonly publicKey: string
  /** Agent's personality (emergent from on-chain history) */
  readonly personality: Personality
  /** Run one decision+action cycle */
  tick(factions?: FactionInfo[]): Promise<AgentTickResult>
  /** Recompute personality + weights from accumulated runtime actions. Returns true if personality changed. */
  evolve(): Promise<boolean>
  /** Get current mutable state */
  getState(): AgentState
  /** Serialize state for persistence */
  serialize(): SerializedAgentState
}

// ─── On-Chain History Types ──────────────────────────────────────

/** A single on-chain action parsed from transaction history */
export interface OnChainAction {
  signature: string
  timestamp: number
  action: Action | 'fund' | 'dex_buy' | 'dex_sell' | 'unknown'
  mint?: string          // faction mint involved
  memo?: string          // SPL memo if present
  otherAgents?: string[] // other signers/participants
}

/** State derived entirely from on-chain data */
export interface ChainDerivedState {
  /** Personality weights computed from action frequency */
  weights: number[]
  /** Classified personality from weight distribution */
  personality: Personality
  /** Sentiment from on-chain interactions (buys/sells/memos per faction) */
  sentiment: Map<string, number>
  /** Allies derived from shared factions + positive memos */
  allies: Set<string>
  /** Rivals derived from defections + negative memos */
  rivals: Set<string>
  /** SOL spending range derived from actual tx amounts */
  solRange: [number, number]
  /** Total on-chain actions */
  actionCount: number
  /** Recent action descriptions for LLM context */
  recentHistory: string[]
  /** Founded faction mints (agent was signer on CreateToken) */
  founded: string[]
  /** Agent's own memos as persistent memory */
  memories: string[]
  /** Raw parsed history */
  history: OnChainAction[]
}
