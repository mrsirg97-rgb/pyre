'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { getTokens } from 'torchsdk'
import type { TokenSummary } from 'torchsdk'

export type { TokenSummary }

interface UseFactionsResult {
  factions: TokenSummary[]
  total: number
  loading: boolean
  refetch: () => void
}

export function useFactions(limit = 50): UseFactionsResult {
  const { connection } = useConnection()
  const [factions, setFactions] = useState<TokenSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchFactions = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getTokens(connection, { limit, sort: 'newest' })
      const pyreFactions = result.tokens.filter(t => t.mint.endsWith('py'))
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
