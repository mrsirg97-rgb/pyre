'use client'

import type { Action, FactionInfo } from 'pyre-agent-kit'
import { getValidTargets } from 'pyre-agent-kit'

interface LensFactionTableProps {
  factions: FactionInfo[]
  holdings: Map<string, number>
  selectedAction: Action | null
  selectedFaction: FactionInfo | null
  onSelect: (faction: FactionInfo) => void
}

function formatBalance(raw: number): string {
  const TOKEN_DECIMALS = 1_000_000
  const tokens = raw / TOKEN_DECIMALS
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return tokens.toFixed(2)
}

const STATUS_COLORS: Record<string, string> = {
  rising: 'var(--accent)',
  ready: 'var(--success)',
  ascended: '#a78bfa',
  razed: 'var(--danger)',
}

export function LensFactionTable({
  factions,
  holdings,
  selectedAction,
  selectedFaction,
  onSelect,
}: LensFactionTableProps) {
  // Filter factions based on selected action
  const validTargets = selectedAction
    ? getValidTargets(selectedAction, factions, holdings)
    : factions.filter((f) => f.status !== 'razed')

  if (validTargets.length === 0 && selectedAction) {
    return (
      <div className="text-xs text-center py-4" style={{ color: 'var(--muted)' }}>
        No valid targets for this action
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div className="text-xs font-medium px-2 py-1" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
        Factions {selectedAction && `(${validTargets.length} targets)`}
      </div>
      {validTargets.map((faction) => {
        const selected = selectedFaction?.mint === faction.mint
        const held = holdings.has(faction.mint)
        const balance = holdings.get(faction.mint)

        return (
          <button
            key={faction.mint}
            onClick={() => onSelect(faction)}
            className="w-full text-left border-b transition-colors cursor-pointer"
            style={{
              borderColor: 'var(--border)',
              padding: '0.4rem 0.5rem',
              background: selected ? 'rgba(255,255,255,0.08)' : 'transparent',
            }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  {faction.name}
                </span>
                <span className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
                  {faction.symbol}
                </span>
                {held && (
                  <span className="text-[10px] font-mono" style={{ color: 'var(--success)' }}>
                    HELD
                  </span>
                )}
              </div>
              <span
                className="text-[10px] font-mono uppercase"
                style={{ color: STATUS_COLORS[faction.status] ?? 'var(--muted)' }}
              >
                {faction.status}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              <span>{(faction.price_sol ?? 0).toFixed(6)} SOL</span>
              <span>mcap {(faction.market_cap_sol ?? 0).toFixed(2)}</span>
              {balance !== undefined && balance > 0 && (
                <span style={{ color: 'var(--foreground)' }}>
                  bal {formatBalance(balance)}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
