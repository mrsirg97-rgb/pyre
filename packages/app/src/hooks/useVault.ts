'use client'

import { useState, useEffect, useCallback } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import type { Stronghold } from 'pyre-world-kit'
import { usePyreKit } from './usePyreKit'

export type { Stronghold }

interface UseVaultResult {
  vault: Stronghold | null
  linkedVault: Stronghold | null
  activeVault: Stronghold | null
  loading: boolean
  refetch: () => void
}

export function useVault(): UseVaultResult {
  const { actions } = usePyreKit()
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
        actions.getStronghold(walletStr).catch(() => undefined),
        actions.getStrongholdForAgent(walletStr).catch(() => undefined),
      ])
      setVault(ownVault ?? null)
      setLinkedVault(linked && linked.address !== ownVault?.address ? linked : null)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [actions, publicKey])

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
