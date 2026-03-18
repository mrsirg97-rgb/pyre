import { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'

export interface WalletSigner {
  publicKey: string
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>
}

/** Local signer using an ephemeral Keypair — no wallet adapter popup */
export function createKeypairSigner(keypair: Keypair): WalletSigner {
  return {
    publicKey: keypair.publicKey.toBase58(),
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair])
      } else {
        tx.partialSign(keypair)
      }
      return tx
    },
  }
}

async function confirm(connection: Connection, sig: string): Promise<void> {
  try {
    await connection.confirmTransaction(sig, 'confirmed')
  } catch {
    const start = Date.now()
    while (Date.now() - start < 60000) {
      const status = await connection.getSignatureStatus(sig)
      if (
        status?.value?.confirmationStatus === 'confirmed' ||
        status?.value?.confirmationStatus === 'finalized'
      ) {
        if (status.value.err)
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`)
        return
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(`Transaction confirmation timeout: ${sig}`)
  }
}

export async function walletSignAndSend(
  connection: Connection,
  signer: WalletSigner,
  result: { transaction: Transaction | VersionedTransaction; additionalTransactions?: (Transaction | VersionedTransaction)[] },
): Promise<string> {
  const signedTx = await signer.signTransaction(result.transaction)
  const sig = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await confirm(connection, sig)

  if (result.additionalTransactions) {
    for (const tx of result.additionalTransactions) {
      const signed = await signer.signTransaction(tx)
      const addlSig = await connection.sendRawTransaction(signed.serialize())
      await confirm(connection, addlSig)
    }
  }

  return sig
}
