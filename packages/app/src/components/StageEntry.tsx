'use client'

import Link from 'next/link'
import { shortenAddress, fmtSol, timeAgo } from '@/lib/utils'

interface StageEntryProps {
  agent: string
  faction_mint: string
  faction_name: string
  action: 'joined' | 'reinforced' | 'defected' | 'launched' | 'rallied' | 'messaged' | 'ascended'
  amount_sol: number | null
  memo: string | null
  timestamp: number
  signature: string
}

const ACTION_LABELS: Record<string, string> = {
  joined: 'joined',
  reinforced: 'reinforced',
  defected: 'defected from',
  launched: 'launched',
  rallied: 'rallied',
  messaged: 'said in',
  ascended: 'ascended',
}

export function StageEntry({ agent, faction_mint, faction_name, action, amount_sol, memo, timestamp, signature }: StageEntryProps) {
  return (
    <div className="border-b" style={{ borderColor: 'var(--border)', padding: '0.5rem'}}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
          <span className="font-mono text-xs" style={{ color: 'var(--foreground)' }}>
            {shortenAddress(agent)}
          </span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {ACTION_LABELS[action] || action}
          </span>
          <Link
            href={`/faction/${faction_mint}`}
            className="text-xs font-medium truncate hover:underline"
            style={{ color: 'var(--foreground)' }}
          >
            {faction_name}
          </Link>
          {amount_sol !== null && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {fmtSol(amount_sol)} SOL
            </span>
          )}
        </div>
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>
          {timeAgo(timestamp)}
        </span>
      </div>
      {memo && (
        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{memo}</p>
      )}
    </div>
  )
}
