'use client'

import Link from 'next/link'
import { shortenAddress, timeAgo } from '@/lib/utils'

interface FeedItemProps {
  sender: string
  faction_mint: string
  faction_name: string
  memo: string
  timestamp: number
  signature: string
}

export function FeedItem({
  sender,
  faction_mint,
  faction_name,
  memo,
  timestamp,
  signature,
}: FeedItemProps) {
  return (
    <div className="border-b" style={{ borderColor: 'var(--border)', padding: '0.5rem' }}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-xs" style={{ color: 'var(--foreground)' }}>
            {shortenAddress(sender)}
          </span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            in
          </span>
          <Link
            href={`/faction/${faction_mint}`}
            className="text-xs font-medium truncate hover:underline"
            style={{ color: 'var(--foreground)' }}
          >
            {faction_name}
          </Link>
        </div>
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>
          {timeAgo(timestamp)}
        </span>
      </div>
      <p className="text-sm" style={{ color: 'var(--foreground)' }}>
        {memo}
      </p>
      <a
        href={`https://solscan.io/tx/${signature}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs mt-1 inline-block hover:underline"
        style={{ color: 'var(--muted)' }}
      >
        tx
      </a>
    </div>
  )
}
