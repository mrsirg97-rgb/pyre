import { Connection, GetProgramAccountsFilter, PublicKey } from '@solana/web3.js'
import {
  buildBorrowTransaction,
  buildBuyTransaction,
  buildClaimProtocolRewardsTransaction,
  buildCreateVaultTransaction,
  buildDepositVaultTransaction,
  buildLinkWalletTransaction,
  buildLiquidateTransaction,
  buildMigrateTransaction,
  buildReclaimFailedTokenTransaction,
  buildRepayTransaction,
  buildSellTransaction,
  buildStarTransaction,
  buildSwapFeesToSolTransaction,
  buildTransferAuthorityTransaction,
  buildUnlinkWalletTransaction,
  buildVaultSwapTransaction,
  buildWithdrawTokensTransaction,
  buildWithdrawVaultTransaction,
  BuyQuoteResult,
  getAllLoanPositions,
  getBorrowQuote,
  getBuyQuote,
  getHolders,
  getLendingInfo,
  getLoanPosition,
  getMessages,
  getSellQuote,
  getToken,
  getTokens,
  getVault,
  getVaultForWallet,
  getVaultWalletLink,
  PROGRAM_ID,
  SellQuoteResult,
  TransactionResult,
} from 'torchsdk'

import { MapperProvider } from './mapper.provider'
import {
  buildCreateFactionTransaction,
  getBondingCurvePda,
  getTokenTreasuryPda,
  getTreasuryLockPda,
  isPyreMint,
} from '../vanity'
import { isBlacklistedMint } from '../util'
import {
  AgentLink,
  AllWarLoansResult,
  AscendParams,
  ClaimSpoilsParams,
  CommsResult,
  CoupParams,
  CreateStrongholdParams,
  DefectParams,
  ExileAgentParams,
  FactionDetail,
  FactionListParams,
  FactionListResult,
  FactionStatus,
  FudFactionParams,
  FundStrongholdParams,
  JoinFactionParams,
  JoinFactionResult,
  LaunchFactionParams,
  LaunchFactionResult,
  MembersResult,
  MessageFactionParams,
  RallyParams,
  RazeParams,
  RecruitAgentParams,
  RepayWarLoanParams,
  RequestWarLoanParams,
  SiegeParams,
  Strategy,
  Stronghold,
  TitheParams,
  WarChest,
  WarLoan,
  WarLoanQuote,
  WithdrawAssetsParams,
  WithdrawFromStrongholdParams,
} from '../types'
import { Action } from '../types/action.types'
import { Registry } from '../types/registry.types'

export class ActionProvider implements Action {
  private mapper = new MapperProvider()
  constructor(
    private connection: Connection,
    private registryProvider: Registry,
  ) {}

  async createStronghold(params: CreateStrongholdParams): Promise<TransactionResult> {
    return buildCreateVaultTransaction(this.connection, { creator: params.creator })
  }

  async coup(params: CoupParams): Promise<TransactionResult> {
    return buildTransferAuthorityTransaction(this.connection, {
      authority: params.authority,
      vault_creator: params.stronghold_creator,
      new_authority: params.new_authority,
    })
  }

  async exileAgent(params: ExileAgentParams): Promise<TransactionResult> {
    return buildUnlinkWalletTransaction(this.connection, {
      authority: params.authority,
      vault_creator: params.stronghold_creator,
      wallet_to_unlink: params.wallet_to_unlink,
    })
  }

  async fundStronghold(params: FundStrongholdParams): Promise<TransactionResult> {
    return buildDepositVaultTransaction(this.connection, {
      depositor: params.depositor,
      vault_creator: params.stronghold_creator,
      amount_sol: params.amount_sol,
    })
  }

  async recruitAgent(params: RecruitAgentParams): Promise<TransactionResult> {
    return buildLinkWalletTransaction(this.connection, {
      authority: params.authority,
      vault_creator: params.stronghold_creator,
      wallet_to_link: params.wallet_to_link,
    })
  }

  async withdrawAssets(params: WithdrawAssetsParams): Promise<TransactionResult> {
    return buildWithdrawTokensTransaction(this.connection, {
      authority: params.authority,
      vault_creator: params.stronghold_creator,
      mint: params.mint,
      destination: params.destination,
      amount: params.amount,
    })
  }

