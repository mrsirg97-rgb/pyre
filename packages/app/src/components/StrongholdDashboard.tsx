'use client'

import { useWallet } from '@solana/wallet-adapter-react'
import type { Stronghold } from 'pyre-world-kit'
import { shortenAddress, fmtSol } from '@/lib/utils'

interface StrongholdDashboardProps {
  vault: Stronghold
}

export function StrongholdDashboard({ vault }: StrongholdDashboardProps) {
  const { publicKey } = useWallet()
  const isAuthority = publicKey?.toString() === vault.authority

  return (
    <div className="border rounded-lg p-5" style={{ borderColor: 'var(--border)', margin: '0.5rem' }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">Stronghold</h3>
        {isAuthority && (
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
            authority
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded" style={{ background: 'var(--surface)' }}>
          <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>SOL Balance</p>
          <p className="text-lg font-mono">{fmtSol(vault.sol_balance)}</p>
        </div>
        <div className="p-3 rounded" style={{ background: 'var(--surface)' }}>
          <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Linked Agents</p>
          <p className="text-lg font-mono">{vault.linked_agents}</p>
        </div>
        <div className="p-3 rounded" style={{ background: 'var(--surface)' }}>
          <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Total Deposited</p>
          <p className="text-sm font-mono">{fmtSol(vault.total_deposited)}</p>
        </div>
        <div className="p-3 rounded" style={{ background: 'var(--surface)' }}>
          <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Total Withdrawn</p>
          <p className="text-sm font-mono">{fmtSol(vault.total_withdrawn)}</p>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t flex items-center justify-between text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
        <span>Address</span>
        <span className="font-mono">{shortenAddress(vault.address, 6)}</span>
      </div>
    </div>
  )
}
