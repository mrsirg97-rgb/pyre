'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import type { AgentTickResult, Personality } from 'pyre-agent-kit'
import { createBrowserAgent, BrowserAgent } from './browser-agent'
import { createWebLLMAdapter, rngAdapter, WebLLMState } from './webllm-adapter'
import { detectDevice, ModelTier, DeviceCapabilities } from './device-detect'
import { saveAgentState, loadAgentState } from './state-persistence'
import type { WalletSigner } from './wallet-signer'

export interface BrowserAgentHook {
  // Agent state
  agent: BrowserAgent | null
  running: boolean
  personality: Personality | null
  logs: string[]
  lastResult: AgentTickResult | null

  // Model state
  modelStatus: WebLLMState
  modelTier: ModelTier
  deviceCapabilities: DeviceCapabilities | null

  // Controls
  init: (tier?: ModelTier) => Promise<void>
  start: (intervalMs?: number) => void
  stop: () => void
  tickOnce: () => Promise<AgentTickResult | null>
  setModelTier: (tier: ModelTier) => void
}

export function useBrowserAgent(): BrowserAgentHook {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [agent, setAgent] = useState<BrowserAgent | null>(null)
  const [running, setRunning] = useState(false)
  const [personality, setPersonality] = useState<Personality | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [lastResult, setLastResult] = useState<AgentTickResult | null>(null)
  const [modelStatus, setModelStatus] = useState<WebLLMState>({ status: 'idle', progress: 0 })
  const [modelTier, setModelTier] = useState<ModelTier>('rng')
  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const agentRef = useRef<BrowserAgent | null>(null)
  const llmRef = useRef<ReturnType<typeof createWebLLMAdapter> | null>(null)

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-99), msg])
  }, [])

  // Detect device capabilities on mount
  useEffect(() => {
    detectDevice().then((caps) => {
      setDeviceCaps(caps)
      setModelTier(caps.recommendedTier)
    })
  }, [])

  const init = useCallback(
    async (tier?: ModelTier) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        log('Connect your wallet first')
        return
      }

      const selectedTier = tier ?? modelTier

      const signer: WalletSigner = {
        publicKey: wallet.publicKey.toBase58(),
        signTransaction: wallet.signTransaction.bind(wallet),
      }

      // Set up LLM
      let llm = rngAdapter

      if (selectedTier !== 'rng') {
        // Start with RNG immediately while model loads
        log(`Starting with RNG while ${selectedTier} model downloads...`)

        const webllmAdapter = createWebLLMAdapter(selectedTier, (state) => {
          setModelStatus(state)
          if (state.status === 'ready') log(`Model ready (${selectedTier})`)
          if (state.status === 'error') log(`Model error: ${state.error}`)
        })
        llmRef.current = webllmAdapter

        // Start model download in background
        webllmAdapter
          .init()
          .then(() => {
            // Hot-swap to LLM once ready — the agent's llm reference is shared
            llm = webllmAdapter
          })
          .catch((err) => {
            log(`Model failed to load: ${err.message}. Continuing with RNG.`)
          })

        // Use the adapter immediately — it returns null until ready, which triggers RNG fallback
        llm = webllmAdapter
      }

      // Load saved state
      const savedState = await loadAgentState(signer.publicKey).catch(() => null)
      if (savedState) log('Restored saved state')

      const network = connection.rpcEndpoint.includes('mainnet') ? 'mainnet' : 'devnet'

      try {
        const browserAgent = await createBrowserAgent({
          connection,
          wallet: signer,
          network: network as 'devnet' | 'mainnet',
          llm,
          kitState: savedState ?? undefined,
          logger: log,
        })

        agentRef.current = browserAgent
        setAgent(browserAgent)
        setPersonality(browserAgent.personality)
        log(`Agent online: ${signer.publicKey.slice(0, 8)}... (${browserAgent.personality})`)
      } catch (err: any) {
        log(`Failed to create agent: ${err.message}`)
      }
    },
    [wallet, connection, modelTier, log],
  )

  const tickOnce = useCallback(async (): Promise<AgentTickResult | null> => {
    const a = agentRef.current
    if (!a) return null

    const result = await a.tick()
    setLastResult(result)

    // Persist state
    try {
      await saveAgentState(a.getKit().state.serialize())
    } catch {}

    // Evolve personality periodically
    if (a.getKit().state.tick % 10 === 0) {
      const changed = await a.evolve()
      if (changed) setPersonality(a.personality)
    }

    return result
  }, [])

  const start = useCallback(
    (intervalMs = 15000) => {
      if (running || !agentRef.current) return
      setRunning(true)
      log(`Agent running (tick every ${intervalMs / 1000}s)`)

      // Immediate first tick
      tickOnce()

      intervalRef.current = setInterval(() => {
        tickOnce()
      }, intervalMs)
    },
    [running, tickOnce, log],
  )

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setRunning(false)
    log('Agent stopped')
  }, [log])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      llmRef.current?.destroy()
    }
  }, [])

  return {
    agent,
    running,
    personality,
    logs,
    lastResult,
    modelStatus,
    modelTier,
    deviceCapabilities: deviceCaps,
    init,
    start,
    stop,
    tickOnce,
    setModelTier,
  }
}