  async withdrawFromStronghold(params: WithdrawFromStrongholdParams): Promise<TransactionResult> {
    return buildWithdrawVaultTransaction(this.connection, {
      authority: params.authority,
      vault_creator: params.stronghold_creator,
      amount_sol: params.amount_sol,
    })
  }

  async getAgentLink(wallet: string): Promise<AgentLink | undefined> {
    const link = await getVaultWalletLink(this.connection, wallet)
    return link ? this.mapper.walletLinkToAgentLink(link) : undefined
  }

  async getComms(
    mint: string,
    { limit, status }: { limit?: number; status?: FactionStatus },
  ): Promise<CommsResult> {
    const source = status === 'ascended' ? 'pool' : status ? 'bonding' : 'all'
    const result = await getMessages(this.connection, mint, limit, { source })
    return this.mapper.messagesResult(result)
  }

  async getDefectQuote(mint: string, amountTokens: number): Promise<SellQuoteResult> {
    return getSellQuote(this.connection, mint, amountTokens)
  }

  async getJoinQuote(mint: string, amountSolLamports: number): Promise<BuyQuoteResult> {
    return getBuyQuote(this.connection, mint, amountSolLamports)
  }

  async getFaction(mint: string): Promise<FactionDetail> {
    const detail = await getToken(this.connection, mint)
    return this.mapper.tokenDetailToFaction(detail)
  }

  async getFactions(params?: FactionListParams): Promise<FactionListResult> {
    const sdkParams = params
      ? {
          limit: params.limit,
          offset: params.offset,
          status: params.status ? this.mapper.tokenStatusFilter(params.status) : undefined,
          sort: params.sort,
        }
      : undefined
    const result = await getTokens(this.connection, sdkParams)
    const tokens = result.tokens.filter((t) => isPyreMint(t.mint))
    return this.mapper.tokenListResult({
      tokens: result.tokens.filter((t) => isPyreMint(t.mint) && !isBlacklistedMint(t.mint)),
      limit: result.limit,
      offset: result.offset,
      total: tokens.length,
    })
  }

  async getLinkedAgents(vaultAddress: string): Promise<AgentLink[]> {
    const vaultPubkey = new PublicKey(vaultAddress)
    const filters: GetProgramAccountsFilter[] = [
      { dataSize: 81 }, // 8 + 32 + 32 + 8 + 1
      { memcmp: { offset: 8, bytes: vaultPubkey.toBase58() } },
    ]

    const accounts = await this.connection.getProgramAccounts(PROGRAM_ID, { filters })
    return accounts.map((acc) => {
      const data = acc.account.data
      const wallet = new PublicKey(data.subarray(40, 72)).toBase58()
      const linked_at = Number(data.readBigInt64LE(72))
      return {
        address: acc.pubkey.toBase58(),
        stronghold: vaultAddress,
        wallet,
        linked_at,
      }
    })
  }

  async getMembers(mint: string, limit?: number): Promise<MembersResult> {
    const mintPk = new PublicKey(mint)
    const [bondingCurve] = getBondingCurvePda(mintPk)
    const [treasury] = getTokenTreasuryPda(mintPk)
    const [treasuryLock] = getTreasuryLockPda(mintPk)
    const excluded = new Set([
      bondingCurve.toString(),
      treasury.toString(),
      treasuryLock.toString(),
    ])

    // Fetch extra to compensate for filtered-out program accounts
    const result = await getHolders(this.connection, mint, (limit ?? 10) + 5)
    result.holders = result.holders.filter((h) => !excluded.has(h.address))
    if (limit) result.holders = result.holders.slice(0, limit)
    return this.mapper.holdersResult(result)
  }

  async getStronghold(creator: string): Promise<Stronghold | undefined> {
    const vault = await getVault(this.connection, creator)
    return vault ? this.mapper.vaultToStronghold(vault) : undefined
  }

  async getStrongholdForAgent(wallet: string): Promise<Stronghold | undefined> {
    const vault = await getVaultForWallet(this.connection, wallet)
    return vault ? this.mapper.vaultToStronghold(vault) : undefined
  }

  async getWarChest(mint: string): Promise<WarChest> {
    const info = await getLendingInfo(this.connection, mint)
    return this.mapper.lendingToWarChest(info)
  }

  async getWarLoan(mint: string, wallet: string): Promise<WarLoan> {
    const pos = await getLoanPosition(this.connection, mint, wallet)
    return this.mapper.loanToWarLoan(pos)
  }

