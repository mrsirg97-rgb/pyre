'use client'

import { useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { buildDepositVaultTransaction, buildWithdrawVaultTransaction, LAMPORTS_PER_SOL } from 'torchsdk'
import type { VaultInfo } from 'torchsdk'
import { fmtSol } from '@/lib/utils'

interface StrongholdActionsProps {
  vault: VaultInfo
  onSuccess: () => void
}

export function StrongholdActions({ vault, onSuccess }: StrongholdActionsProps) {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const isAuthority = wallet.publicKey?.toString() === vault.authority

  async function handleAction() {
    if (!wallet.publicKey || !wallet.signTransaction) return

    const solAmount = parseFloat(amount)
    if (isNaN(solAmount) || solAmount <= 0) {
      setError('Enter a valid SOL amount')
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL)
      let tx

      if (tab === 'deposit') {
        const result = await buildDepositVaultTransaction(connection, {
          depositor: wallet.publicKey.toString(),
          vault_creator: vault.creator,
          amount_sol: lamports,
        })
        tx = result.transaction
      } else {
        if (!isAuthority) {
          setError('Only the authority can withdraw')
          setLoading(false)
          return
        }
        const result = await buildWithdrawVaultTransaction(connection, {
          authority: wallet.publicKey.toString(),
          vault_creator: vault.creator,
          amount_sol: lamports,
        })
        tx = result.transaction
      }

      const signedTx = await wallet.signTransaction(tx)
      const txId = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true })
      await connection.confirmTransaction(txId, 'confirmed')

      setAmount('')
      setSuccess(`${tab === 'deposit' ? 'Deposited' : 'Withdrew'} ${solAmount} SOL`)
      setTimeout(onSuccess, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border rounded-lg p-4" style={{ borderColor: 'var(--border)' }}>
      <h3 className="text-sm font-medium mb-3">SOL</h3>

      <div className="flex mb-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={() => { setTab('deposit'); setError(null); setSuccess(null) }}
          className="flex-1 pb-2 text-sm text-center transition-colors cursor-pointer"
          style={{
            color: tab === 'deposit' ? 'var(--foreground)' : 'var(--muted)',
            borderBottom: tab === 'deposit' ? '1px solid var(--foreground)' : 'none',
          }}
        >
          Deposit
        </button>
        <button
          onClick={() => { setTab('withdraw'); setError(null); setSuccess(null) }}
          className="flex-1 pb-2 text-sm text-center transition-colors cursor-pointer"
          style={{
            color: tab === 'withdraw' ? 'var(--foreground)' : 'var(--muted)',
            borderBottom: tab === 'withdraw' ? '1px solid var(--foreground)' : 'none',
          }}
        >
          Withdraw
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs" style={{ color: 'var(--muted)' }}>Amount (SOL)</label>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              Balance: {fmtSol(vault.sol_balance)}
            </span>
          </div>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            className="w-full rounded-lg px-3 py-2.5 text-sm focus:outline-none transition-colors"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
            }}
          />
        </div>

        {tab === 'withdraw' && !isAuthority && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>Only the authority can withdraw.</p>
        )}

        {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
        {success && <p className="text-xs" style={{ color: 'var(--success)' }}>{success}</p>}

        <button
          onClick={handleAction}
          disabled={loading || !wallet.publicKey || (tab === 'withdraw' && !isAuthority)}
          className="w-full py-2.5 text-sm rounded-lg font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'var(--surface)', color: 'var(--foreground)' }}
        >
          {loading ? 'Processing...' : tab === 'deposit' ? 'Deposit' : 'Withdraw'}
        </button>
      </div>
    </div>
  )
}
