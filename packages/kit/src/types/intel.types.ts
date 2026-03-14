import {
  AgentFactionPosition,
  AgentProfile,
  AllianceCluster,
  FactionPower,
  FactionStatus,
  RivalFaction,
  WorldEvent,
  WorldStats,
} from '../types'

export interface Intel {
  getAgentFactions(wallet: string, factionLimit?: number): Promise<AgentFactionPosition[]>
  getAgentProfile(wallet: string): Promise<AgentProfile>
  getAgentSolLamports(wallet: string): Promise<number>
  getAllies(mints: string[], holderLimit?: number): Promise<AllianceCluster[]>
  getFactionPower(mint: string): Promise<FactionPower>
  getFactionLeaderboard(opts?: { status?: FactionStatus; limit?: number }): Promise<FactionPower[]>
  getFactionRivals(mint: string, opts?: { limit?: number }): Promise<RivalFaction[]>
  getWorldFeed(opts?: { limit?: number; factionLimit?: number }): Promise<WorldEvent[]>
  getWorldStats(): Promise<WorldStats>
}