  async getWarLoanQuote(mint: string, collateralAmount: number): Promise<WarLoanQuote> {
    return getBorrowQuote(this.connection, mint, collateralAmount)
  }

  async getWarLoansForFaction(mint: string): Promise<AllWarLoansResult> {
    const result = await getAllLoanPositions(this.connection, mint)
    return this.mapper.allLoansResult(result)
  }

  async ascend(params: AscendParams): Promise<TransactionResult> {
    return buildMigrateTransaction(this.connection, {
      mint: params.mint,
      payer: params.payer,
    })
  }

  async claimSpoils(params: ClaimSpoilsParams): Promise<TransactionResult> {
    return buildClaimProtocolRewardsTransaction(this.connection, {
      user: params.agent,
      vault: params.stronghold,
    })
  }

  async defect(params: DefectParams): Promise<TransactionResult> {
    if (params.ascended) {
      const slippage = params.slippage_bps ?? 500
      const quote = await getSellQuote(this.connection, params.mint, params.amount_tokens)
      const minOut = Math.max(1, Math.floor(quote.output_sol * (1 - slippage / 10_000)))
      return buildVaultSwapTransaction(this.connection, {
        mint: params.mint,
        signer: params.agent,
        vault_creator: params.stronghold,
        amount_in: params.amount_tokens,
        minimum_amount_out: minOut,
        is_buy: false,
        message: params.message,
      })
    }
    return buildSellTransaction(this.connection, {
      mint: params.mint,
      seller: params.agent,
      amount_tokens: params.amount_tokens,
      slippage_bps: params.slippage_bps,
      message: params.message,
      vault: params.stronghold,
    })
  }

  async fud(params: FudFactionParams): Promise<TransactionResult> {
    const MICRO_SELL_TOKENS = 100
    if (params.ascended) {
      const quote = await getSellQuote(this.connection, params.mint, MICRO_SELL_TOKENS)
      const minOut = Math.max(1, Math.floor(quote.output_sol * (1 - 500 / 10_000)))
      return buildVaultSwapTransaction(this.connection, {
        mint: params.mint,
        signer: params.agent,
        vault_creator: params.stronghold,
        amount_in: MICRO_SELL_TOKENS,
        minimum_amount_out: minOut,
        is_buy: false,
        message: params.message,
      })
    }
    return buildSellTransaction(this.connection, {
      mint: params.mint,
      seller: params.agent,
      amount_tokens: MICRO_SELL_TOKENS,
      message: params.message,
      vault: params.stronghold,
    })
  }

  async join(params: JoinFactionParams): Promise<JoinFactionResult> {
    if (params.ascended) {
      const slippage = params.slippage_bps ?? 500
      const quote = await getBuyQuote(this.connection, params.mint, params.amount_sol)
      const minOut = Math.max(1, Math.floor(quote.tokens_to_user * (1 - slippage / 10_000)))
      const result = await buildVaultSwapTransaction(this.connection, {
        mint: params.mint,
        signer: params.agent,
        vault_creator: params.stronghold,
        amount_in: params.amount_sol,
        minimum_amount_out: minOut,
        is_buy: true,
        message: params.message,
      })
      return this.mapper.buyResult(result)
    }
    const result = await buildBuyTransaction(this.connection, {
      mint: params.mint,
      buyer: params.agent,
      amount_sol: params.amount_sol,
      slippage_bps: params.slippage_bps,
      vote: params.strategy ? this.mapper.vote(params.strategy) : undefined,
      message: params.message,
      vault: params.stronghold,
    })
    return this.mapper.buyResult(result)
  }

  async launch(params: LaunchFactionParams): Promise<LaunchFactionResult> {
    const result = await buildCreateFactionTransaction(this.connection, {
      creator: params.founder,
      name: params.name,
      symbol: params.symbol,
      metadata_uri: params.metadata_uri,
      sol_target: params.sol_target,
      community_token: params.community_faction,
    })
    return this.mapper.createResult(result)
  }

