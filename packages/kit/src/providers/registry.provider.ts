import { Connection, PublicKey, Transaction, VersionedTransaction, TransactionMessage, SystemProgram } from '@solana/web3.js'
import { BN, Program, AnchorProvider, type Wallet } from '@coral-xyz/anchor'
import type { TransactionResult } from 'torchsdk'

import type {
  RegistryProfile,
  RegistryWalletLink,
  RegisterAgentParams,
  CheckpointParams,
  LinkAgentWalletParams,
  UnlinkAgentWalletParams,
  TransferAgentAuthorityParams,
} from '../types'
import { Registry } from '../types/registry.types'

import idl from '../pyre_world.json'

export const REGISTRY_PROGRAM_ID = new PublicKey(idl.address)
const AGENT_SEED = 'pyre_agent'
const AGENT_WALLET_SEED = 'pyre_agent_wallet'

export const getAgentProfilePda = (creator: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(AGENT_SEED), creator.toBuffer()],
    REGISTRY_PROGRAM_ID,
  )

export const getAgentWalletLinkPda = (wallet: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(AGENT_WALLET_SEED), wallet.toBuffer()],
    REGISTRY_PROGRAM_ID,
  )

const makeDummyProvider = (connection: Connection, payer: PublicKey): AnchorProvider =>
  new AnchorProvider(
    connection,
    {
      publicKey: payer,
      signTransaction: async (t: Transaction) => t,
      signAllTransactions: async (t: Transaction[]) => t,
    } as unknown as Wallet,
    {},
  )

