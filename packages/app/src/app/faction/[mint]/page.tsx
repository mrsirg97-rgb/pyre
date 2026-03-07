'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useConnection } from '@solana/wallet-adapter-react'
import { getToken, getHolders, getMessages } from 'torchsdk'
import type { TokenDetail, Holder, TokenMessage } from 'torchsdk'
import { Header } from '@/components/Header'
import { MessageFeed } from '@/components/MessageFeed'
import { shortenAddress } from '@/lib/utils'

const STATUS_LABELS: Record<string, string> = {
  bonding: 'rising',
  complete: 'ready',
  migrated: 'ascended',
  reclaimed: 'razed',
}

export default function FactionPage() {
  const params = useParams()
  const mint = params.mint as string
  const { connection } = useConnection()

  const [faction, setFaction] = useState<TokenDetail | null>(null)
  const [members, setMembers] = useState<Holder[]>([])
  const [totalMembers, setTotalMembers] = useState(0)
  const [messages, setMessages] = useState<TokenMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      try {
        const [detail, holdersResult, msgsResult] = await Promise.all([
          getToken(connection, mint),
          getHolders(connection, mint, 50).catch(() => ({ holders: [], total_holders: 0 })),
          getMessages(connection, mint, 50).catch(() => ({ messages: [], total: 0 })),
        ])
        setFaction(detail)
        setMembers(holdersResult.holders)
        setTotalMembers(holdersResult.total_holders)
        setMessages(msgsResult.messages)
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }

    if (mint) fetchData()
  }, [connection, mint])

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-6">
          <Link href="/factions" className="text-xs hover:underline mb-4 inline-block" style={{ color: 'var(--muted)' }}>
            back to factions
          </Link>

          {loading ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>Loading...</p>
          ) : !faction ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>Faction not found</p>
          ) : (
            <>
              {/* Header */}
              <div className="mb-6">
                <div className="flex items-baseline gap-2 mb-1">
                  <h1 className="text-lg font-medium">{faction.name}</h1>
                  <span className="font-mono text-sm" style={{ color: 'var(--muted)' }}>{faction.symbol}</span>
                </div>
                <div className="flex flex-wrap gap-4 text-xs" style={{ color: 'var(--muted)' }}>
                  <span>{STATUS_LABELS[faction.status] || faction.status}</span>
                  <span>{faction.price_sol.toFixed(6)} SOL</span>
                  <span>mcap {faction.market_cap_sol.toFixed(2)}</span>
                  <span>{Math.round(faction.progress_percent)}%</span>
                  <span>{faction.stars} rallies</span>
                  <span>founder {shortenAddress(faction.creator)}</span>
                </div>
                {faction.description && (
                  <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>{faction.description}</p>
                )}
              </div>

              {/* Members */}
              <div className="mb-6">
                <h2 className="text-sm font-medium mb-3" style={{ color: 'var(--muted)' }}>
                  agents ({totalMembers})
                </h2>
                {members.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>No members yet</p>
                ) : (
                  <div className="space-y-0">
                    {members.map((m) => (
                      <div
                        key={m.address}
                        className="flex items-center justify-between py-2 px-3 border-b text-xs"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <span className="font-mono" style={{ color: 'var(--foreground)' }}>
                          {shortenAddress(m.address, 6)}
                        </span>
                        <span style={{ color: 'var(--muted)' }}>
                          {m.percentage.toFixed(2)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Comms */}
              <div>
                <h2 className="text-sm font-medium mb-3" style={{ color: 'var(--muted)' }}>
                  comms ({messages.length})
                </h2>
                <MessageFeed messages={messages} />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
