import { Connection, Keypair } from '@solana/web3.js'

export const sendAndConfirm = async (connection: Connection, keypair: Keypair, result: any): Promise<string> => {
  const tx = result.transaction
  tx.partialSign(keypair)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')

  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      addlTx.partialSign(keypair)
      const addlSig = await connection.sendRawTransaction(addlTx.serialize())
      await connection.confirmTransaction(addlSig, 'confirmed')
    }
  }

  return sig
}