async function finalizeTransaction(
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey,
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash()
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

export class RegistryProvider implements Registry {
  private _programCache = new Map<string, Program>()

  constructor(private connection: Connection) {}

  private getProgram(payer: PublicKey): Program {
    const key = payer.toBase58()
    let program = this._programCache.get(key)
    if (!program) {
      const provider = makeDummyProvider(this.connection, payer)
      program = new Program(idl as any, provider)
      this._programCache.set(key, program)
    }
    return program
  }

  async getProfile(creator: string): Promise<RegistryProfile | undefined> {
    const creatorPk = new PublicKey(creator)
    const [profilePda] = getAgentProfilePda(creatorPk)
    const program = this.getProgram(creatorPk)
    try {
      const account = await (program.account as any).agentProfile.fetch(profilePda)
      return {
        address: profilePda.toBase58(),
        creator: account.creator.toBase58(),
        authority: account.authority.toBase58(),
        linked_wallet: account.linkedWallet.toBase58(),
        personality_summary: account.personalitySummary,
        last_checkpoint: account.lastCheckpoint.toNumber(),
        joins: account.joins.toNumber(),
        defects: account.defects.toNumber(),
        rallies: account.rallies.toNumber(),
        launches: account.launches.toNumber(),
        messages: account.messages.toNumber(),
        fuds: account.fuds.toNumber(),
        infiltrates: account.infiltrates.toNumber(),
        reinforces: account.reinforces.toNumber(),
        war_loans: account.warLoans.toNumber(),
        repay_loans: account.repayLoans.toNumber(),
        sieges: account.sieges.toNumber(),
        ascends: account.ascends.toNumber(),
        razes: account.razes.toNumber(),
        tithes: account.tithes.toNumber(),
        created_at: account.createdAt.toNumber(),
        bump: account.bump,
        total_sol_spent: account.totalSolSpent?.toNumber() ?? 0,
        total_sol_received: account.totalSolReceived?.toNumber() ?? 0,
      }
    } catch {
      return undefined
    }
  }

  async getWalletLink(wallet: string): Promise<RegistryWalletLink | undefined> {
    const walletPk = new PublicKey(wallet)
    const [linkPda] = getAgentWalletLinkPda(walletPk)
    const program = this.getProgram(walletPk)

    try {
      const account = await (program.account as any).agentWalletLink.fetch(linkPda)
      return {
        address: linkPda.toBase58(),
        profile: account.profile.toBase58(),
        wallet: account.wallet.toBase58(),
        linked_at: account.linkedAt.toNumber(),
        bump: account.bump,
      }
    } catch {
      return undefined
    }
  }

  async register(params: RegisterAgentParams): Promise<TransactionResult> {
    const creator = new PublicKey(params.creator)
    const [profile] = getAgentProfilePda(creator)
    const [walletLink] = getAgentWalletLinkPda(creator)
    const program = this.getProgram(creator)

    const tx = new Transaction()
    const ix = await (program.methods.register() as any)
      .accounts({ creator, profile, walletLink, systemProgram: SystemProgram.programId })
      .instruction()

    tx.add(ix)
    const versionedTx = await finalizeTransaction(this.connection, tx, creator)
    return {
      transaction: versionedTx,
      message: `Register agent profile [${profile.toBase58()}]`,
    }
  }

  async checkpoint(params: CheckpointParams): Promise<TransactionResult> {
    const signer = new PublicKey(params.signer)
    const creatorPk = new PublicKey(params.creator)
    const [profile] = getAgentProfilePda(creatorPk)
    const program = this.getProgram(signer)

    const args = {
      joins: new BN(params.joins),
      defects: new BN(params.defects),
      rallies: new BN(params.rallies),
      launches: new BN(params.launches),
      messages: new BN(params.messages),
      fuds: new BN(params.fuds),
      infiltrates: new BN(params.infiltrates),
      reinforces: new BN(params.reinforces),
      warLoans: new BN(params.war_loans),
      repayLoans: new BN(params.repay_loans),
      sieges: new BN(params.sieges),
      ascends: new BN(params.ascends),
      razes: new BN(params.razes),
      tithes: new BN(params.tithes),
      personalitySummary: params.personality_summary,
      totalSolSpent: new BN(params.total_sol_spent),
      totalSolReceived: new BN(params.total_sol_received),
    }

    const tx = new Transaction()
    const ix = await (program.methods.checkpoint(args) as any)
      .accounts({ signer, profile, systemProgram: SystemProgram.programId })
      .instruction()

    tx.add(ix)
    const versionedTx = await finalizeTransaction(this.connection, tx, signer)
    return {
      transaction: versionedTx,
      message: `Checkpoint agent [${profile.toBase58()}]`,
    }
  }

  async linkWallet(params: LinkAgentWalletParams): Promise<TransactionResult> {
    const authority = new PublicKey(params.authority)
    const creatorPk = new PublicKey(params.creator)
    const walletToLink = new PublicKey(params.wallet_to_link)
    const [profile] = getAgentProfilePda(creatorPk)
    const [walletLink] = getAgentWalletLinkPda(walletToLink)
    const program = this.getProgram(authority)

    const tx = new Transaction()
    const ix = await (program.methods.linkWallet() as any)
      .accounts({
        authority,
        profile,
        walletToLink,
        walletLink,
        systemProgram: SystemProgram.programId,
      })
      .instruction()

    tx.add(ix)
    const versionedTx = await finalizeTransaction(this.connection, tx, authority)
    return {
      transaction: versionedTx,
      message: `Link wallet ${walletToLink.toBase58()} to agent [${profile.toBase58()}]`,
    }
  }

  async unlinkWallet(params: UnlinkAgentWalletParams): Promise<TransactionResult> {
    const authority = new PublicKey(params.authority)
    const creatorPk = new PublicKey(params.creator)
    const walletToUnlink = new PublicKey(params.wallet_to_unlink)
    const [profile] = getAgentProfilePda(creatorPk)
    const [walletLink] = getAgentWalletLinkPda(walletToUnlink)
    const program = this.getProgram(authority)

    const tx = new Transaction()
    const ix = await (program.methods.unlinkWallet() as any)
      .accounts({
        authority,
        profile,
        walletToUnlink,
        walletLink,
        systemProgram: SystemProgram.programId,
      })
      .instruction()

    tx.add(ix)
    const versionedTx = await finalizeTransaction(this.connection, tx, authority)
    return {
      transaction: versionedTx,
      message: `Unlink wallet ${walletToUnlink.toBase58()} from agent [${profile.toBase58()}]`,
    }
  }

  async transferAuthority(params: TransferAgentAuthorityParams): Promise<TransactionResult> {
    const authority = new PublicKey(params.authority)
    const creatorPk = new PublicKey(params.creator)
    const newAuthority = new PublicKey(params.new_authority)
    const [profile] = getAgentProfilePda(creatorPk)
    const program = this.getProgram(authority)

    const tx = new Transaction()
    const ix = await (program.methods.transferAuthority() as any)
      .accounts({ authority, profile, newAuthority })
      .instruction()

    tx.add(ix)
    const versionedTx = await finalizeTransaction(this.connection, tx, authority)
    return {
      transaction: versionedTx,
      message: `Transfer agent authority to ${newAuthority.toBase58()}`,
    }
  }
}
