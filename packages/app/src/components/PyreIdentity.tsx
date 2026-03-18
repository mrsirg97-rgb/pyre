'use client'

import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import type { RegistryProfile } from 'pyre-world-kit'
import { usePyreKit } from '@/hooks/usePyreKit'
import { shortenAddress, timeAgo } from '@/lib/utils'

interface PyreIdentityProps {
  profile: RegistryProfile | null
  loading: boolean
  isAuthority: boolean
  onSuccess: () => void
}

const ACTION_LABELS: { key: keyof RegistryProfile; label: string }[] = [
  { key: 'joins', label: 'Joins' },
  { key: 'defects', label: 'Defects' },
  { key: 'rallies', label: 'Rallies' },
  { key: 'launches', label: 'Launches' },
  { key: 'messages', label: 'Messages' },
  { key: 'reinforces', label: 'Reinforces' },
  { key: 'war_loans', label: 'War Loans' },
  { key: 'repay_loans', label: 'Repayments' },
  { key: 'sieges', label: 'Sieges' },
  { key: 'ascends', label: 'Ascends' },
  { key: 'razes', label: 'Razes' },
  { key: 'tithes', label: 'Tithes' },
  { key: 'infiltrates', label: 'Infiltrates' },
  { key: 'fuds', label: 'Fuds' },
]

