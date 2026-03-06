'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { getVault, getVaultForWallet } from 'torchsdk'
import type { VaultInfo } from 'torchsdk'

export type { VaultInfo }

interface UseVaultResult {
  vault: VaultInfo | null
  linkedVault: VaultInfo | null
  activeVault: VaultInfo | null
  loading: boolean
  refetch: () => void
}

export function useVault(): UseVaultResult {
  const { connection } = useConnection()
  const { publicKey } = useWallet()

  const [vault, setVault] = useState<VaultInfo | null>(null)
  const [linkedVault, setLinkedVault] = useState<VaultInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchVault = useCallback(async () => {
    if (!publicKey) {
      setVault(null)
      setLinkedVault(null)
      return
    }

    setLoading(true)
    try {
      const walletStr = publicKey.toString()
      const [ownVault, linked] = await Promise.all([
        getVault(connection, walletStr).catch(() => null),
        getVaultForWallet(connection, walletStr).catch(() => null),
      ])
      setVault(ownVault)
      setLinkedVault(linked && linked.address !== ownVault?.address ? linked : null)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [connection, publicKey])

  useEffect(() => {
    fetchVault()
  }, [fetchVault])

  return {
    vault,
    linkedVault,
    activeVault: vault || linkedVault || null,
    loading,
    refetch: fetchVault,
  }
}
