'use client'

import { useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { recruitAgent, exileAgent, getAgentLink } from 'pyre-world-kit'
import type { Stronghold } from 'pyre-world-kit'
import { shortenAddress } from '@/lib/utils'

interface StrongholdWalletsProps {
  vault: Stronghold
  onSuccess: () => void
}

export function StrongholdWallets({ vault, onSuccess }: StrongholdWalletsProps) {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [walletAddress, setWalletAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [checkAddress, setCheckAddress] = useState('')
  const [checkResult, setCheckResult] = useState<{ wallet: string; linked: boolean } | null>(null)
  const [checking, setChecking] = useState(false)
  const [unlinkLoading, setUnlinkLoading] = useState(false)

  const isAuthority = wallet.publicKey?.toString() === vault.authority

  async function handleLink() {
    if (!wallet.publicKey || !wallet.signTransaction || !isAuthority) return

    const addr = walletAddress.trim()
    if (!addr) { setError('Enter an agent wallet address'); return }

    try { new PublicKey(addr) } catch { setError('Invalid address'); return }

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const { transaction: tx } = await recruitAgent(connection, {
        authority: wallet.publicKey.toString(),
        stronghold_creator: vault.creator,
        wallet_to_link: addr,
      })

      const signedTx = await wallet.signTransaction(tx)
      const txId = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true })
      await connection.confirmTransaction(txId, 'confirmed')

      setWalletAddress('')
      setSuccess(`Linked ${shortenAddress(addr)}`)
      setTimeout(onSuccess, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleCheck() {
    const addr = checkAddress.trim()
    if (!addr) { setError('Enter an address to check'); return }
    try { new PublicKey(addr) } catch { setError('Invalid address'); return }

    setChecking(true)
    setError(null)

    try {
      const link = await getAgentLink(connection, addr)
      setCheckResult({ wallet: addr, linked: !!(link && link.stronghold === vault.address) })
    } catch {
      setCheckResult({ wallet: addr, linked: false })
    } finally {
      setChecking(false)
    }
  }

  async function handleUnlink(addr: string) {
    if (!wallet.publicKey || !wallet.signTransaction || !isAuthority) return

    setUnlinkLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const { transaction: tx } = await exileAgent(connection, {
        authority: wallet.publicKey.toString(),
        stronghold_creator: vault.creator,
        wallet_to_unlink: addr,
      })

      const signedTx = await wallet.signTransaction(tx)
      const txId = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true })
      await connection.confirmTransaction(txId, 'confirmed')

      setSuccess(`Unlinked ${shortenAddress(addr)}`)
      setCheckResult(null)
      setCheckAddress('')
      setTimeout(onSuccess, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setUnlinkLoading(false)
    }
  }

  if (!isAuthority) {
    return (
      <div className="border rounded-lg p-5" style={{ borderColor: 'var(--border)', margin: '0.5rem' }}>
        <h3 className="text-sm font-medium mb-2">Linked Agents</h3>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {vault.linked_agents} agent{vault.linked_agents !== 1 ? 's' : ''} linked. Only the authority can manage agents.
        </p>
      </div>
    )
  }

  return (
    <div className="border rounded-lg p-4" style={{ borderColor: 'var(--border)', margin: '0.5rem' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Linked Agents</h3>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>{vault.linked_agents} linked</span>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Link Agent</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              placeholder="Agent wallet address..."
              className="flex-1 rounded-lg px-3 py-2 text-xs min-w-0 focus:outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
            <button
              onClick={handleLink}
              disabled={loading || !walletAddress.trim()}
              className="px-3 py-2 text-xs rounded-lg cursor-pointer disabled:opacity-40 transition-colors"
              style={{ background: 'var(--surface)', color: 'var(--foreground)' }}
            >
              {loading ? '...' : 'Link'}
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>Check / Unlink</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={checkAddress}
              onChange={(e) => { setCheckAddress(e.target.value); setCheckResult(null) }}
              placeholder="Check if agent is linked..."
              className="flex-1 rounded-lg px-3 py-2 text-xs min-w-0 focus:outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            />
            <button
              onClick={handleCheck}
              disabled={checking || !checkAddress.trim()}
              className="px-3 py-2 text-xs rounded-lg cursor-pointer disabled:opacity-40 transition-colors"
              style={{ background: 'var(--surface)', color: 'var(--foreground)' }}
            >
              {checking ? '...' : 'Check'}
            </button>
          </div>
          {checkResult && (
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                {shortenAddress(checkResult.wallet)}:{' '}
                {checkResult.linked ? (
                  <span style={{ color: 'var(--success)' }}>linked</span>
                ) : (
                  <span>not linked</span>
                )}
              </span>
              {checkResult.linked && (
                <button
                  onClick={() => handleUnlink(checkResult.wallet)}
                  disabled={unlinkLoading}
                  className="px-2 py-1 text-xs rounded cursor-pointer disabled:opacity-40"
                  style={{ color: 'var(--danger)' }}
                >
                  {unlinkLoading ? '...' : 'Unlink'}
                </button>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
        {success && <p className="text-xs" style={{ color: 'var(--success)' }}>{success}</p>}
      </div>
    </div>
  )
}
