'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { NetworkProvider, useNetwork } from '@/lib/NetworkContext'
import { ThemeProvider } from '@/lib/ThemeContext'

import '@solana/wallet-adapter-react-ui/styles.css'

function SolanaProviders({ children }: { children: React.ReactNode }) {
  const { networkId, isSimnet, effectiveRpcUrl, effectiveWsUrl } = useNetwork()

  const config = useMemo(
    () => ({
      commitment: 'confirmed' as const,
      ...(effectiveWsUrl ? { wsEndpoint: effectiveWsUrl } : {}),
    }),
    [effectiveWsUrl],
  )

  const wallets = useMemo(() => [], [])

  return (
    <ConnectionProvider key={networkId} endpoint={effectiveRpcUrl} config={config}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

const emptySubscribe = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false

export function Providers({ children }: { children: React.ReactNode }) {
  const mounted = useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot)
  if (!mounted) return null

  return (
    <ThemeProvider>
      <NetworkProvider>
        <SolanaProviders>{children}</SolanaProviders>
      </NetworkProvider>
    </ThemeProvider>
  )
}
