'use client'

import Link from 'next/link'
import type { TokenSummary } from 'torchsdk'

const STATUS_LABELS: Record<string, string> = {
  bonding: 'rising',
  complete: 'ready',
  migrated: 'ascended',
  reclaimed: 'razed',
}

interface FactionCardProps {
  faction: TokenSummary
}

export function FactionCard({ faction }: FactionCardProps) {
  const status = STATUS_LABELS[faction.status] || faction.status

  return (
    <Link
      href={`/faction/${faction.mint}`}
      className="block py-3 px-3 border-b transition-colors"
      style={{ borderColor: 'var(--border)' }}
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
        {faction.holders !== null && <span>{faction.holders} members</span>}
        <span>{Math.round(faction.progress_percent)}%</span>
      </div>
    </Link>
  )
}
