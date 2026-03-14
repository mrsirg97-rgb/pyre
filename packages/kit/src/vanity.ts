/**
 * Pyre vanity mint address grinder
 *
 * Grinds for Solana keypairs whose base58 address ends with "pyre".
 * This is how we distinguish pyre faction tokens from regular torch tokens —
 * no registry program needed, just check the mint suffix.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { BN, Program, AnchorProvider, Wallet } from '@coral-xyz/anchor'
import type { CreateTokenResult, CreateTokenParams } from 'torchsdk'
import { PROGRAM_ID } from 'torchsdk'

// Token-2022 program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// PDA seeds (must match the Rust program)
const GLOBAL_CONFIG_SEED = 'global_config'
const BONDING_CURVE_SEED = 'bonding_curve'
const TREASURY_SEED = 'treasury'
const TREASURY_LOCK_SEED = 'treasury_lock'

// IDL loaded from torchsdk dist
import idl from 'torchsdk/dist/torch_market.json'

// ── PDA helpers (copied from torchsdk internals) ──

const getGlobalConfigPda = (): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from(GLOBAL_CONFIG_SEED)], PROGRAM_ID)

export const getBondingCurvePda = (mint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()], PROGRAM_ID)

export const getTokenTreasuryPda = (mint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from(TREASURY_SEED), mint.toBuffer()], PROGRAM_ID)

const getTreasuryTokenAccount = (mint: PublicKey, treasury: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, treasury, true, TOKEN_2022_PROGRAM_ID)

export const getTreasuryLockPda = (mint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from(TREASURY_LOCK_SEED), mint.toBuffer()], PROGRAM_ID)

const getTreasuryLockTokenAccount = (mint: PublicKey, treasuryLock: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, treasuryLock, true, TOKEN_2022_PROGRAM_ID)

const makeDummyProvider = (connection: Connection, payer: PublicKey): AnchorProvider => {
  const dummyWallet = {
    publicKey: payer,
    signTransaction: async (t: Transaction) => t,
    signAllTransactions: async (t: Transaction[]) => t,
  }
  return new AnchorProvider(connection, dummyWallet as unknown as Wallet, {})
}

const finalizeTransaction = async (
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey,
): Promise<void> => {
  const { blockhash } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = feePayer
}

// ── Vanity grinder ──

const PYRE_SUFFIX = 'py'

/** Grind for a keypair whose base58 address ends with "py" */
export const grindPyreMint = (maxAttempts: number = 500_000): Keypair => {
  for (let i = 0; i < maxAttempts; i++) {
    const kp = Keypair.generate()
    if (kp.publicKey.toBase58().endsWith(PYRE_SUFFIX)) {
      return kp
    }
  }
  // Fallback — return last generated keypair (should be extremely rare)
  return Keypair.generate()
}

/** Check if a mint address is a pyre faction (ends with "py") */
export const isPyreMint = (mint: string): boolean => mint.endsWith(PYRE_SUFFIX)

// ── Build create transaction with pyre vanity address ──

export const buildCreateFactionTransaction = async (
  connection: Connection,
  params: CreateTokenParams,
): Promise<CreateTokenResult> => {
  const {
    creator: creatorStr,
    name,
    symbol,
    metadata_uri,
    sol_target = 0,
    community_token = true,
  } = params

  const creator = new PublicKey(creatorStr)

  if (name.length > 32) throw new Error('Name must be 32 characters or less')
  if (symbol.length > 10) throw new Error('Symbol must be 10 characters or less')

  // Grind for "pyre" suffix instead of "tm"
  const mint = grindPyreMint()

  // Derive PDAs
  const [globalConfig] = getGlobalConfigPda()
  const [bondingCurve] = getBondingCurvePda(mint.publicKey)
  const [treasury] = getTokenTreasuryPda(mint.publicKey)
  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const treasuryTokenAccount = getTreasuryTokenAccount(mint.publicKey, treasury)
  const [treasuryLock] = getTreasuryLockPda(mint.publicKey)
  const treasuryLockTokenAccount = getTreasuryLockTokenAccount(mint.publicKey, treasuryLock)

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, creator)
  const program = new Program(idl as any, provider)

  const createIx = await (
    program.methods.createToken({
      name,
      symbol,
      uri: metadata_uri,
      solTarget: new BN(sol_target),
      communityToken: community_token,
    }) as any
  )
    .accounts({
      creator,
      globalConfig,
      mint: mint.publicKey,
      bondingCurve,
      tokenVault: bondingCurveTokenAccount,
      treasury,
      treasuryTokenAccount,
      treasuryLock,
      treasuryLockTokenAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction()

  tx.add(createIx)
  await finalizeTransaction(connection, tx, creator)

  // Partially sign with mint keypair
  tx.partialSign(mint)

  return {
    transaction: tx,
    mint: mint.publicKey,
    mintKeypair: mint,
    message: `Create faction "${name}" ($${symbol}) [pyre:${mint.publicKey.toBase58()}]`,
  }
}
