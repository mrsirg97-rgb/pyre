'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { getStronghold, getStrongholdForAgent } from 'pyre-world-kit'
import type { Stronghold } from 'pyre-world-kit'

export type { Stronghold }

interface UseVaultResult {
  vault: Stronghold | null
  linkedVault: Stronghold | null
  activeVault: Stronghold | null
  loading: boolean
  refetch: () => void
}

export function useVault(): UseVaultResult {
  const { connection } = useConnection()
  const { publicKey } = useWallet()

  const [vault, setVault] = useState<Stronghold | null>(null)
  const [linkedVault, setLinkedVault] = useState<Stronghold | null>(null)
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
        getStronghold(connection, walletStr).catch(() => null),
        getStrongholdForAgent(connection, walletStr).catch(() => null),
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
