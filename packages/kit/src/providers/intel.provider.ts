import { Connection, PublicKey } from '@solana/web3.js'
import { MapperProvider } from './mapper.provider'
import {
  AgentFactionPosition,
  AgentProfile,
  AllianceCluster,
  FactionPower,
  FactionDetail,
  FactionSummary,
  FactionStatus,
  WorldEvent,
  WorldStats,
  RivalFaction,
} from '../types'
import { Intel } from '../types/intel.types'
import { getBondingCurvePda, getTokenTreasuryPda, getTreasuryLockPda, isPyreMint } from '../vanity'
import { isBlacklistedMint } from '../util'
import { Action } from '../types/action.types'

export class IntelProvider implements Intel {
  constructor(
    private connection: Connection,
    private actionProvider: Action,
  ) {}

  async getAgentFactions(wallet: string, factionLimit = 50): Promise<AgentFactionPosition[]> {
    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
    const walletPk = new PublicKey(wallet)

    // Scan wallet token accounts
    const walletAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPk, {
      programId: TOKEN_2022_PROGRAM_ID,
    })

    // Scan vault token accounts if a vault exists
    let vaultAccounts: typeof walletAccounts = { context: walletAccounts.context, value: [] }
    try {
      const vault = await this.actionProvider.getStrongholdForAgent(wallet)
      if (!vault) throw new Error('no vault')
      const vaultPk = new PublicKey(vault.address)
      vaultAccounts = await this.connection.getParsedTokenAccountsByOwner(vaultPk, {
        programId: TOKEN_2022_PROGRAM_ID,
      })
    } catch {}

