'use client'

import { shortenAddress } from '@/lib/utils'

interface LensPlayerStatusProps {
  controllerPublicKey: string | null
  controllerBalance: number
  pnl: { spent: number; received: number; net: number }
}

export function LensPlayerStatus({ controllerPublicKey, controllerBalance, pnl }: LensPlayerStatusProps) {
  return (
    <div
      className="flex items-center justify-between gap-4 text-xs"
      style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-3">
        {controllerPublicKey && (
          <span className="font-mono" style={{ color: 'var(--muted)' }}>
            {shortenAddress(controllerPublicKey)}
          </span>
        )}
        <span style={{ color: 'var(--foreground)' }}>
          {controllerBalance.toFixed(4)} SOL
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span style={{ color: pnl.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
          P&L: {pnl.net >= 0 ? '+' : ''}{pnl.net.toFixed(4)}
        </span>
      </div>
    </div>
  )
}
