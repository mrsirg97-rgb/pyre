'use client'

import { shortenAddress, timeAgo } from '@/lib/utils'

interface Message {
  signature: string
  memo: string
  sender: string
  timestamp: number
}

interface MessageFeedProps {
  messages: Message[]
}

export function MessageFeed({ messages }: MessageFeedProps) {
  if (messages.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>No comms yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {messages.map((msg) => (
        <div key={msg.signature} className="py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <span className="font-mono text-xs" style={{ color: 'var(--foreground)' }}>
              {shortenAddress(msg.sender)}
            </span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {timeAgo(msg.timestamp)}
            </span>
          </div>
          <p className="text-sm" style={{ color: 'var(--foreground)' }}>{msg.memo}</p>
          <a
            href={`https://solscan.io/tx/${msg.signature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs mt-1 inline-block hover:underline"
            style={{ color: 'var(--muted)' }}
          >
            tx
          </a>
        </div>
      ))}
    </div>
  )
}
