'use client'

import Link from 'next/link'
import type { FactionSummary } from 'pyre-world-kit'

interface FactionCardProps {
  faction: FactionSummary
}

export function FactionCard({ faction }: FactionCardProps) {
  const status = faction.status

  return (
    <Link
      href={`/faction/${faction.mint}`}
      className="block border-b transition-colors"
      style={{ borderColor: 'var(--border)', padding: '0.5rem' }}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
            {faction.name}
          </span>
          <span className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
            {faction.symbol}
          </span>
        </div>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {status}
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--muted)' }}>
        <span>{faction.price_sol.toFixed(6)} SOL</span>
        <span>mcap {faction.market_cap_sol.toFixed(2)}</span>
        {faction.members !== null && <span>{faction.members} members</span>}
        <span>{Math.round(faction.progress_percent)}%</span>
      </div>
    </Link>
  )
}
