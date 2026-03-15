'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useWallet } from '@solana/wallet-adapter-react'
import { usePyreKit } from '@/hooks/usePyreKit'
import { Header } from '@/components/Header'
import { StrongholdDashboard } from '@/components/StrongholdDashboard'
import { StrongholdActions } from '@/components/StrongholdActions'
import { StrongholdWallets } from '@/components/StrongholdWallets'
import { PyreIdentity } from '@/components/PyreIdentity'
import { useVault } from '@/hooks/useVault'
import { useRegistryProfile } from '@/hooks/useRegistryProfile'

export default function StrongholdPage() {
  const { actions, connection } = usePyreKit()
  const wallet = useWallet()
  const { vault, linkedVault, activeVault, loading, refetch } = useVault()
  const {
    profile: registryProfile,
    loading: registryLoading,
    refetch: refetchRegistry,
  } = useRegistryProfile()

  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleCreate() {
    if (!wallet.publicKey || !wallet.signTransaction) return

    setCreating(true)
    setCreateError(null)

    try {
      const { transaction: tx } = await actions.createStronghold({
        creator: wallet.publicKey.toString(),
      })

      const signedTx = await wallet.signTransaction(tx)
      const txId = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
      })
      await connection.confirmTransaction(txId, 'confirmed')

      setTimeout(refetch, 1000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setCreateError(msg.includes('User rejected') ? 'Cancelled' : msg)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex justify-center">
        <div className="w-full max-w-xl px-6 sm:px-8 py-6">
          <h1 className="text-sm font-medium mb-1 text-center" style={{ color: 'var(--muted)' }}>
            stronghold
          </h1>
          <p className="text-xs mb-8 text-center" style={{ color: 'var(--muted)' }}>
            On-chain vault for depositing SOL and linking agent wallets.
          </p>

          {!wallet.publicKey ? (
            <p className="text-sm py-12 text-center" style={{ color: 'var(--muted)' }}>
              Connect wallet to manage your stronghold.
            </p>
          ) : loading ? (
            <p className="text-sm py-12 text-center" style={{ color: 'var(--muted)' }}>
              Loading...
            </p>
          ) : !activeVault ? (
            <div
              className="border rounded-lg p-8 text-center"
              style={{ borderColor: 'var(--border)' }}
            >
              <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
                No stronghold found. Create one to deposit SOL and link agent wallets.
              </p>

              {createError && (
                <p className="text-xs mb-3" style={{ color: 'var(--danger)' }}>
                  {createError}
                </p>
              )}

              <button
                onClick={handleCreate}
                disabled={creating}
                className="px-6 py-2.5 text-sm rounded-lg font-medium cursor-pointer disabled:opacity-40 transition-colors"
                style={{
                  background: 'var(--surface)',
                  color: 'var(--foreground)',
                  border: '1px solid var(--border)',
                }}
              >
                {creating ? 'Creating...' : 'Create Stronghold'}
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {!vault && linkedVault && (
                <p
                  className="text-xs p-3 rounded-lg"
                  style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                >
                  Viewing a stronghold you are linked to (not your own).
                </p>
              )}

              <StrongholdDashboard vault={activeVault} />
              <StrongholdActions vault={activeVault} onSuccess={refetch} />
              <StrongholdWallets vault={activeVault} onSuccess={refetch} />
              <PyreIdentity
                profile={registryProfile}
                loading={registryLoading}
                isAuthority={wallet.publicKey?.toString() === activeVault.authority}
                onSuccess={refetchRegistry}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
