import {
  AllLoanPositionsResult,
  BuyTransactionResult,
  CreateTokenResult,
  Holder,
  HoldersResult,
  LendingInfo,
  LoanPositionInfo,
  LoanPositionWithKey,
  MessagesResult,
  TokenDetail,
  TokenListResult,
  TokenMessage,
  TokenStatus,
  TokenStatusFilter,
  TokenSummary,
  VaultInfo,
  VaultWalletLinkInfo,
} from 'torchsdk'
import {
  AgentLink,
  AllWarLoansResult,
  Comms,
  CommsResult,
  FactionDetail,
  FactionListResult,
  FactionStatus,
  FactionStatusFilter,
  FactionSummary,
  JoinFactionResult,
  LaunchFactionResult,
  Member,
  MembersResult,
  Stronghold,
  WarChest,
  WarLoan,
  WarLoanWithAgent,
} from '../types'

export interface Mapper {
  allLoansResult(r: AllLoanPositionsResult): AllWarLoansResult
  buyResult(r: BuyTransactionResult): JoinFactionResult
  createResult(r: CreateTokenResult): LaunchFactionResult
  factionStatus(status: TokenStatus): FactionStatus
  holdersResult(r: HoldersResult): MembersResult
  holderToMember(h: Holder): Member
  lendingToWarChest(l: LendingInfo): WarChest
  loanToWarLoan(l: LoanPositionInfo): WarLoan
  loanWithKeyToWarLoan(l: LoanPositionWithKey): WarLoanWithAgent
  messagesResult(r: MessagesResult): CommsResult
  tokenDetailToFaction(t: TokenDetail): FactionDetail
  tokenListResult(r: TokenListResult): FactionListResult
  tokenMessageToComms(m: TokenMessage): Comms
  tokenStatus(status: FactionStatus): TokenStatus
  tokenStatusFilter(status: FactionStatusFilter): TokenStatusFilter
  tokenSummaryToFaction(t: TokenSummary): FactionSummary
  vaultToStronghold(v: VaultInfo): Stronghold
  walletLinkToAgentLink(l: VaultWalletLinkInfo): AgentLink
}

export const STATUS_MAP: Record<TokenStatus, FactionStatus> = {
  bonding: 'rising',
  complete: 'ready',
  migrated: 'ascended',
  reclaimed: 'razed',
}

export const STATUS_REVERSE: Record<FactionStatus, TokenStatus> = {
  rising: 'bonding',
  ready: 'complete',
  ascended: 'migrated',
  razed: 'reclaimed',
}

export const STATUS_FILTER_REVERSE: Record<FactionStatusFilter, TokenStatusFilter> = {
  rising: 'bonding',
  ready: 'complete',
  ascended: 'migrated',
  razed: 'reclaimed',
  all: 'all',
}
