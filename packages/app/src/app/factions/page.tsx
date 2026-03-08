'use client'

import { useState, useEffect, useCallback } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { getFactions, getMembers } from 'pyre-world-kit'
import type { FactionSummary, Member } from 'pyre-world-kit'
import Link from 'next/link'
import { Header } from '@/components/Header'
import { FactionCard } from '@/components/FactionCard'
import { shortenAddress } from '@/lib/utils'

interface AgentEntry {
  address: string
  factions: { mint: string; name: string; symbol: string; percentage: number }[]
  totalFactions: number
}

export default function FactionsPage() {
  const { connection } = useConnection()
  const [tab, setTab] = useState<'factions' | 'agents'>('factions')
  const [factions, setFactions] = useState<FactionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)

  const fetchFactions = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getFactions(connection, { limit: 100, sort: 'marketcap' })
      const pyreFactions = result.factions.filter(t => t.mint.endsWith('py'))
      pyreFactions.sort((a, b) => b.market_cap_sol - a.market_cap_sol)
      setFactions(pyreFactions)
      setTotal(pyreFactions.length)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [connection])

  const fetchAgents = useCallback(async () => {
    if (factions.length === 0) return
    setAgentsLoading(true)
    try {
      const agentMap = new Map<string, AgentEntry['factions']>()

      await Promise.all(
        factions.slice(0, 30).map(async (faction) => {
          try {
            const result = await getMembers(connection, faction.mint, 50)
            for (const m of result.members) {
              // Skip bonding curve PDA (not a real agent)
              if (m.percentage > 50) continue
              const existing = agentMap.get(m.address) || []
              existing.push({
                mint: faction.mint,
                name: faction.name,
                symbol: faction.symbol,
                percentage: m.percentage,
              })
              agentMap.set(m.address, existing)
            }
          } catch {
            // skip
          }
        }),
      )

      const agentList: AgentEntry[] = []
      for (const [address, factionList] of agentMap) {
        agentList.push({
          address,
          factions: factionList.sort((a, b) => b.percentage - a.percentage),
          totalFactions: factionList.length,
        })
      }
      agentList.sort((a, b) => b.totalFactions - a.totalFactions)
      setAgents(agentList)
    } catch {
      // ignore
    } finally {
      setAgentsLoading(false)
    }
  }, [connection, factions])

  useEffect(() => {
    fetchFactions()
  }, [fetchFactions])

  useEffect(() => {
    if (tab === 'agents' && agents.length === 0 && factions.length > 0) {
      fetchAgents()
    }
  }, [tab, agents.length, factions.length, fetchAgents])

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full" style={{ padding: '0.25rem' }}>
          <div className="flex items-baseline justify-between mb-4">
            <div className="flex items-baseline gap-4">
              <button
                onClick={() => setTab('factions')}
                className="text-sm font-medium cursor-pointer"
                style={{ color: tab === 'factions' ? 'var(--foreground)' : 'var(--muted)' }}
              >
                factions
              </button>
              <button
                onClick={() => setTab('agents')}
                className="text-sm font-medium cursor-pointer"
                style={{ color: tab === 'agents' ? 'var(--foreground)' : 'var(--muted)' }}
              >
                agents
              </button>
            </div>
            {!loading && tab === 'factions' && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{total} total</span>
            )}
            {!agentsLoading && tab === 'agents' && agents.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{agents.length} agents</span>
            )}
          </div>

          {tab === 'factions' ? (
            loading ? (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
                Loading...
              </p>
            ) : factions.length === 0 ? (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
                No factions yet
              </p>
            ) : (
              <div>
                {factions.map((f) => (
                  <FactionCard key={f.mint} faction={f} />
                ))}
              </div>
            )
          ) : (
            agentsLoading ? (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
                Loading agents...
              </p>
            ) : agents.length === 0 ? (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
                No agents found
              </p>
            ) : (
              <div>
                {agents.map((agent) => (
                  <AgentRow key={agent.address} agent={agent} />
                ))}
              </div>
            )
          )}
        </div>
      </main>
    </div>
  )
}

function AgentRow({ agent }: { agent: AgentEntry }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="border-b"
      style={{ borderColor: 'var(--border)' }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between cursor-pointer"
        style={{ padding: '0.5rem' }}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs" style={{ color: 'var(--foreground)' }}>
            {shortenAddress(agent.address, 6)}
          </span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {agent.totalFactions} faction{agent.totalFactions !== 1 ? 's' : ''}
          </span>
        </div>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {expanded ? '-' : '+'}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0 0.5rem 0.5rem' }}>
          {agent.factions.map((f) => (
            <Link
              key={f.mint}
              href={`/faction/${f.mint}`}
              className="flex items-center justify-between text-xs hover:underline"
              style={{ color: 'var(--muted)', padding: '0.15rem 0' }}
            >
              <span>
                <span style={{ color: 'var(--foreground)' }}>{f.name}</span>
                {' '}
                <span className="font-mono">{f.symbol}</span>
              </span>
              <span>{f.percentage.toFixed(2)}%</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
