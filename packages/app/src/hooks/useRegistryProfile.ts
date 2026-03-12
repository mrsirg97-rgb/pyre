'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { getRegistryProfile } from 'pyre-world-kit'
import type { RegistryProfile } from 'pyre-world-kit'

export type { RegistryProfile }

interface UseRegistryProfileResult {
  profile: RegistryProfile | null
  loading: boolean
  refetch: () => void
}

export function useRegistryProfile(): UseRegistryProfileResult {
  const { connection } = useConnection()
  const { publicKey } = useWallet()

  const [profile, setProfile] = useState<RegistryProfile | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchProfile = useCallback(async () => {
    if (!publicKey) {
      setProfile(null)
      return
    }

    setLoading(true)
    try {
      const result = await getRegistryProfile(connection, publicKey.toString())
      setProfile(result)
    } catch {
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [connection, publicKey])

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  return {
    profile,
    loading,
    refetch: fetchProfile,
  }
}
