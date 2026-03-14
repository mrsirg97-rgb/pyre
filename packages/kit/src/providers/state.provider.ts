import { Connection, PublicKey } from '@solana/web3.js'

import { isPyreMint } from '../vanity'
import { isBlacklistedMint } from '../util'
import type {
  State,
  AgentGameState,
  SerializedGameState,
  TrackedAction,
  CheckpointConfig,
} from '../types/state.types'
import { Registry } from '../types/registry.types'

const EMPTY_COUNTS: Record<TrackedAction, number> = {
  join: 0,
  defect: 0,
  rally: 0,
  launch: 0,
  message: 0,
  reinforce: 0,
  war_loan: 0,
  repay_loan: 0,
  siege: 0,
  ascend: 0,
  raze: 0,
  tithe: 0,
  infiltrate: 0,
  fud: 0,
}

export class StateProvider implements State {
  private _state: AgentGameState | null = null
  private checkpointConfig: CheckpointConfig | null = null
  private ticksSinceCheckpoint = 0

  constructor(
    private connection: Connection,
    private registry: Registry,
    private publicKey: string,
  ) {}

  get state() {
    return this._state
  }
  get vaultCreator() {
    return this._state?.vaultCreator ?? null
  }
  get initialized() {
    return this._state?.initialized ?? false
  }
  get tick() {
    return this._state?.tick ?? 0
  }

  /** Configure auto-checkpoint behavior */
  setCheckpointConfig(config: CheckpointConfig) {
    this.checkpointConfig = config
  }

  async init(): Promise<AgentGameState> {
    if (this._state?.initialized) return this._state

    const state: AgentGameState = {
      publicKey: this.publicKey,
      vaultCreator: null,
      stronghold: null,
      tick: 0,
      actionCounts: { ...EMPTY_COUNTS },
      holdings: new Map(),
      activeLoans: new Set(),
      founded: [],
      rallied: new Set(),
      voted: new Set(),
      sentiment: new Map(),
      recentHistory: [],
      personalitySummary: null,
      totalSolSpent: 0,
      totalSolReceived: 0,
      initialized: false,
    }

    this._state = state

    // resolve vault link
    const { getVaultForWallet } = await import('torchsdk')
    try {
      const vault = await getVaultForWallet(this.connection, this.publicKey)
      if (vault) {
        state.vaultCreator = vault.creator
        state.stronghold = {
          address: vault.address,
          creator: vault.creator,
          authority: vault.authority,
          sol_balance: vault.sol_balance,
          total_deposited: vault.total_deposited,
          total_withdrawn: vault.total_withdrawn,
          total_spent: vault.total_spent,
          total_received: vault.total_received,
          linked_agents: vault.linked_wallets,
          created_at: vault.created_at,
        }
      }
    } catch {}

    try {
      const profile = await this.registry.getProfile(this.publicKey)
      if (profile) {
        state.personalitySummary = profile.personality_summary || null
        state.totalSolSpent = profile.total_sol_spent
        state.totalSolReceived = profile.total_sol_received

        state.actionCounts.join = Math.max(state.actionCounts.join, profile.joins)
        state.actionCounts.defect = Math.max(state.actionCounts.defect, profile.defects)
        state.actionCounts.rally = Math.max(state.actionCounts.rally, profile.rallies)
        state.actionCounts.launch = Math.max(state.actionCounts.launch, profile.launches)
        state.actionCounts.message = Math.max(state.actionCounts.message, profile.messages)
        state.actionCounts.reinforce = Math.max(state.actionCounts.reinforce, profile.reinforces)
        state.actionCounts.fud = Math.max(state.actionCounts.fud, profile.fuds)
        state.actionCounts.infiltrate = Math.max(state.actionCounts.infiltrate, profile.infiltrates)
        state.actionCounts.war_loan = Math.max(state.actionCounts.war_loan, profile.war_loans)
        state.actionCounts.repay_loan = Math.max(state.actionCounts.repay_loan, profile.repay_loans)
        state.actionCounts.siege = Math.max(state.actionCounts.siege, profile.sieges)
        state.actionCounts.ascend = Math.max(state.actionCounts.ascend, profile.ascends)
        state.actionCounts.raze = Math.max(state.actionCounts.raze, profile.razes)
        state.actionCounts.tithe = Math.max(state.actionCounts.tithe, profile.tithes)

        const totalFromCheckpoint = Object.values(state.actionCounts).reduce((a, b) => a + b, 0)
        state.tick = totalFromCheckpoint
      }
    } catch {}

    await this.refreshHoldings()
    state.initialized = true
    return state
  }

  async record(action: TrackedAction, mint?: string, description?: string): Promise<void> {
    if (!this._state) throw new Error('State not initialized — call init() first')

    this._state.tick++
    this._state.actionCounts[action]++
    this.ticksSinceCheckpoint++

    if (action === 'launch' && mint) {
      this._state.founded.push(mint)
    }

    if (mint) {
      this.updateSentiment(action, mint)
    }

    if (description) {
      this._state.recentHistory.push(description)
      if (this._state.recentHistory.length > 20) {
        this._state.recentHistory = this._state.recentHistory.slice(-20)
      }
    }

    await this.refreshHoldings()
    if (this.checkpointConfig && this.ticksSinceCheckpoint >= this.checkpointConfig.interval) {
      this.ticksSinceCheckpoint = 0
      this.onCheckpointDue?.()
    }
  }

