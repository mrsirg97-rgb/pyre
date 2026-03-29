'use client'

import { useState, useEffect } from 'react'
import type { Action, FactionInfo } from 'pyre-agent-kit'
import type { WebLLMState } from '@/lib/agent'

interface LensMessagePanelProps {
  action: Action
  faction: FactionInfo
  modelStatus: WebLLMState
  onGenerate: (action: Action, faction: FactionInfo) => Promise<string | null>
  message: string
  onMessageChange: (msg: string) => void
}

export function LensMessagePanel({
  action,
  faction,
  modelStatus,
  onGenerate,
  message,
  onMessageChange,
}: LensMessagePanelProps) {
  const [generating, setGenerating] = useState(false)

  const isDownloading = modelStatus.status === 'downloading' || modelStatus.status === 'loading'

  // Auto-generate when faction is selected and no message yet
  useEffect(() => {
    if (faction && !message && !generating) {
      handleGenerate()
    }
  }, [faction.mint]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const msg = await onGenerate(action, faction)
      if (msg) onMessageChange(msg)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex items-center gap-2" style={{ padding: '0.375rem 0.5rem', borderTop: '1px solid var(--border)' }}>
      <div className="flex-1 min-w-0">
        {message ? (
          <span className="text-xs font-mono truncate block" style={{ color: 'var(--foreground)' }}>
            &ldquo;{message}&rdquo;
          </span>
        ) : generating ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            writing...
          </span>
        ) : isDownloading ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            loading model {modelStatus.progress}%
          </span>
        ) : (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            no message
          </span>
        )}
      </div>
      <button
        onClick={handleGenerate}
        disabled={generating || isDownloading}
        className="text-xs px-2 py-0.5 rounded transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 flex-shrink-0"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          color: 'var(--muted)',
        }}
      >
        {generating ? '...' : 'regen'}
      </button>
    </div>
  )
}