  async message(params: MessageFactionParams): Promise<TransactionResult> {
    const MICRO_BUY_LAMPORTS = 1_000_000 // 0.001 SOL
    if (params.ascended) {
      const quote = await getBuyQuote(this.connection, params.mint, MICRO_BUY_LAMPORTS)
      const minOut = Math.max(1, Math.floor(quote.tokens_to_user * (1 - 500 / 10_000)))
      const result = await buildVaultSwapTransaction(this.connection, {
        mint: params.mint,
        signer: params.agent,
        vault_creator: params.stronghold,
        amount_in: MICRO_BUY_LAMPORTS,
        minimum_amount_out: minOut,
        is_buy: true,
        message: params.message,
      })
      return this.mapper.buyResult(result)
    }
    const result = await buildBuyTransaction(this.connection, {
      mint: params.mint,
      buyer: params.agent,
      amount_sol: MICRO_BUY_LAMPORTS,
      message: params.message,
      vault: params.stronghold,
      vote: params.first_buy
        ? this.mapper.vote(Math.random() > 0.5 ? 'fortify' : ('scorched_earth' as Strategy))
        : undefined,
    })
    return this.mapper.buyResult(result)
  }

  async rally(params: RallyParams): Promise<TransactionResult> {
    return buildStarTransaction(this.connection, {
      mint: params.mint,
      user: params.agent,
      vault: params.stronghold,
    })
  }

  async raze(params: RazeParams): Promise<TransactionResult> {
    return buildReclaimFailedTokenTransaction(this.connection, {
      payer: params.payer,
      mint: params.mint,
    })
  }

  async repayWarLoan(params: RepayWarLoanParams): Promise<TransactionResult> {
    return buildRepayTransaction(this.connection, {
      mint: params.mint,
      borrower: params.borrower,
      sol_amount: params.sol_amount,
      vault: params.stronghold,
    })
  }

  async requestWarLoan(params: RequestWarLoanParams): Promise<TransactionResult> {
    return buildBorrowTransaction(this.connection, {
      mint: params.mint,
      borrower: params.borrower,
      collateral_amount: params.collateral_amount,
      sol_to_borrow: params.sol_to_borrow,
      vault: params.stronghold,
    })
  }

  async scout(targetAddress: string): Promise<string> {
    try {
      const p = await this.registryProvider.getProfile(targetAddress)
      if (!p) return `  @${targetAddress.slice(0, 8)}: no pyre identity found`

      const total =
        p.joins +
        p.defects +
        p.rallies +
        p.launches +
        p.messages +
        p.fuds +
        p.infiltrates +
        p.reinforces +
        p.war_loans +
        p.repay_loans +
        p.sieges +
        p.ascends +
        p.razes +
        p.tithes

      const topActions = [
        { n: 'joins', v: p.joins },
        { n: 'defects', v: p.defects },
        { n: 'rallies', v: p.rallies },
        { n: 'messages', v: p.messages },
        { n: 'fuds', v: p.fuds },
        { n: 'infiltrates', v: p.infiltrates },
        { n: 'reinforces', v: p.reinforces },
        { n: 'war_loans', v: p.war_loans },
        { n: 'sieges', v: p.sieges },
      ]
        .sort((a, b) => b.v - a.v)
        .filter((a) => a.v > 0)
        .slice(0, 4)
        .map((a) => `${a.n}:${a.v}`)
        .join(', ')

      const personality = p.personality_summary || 'unknown'
      const checkpoint =
        p.last_checkpoint > 0
          ? new Date(p.last_checkpoint * 1000).toISOString().slice(0, 10)
          : 'never'

      const spent = (p.total_sol_spent ?? 0) / 1e9
      const received = (p.total_sol_received ?? 0) / 1e9
      const pnl = received - spent
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(3)}` : pnl.toFixed(3)

      return `  @${targetAddress.slice(0, 8)}: "${personality}" | ${total} actions (${topActions}) | P&L: ${pnlStr} SOL | last seen: ${checkpoint}`
    } catch {
      return `  @${targetAddress.slice(0, 8)}: lookup failed`
    }
  }

  async siege(params: SiegeParams): Promise<TransactionResult> {
    return buildLiquidateTransaction(this.connection, {
      mint: params.mint,
      liquidator: params.liquidator,
      borrower: params.borrower,
      vault: params.stronghold,
    })
  }

  async tithe(params: TitheParams): Promise<TransactionResult> {
    return buildSwapFeesToSolTransaction(this.connection, {
      mint: params.mint,
      payer: params.payer,
      minimum_amount_out: params.minimum_amount_out,
      harvest: true,
      sources: params.sources,
    })
  }
}