    // Merge balances from both sources (wallet + vault)
    const balanceMap = new Map<string, number>()
    for (const a of [...walletAccounts.value, ...vaultAccounts.value]) {
      const mint = a.account.data.parsed.info.mint as string
      const balance = Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0)
      if (balance > 0 && isPyreMint(mint) && !isBlacklistedMint(mint)) {
        balanceMap.set(mint, (balanceMap.get(mint) ?? 0) + balance)
      }
    }

    if (balanceMap.size === 0) return []

    // Fetch faction metadata for held mints
    const allFactions = await this.actionProvider.getFactions({ limit: factionLimit })
    const factionMap = new Map(allFactions.factions.map((t) => [t.mint, t]))

    const positions: AgentFactionPosition[] = []
    for (const [mint, balance] of balanceMap) {
      const faction = factionMap.get(mint)
      if (!faction) continue

      // balance / 1B total supply
      const percentage = (balance / 1_000_000_000) * 100
      positions.push({
        mint,
        name: faction.name,
        symbol: faction.symbol,
        balance,
        percentage,
        value_sol: balance * faction.price_sol,
      })
    }

    positions.sort((a, b) => b.value_sol - a.value_sol)
    return positions
  }

  async getAgentProfile(wallet: string): Promise<AgentProfile> {
    const vault = await this.actionProvider.getStrongholdForAgent(wallet)
    const factions = await this.getAgentFactions(wallet)
    const totalValue = factions.reduce((sum, f) => sum + f.value_sol, 0)
    return {
      wallet,
      stronghold: vault
        ? {
            address: vault.address,
            creator: vault.creator,
            authority: vault.authority,
            sol_balance: vault.sol_balance,
            total_deposited: vault.total_deposited,
            total_withdrawn: vault.total_withdrawn,
            total_spent: vault.total_spent,
            total_received: vault.total_received,
            linked_agents: vault.linked_agents,
            created_at: vault.created_at,
          }
        : null,
      factions_joined: factions,
      factions_founded: [], // Would need per-token creator lookup
      total_value_sol: totalValue + (vault?.sol_balance ?? 0),
    }
  }

  async getAgentSolLamports(wallet: string): Promise<number> {
    const walletPk = new PublicKey(wallet)
    let total = 0
    try {
      total += await this.connection.getBalance(walletPk)
    } catch {}
    try {
      const vault = await this.actionProvider.getStrongholdForAgent(wallet)
      if (vault) total += Math.round(vault.sol_balance * 1e9)
    } catch {}
    return total
  }

  async getAllies(mints: string[], holderLimit = 50): Promise<AllianceCluster[]> {
    const holdersPerFaction = await Promise.all(
      mints.map(async (mint) => {
        const result = await this.getPyreHolders(mint, holderLimit)
        return { mint, holders: new Set(result.members.map((h) => h.address)) }
      }),
    )

    // Find overlapping holders between faction pairs
    const clusters: AllianceCluster[] = []
    for (let i = 0; i < holdersPerFaction.length; i++) {
      for (let j = i + 1; j < holdersPerFaction.length; j++) {
        const a = holdersPerFaction[i]
        const b = holdersPerFaction[j]
        const shared = [...a.holders].filter((h) => b.holders.has(h))
        if (shared.length > 0) {
          const minSize = Math.min(a.holders.size, b.holders.size)
          clusters.push({
            factions: [a.mint, b.mint],
            shared_members: shared.length,
            overlap_percent: minSize > 0 ? (shared.length / minSize) * 100 : 0,
          })
        }
      }
    }

    clusters.sort((a, b) => b.shared_members - a.shared_members)
    return clusters
  }

  async getFactionPower(mint: string): Promise<FactionPower> {
    const t = await this.actionProvider.getFaction(mint)
    const score = this.computePowerScore(t)
    return {
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      score,
      market_cap_sol: t.market_cap_sol,
      members: t.members ?? 0,
      war_chest_sol: t.war_chest_sol,
      rallies: t.rallies,
      progress_percent: t.progress_percent,
      status: t.status,
    }
  }

  async getFactionLeaderboard({
    status,
    limit,
  }: {
    status?: FactionStatus
    limit?: number
  }): Promise<FactionPower[]> {
    const statusMap: Record<FactionStatus, string> = {
      rising: 'bonding',
      ready: 'complete',
      ascended: 'migrated',
      razed: 'reclaimed',
    }

    const fetchLimit = Math.min((limit ?? 20) * 3, 100)
    const { factions } = await this.actionProvider.getFactions({
      limit: fetchLimit,
      status: status,
    })
    const powers: FactionPower[] = factions.map((t) => ({
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      score: this.computePowerScoreFromSummary(t),
      market_cap_sol: t.market_cap_sol,
      members: t.members ?? 0,
      war_chest_sol: 0, // Not available in summary
      rallies: 0, // Not available in summary
      progress_percent: t.progress_percent,
      status: t.status,
    }))

    powers.sort((a, b) => b.score - a.score)
    return powers
  }

  async getFactionRivals(
    mint: string,
    { limit = 50 }: { limit?: number },
  ): Promise<RivalFaction[]> {
    const { comms } = await this.actionProvider.getComms(mint, { limit })
    const defectors = new Set(comms.map((m) => m.sender))
    const rivalCounts = new Map<string, { in: number; out: number }>()
    const { factions } = await this.actionProvider.getFactions({ limit: 20, sort: 'volume' })
    for (const faction of factions) {
      if (faction.mint === mint) continue
      const { members } = await this.getPyreHolders(faction.mint, 50)
      const holderAddrs = new Set(members.map((h) => h.address))
      const overlap = [...defectors].filter((d) => holderAddrs.has(d)).length
      if (overlap > 0) {
        rivalCounts.set(faction.mint, {
          in: overlap,
          out: overlap,
          ...(rivalCounts.get(faction.mint) ?? {}),
        })
      }
    }

    const rivals: RivalFaction[] = []
    for (const [rivalMint, counts] of rivalCounts) {
      const faction = factions.find((t) => t.mint === rivalMint)
      if (faction) {
        rivals.push({
          mint: rivalMint,
          name: faction.name,
          symbol: faction.symbol,
          defections_in: counts.in,
          defections_out: counts.out,
        })
      }
    }

    rivals.sort((a, b) => b.defections_in + b.defections_out - (a.defections_in + a.defections_out))
    return rivals
  }

  async getWorldFeed({
    limit,
    factionLimit,
  }: {
    limit?: number
    factionLimit?: number
  }): Promise<WorldEvent[]> {
    const fLimit = factionLimit ?? 20
    const msgLimit = limit ?? 5
    const allFactions = await this.actionProvider.getFactions({ limit: fLimit, sort: 'newest' })
    const events: WorldEvent[] = []
    for (const faction of allFactions.factions) {
      events.push({
        type: 'launch',
        faction_mint: faction.mint,
        faction_name: faction.name,
        timestamp: faction.created_at,
      })

      if (faction.status === 'ascended') {
        events.push({
          type: 'ascend',
          faction_mint: faction.mint,
          faction_name: faction.name,
          timestamp: faction.last_activity_at,
        })
      } else if (faction.status === 'razed') {
        events.push({
          type: 'raze',
          faction_mint: faction.mint,
          faction_name: faction.name,
          timestamp: faction.last_activity_at,
        })
      }
    }

    const topFactions = allFactions.factions.slice(0, 10)
    await Promise.all(
      topFactions.map(async (faction) => {
        try {
          const { comms } = await this.actionProvider.getComms(faction.mint, { limit: msgLimit })
          for (const msg of comms) {
            events.push({
              type: 'join', // Messages are trade-bundled, most are buys
              faction_mint: faction.mint,
              faction_name: faction.name,
              agent: msg.sender,
              timestamp: msg.timestamp,
              signature: msg.signature,
              message: msg.memo,
            })
          }
        } catch {
          // Skip factions with no messages
        }
      }),
    )
    events.sort((a, b) => b.timestamp - a.timestamp)
    return events.slice(0, limit ?? 100)
  }

  async getWorldStats(): Promise<WorldStats> {
    const { factions } = await this.actionProvider.getFactions({ limit: 200, status: 'all' })
    const pyreRising = factions.filter((t) => t.status === 'rising')
    const pyreAscended = factions.filter((t) => t.status === 'ascended')
    const allFactions = [...pyreRising, ...pyreAscended]
    const totalSolLocked = allFactions.reduce((sum, t) => sum + t.market_cap_sol, 0)

    let mostPowerful: FactionPower | null = null
    let maxScore = 0
    for (const t of allFactions) {
      const score = this.computePowerScoreFromSummary(t)
      if (score > maxScore) {
        maxScore = score
        mostPowerful = {
          mint: t.mint,
          name: t.name,
          symbol: t.symbol,
          score,
          market_cap_sol: t.market_cap_sol,
          members: t.members ?? 0,
          war_chest_sol: 0,
          rallies: 0,
          progress_percent: t.progress_percent,
          status: t.status,
        }
      }
    }

    return {
      total_factions: factions.length,
      rising_factions: pyreRising.length,
      ascended_factions: pyreAscended.length,
      total_sol_locked: totalSolLocked,
      most_powerful: mostPowerful,
    }
  }

  private computePowerScore(t: FactionDetail) {
    const mcWeight = 0.4
    const memberWeight = 0.2
    const chestWeight = 0.2
    const rallyWeight = 0.1
    const progressWeight = 0.1
    return (
      t.market_cap_sol * mcWeight +
      (t.members ?? 0) * memberWeight +
      t.war_chest_sol * chestWeight +
      t.rallies * rallyWeight +
      t.progress_percent * progressWeight
    )
  }

  private computePowerScoreFromSummary(t: FactionSummary) {
    const mcWeight = 0.4
    const memberWeight = 0.2
    const progressWeight = 0.1
    return (
      t.market_cap_sol * mcWeight +
      (t.members ?? 0) * memberWeight +
      t.progress_percent * progressWeight
    )
  }

  private async getPyreHolders(mint: string, limit: number) {
    const mintPk = new PublicKey(mint)
    const [bondingCurve] = getBondingCurvePda(mintPk)
    const [treasury] = getTokenTreasuryPda(mintPk)
    const [treasuryLock] = getTreasuryLockPda(mintPk)
    const excluded = new Set([
      bondingCurve.toString(),
      treasury.toString(),
      treasuryLock.toString(),
    ])
    const result = await this.actionProvider.getMembers(mint, limit + 5)
    result.members = result.members.filter((h) => !excluded.has(h.address)).slice(0, limit)
    return result
  }
}
