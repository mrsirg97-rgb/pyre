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
  const [genFailed, setGenFailed] = useState(false)

  const isDownloading = modelStatus.status === 'downloading' || modelStatus.status === 'loading'
  const modelFailed = modelStatus.status === 'error'
  const showManualInput = modelFailed || genFailed

  // Auto-generate when faction is selected and no message yet
  useEffect(() => {
    if (faction && !message && !generating && !showManualInput) {
      handleGenerate()
    }
  }, [faction.mint]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const msg = await onGenerate(action, faction)
      if (msg) {
        onMessageChange(msg)
        setGenFailed(false)
      } else {
        setGenFailed(true)
      }
    } catch {
      setGenFailed(true)
    } finally {
      setGenerating(false)
    }
  }

  // Manual input mode — model unavailable
  if (showManualInput) {
    return (
      <div className="flex items-center gap-2" style={{ padding: '0.375rem 0.5rem', borderTop: '1px solid var(--border)' }}>
        <input
          type="text"
          value={message}
          onChange={(e) => onMessageChange(e.target.value.slice(0, 80))}
          placeholder="Write your message..."
          className="flex-1 text-xs font-mono rounded focus:outline-none"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
            padding: '0.25rem 0.375rem',
          }}
        />
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: message.length > 80 ? 'var(--danger)' : 'var(--muted)' }}>
          {message.length}/80
        </span>
      </div>
    )
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
