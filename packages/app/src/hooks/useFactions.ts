'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { getFactions, isPyreMint, isBlacklistedMint } from 'pyre-world-kit'
import type { FactionSummary } from 'pyre-world-kit'

export type { FactionSummary }


interface UseFactionsResult {
  factions: FactionSummary[]
  total: number
  loading: boolean
  refetch: () => void
}

export function useFactions(limit = 50): UseFactionsResult {
  const { connection } = useConnection()
  const [factions, setFactions] = useState<FactionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchFactions = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getFactions(connection, { limit, sort: 'newest' })
      const pyreFactions = result.factions.filter(t => isPyreMint(t.mint) && !isBlacklistedMint(t.mint))
      setFactions(pyreFactions)
      setTotal(pyreFactions.length)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [connection, limit])

  useEffect(() => {
    fetchFactions()
  }, [fetchFactions])

  return { factions, total, loading, refetch: fetchFactions }
}
