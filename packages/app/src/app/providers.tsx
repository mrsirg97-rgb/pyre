'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { NetworkProvider, useNetwork } from '@/lib/NetworkContext'
import { ThemeProvider } from '@/lib/ThemeContext'
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
} from '@solana-mobile/wallet-standard-mobile'

import '@solana/wallet-adapter-react-ui/styles.css'

function getUriForAppIdentity() {
  const location = globalThis.location
  if (!location) return undefined
  return `${location.protocol}//${location.host}`
}

function isAndroidMobile() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof document !== 'undefined' &&
    /android/i.test(navigator.userAgent)
  )
}

// Determine active chain from localStorage (matches NetworkContext)
function getActiveChain(): 'solana:mainnet' | 'solana:devnet' {
  if (typeof window === 'undefined') return 'solana:devnet'
  const stored = localStorage.getItem('pyre-network')
  return stored === 'mainnet' ? 'solana:mainnet' : 'solana:devnet'
}

// Register MWA at module load — must happen before WalletProvider mounts
if (isAndroidMobile()) {
  const chain = getActiveChain()
  registerMwa({
    appIdentity: {
      name: 'Pyre World',
      uri: getUriForAppIdentity(),
      icon: '/apple-touch-icon.png',
    },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: [chain],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  })
}

function SolanaProviders({ children }: { children: React.ReactNode }) {
  const { networkId, isSimnet, effectiveRpcUrl, effectiveWsUrl } = useNetwork()

  const config = useMemo(
    () => ({
      commitment: 'confirmed' as const,
      ...(effectiveWsUrl && !isSimnet ? { wsEndpoint: effectiveWsUrl } : {}),
    }),
    [effectiveWsUrl, isSimnet],
  )

  const wallets = useMemo(() => [], [])

  return (
    <ConnectionProvider key={networkId} endpoint={effectiveRpcUrl} config={config}>
      <WalletProvider wallets={wallets} autoConnect={isAndroidMobile()}>
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
