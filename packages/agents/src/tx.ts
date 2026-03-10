import { Connection, Keypair } from '@solana/web3.js'

async function confirm(connection: Connection, sig: string): Promise<void> {
  try {
    await connection.confirmTransaction(sig, 'confirmed')
  } catch {
    // WebSocket failed — fall back to polling
    const start = Date.now()
    while (Date.now() - start < 60000) {
      const status = await connection.getSignatureStatus(sig)
      if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
        if (status.value.err) throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`)
        return
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error(`Transaction confirmation timeout: ${sig}`)
  }
}

export const sendAndConfirm = async (connection: Connection, keypair: Keypair, result: any): Promise<string> => {
  const tx = result.transaction
  tx.partialSign(keypair)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await confirm(connection, sig)

  if (result.additionalTransactions) {
    for (const addlTx of result.additionalTransactions) {
      addlTx.partialSign(keypair)
      const addlSig = await connection.sendRawTransaction(addlTx.serialize())
      await confirm(connection, addlSig)
    }
  }

  return sig
}