export function PyreIdentity({ profile, loading, isAuthority, onSuccess }: PyreIdentityProps) {
  const { registry, connection } = usePyreKit()
  const wallet = useWallet()

  const [creating, setCreating] = useState(false)
  const [linking, setLinking] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [linkAddress, setLinkAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function handleCreate() {
    if (!wallet.publicKey || !wallet.sendTransaction) return

    setCreating(true)
    setError(null)

    try {
      const { transaction: tx } = await registry.register({
        creator: wallet.publicKey.toString(),
      })

      const txId = await wallet.sendTransaction(tx, connection)
      await connection.confirmTransaction(txId, 'confirmed')

      setTimeout(onSuccess, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setCreating(false)
    }
  }

  async function handleLink() {
    if (!wallet.publicKey || !wallet.sendTransaction || !profile) return

    const addr = linkAddress.trim()
    if (!addr) {
      setError('Enter an agent wallet address')
      return
    }
    try {
      new PublicKey(addr)
    } catch {
      setError('Invalid address')
      return
    }

    setLinking(true)
    setError(null)
    setSuccess(null)

    try {
      const authority = wallet.publicKey.toString()
      const { transaction: tx } = await registry.linkWallet({
        authority,
        creator: authority,
        wallet_to_link: addr,
      })

      const txId = await wallet.sendTransaction(tx, connection)
      await connection.confirmTransaction(txId, 'confirmed')

      setLinkAddress('')
      setSuccess(`Linked ${shortenAddress(addr)}`)
      setTimeout(onSuccess, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(
        msg.includes('User rejected')
          ? 'Cancelled'
          : msg.includes('WalletAlreadyLinked')
            ? 'Unlink the current wallet first'
            : msg,
      )
    } finally {
      setLinking(false)
    }
  }

  async function handleUnlink() {
    if (!wallet.publicKey || !wallet.sendTransaction || !profile) return
    if (profile.linked_wallet === profile.creator) return

    setUnlinking(true)
    setError(null)
    setSuccess(null)

    try {
      const authority = wallet.publicKey.toString()
      const { transaction: tx } = await registry.unlinkWallet({
        authority,
        creator: authority,
        wallet_to_unlink: profile.linked_wallet,
      })

      const txId = await wallet.sendTransaction(tx, connection)
      await connection.confirmTransaction(txId, 'confirmed')

      setSuccess('Wallet unlinked')
      setTimeout(onSuccess, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setUnlinking(false)
    }
  }

  if (loading) {
    return (
      <div
        className="border rounded-lg p-5"
        style={{ borderColor: 'var(--border)', margin: '0.5rem' }}
      >
        <h3 className="text-sm font-medium mb-2">Pyre Identity</h3>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Loading...
        </p>
      </div>
    )
  }

  if (!profile) {
    return (
      <div
        className="border rounded-lg"
        style={{ borderColor: 'var(--border)', margin: '0.5rem', padding: '0.25rem' }}
      >
        <h3 className="text-sm font-medium mb-2">Pyre Identity</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
          No on-chain identity found. Create one to persist agent history.
        </p>

        {isAuthority && (
          <>
            {error && (
              <p className="text-xs mb-2" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            )}
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-xs rounded-lg cursor-pointer disabled:opacity-40 transition-colors"
              style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                padding: '0.25rem 0.5rem',
                border: '1px solid var(--border)',
              }}
            >
              {creating ? 'Creating...' : 'Create Identity'}
            </button>
          </>
        )}
      </div>
    )
  }

  const totalActions = ACTION_LABELS.reduce((sum, { key }) => sum + (profile[key] as number), 0)
  const nonZeroActions = ACTION_LABELS.filter(({ key }) => (profile[key] as number) > 0)

  return (
    <div
      className="border rounded-lg"
      style={{ borderColor: 'var(--border)', margin: '0.5rem', padding: '0.25rem' }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: '0.25rem' }}>
        <h3 className="text-sm font-medium">Pyre Identity</h3>
        <div className="flex items-center gap-2">
          {(profile.total_sol_spent > 0 || profile.total_sol_received > 0) &&
            (() => {
              const pnl = (profile.total_sol_received - profile.total_sol_spent) / 1e9
              return (
                <span
                  className="text-xs font-medium"
                  style={{ color: pnl >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)' }}
                >
                  {pnl >= 0 ? '+' : ''}
                  {pnl.toFixed(3)} SOL
                </span>
              )
            })()}
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {totalActions} actions
          </span>
        </div>
      </div>

      {profile.personality_summary && (
        <p
          className="text-xs mb-3 rounded"
          style={{ background: 'var(--surface)', padding: '0.25rem', color: 'var(--muted)', marginBottom: '0.25rem' }}
        >
          {profile.personality_summary}
        </p>
      )}

      {nonZeroActions.length > 0 && (
        <div className="grid grid-cols-3 gap-1 mb-3">
          {nonZeroActions.map(({ key, label }) => (
            <div
              key={key}
              className="rounded text-center"
              style={{ background: 'var(--surface)', padding: '2px' }}
            >
              <p className="text-xs font-mono">{profile[key] as number}</p>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {label}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Link / Unlink wallet controls */}
      {isAuthority && (
        <div className="mb-3">
          {profile.linked_wallet === profile.creator ? (
            <div>
              <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>
                Link Agent Wallet
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={linkAddress}
                  onChange={(e) => setLinkAddress(e.target.value)}
                  placeholder="Agent wallet address..."
                  className="flex-1 rounded-lg text-xs min-w-0 focus:outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--foreground)',
                    padding: '0.25rem',
                  }}
                />
                <button
                  onClick={handleLink}
                  disabled={linking || !linkAddress.trim()}
                  className="text-xs rounded-lg cursor-pointer disabled:opacity-40 transition-colors"
                  style={{
                    background: 'var(--surface)',
                    color: 'var(--foreground)',
                    padding: '0.25rem',
                  }}
                >
                  {linking ? '...' : 'Link'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between text-xs">
              <div>
                <span style={{ color: 'var(--muted)' }}>Linked: </span>
                <span className="font-mono">{shortenAddress(profile.linked_wallet, 6)}</span>
              </div>
              <button
                onClick={handleUnlink}
                disabled={unlinking}
                className="text-xs rounded-lg cursor-pointer disabled:opacity-40"
                style={{ color: 'var(--danger)', padding: '0.25rem' }}
              >
                {unlinking ? '...' : 'Unlink'}
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs mb-2" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {success && (
        <p className="text-xs mb-2" style={{ color: 'var(--success)' }}>
          {success}
        </p>
      )}

      <div
        className="border-t text-xs space-y-1"
        style={{
          borderColor: 'var(--border)',
          color: 'var(--muted)',
          marginTop: '2px',
          padding: '2px',
        }}
      >
        <div className="flex items-center justify-between">
          <span>Profile</span>
          <span className="font-mono">{shortenAddress(profile.address, 6)}</span>
        </div>
        {profile.last_checkpoint > 0 && (
          <div className="flex items-center justify-between">
            <span>Last Checkpoint</span>
            <span>{timeAgo(profile.last_checkpoint)}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span>Created</span>
          <span>{timeAgo(profile.created_at)}</span>
        </div>
      </div>
    </div>
  )
}
