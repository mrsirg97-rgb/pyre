'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { NetworkProvider, useNetwork } from '@/lib/NetworkContext'
import { ThemeProvider } from '@/lib/ThemeContext'

import '@solana/wallet-adapter-react-ui/styles.css'

// Register Solana Mobile Wallet Adapter on Android (Seeker, Saga)
function isAndroidMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android/i.test(navigator.userAgent)
}

function getUriForAppIdentity(): string {
  if (typeof window === 'undefined') return 'https://pyre.world'
  return `${window.location.protocol}//${window.location.host}`
}

function useMobileWalletAdapter() {
  useEffect(() => {
    if (!isAndroidMobile()) return
    import('@solana-mobile/wallet-standard-mobile').then(({
      registerMwa,
      createDefaultAuthorizationCache,
      createDefaultChainSelector,
      createDefaultWalletNotFoundHandler,
    }) => {
      registerMwa({
        appIdentity: {
          name: 'Pyre World',
          uri: getUriForAppIdentity(),
          icon: '/apple-touch-icon.png',
        },
        authorizationCache: createDefaultAuthorizationCache(),
        chains: ['solana:mainnet', 'solana:devnet'],
        chainSelector: createDefaultChainSelector(),
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
      })
    }).catch(() => {
      // MWA not available — desktop or unsupported device
    })
  }, [])
}

function SolanaProviders({ children }: { children: React.ReactNode }) {
  useMobileWalletAdapter()
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