  private updateSentiment(action: TrackedAction, mint: string): void {
    if (!this._state) return
    const current = this._state.sentiment.get(mint) ?? 0
    const SENTIMENT_DELTAS: Partial<Record<TrackedAction, number>> = {
      join: 1,
      reinforce: 1.5,
      defect: -2,
      rally: 3,
      infiltrate: -5,
      message: 0.5,
      fud: -1.5,
      war_loan: 1,
      launch: 3,
    }

    const delta = SENTIMENT_DELTAS[action] ?? 0
    if (delta !== 0) {
      this._state.sentiment.set(mint, Math.max(-10, Math.min(10, current + delta)))
    }
  }

  onCheckpointDue: (() => void) | null = null

  async refreshHoldings(): Promise<void> {
    if (!this._state) return

    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
    const walletPk = new PublicKey(this.publicKey)

    let walletValues: any[] = []
    try {
      const walletAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPk, {
        programId: TOKEN_2022_PROGRAM_ID,
      })
      walletValues = walletAccounts.value
    } catch {}

    let vaultValues: any[] = []
    if (this._state.stronghold) {
      try {
        const vaultPk = new PublicKey(this._state.stronghold.address)
        const vaultAccounts = await this.connection.getParsedTokenAccountsByOwner(vaultPk, {
          programId: TOKEN_2022_PROGRAM_ID,
        })
        vaultValues = vaultAccounts.value
      } catch {}
    }

    const newHoldings = new Map<string, number>()
    for (const a of [...walletValues, ...vaultValues]) {
      const mint = a.account.data.parsed.info.mint as string
      const balance = Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0)
      if (balance > 0 && isPyreMint(mint) && !isBlacklistedMint(mint)) {
        newHoldings.set(mint, (newHoldings.get(mint) ?? 0) + balance)
      }
    }

    this._state.holdings.clear()
    for (const [mint, balance] of newHoldings) {
      this._state.holdings.set(mint, balance)
    }
  }

  getSentiment(mint: string): number {
    return this._state?.sentiment.get(mint) ?? 0
  }

  get sentimentMap(): ReadonlyMap<string, number> {
    return this._state?.sentiment ?? new Map()
  }

  get history(): readonly string[] {
    return this._state?.recentHistory ?? []
  }

  getBalance(mint: string): number {
    return this._state?.holdings.get(mint) ?? 0
  }

  hasVoted(mint: string): boolean {
    return this._state?.voted.has(mint) ?? false
  }

  hasRallied(mint: string): boolean {
    return this._state?.rallied.has(mint) ?? false
  }

  markVoted(mint: string): void {
    this._state?.voted.add(mint)
  }

  markRallied(mint: string): void {
    this._state?.rallied.add(mint)
  }

  serialize(): SerializedGameState {
    if (!this._state) {
      return {
        publicKey: this.publicKey,
        vaultCreator: null,
        tick: 0,
        actionCounts: { ...EMPTY_COUNTS },
        holdings: {},
        activeLoans: [],
        founded: [],
        rallied: [],
        voted: [],
        sentiment: {},
        recentHistory: [],
        personalitySummary: null,
        totalSolSpent: 0,
        totalSolReceived: 0,
      }
    }

    return {
      publicKey: this._state.publicKey,
      vaultCreator: this._state.vaultCreator,
      tick: this._state.tick,
      actionCounts: { ...this._state.actionCounts },
      holdings: Object.fromEntries(this._state.holdings),
      activeLoans: Array.from(this._state.activeLoans),
      founded: [...this._state.founded],
      rallied: Array.from(this._state.rallied),
      voted: Array.from(this._state.voted),
      sentiment: Object.fromEntries(this._state.sentiment),
      recentHistory: this._state.recentHistory.slice(-20),
      personalitySummary: this._state.personalitySummary,
      totalSolSpent: this._state.totalSolSpent,
      totalSolReceived: this._state.totalSolReceived,
    }
  }

  hydrate(saved: SerializedGameState): void {
    this._state = {
      publicKey: saved.publicKey,
      vaultCreator: saved.vaultCreator,
      stronghold: null, // will be resolved on next refreshHoldings or init
      tick: saved.tick,
      actionCounts: { ...EMPTY_COUNTS, ...saved.actionCounts },
      holdings: new Map(Object.entries(saved.holdings)),
      activeLoans: new Set(saved.activeLoans),
      founded: [...saved.founded],
      rallied: new Set(saved.rallied),
      voted: new Set(saved.voted),
      sentiment: new Map(Object.entries(saved.sentiment)),
      recentHistory: [...saved.recentHistory],
      personalitySummary: saved.personalitySummary,
      totalSolSpent: saved.totalSolSpent,
      totalSolReceived: saved.totalSolReceived,
      initialized: true,
    }
  }
}
