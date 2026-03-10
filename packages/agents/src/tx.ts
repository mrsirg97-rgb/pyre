import { Connection, Keypair } from '@solana/web3.js'

/** Poll-based transaction confirmation (avoids WebSocket signatureSubscribe flooding) */
async function pollConfirmation(connection: Connection, sig: string, timeout = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const status = await connection.getSignatureStatus(sig)
    if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
      if (status.value.err) throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`)
      return
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error(`Transaction confirmation timeout: ${sig}`)
}

export const sendAndConfirm = async (connection: Connection, keypair: Keypair, result: any): Promise<string> => {
  const tx = result.transaction
  tx.partialSign(keypair)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await pollConfirmation(connection, sig)

  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      addlTx.partialSign(keypair)
      const addlSig = await connection.sendRawTransaction(addlTx.serialize())
      await pollConfirmation(connection, addlSig)
    }
  }

  return sig
}
