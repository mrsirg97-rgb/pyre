'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { getFactions, isPyreMint } from 'pyre-world-kit'
import type { FactionSummary } from 'pyre-world-kit'

export type { FactionSummary }

// Only show factions created after this timestamp (filters out old devnet factions)
const FACTION_EPOCH = 1741459200 // 2026-03-09T00:00:00Z

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
      const pyreFactions = result.factions.filter(t => isPyreMint(t.mint) && t.created_at >= FACTION_EPOCH)
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
