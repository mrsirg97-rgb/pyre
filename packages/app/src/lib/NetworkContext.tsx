'use client'

import { createContext, useContext, useCallback, useSyncExternalStore, ReactNode } from 'react'
export type NetworkId = 'simnet' | 'devnet' | 'mainnet'

interface NetworkConfig {
  id: NetworkId
  rpcUrl: string
  wsUrl?: string
}

// Cloudflare Worker proxy for Helius RPC (keeps API key server-side)
const HELIUS_PROXY_URL = 'https://torch-market-rpc.mrsirg97.workers.dev'
const HELIUS_WS_URL = 'wss://torch-market-rpc.mrsirg97.workers.dev'

const NETWORKS: Record<NetworkId, NetworkConfig> = {
  simnet: {
    id: 'simnet',
    rpcUrl: 'http://localhost:8899',
    wsUrl: 'ws://localhost:8900',
  },
  devnet: {
    id: 'devnet',
    rpcUrl: `${HELIUS_PROXY_URL}/devnet`,
    wsUrl: `${HELIUS_WS_URL}/devnet`,
  },
  mainnet: {
    id: 'mainnet',
    rpcUrl: HELIUS_PROXY_URL,
    wsUrl: HELIUS_WS_URL,
  },
}

const STORAGE_KEY = 'pyre-network'

function getDefaultNetworkId(): NetworkId {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'simnet' || stored === 'devnet' || stored === 'mainnet') {
      return stored
    }
  }
  const env = process.env.NEXT_PUBLIC_NETWORK
  if (env === 'simnet' || env === 'devnet' || env === 'mainnet') return env
  return 'devnet'
}

interface NetworkContextType {
  networkId: NetworkId
  setNetworkId: (id: NetworkId) => void
  effectiveRpcUrl: string
  effectiveWsUrl: string | undefined
  isSimnet: boolean
}

const NetworkContext = createContext<NetworkContextType | null>(null)

function subscribeToStorage(callback: () => void) {
  window.addEventListener('storage', callback)
  return () => window.removeEventListener('storage', callback)
}

function getNetworkSnapshot(): NetworkId {
  return getDefaultNetworkId()
}

function getServerSnapshot(): NetworkId {
  return 'devnet'
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const networkId = useSyncExternalStore(subscribeToStorage, getNetworkSnapshot, getServerSnapshot)

  const setNetworkId = useCallback((id: NetworkId) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, id)
      ;(globalThis as any).__TORCH_NETWORK__ = id === 'devnet' ? 'devnet' : ''
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: id }))
    }
  }, [])

  if (typeof window !== 'undefined') {
    ;(globalThis as any).__TORCH_NETWORK__ = networkId === 'devnet' ? 'devnet' : ''
  }

  const network = NETWORKS[networkId]

  const value: NetworkContextType = {
    networkId,
    setNetworkId,
    effectiveRpcUrl: network.rpcUrl,
    effectiveWsUrl: networkId === 'simnet' ? undefined : network.wsUrl,
    isSimnet: networkId === 'simnet',
  }

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
}

export function useNetwork(): NetworkContextType {
  const context = useContext(NetworkContext)
  if (!context) throw new Error('useNetwork must be used within a NetworkProvider')
  return context
}
