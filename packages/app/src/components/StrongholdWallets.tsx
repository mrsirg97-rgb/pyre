'use client'

import { useState, useEffect, useMemo } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import Link from 'next/link'
import type { Stronghold, AgentLink } from 'pyre-world-kit'
import { usePyreKit } from '@/hooks/usePyreKit'
import { shortenAddress } from '@/lib/utils'

interface StrongholdWalletsProps {
  vault: Stronghold
  onSuccess: () => void
}

export function StrongholdWallets({ vault, onSuccess }: StrongholdWalletsProps) {
  const { actions, connection } = usePyreKit()
  const wallet = useWallet()

  const [walletAddress, setWalletAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [agents, setAgents] = useState<AgentLink[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [unlinkingWallet, setUnlinkingWallet] = useState<string | null>(null)

  const isAuthority = wallet.publicKey?.toString() === vault.authority

  async function fetchAgents() {
    setAgentsLoading(true)
    try {
      const links = await actions.getLinkedAgents(vault.address)
      setAgents(links.sort((a, b) => b.linked_at - a.linked_at))
    } catch {
      setAgents([])
    } finally {
      setAgentsLoading(false)
    }
  }

  useEffect(() => {
    fetchAgents()
  }, [vault.address])

  const filteredAgents = useMemo(() => {
    const nonAuthority = agents.filter(
      (a) => a.wallet !== vault.authority && a.wallet !== vault.creator,
    )
    if (!search.trim()) return nonAuthority
    const q = search.trim().toLowerCase()
    return nonAuthority.filter((a) => a.wallet.toLowerCase().includes(q))
  }, [agents, search, vault.authority, vault.creator])

  async function handleLink() {
    if (!wallet.publicKey || !wallet.sendTransaction || !isAuthority) return

    const addr = walletAddress.trim()
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

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const { transaction: tx } = await actions.recruitAgent({
        authority: wallet.publicKey.toString(),
        stronghold_creator: vault.creator,
        wallet_to_link: addr,
      })

      const txId = await wallet.sendTransaction(tx, connection)
      await connection.confirmTransaction(txId, 'confirmed')

      setWalletAddress('')
      setSuccess(`Linked ${shortenAddress(addr)}`)
      setTimeout(() => {
        onSuccess()
        fetchAgents()
      }, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleUnlink(addr: string) {
    if (!wallet.publicKey || !wallet.sendTransaction || !isAuthority) return

    setUnlinkingWallet(addr)
    setError(null)
    setSuccess(null)

    try {
      const { transaction: tx } = await actions.exileAgent({
        authority: wallet.publicKey.toString(),
        stronghold_creator: vault.creator,
        wallet_to_unlink: addr,
      })

      const txId = await wallet.sendTransaction(tx, connection)
      await connection.confirmTransaction(txId, 'confirmed')

      setSuccess(`Unlinked ${shortenAddress(addr)}`)
      setTimeout(() => {
        onSuccess()
        fetchAgents()
      }, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setUnlinkingWallet(null)
    }
  }

  if (!isAuthority) {
    return (
      <div
        className="border rounded-lg p-5"
        style={{ borderColor: 'var(--border)', margin: '0.5rem' }}
      >
        <h3 className="text-sm font-medium mb-2">Linked Agents</h3>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {vault.linked_agents} agent{vault.linked_agents !== 1 ? 's' : ''} linked. Only the
          authority can manage agents.
        </p>
      </div>
    )
  }

  return (
    <div
      className="border rounded-lg"
      style={{ borderColor: 'var(--border)', margin: '0.5rem', padding: '0.25rem' }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Linked Agents</h3>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {vault.linked_agents} linked
        </span>
      </div>

      <div className="space-y-3">
        {/* Link new agent */}
        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>
            Link Agent
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              placeholder="Agent wallet address..."
              className="flex-1 rounded-lg text-xs min-w-0 focus:outline-none"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                padding: '0.25rem',
                marginBottom: '0.25rem',
              }}
            />
            <button
              onClick={handleLink}
              disabled={loading || !walletAddress.trim()}
              className="text-xs rounded-lg cursor-pointer disabled:opacity-40 transition-colors"
              style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                padding: '0.25rem',
              }}
            >
              {loading ? '...' : 'Link'}
            </button>
          </div>
        </div>

        {/* Agent list with search */}
        <div>
          <label className="text-xs mb-1 block" style={{ color: 'var(--muted)' }}>
            Agents
          </label>
          {agents.length > 0 && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by address..."
              className="w-full rounded-lg text-xs focus:outline-none"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                padding: '0.25rem',
                marginBottom: '0.25rem',
              }}
            />
          )}

          {agentsLoading ? (
            <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>
              Loading agents...
            </p>
          ) : agents.length === 0 ? (
            <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>
              No agents linked yet.
            </p>
          ) : filteredAgents.length === 0 ? (
            <p className="text-xs py-2" style={{ color: 'var(--muted)' }}>
              No agents match "{search}"
            </p>
          ) : (
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {filteredAgents.map((agent) => (
                <div
                  key={agent.wallet}
                  className="flex items-center justify-between rounded-lg text-xs"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    padding: '0.25rem',
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Link
                      href={`/agent/${agent.wallet}`}
                      className="font-mono truncate hover:underline"
                      title={agent.wallet}
                      style={{ color: 'var(--foreground)' }}
                    >
                      {shortenAddress(agent.wallet)}
                    </Link>
                    <span style={{ color: 'var(--muted)' }}>
                      {new Date(agent.linked_at * 1000).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => handleUnlink(agent.wallet)}
                    disabled={unlinkingWallet === agent.wallet}
                    className="text-xs rounded-lg cursor-pointer disabled:opacity-40 shrink-0 ml-3"
                    style={{ color: 'var(--danger)', padding: '0.25rem' }}
                  >
                    {unlinkingWallet === agent.wallet ? '...' : 'Unlink'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        {success && (
          <p className="text-xs" style={{ color: 'var(--success)' }}>
            {success}
          </p>
        )}
      </div>
    </div>
  )
}
