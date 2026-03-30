'use client'

import { useCallback } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConnection } from '@solana/wallet-adapter-react'
import type { Transaction, VersionedTransaction, Connection } from '@solana/web3.js'

function isAndroidMobile() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof document !== 'undefined' &&
    /android/i.test(navigator.userAgent)
  )
}

/**
 * MWA-aware sendTransaction.
 *
 * On Android, uses signTransaction + sendRawTransaction.
 * Pyre uses ephemeral controller keypairs for game actions,
 * so MWA signing is only needed for stronghold setup.
 *
 * On desktop/iOS, uses wallet.sendTransaction directly.
 */
export function useMwaSendTransaction() {
  const wallet = useWallet()
  const { connection } = useConnection()

  const sendTransaction = useCallback(
    async (
      tx: Transaction | VersionedTransaction,
      conn?: Connection,
    ): Promise<string> => {
      const c = conn ?? connection

      if (isAndroidMobile() && wallet.signTransaction) {
        const signed = await wallet.signTransaction(tx)
        return c.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        })
      }

      if (!wallet.sendTransaction) {
        throw new Error('Wallet does not support sendTransaction')
      }
      return wallet.sendTransaction(tx, c)
    },
    [wallet, connection],
  )

  return sendTransaction
}
