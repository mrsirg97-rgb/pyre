'use client'

import { useState, useEffect, useCallback } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import type { RegistryProfile } from 'pyre-world-kit'
import { usePyreKit } from './usePyreKit'

export type { RegistryProfile }

interface UseRegistryProfileResult {
  profile: RegistryProfile | null
  loading: boolean
  refetch: () => void
}

export function useRegistryProfile(): UseRegistryProfileResult {
  const { registry } = usePyreKit()
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
      const result = await registry.getProfile(publicKey.toString())
      setProfile(result ?? null)
    } catch {
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [registry, publicKey])

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  return {
    profile,
    loading,
    refetch: fetchProfile,
  }
}
