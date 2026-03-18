'use client'

import { useState, useEffect, useCallback } from 'react'
import type { FactionSummary } from 'pyre-world-kit'
import { usePyreKit } from './usePyreKit'

export type { FactionSummary }

interface UseFactionsResult {
  factions: FactionSummary[]
  total: number
  loading: boolean
  refetch: () => void
}

export function useFactions(): UseFactionsResult {
  const { actions } = usePyreKit()
  const [factions, setFactions] = useState<FactionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchFactions = useCallback(async () => {
    setLoading(true)
    try {
      const result = await actions.getFactions({ sort: 'newest' })
      setFactions(result.factions)
      setTotal(result.factions.length)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [actions])

  useEffect(() => {
    fetchFactions()
  }, [fetchFactions])

  return { factions, total, loading, refetch: fetchFactions }
}
