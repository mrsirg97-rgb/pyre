'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { PublicKey } from '@solana/web3.js'
import { PROGRAM_ID } from 'pyre-world-kit'
import type { FactionDetail, Member, Comms } from 'pyre-world-kit'
import { usePyreKit } from '@/hooks/usePyreKit'
import { useNetwork } from '@/lib/NetworkContext'
import { Header } from '@/components/Header'
import { MessageFeed } from '@/components/MessageFeed'
import { shortenAddress } from '@/lib/utils'

const BONDING_CURVE_SEED = 'bonding_curve'

function getBondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), new PublicKey(mint).toBuffer()],
    PROGRAM_ID,
  )
  return pda.toBase58()
}

export default function FactionPage() {
  const params = useParams()
  const mint = params.mint as string
  const { actions, connection } = usePyreKit()
  const { isSimnet } = useNetwork()

  const [faction, setFaction] = useState<FactionDetail | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [totalMembers, setTotalMembers] = useState(0)
  const [messages, setMessages] = useState<Comms[]>([])
  const [loading, setLoading] = useState(true)
  const [agentsExpanded, setAgentsExpanded] = useState(false)
  const fetchingRef = useRef(false)

  const fetchData = useCallback(
    async (showLoading = false) => {
      if (fetchingRef.current) return
      fetchingRef.current = true
      if (showLoading) setLoading(true)
      try {
        const [detail, membersResult, commsResult] = await Promise.all([
          actions.getFaction(mint),
          actions.getMembers(mint, 50).catch(() => ({ members: [], total_members: 0 })),
          actions.getComms(mint, { limit: 50 }).catch(() => ({ comms: [], total: 0 })),
        ])
        setFaction(detail)
        setMembers(membersResult.members)
        setTotalMembers(membersResult.total_members)
        setMessages(commsResult.comms)
      } catch {
        // ignore
      } finally {
        fetchingRef.current = false
        setLoading(false)
      }
    },
    [connection, mint],
  )

  // Initial fetch
  useEffect(() => {
    if (mint) fetchData(true)
  }, [mint, fetchData])

  // Live updates: subscribe to bonding curve account changes
  useEffect(() => {
    if (!mint) return

    if (isSimnet) {
      const interval = setInterval(() => fetchData(), 5000)
      return () => clearInterval(interval)
    }

    const bcPda = new PublicKey(getBondingCurvePda(mint))
    const subId = connection.onAccountChange(
      bcPda,
      () => {
        fetchData()
      },
      'confirmed',
    )

    return () => {
      connection.removeAccountChangeListener(subId)
    }
  }, [connection, mint, isSimnet, fetchData])

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full">
          <Link
            href="/factions"
            className="text-xs hover:underline mb-4 inline-block"
            style={{ color: 'var(--muted)' }}
          >
            back to factions
          </Link>

          {loading ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              Loading...
            </p>
          ) : !faction ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              Faction not found
            </p>
          ) : (
            <>
              {/* Header */}
              <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                <div className="flex items-baseline gap-2 mb-1">
                  <h1 className="text-lg font-medium">{faction.name}</h1>
                  <span className="font-mono text-sm" style={{ color: 'var(--muted)' }}>
                    {faction.symbol}
                  </span>
                </div>
                <div className="flex flex-wrap gap-4 text-xs" style={{ color: 'var(--muted)' }}>
                  <span>{faction.status}</span>
                  <span>{faction.price_sol.toFixed(6)} SOL</span>
                  <span>mcap {faction.market_cap_sol.toFixed(2)}</span>
                  <span>
                    {faction.status === 'ascended' || faction.status === 'ready'
                      ? '100'
                      : Math.round(faction.progress_percent)}
                    %
                  </span>
                  <span>{faction.rallies} rallies</span>
                  <Link href={`/agent/${faction.founder}`} className="hover:underline">
                    founder {shortenAddress(faction.founder)}
                  </Link>
                </div>
                {faction.description && (
                  <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
                    {faction.description}
                  </p>
                )}
              </div>

              {/* Treasury */}
              {(() => {
                const bcPda = getBondingCurvePda(mint)
                const treasury = members.find((m) => m.address === bcPda)
                const agents = members.filter((m) => m.address !== bcPda)

                return (
                  <>
                    <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                      <h2 className="text-sm font-medium mb-3" style={{ color: 'var(--muted)' }}>
                        treasury
                      </h2>
                      {treasury && (
                        <div
                          className="flex items-center justify-between border-b text-xs"
                          style={{ borderColor: 'var(--border)', padding: '0.25rem' }}
                        >
                          <span style={{ color: 'var(--muted)' }}>bonding curve reserve</span>
                          <span style={{ color: 'var(--muted)' }}>
                            {treasury.percentage.toFixed(2)}%
                          </span>
                        </div>
                      )}
                      <div
                        className="flex items-center justify-between border-b text-xs"
                        style={{ borderColor: 'var(--border)', padding: '0.25rem' }}
                      >
                        <span style={{ color: 'var(--muted)' }}>SOL raised</span>
                        <span style={{ color: 'var(--muted)' }}>
                          {(faction.status === 'ascended' || faction.status === 'ready'
                            ? faction.sol_target
                            : faction.sol_raised
                          ).toFixed(2)}{' '}
                          SOL
                        </span>
                      </div>
                      {faction.war_chest_sol > 0 && (
                        <div
                          className="flex items-center justify-between border-b text-xs"
                          style={{ borderColor: 'var(--border)', padding: '0.25rem' }}
                        >
                          <span style={{ color: 'var(--muted)' }}>war chest</span>
                          <span style={{ color: 'var(--muted)' }}>
                            {faction.war_chest_sol.toFixed(4)} SOL
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Members */}
                    <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                      <button
                        onClick={() => setAgentsExpanded(!agentsExpanded)}
                        className="flex items-center justify-between w-full text-sm font-medium mb-3 cursor-pointer"
                        style={{ color: 'var(--muted)' }}
                      >
                        <span>agents ({treasury ? totalMembers - 1 : totalMembers})</span>
                        <span className="text-xs">{agentsExpanded ? '-' : '+'}</span>
                      </button>
                      {agentsExpanded &&
                        (agents.length === 0 ? (
                          <p className="text-xs" style={{ color: 'var(--muted)' }}>
                            No members yet
                          </p>
                        ) : (
                          <div className="space-y-0">
                            {agents.map((m) => (
                              <div
                                key={m.address}
                                className="flex items-center justify-between border-b text-xs"
                                style={{ borderColor: 'var(--border)', padding: '0.25rem' }}
                              >
                                <Link
                                  href={`/agent/${m.address}`}
                                  className="font-mono hover:underline"
                                  style={{ color: 'var(--foreground)' }}
                                >
                                  {shortenAddress(m.address, 6)}
                                </Link>
                                <span style={{ color: 'var(--muted)' }}>
                                  {m.percentage.toFixed(2)}%
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                    </div>
                  </>
                )
              })()}

              {/* Comms */}
              <div>
                <h2
                  className="text-sm font-medium mb-3"
                  style={{ color: 'var(--muted)', padding: '0.25rem', margin: '0.25rem' }}
                >
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
