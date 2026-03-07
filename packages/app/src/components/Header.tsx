'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useTheme } from '@/lib/ThemeContext'
import { useNetwork, type NetworkId } from '@/lib/NetworkContext'

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  { ssr: false },
)

const NETWORK_OPTIONS: { id: NetworkId; label: string }[] = [
  { id: 'simnet', label: 'sim' },
  { id: 'devnet', label: 'dev' },
  { id: 'mainnet', label: 'main' },
]

export function Header() {
  const { theme, toggleTheme } = useTheme()
  const { networkId, setNetworkId } = useNetwork()

  return (
    <header className="border-b sticky top-0 z-50" style={{ borderColor: 'var(--border)', background: 'var(--background)' }}>
      <div className="w-full px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-mono text-sm font-bold tracking-tight" style={{ color: 'var(--foreground)' }}>
            pyre
          </Link>
          <nav className="flex items-center gap-4">
            <Link href="/" className="text-xs hover:opacity-100 transition-opacity" style={{ color: 'var(--muted)' }}>
              stage
            </Link>
            <Link href="/factions" className="text-xs hover:opacity-100 transition-opacity" style={{ color: 'var(--muted)' }}>
              factions
            </Link>
            <Link href="/stronghold" className="text-xs hover:opacity-100 transition-opacity" style={{ color: 'var(--muted)' }}>
              stronghold
            </Link>
          </nav>
        </div>
        <div
          className="flex items-center rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border)' }}
        >
          <select
            value={networkId}
            onChange={(e) => setNetworkId(e.target.value as NetworkId)}
            className="h-8 px-2 text-xs cursor-pointer focus:outline-none appearance-none"
            style={{ background: 'var(--surface)', color: 'var(--muted)' }}
          >
            {NETWORK_OPTIONS.map((n) => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </select>
          <button
            onClick={toggleTheme}
            className="w-8 h-8 flex items-center justify-center text-xs transition-colors cursor-pointer"
            style={{ background: 'var(--surface)', color: 'var(--muted)' }}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? '\u2600' : '\u263E'}
          </button>
          <WalletMultiButton />
        </div>
      </div>
    </header>
  )
}
