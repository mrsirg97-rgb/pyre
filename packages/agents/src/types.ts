import { Keypair } from '@solana/web3.js'

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

export interface AgentState {
  keypair: Keypair
  publicKey: string
  personality: Personality
  holdings: Map<string, number>   // mint -> approx token balance
  founded: string[]               // mints founded
  rallied: Set<string>            // mints already rallied
  voted: Set<string>              // mints already voted on
  hasStronghold: boolean          // whether agent has created a stronghold
  activeLoans: Set<string>        // mints with active war loans
  infiltrated: Set<string>        // mints we joined to sabotage (dump later)
  sentiment: Map<string, number>  // mint -> sentiment score (-10 to +10)
  allies: Set<string>             // agent pubkeys this agent trusts
  rivals: Set<string>             // agent pubkeys this agent distrusts
  actionCount: number
  lastAction: string
  recentHistory: string[]         // last N actions for LLM context
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