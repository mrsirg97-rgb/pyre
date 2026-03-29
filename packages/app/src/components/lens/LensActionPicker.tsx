'use client'

import type { Action } from 'pyre-agent-kit'
import type { ActionAvailability } from 'pyre-agent-kit'

interface LensActionPickerProps {
  availableActions: Map<Action, ActionAvailability>
  selectedAction: Action | null
  onSelect: (action: Action) => void
}

const ACTION_DISPLAY: { action: Action; label: string; symbol: string }[] = [
  { action: 'join', label: 'Join', symbol: '&' },
  { action: 'defect', label: 'Defect', symbol: '-' },
  { action: 'infiltrate', label: 'Infiltrate', symbol: '/' },
  { action: 'message', label: 'Message', symbol: '!' },
  { action: 'fud', label: 'FUD', symbol: '#' },
  { action: 'ascend', label: 'Ascend', symbol: '^' },
  { action: 'tithe', label: 'Tithe', symbol: '~' },
  { action: 'war_loan', label: 'War Loan', symbol: '?' },
  { action: 'siege', label: 'Siege', symbol: '>' },
  { action: 'repay_loan', label: 'Repay', symbol: '<' },
  { action: 'launch', label: 'Launch', symbol: '%' },
  { action: 'hold', label: 'Hold', symbol: '_' },
]

export function LensActionPicker({ availableActions, selectedAction, onSelect }: LensActionPickerProps) {
  return (
    <div style={{ padding: '0.5rem' }}>
      <div className="text-xs font-medium mb-2" style={{ color: 'var(--muted)' }}>Actions</div>
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-1">
        {ACTION_DISPLAY.map(({ action, label, symbol }) => {
          const avail = availableActions.get(action)
          const enabled = avail?.enabled ?? false
          const selected = selectedAction === action

          return (
            <button
              key={action}
              onClick={() => enabled && onSelect(action)}
              disabled={!enabled}
              title={!enabled ? avail?.reason : label}
              className="flex flex-col items-center gap-0.5 py-1.5 px-1 rounded transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
              style={{
                background: selected
                  ? 'rgba(255,255,255,0.12)'
                  : 'var(--surface)',
                border: selected
                  ? '1px solid rgba(255,255,255,0.3)'
                  : '1px solid var(--border)',
                color: selected ? 'var(--foreground)' : enabled ? 'var(--foreground)' : 'var(--muted)',
              }}
            >
              <span className="font-mono text-sm leading-none">{symbol}</span>
              <span className="text-[10px] leading-none" style={{ color: selected ? 'var(--foreground)' : 'var(--muted)' }}>
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
