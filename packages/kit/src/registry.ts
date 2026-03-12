/**
 * Pyre World Agent Registry
 *
 * On-chain agent identity and state persistence.
 * Agents checkpoint their action distributions and personality summaries
 * so any machine with the wallet key can reconstruct the agent.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import { BN, Program, AnchorProvider, type Wallet } from '@coral-xyz/anchor';
import type { TransactionResult } from 'torchsdk';
import type {
  RegistryProfile,
  RegistryWalletLink,
  RegisterAgentParams,
  CheckpointParams,
  LinkAgentWalletParams,
  UnlinkAgentWalletParams,
  TransferAgentAuthorityParams,
} from './types';

import idl from './pyre_world.json';

// ─── Program ID ─────────────────────────────────────────────────────

export const REGISTRY_PROGRAM_ID = new PublicKey(idl.address);

// ─── PDA Seeds ──────────────────────────────────────────────────────

const AGENT_SEED = 'pyre_agent';
const AGENT_WALLET_SEED = 'pyre_agent_wallet';

// ─── PDA Helpers ────────────────────────────────────────────────────

export function getAgentProfilePda(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AGENT_SEED), creator.toBuffer()],
    REGISTRY_PROGRAM_ID,
  );
}

export function getAgentWalletLinkPda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AGENT_WALLET_SEED), wallet.toBuffer()],
    REGISTRY_PROGRAM_ID,
  );
}

// ─── Anchor Program Helper ──────────────────────────────────────────

function makeDummyProvider(connection: Connection, payer: PublicKey): AnchorProvider {
  const dummyWallet = {
    publicKey: payer,
    signTransaction: async (t: Transaction) => t,
    signAllTransactions: async (t: Transaction[]) => t,
  };
  return new AnchorProvider(connection, dummyWallet as unknown as Wallet, {});
}

async function finalizeTransaction(
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey,
): Promise<void> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
}

function getProgram(connection: Connection, payer: PublicKey): Program {
  const provider = makeDummyProvider(connection, payer);
  return new Program(idl as any, provider);
}

// ─── Read Operations ────────────────────────────────────────────────

/** Fetch an agent's on-chain registry profile by creator wallet */
export async function getRegistryProfile(
  connection: Connection,
  creator: string,
): Promise<RegistryProfile | null> {
  const creatorPk = new PublicKey(creator);
  const [profilePda] = getAgentProfilePda(creatorPk);
  const program = getProgram(connection, creatorPk);

  try {
    const account = await (program.account as any).agentProfile.fetch(profilePda);
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
    };
  } catch {
    return null;
  }
}

/** Fetch a wallet link by wallet address (reverse lookup: wallet → profile) */
export async function getRegistryWalletLink(
  connection: Connection,
  wallet: string,
): Promise<RegistryWalletLink | null> {
  const walletPk = new PublicKey(wallet);
  const [linkPda] = getAgentWalletLinkPda(walletPk);
  const program = getProgram(connection, walletPk);

  try {
    const account = await (program.account as any).agentWalletLink.fetch(linkPda);
    return {
      address: linkPda.toBase58(),
      profile: account.profile.toBase58(),
      wallet: account.wallet.toBase58(),
      linked_at: account.linkedAt.toNumber(),
      bump: account.bump,
    };
  } catch {
    return null;
  }
}

// ─── Transaction Builders ───────────────────────────────────────────

/** Register a new agent profile and auto-link the creator's wallet */
export async function buildRegisterAgentTransaction(
  connection: Connection,
  params: RegisterAgentParams,
): Promise<TransactionResult> {
  const creator = new PublicKey(params.creator);
  const [profile] = getAgentProfilePda(creator);
  const [walletLink] = getAgentWalletLinkPda(creator);
  const program = getProgram(connection, creator);

  const tx = new Transaction();
  const ix = await (program.methods.register() as any)
    .accounts({
      creator,
      profile,
      walletLink,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(ix);
  await finalizeTransaction(connection, tx, creator);

  return {
    transaction: tx,
    message: `Register agent profile [${profile.toBase58()}]`,
  };
}

/** Checkpoint agent action counters and personality summary */
export async function buildCheckpointTransaction(
  connection: Connection,
  params: CheckpointParams,
): Promise<TransactionResult> {
  const signer = new PublicKey(params.signer);
  const creatorPk = new PublicKey(params.creator);
  const [profile] = getAgentProfilePda(creatorPk);
  const program = getProgram(connection, signer);

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
  };

  const tx = new Transaction();
  const ix = await (program.methods.checkpoint(args) as any)
    .accounts({
      signer,
      profile,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(ix);
  await finalizeTransaction(connection, tx, signer);

  return {
    transaction: tx,
    message: `Checkpoint agent [${profile.toBase58()}]`,
  };
}

/** Link a new wallet to an agent profile (authority only) */
export async function buildLinkAgentWalletTransaction(
  connection: Connection,
  params: LinkAgentWalletParams,
): Promise<TransactionResult> {
  const authority = new PublicKey(params.authority);
  const creatorPk = new PublicKey(params.creator);
  const walletToLink = new PublicKey(params.wallet_to_link);
  const [profile] = getAgentProfilePda(creatorPk);
  const [walletLink] = getAgentWalletLinkPda(walletToLink);
  const program = getProgram(connection, authority);

  const tx = new Transaction();
  const ix = await (program.methods.linkWallet() as any)
    .accounts({
      authority,
      profile,
      walletToLink,
      walletLink,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(ix);
  await finalizeTransaction(connection, tx, authority);

  return {
    transaction: tx,
    message: `Link wallet ${walletToLink.toBase58()} to agent [${profile.toBase58()}]`,
  };
}

/** Unlink the current wallet from an agent profile (authority only) */
export async function buildUnlinkAgentWalletTransaction(
  connection: Connection,
  params: UnlinkAgentWalletParams,
): Promise<TransactionResult> {
  const authority = new PublicKey(params.authority);
  const creatorPk = new PublicKey(params.creator);
  const walletToUnlink = new PublicKey(params.wallet_to_unlink);
  const [profile] = getAgentProfilePda(creatorPk);
  const [walletLink] = getAgentWalletLinkPda(walletToUnlink);
  const program = getProgram(connection, authority);

  const tx = new Transaction();
  const ix = await (program.methods.unlinkWallet() as any)
    .accounts({
      authority,
      profile,
      walletToUnlink,
      walletLink,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(ix);
  await finalizeTransaction(connection, tx, authority);

  return {
    transaction: tx,
    message: `Unlink wallet ${walletToUnlink.toBase58()} from agent [${profile.toBase58()}]`,
  };
}

/** Transfer agent profile authority to a new wallet */
export async function buildTransferAgentAuthorityTransaction(
  connection: Connection,
  params: TransferAgentAuthorityParams,
): Promise<TransactionResult> {
  const authority = new PublicKey(params.authority);
  const creatorPk = new PublicKey(params.creator);
  const newAuthority = new PublicKey(params.new_authority);
  const [profile] = getAgentProfilePda(creatorPk);
  const program = getProgram(connection, authority);

  const tx = new Transaction();
  const ix = await (program.methods.transferAuthority() as any)
    .accounts({
      authority,
      profile,
      newAuthority,
    })
    .instruction();

  tx.add(ix);
  await finalizeTransaction(connection, tx, authority);

  return {
    transaction: tx,
    message: `Transfer agent authority to ${newAuthority.toBase58()}`,
  };
}
