'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { AgentTickResult, Personality } from 'pyre-agent-kit'
import { createBrowserAgent, BrowserAgent } from './browser-agent'
import { createWebLLMAdapter, rngAdapter, WebLLMState } from './webllm-adapter'
import { detectDevice, ModelTier, DeviceCapabilities } from './device-detect'
import { saveAgentState, loadAgentState } from './state-persistence'
import { getOrCreateController, loadController } from './keypair-store'
import { createKeypairSigner, type WalletSigner } from './wallet-signer'

export type ControllerStatus =
  | 'none'        // no controller yet
  | 'created'     // keypair exists, needs funding + linking
  | 'unfunded'    // linked but no SOL for gas
  | 'ready'       // funded + linked, ready to operate

export interface BrowserAgentHook {
  // Agent state
  agent: BrowserAgent | null
  running: boolean
  ticking: boolean
  personality: Personality | null
  logs: string[]
  lastResult: AgentTickResult | null

  // Controller state
  controllerStatus: ControllerStatus
  controllerPublicKey: string | null
  controllerBalance: number // SOL

  // Model state
  modelStatus: WebLLMState
  modelTier: ModelTier
  deviceCapabilities: DeviceCapabilities | null

  // Controls
  setupController: () => Promise<void>
  linkController: () => Promise<void>
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
  const [ticking, setTicking] = useState(false)
  const [personality, setPersonality] = useState<Personality | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [lastResult, setLastResult] = useState<AgentTickResult | null>(null)
  const [modelStatus, setModelStatus] = useState<WebLLMState>({ status: 'idle', progress: 0 })
  const [modelTier, setModelTier] = useState<ModelTier>('rng')
  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null)

  // Controller state
  const [controllerStatus, setControllerStatus] = useState<ControllerStatus>('none')
  const [controllerPublicKey, setControllerPublicKey] = useState<string | null>(null)
  const [controllerBalance, setControllerBalance] = useState(0)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const agentRef = useRef<BrowserAgent | null>(null)
  const llmRef = useRef<ReturnType<typeof createWebLLMAdapter> | null>(null)

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-99), msg])
  }, [])

  // Detect device capabilities on mount
  useEffect(() => {
    detectDevice()
      .then((caps) => {
        setDeviceCaps(caps)
        setModelTier(caps.recommendedTier)
      })
      .catch(() => {
        // WebGPU probe crashed — force RNG so agent still works
        setModelTier('rng')
      })
  }, [])

  // Check for existing controller on mount
  useEffect(() => {
    loadController().then((kp) => {
      if (kp) {
        setControllerPublicKey(kp.publicKey.toBase58())
        setControllerStatus('created')
        // Check balance
        connection.getBalance(kp.publicKey).then((bal) => {
          setControllerBalance(bal / LAMPORTS_PER_SOL)
          if (bal > 0) setControllerStatus('ready')
        }).catch(() => {})
      }
    })
  }, [connection])

  /** Step 1: Generate ephemeral controller keypair */
  const setupController = useCallback(async () => {
    const kp = await getOrCreateController()
    const pubkey = kp.publicKey.toBase58()
    setControllerPublicKey(pubkey)
    setControllerStatus('created')
    log(`Controller created: ${pubkey}`)
    log(`Fund with ~0.01 SOL for gas`)

    // Check if already funded
    try {
      const bal = await connection.getBalance(kp.publicKey)
      setControllerBalance(bal / LAMPORTS_PER_SOL)
      if (bal > 0) setControllerStatus('ready')
    } catch {}
  }, [connection, log])

  /** Step 2: Link controller to user's stronghold via Phantom */
  const linkController = useCallback(async () => {
    if (!wallet.publicKey || !wallet.sendTransaction || !controllerPublicKey) {
      log('Connect your wallet first')
      return
    }

    try {
      const { PyreKit } = await import('pyre-world-kit')
      const kit = new PyreKit(connection, wallet.publicKey.toBase58())

      // Check if stronghold exists
      const stronghold = await kit.actions.getStrongholdForAgent(wallet.publicKey.toBase58())
      if (!stronghold) {
        log('No stronghold found — create one at pyre.world/stronghold')
        return
      }

      const authority = wallet.publicKey.toBase58()

      // Link controller to stronghold
      const recruitResult = await kit.actions.recruitAgent({
        authority,
        stronghold_creator: stronghold.creator,
        wallet_to_link: controllerPublicKey,
      })
      const recruitSig = await wallet.sendTransaction(recruitResult.transaction, connection)
      await connection.confirmTransaction(recruitSig, 'confirmed')
      log(`Controller linked to stronghold`)

      // Link controller to pyre identity (so it can checkpoint)
      try {
        // Ensure identity exists
        const profile = await kit.registry.getProfile(authority)
        if (!profile) {
          const regResult = await kit.registry.register({ creator: authority })
          const regSig = await wallet.sendTransaction(regResult.transaction, connection)
          await connection.confirmTransaction(regSig, 'confirmed')
          log(`Pyre identity created`)
        }

        const linkResult = await kit.registry.linkWallet({
          authority,
          creator: authority,
          wallet_to_link: controllerPublicKey,
        })
        const linkSig = await wallet.sendTransaction(linkResult.transaction, connection)
        await connection.confirmTransaction(linkSig, 'confirmed')
        log(`Controller linked to pyre identity`)
      } catch (e: any) {
        // Already linked or no profile — non-fatal
        log(`Identity link: ${e.message?.slice(0, 60) || 'skipped'}`)
      }

      setControllerStatus('ready')
    } catch (err: any) {
      // Already linked is fine
      if (err.message?.includes('already')) {
        log('Controller already linked')
        setControllerStatus('ready')
      } else {
        log(`Link failed: ${err.message?.slice(0, 80)}`)
      }
    }
  }, [wallet, connection, controllerPublicKey, log])

  /** Initialize agent with ephemeral controller (or fall back to wallet adapter) */
  const init = useCallback(
    async (tier?: ModelTier) => {
      const selectedTier = tier ?? modelTier

      // Try ephemeral controller first
      let signer: WalletSigner
      const controller = await loadController()

      if (controller) {
        signer = createKeypairSigner(controller)
        log(`Using controller: ${signer.publicKey.slice(0, 8)}...`)
      } else if (wallet.publicKey && wallet.signTransaction) {
        // Fall back to wallet adapter (legacy mode — uses signTransaction for WalletSigner compat)
        signer = {
          publicKey: wallet.publicKey.toBase58(),
          signTransaction: wallet.signTransaction.bind(wallet),
        }
        log(`Using wallet adapter (no controller — setup recommended)`)
      } else {
        log('Connect your wallet or set up a controller first')
        return
      }

      // Set up LLM
      let llm = rngAdapter

      if (selectedTier !== 'rng') {
        log(`Starting with RNG while ${selectedTier} model downloads...`)

        const webllmAdapter = createWebLLMAdapter(
          selectedTier,
          deviceCaps?.hasShaderF16 ?? false,
          (state) => {
            setModelStatus(state)
            if (state.status === 'ready') log(`Model ready (${selectedTier})`)
            if (state.status === 'error') log(`Model error: ${state.error}`)
          },
          (() => {
            let buf = ''
            return (delta: string) => {
              buf += delta
              // Flush on sentence boundaries for readable streaming
              if (delta.includes('.') || delta.includes('\n')) {
                log(`thinking: ${buf.trim()}`)
                buf = ''
              }
            }
          })(),
          deviceCaps?.isMobile ?? false,
        )
        llmRef.current = webllmAdapter

        // Start with RNG — agent uses webllmAdapter which returns null until ready
        llm = webllmAdapter

        webllmAdapter.init().catch(() => {
          log('Model failed — agent continues with RNG.')
        })
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
          modelTier: selectedTier,
          kitState: savedState ?? undefined,
          logger: log,
        })

        // Wire auto-checkpoint (same as CLI/swarm)
        const kit = browserAgent.getKit()
        kit.setCheckpointConfig({ interval: 1 })
        const authorityPubkey = wallet.publicKey?.toBase58() ?? signer.publicKey
        kit.onCheckpointDue = async () => {
          try {
            const gameState = kit.state.state!
            const counts = gameState.actionCounts

            // Read on-chain profile and take max to avoid CounterNotMonotonic
            const profile = await kit.registry.getProfile(authorityPubkey)
            const max = (local: number, chain: number) => Math.max(local, chain)
            // Sync local state with chain (catch up if behind)
            if (profile) {
              counts.join = max(counts.join, profile.joins)
              counts.defect = max(counts.defect, profile.defects)
              counts.rally = max(counts.rally, profile.rallies)
              counts.launch = max(counts.launch, profile.launches)
              counts.message = max(counts.message, profile.messages)
              counts.fud = max(counts.fud, profile.fuds)
              counts.infiltrate = max(counts.infiltrate, profile.infiltrates)
              counts.reinforce = max(counts.reinforce, profile.reinforces)
              counts.war_loan = max(counts.war_loan, profile.war_loans)
              counts.repay_loan = max(counts.repay_loan, profile.repay_loans)
              counts.siege = max(counts.siege, profile.sieges)
              counts.ascend = max(counts.ascend, profile.ascends)
              counts.raze = max(counts.raze, profile.razes)
              counts.tithe = max(counts.tithe, profile.tithes)
              gameState.totalSolSpent = max(gameState.totalSolSpent, profile.total_sol_spent)
              gameState.totalSolReceived = max(gameState.totalSolReceived, profile.total_sol_received)
            }

            const cpResult = await kit.registry.checkpoint({
              signer: signer.publicKey,
              creator: authorityPubkey,
              joins: max(counts.join, profile?.joins ?? 0),
              defects: max(counts.defect, profile?.defects ?? 0),
              rallies: max(counts.rally, profile?.rallies ?? 0),
              launches: max(counts.launch, profile?.launches ?? 0),
              messages: max(counts.message, profile?.messages ?? 0),
              fuds: max(counts.fud, profile?.fuds ?? 0),
              infiltrates: max(counts.infiltrate, profile?.infiltrates ?? 0),
              reinforces: max(counts.reinforce, profile?.reinforces ?? 0),
              war_loans: max(counts.war_loan, profile?.war_loans ?? 0),
              repay_loans: max(counts.repay_loan, profile?.repay_loans ?? 0),
              sieges: max(counts.siege, profile?.sieges ?? 0),
              ascends: max(counts.ascend, profile?.ascends ?? 0),
              razes: max(counts.raze, profile?.razes ?? 0),
              tithes: max(counts.tithe, profile?.tithes ?? 0),
              personality_summary: await (async () => {
                try {
                  const topActions = Object.entries(counts)
                    .filter(([, v]) => v > 0)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([n, v]) => `${n}:${v}`)
                    .join(', ')
                  const bio = llm
                    ? await llm.generate(
                        `You are a ${browserAgent.personality}. Actions: ${topActions}. Write a 1 sentence bio under 80 chars. First person. No quotes.`,
                      )
                    : null
                  return bio?.slice(0, 100).replace(/^["']+|["']+$/g, '') ?? browserAgent.personality
                } catch {
                  return browserAgent.personality
                }
              })(),
              total_sol_spent: max(gameState.totalSolSpent, profile?.total_sol_spent ?? 0),
              total_sol_received: max(gameState.totalSolReceived, profile?.total_sol_received ?? 0),
            })

            // Sign with controller keypair (local, no popup)
            const { walletSignAndSend } = await import('./wallet-signer')
            await walletSignAndSend(connection, signer, cpResult)
            log(`Checkpointed (tick ${kit.state.tick})`)
          } catch (e: any) {
            log(`Checkpoint failed: ${e.message?.slice(0, 120)}`)
          }
        }

        agentRef.current = browserAgent
        setAgent(browserAgent)
        setPersonality(browserAgent.personality)
        log(`Agent online: ${signer.publicKey.slice(0, 8)}... (${browserAgent.personality})`)
      } catch (err: any) {
        log(`Failed to create agent: ${err.message}`)
      }
    },
    [wallet, connection, modelTier, deviceCaps, log],
  )

  const tickOnce = useCallback(async (): Promise<AgentTickResult | null> => {
    const a = agentRef.current
    if (!a || ticking) return null

    setTicking(true)
    try {
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
    } finally {
      setTicking(false)
    }
  }, [ticking])

  const start = useCallback(
    (intervalMs = 15000) => {
      if (running || !agentRef.current) return
      setRunning(true)
      log(`Agent running (tick every ${intervalMs / 1000}s)`)

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
    ticking,
    personality,
    logs,
    lastResult,
    controllerStatus,
    controllerPublicKey,
    controllerBalance,
    modelStatus,
    modelTier,
    deviceCapabilities: deviceCaps,
    setupController,
    linkController,
    init,
    start,
    stop,
    tickOnce,
    setModelTier,
  }
}
