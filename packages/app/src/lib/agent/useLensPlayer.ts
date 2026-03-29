'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { PyreKit } from 'pyre-world-kit'
import type { Action, FactionInfo, LLMAdapter, AgentState, Personality } from 'pyre-agent-kit'
import { getAvailableActions, getValidTargets, MESSAGE_ACTIONS, SOL_ACTIONS, buildAgentPrompt, assignPersonality, PERSONALITY_SOL } from 'pyre-agent-kit'
import type { ActionAvailability, FactionContext } from 'pyre-agent-kit'
import { createWebLLMAdapter, rngAdapter, WebLLMState } from './webllm-adapter'
import { detectDevice, DeviceCapabilities } from './device-detect'
import { getOrCreateController, loadController } from './keypair-store'
import { createKeypairSigner, walletSignAndSend, type WalletSigner } from './wallet-signer'

export type ControllerStatus = 'none' | 'created' | 'unfunded' | 'ready'

export interface LensPlayerHook {
  // Game state
  factions: FactionInfo[]
  holdings: Map<string, number>
  availableActions: Map<Action, ActionAvailability>
  loading: boolean
  prompt: string | null

  // Controller
  controllerStatus: ControllerStatus
  controllerPublicKey: string | null
  controllerBalance: number

  // Model
  modelStatus: WebLLMState

  // P&L
  pnl: { spent: number; received: number; net: number }

  // Logs
  logs: string[]

  // Controls
  setupController: () => Promise<void>
  linkController: () => Promise<void>
  init: () => Promise<void>
  generateMessage: (action: Action, faction: FactionInfo) => Promise<string | null>
  execute: (action: Action, faction: FactionInfo | null, message?: string, solAmount?: number) => Promise<{ success: boolean; error?: string }>
  refresh: () => Promise<void>
}

export function useLensPlayer(): LensPlayerHook {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [factions, setFactions] = useState<FactionInfo[]>([])
  const [holdings, setHoldings] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [pnl, setPnl] = useState({ spent: 0, received: 0, net: 0 })
  const [prompt, setPrompt] = useState<string | null>(null)

  // Controller state
  const [controllerStatus, setControllerStatus] = useState<ControllerStatus>('none')
  const [controllerPublicKey, setControllerPublicKey] = useState<string | null>(null)
  const [controllerBalance, setControllerBalance] = useState(0)

  // Model state
  const [modelStatus, setModelStatus] = useState<WebLLMState>({ status: 'idle', progress: 0 })
  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null)

  // Refs
  const kitRef = useRef<PyreKit | null>(null)
  const signerRef = useRef<WalletSigner | null>(null)
  const llmRef = useRef<(LLMAdapter & { init: () => Promise<void>; destroy: () => void }) | null>(null)
  const llmReadyRef = useRef(false)
  const initializingLLM = useRef(false)

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-99), msg])
  }, [])

  // Compute available actions from current state
  const availableActions = useMemo(() => {
    const activeLoans = kitRef.current?.state?.state?.activeLoans?.size ?? 0
    return getAvailableActions(holdings, factions, activeLoans)
  }, [holdings, factions])

  // Detect device on mount
  useEffect(() => {
    detectDevice()
      .then((caps) => setDeviceCaps(caps))
      .catch(() => {})
  }, [])

  // Check for existing controller on mount
  useEffect(() => {
    loadController().then((kp) => {
      if (kp) {
        setControllerPublicKey(kp.publicKey.toBase58())
        setControllerStatus('created')
        connection.getBalance(kp.publicKey).then((bal) => {
          setControllerBalance(bal / LAMPORTS_PER_SOL)
          if (bal > 0) setControllerStatus('ready')
        }).catch(() => {})
      }
    })
  }, [connection])

  const setupController = useCallback(async () => {
    const kp = await getOrCreateController()
    const pubkey = kp.publicKey.toBase58()
    setControllerPublicKey(pubkey)
    setControllerStatus('created')
    log(`Controller created: ${pubkey}`)
    log(`Fund with ~0.01 SOL for gas`)
    try {
      const bal = await connection.getBalance(kp.publicKey)
      setControllerBalance(bal / LAMPORTS_PER_SOL)
      if (bal > 0) setControllerStatus('ready')
    } catch {}
  }, [connection, log])

  const linkController = useCallback(async () => {
    if (!wallet.publicKey || !wallet.sendTransaction || !controllerPublicKey) {
      log('Connect your wallet first')
      return
    }
    try {
      const kit = new PyreKit(connection, wallet.publicKey.toBase58())
      const stronghold = await kit.actions.getStrongholdForAgent(wallet.publicKey.toBase58())
      if (!stronghold) {
        log('No stronghold found — create one at /stronghold')
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
      log('Controller linked to stronghold')

      // Link to pyre identity
      try {
        const profile = await kit.registry.getProfile(authority)
        if (!profile) {
          const regResult = await kit.registry.register({ creator: authority })
          const regSig = await wallet.sendTransaction(regResult.transaction, connection)
          await connection.confirmTransaction(regSig, 'confirmed')
          log('Pyre identity created')
        }
        const linkResult = await kit.registry.linkWallet({
          authority,
          creator: authority,
          wallet_to_link: controllerPublicKey,
        })
        const linkSig = await wallet.sendTransaction(linkResult.transaction, connection)
        await connection.confirmTransaction(linkSig, 'confirmed')
        log('Controller linked to pyre identity')
      } catch (e: any) {
        log(`Identity link: ${e.message?.slice(0, 60) || 'skipped'}`)
      }
      setControllerStatus('ready')
    } catch (err: any) {
      if (err.message?.includes('already')) {
        log('Controller already linked')
        setControllerStatus('ready')
      } else {
        log(`Link failed: ${err.message?.slice(0, 80)}`)
      }
    }
  }, [wallet, connection, controllerPublicKey, log])

  /** Initialize PyreKit + signer. Call after controller is ready. */
  const init = useCallback(async () => {
    // Get signer
    const controller = await loadController()
    let signer: WalletSigner
    if (controller) {
      signer = createKeypairSigner(controller)
      log(`Using controller: ${signer.publicKey.slice(0, 8)}...`)
    } else if (wallet.publicKey && wallet.signTransaction) {
      signer = {
        publicKey: wallet.publicKey.toBase58(),
        signTransaction: wallet.signTransaction.bind(wallet),
      }
      log('Using wallet adapter (no controller — setup recommended)')
    } else {
      log('Connect your wallet or set up a controller first')
      return
    }

    signerRef.current = signer

    // Initialize PyreKit
    const kit = new PyreKit(connection, signer.publicKey)
    await kit.state.init()
    kitRef.current = kit

    const vc = await kit.state.getVaultCreator()
    if (vc) {
      log(`Vault linked: ${vc.slice(0, 8)}...`)
    } else {
      log('No vault found — some actions need a stronghold')
    }

    // Load initial data
    await refreshData(kit)
    log('Lens ready — pick your move')
  }, [wallet, connection, log])

  /** Refresh factions, holdings, P&L, and build the full agent prompt */
  const refreshData = useCallback(async (kit?: PyreKit) => {
    const k = kit ?? kitRef.current
    if (!k) return

    setLoading(true)
    try {
      // Fetch holdings
      const h = await k.state.getHoldings()
      setHoldings(new Map(h))

      // Fetch faction context in parallel (same as llmDecide does)
      const pubkey = signerRef.current?.publicKey ?? ''
      const [risingAll, ascendedAll, nearbyResult] = await Promise.all([
        k.intel.getRisingFactions().catch(() => ({ factions: [] })),
        k.intel.getAscendedFactions().catch(() => ({ factions: [] })),
        k.intel.getNearbyFactions(pubkey, { depth: 2, limit: 15 }).catch(() => ({
          factions: [],
          allies: [] as string[],
        })),
      ])

      // Deduplicate into full faction list
      const seenMints = new Set<string>()
      const allFactions: FactionInfo[] = []
      for (const f of [...risingAll.factions, ...ascendedAll.factions, ...nearbyResult.factions]) {
        if (!seenMints.has(f.mint)) {
          seenMints.add(f.mint)
          allFactions.push(f as FactionInfo)
        }
      }
      setFactions(allFactions)

      const factionCtx: FactionContext = {
        rising: risingAll.factions.slice(0, 5) as FactionInfo[],
        ascended: ascendedAll.factions.slice(0, 5) as FactionInfo[],
        nearby: nearbyResult.factions as FactionInfo[],
        all: allFactions,
      }

      // Build a minimal AgentState for the prompt builder
      const agentState: AgentState = {
        keypair: null as any,
        publicKey: pubkey,
        personality: 'loyalist' as Personality,
        infiltrated: new Set(),
        allies: new Set('allies' in nearbyResult ? (nearbyResult.allies as string[]).filter(a => a !== pubkey) : []),
        rivals: new Set(),
        lastAction: 'none',
      }

      // Build the full agent prompt — the human sees exactly what the agent sees
      try {
        const promptText = await buildAgentPrompt(k, agentState, factionCtx, [0.01, 0.1], h)
        setPrompt(promptText)
      } catch (e: any) {
        log(`Prompt build failed: ${e.message?.slice(0, 60)}`)
      }

      // P&L
      const gs = k.state.state
      if (gs) {
        const spent = gs.totalSolSpent / 1e9
        const received = gs.totalSolReceived / 1e9
        setPnl({ spent, received, net: received - spent })
      }

      // Update controller balance
      if (signerRef.current) {
        try {
          const { PublicKey } = await import('@solana/web3.js')
          const bal = await connection.getBalance(new PublicKey(signerRef.current.publicKey))
          setControllerBalance(bal / LAMPORTS_PER_SOL)
        } catch {}
      }
    } finally {
      setLoading(false)
    }
  }, [connection, log])

  const refresh = useCallback(async () => {
    await refreshData()
  }, [refreshData])

  /** Lazy-load the 0.5b model and generate a message for the given action+faction */
  const ensureLLM = useCallback(async (): Promise<LLMAdapter> => {
    // Already ready
    if (llmRef.current && llmReadyRef.current) return llmRef.current

    // Already initializing — wait for it
    if (initializingLLM.current && llmRef.current) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (llmReadyRef.current && llmRef.current) {
            clearInterval(check)
            resolve(llmRef.current)
          }
        }, 500)
      })
    }

    initializingLLM.current = true
    const adapter = createWebLLMAdapter(
      'smol',
      deviceCaps?.hasShaderF16 ?? false,
      (state) => {
        setModelStatus(state)
        if (state.status === 'ready') {
          llmReadyRef.current = true
          log('Model ready (0.5B)')
        }
        if (state.status === 'error') {
          log(`Model error: ${state.error}`)
          initializingLLM.current = false
        }
      },
      undefined,
      deviceCaps?.isMobile ?? false,
    )
    llmRef.current = adapter
    await adapter.init()
    initializingLLM.current = false
    return adapter
  }, [deviceCaps, log])

  const generateMessage = useCallback(async (action: Action, faction: FactionInfo): Promise<string | null> => {
    log('Generating message...')
    try {
      const llm = await ensureLLM()

      const actionVerbs: Record<string, string> = {
        join: 'joining',
        reinforce: 'reinforcing',
        defect: 'leaving',
        message: 'messaging',
        fud: 'trash-talking',
        infiltrate: 'infiltrating',
      }
      const verb = actionVerbs[action] ?? action

      const prompt = `You are a player in a faction war game. You are ${verb} faction ${faction.name} (${faction.symbol}, ${(faction.market_cap_sol ?? 0).toFixed(1)} SOL mcap). Write a short punchy one-liner (under 60 chars) for faction comms. Be creative, no generic crypto talk. Just the message, no quotes.`

      const result = await llm.generate(prompt)
      if (result) {
        const cleaned = result.replace(/^["']+|["']+$/g, '').split('\n')[0].trim().slice(0, 80)
        log(`Generated: "${cleaned}"`)
        return cleaned
      }
      log('Generation failed — type your own message')
      return null
    } catch (e: any) {
      log(`Generation error: ${e.message?.slice(0, 60)}`)
      return null
    }
  }, [ensureLLM, log])

  /** Execute an action on-chain */
  const execute = useCallback(async (
    action: Action,
    faction: FactionInfo | null,
    message?: string,
    solAmount?: number,
  ): Promise<{ success: boolean; error?: string }> => {
    const kit = kitRef.current
    const signer = signerRef.current
    if (!kit || !signer) {
      return { success: false, error: 'Not initialized' }
    }

    const publicKey = signer.publicKey
    const stronghold = (await kit.state.getVaultCreator()) ?? publicKey

    try {
      let execResult: any
      let execConfirm: (() => Promise<void>) | undefined

      switch (action) {
        case 'hold': {
          log('Skipping turn')
          return { success: true }
        }

        case 'join':
        case 'reinforce': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const lamports = Math.floor((solAmount ?? 0.01) * LAMPORTS_PER_SOL)
          const params: any = {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: lamports,
            message: message?.slice(0, 80),
            stronghold,
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          try {
            const { result, confirm } = await kit.exec('actions', 'join', params)
            execResult = result
            execConfirm = confirm
          } catch (e: any) {
            if (e.message?.includes('6022') || e.message?.includes('VoteRequired')) {
              params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
              const retry = await kit.exec('actions', 'join', params)
              execResult = retry.result
              execConfirm = retry.confirm
            } else {
              throw e
            }
          }
          kit.state.markVoted(faction.mint)
          break
        }

        case 'defect': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const balance = holdings.get(faction.mint) ?? 0
          if (balance <= 0) return { success: false, error: 'No balance in this faction' }
          const sellAmount = solAmount
            ? Math.floor(balance * Math.min(1, solAmount))
            : balance  // default: sell all
          const { result, confirm } = await kit.exec('actions', 'defect', {
            mint: faction.mint,
            agent: publicKey,
            amount_tokens: sellAmount,
            message: message?.slice(0, 80),
            stronghold,
            ascended: faction.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          break
        }

        case 'message': {
          if (!faction) return { success: false, error: 'No faction selected' }
          if (!message) return { success: false, error: 'No message' }
          const params: any = {
            mint: faction.mint,
            agent: publicKey,
            message: message.slice(0, 80),
            stronghold,
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
          }
          try {
            const { result, confirm } = await kit.exec('actions', 'message', params)
            execResult = result
            execConfirm = confirm
          } catch (e: any) {
            if (e.message?.includes('6022') || e.message?.includes('VoteRequired')) {
              params.strategy = Math.random() > 0.5 ? 'fortify' : 'smelt'
              const retry = await kit.exec('actions', 'message', params)
              execResult = retry.result
              execConfirm = retry.confirm
            } else {
              throw e
            }
          }
          kit.state.markVoted(faction.mint)
          break
        }

        case 'fud': {
          if (!faction) return { success: false, error: 'No faction selected' }
          if (!message) return { success: false, error: 'No message' }
          const { result, confirm } = await kit.exec('actions', 'fud', {
            mint: faction.mint,
            agent: publicKey,
            message: message.slice(0, 80),
            stronghold,
            ascended: faction.status === 'ascended',
          })
          execResult = result
          execConfirm = confirm
          break
        }

        case 'rally': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const { result, confirm } = await kit.exec('actions', 'rally', {
            mint: faction.mint,
            agent: publicKey,
            stronghold,
          })
          execResult = result
          execConfirm = confirm
          break
        }

        case 'launch': {
          const llm = llmReadyRef.current && llmRef.current ? llmRef.current : null
          let name = 'Pyre Faction'
          let symbol = 'PYRE'
          if (message && message.length >= 3 && message.length <= 32) {
            name = message
            const words = message.split(/\s+/)
            symbol = words.length >= 2
              ? words.slice(0, 2).map((w) => w.slice(0, 2).toUpperCase()).join('')
              : message.slice(0, 4).toUpperCase()
          } else if (llm) {
            try {
              const raw = await llm.generate(
                'Invent a creative faction name (2-3 words). It can be a cult, cartel, syndicate, order, lab, movement, guild — anything memorable. One line only, just the name.',
              )
              if (raw) {
                const cleaned = raw.trim().replace(/^["']+|["']+$/g, '').split('\n')[0].trim()
                if (cleaned.length >= 3 && cleaned.length <= 32) {
                  name = cleaned
                  const words = cleaned.split(/\s+/)
                  symbol = words.length >= 2
                    ? words.slice(0, 2).map((w) => w.slice(0, 2).toUpperCase()).join('')
                    : cleaned.slice(0, 4).toUpperCase()
                }
              }
            } catch {}
          }
          const { result, confirm } = await kit.exec('actions', 'launch', {
            founder: publicKey,
            name,
            symbol,
            metadata_uri: `https://pyre.gg/factions/${symbol.toLowerCase()}.json`,
            community_faction: true,
          })
          execResult = result
          execConfirm = confirm
          log(`Launching faction: ${name} [${symbol}]`)
          break
        }

        case 'infiltrate': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const lamports = Math.floor((solAmount ?? 0.01) * 1.5 * LAMPORTS_PER_SOL)
          const params: any = {
            mint: faction.mint,
            agent: publicKey,
            amount_sol: lamports,
            stronghold,
            ascended: faction.status === 'ascended',
          }
          if (!kit.state.hasVoted(faction.mint)) {
            params.strategy = 'smelt'
          }
          const { result, confirm } = await kit.exec('actions', 'join', params)
          execResult = result
          execConfirm = confirm
          break
        }

        case 'siege': {
          if (!faction) return { success: false, error: 'No faction selected' }
          // Find a liquidatable borrower
          let targetBorrower: string | null = null
          try {
            const allLoans = await kit.actions.getWarLoansForFaction(faction.mint)
            for (const pos of allLoans.positions) {
              if (pos.health === 'liquidatable') {
                targetBorrower = pos.borrower
                break
              }
            }
          } catch {
            return { success: false, error: 'No loans to siege' }
          }
          if (!targetBorrower) return { success: false, error: 'No liquidatable positions' }
          const { result: siegeResult, confirm: siegeConfirm } = await kit.exec('actions', 'siege', {
            mint: faction.mint,
            liquidator: publicKey,
            borrower: targetBorrower,
            stronghold,
          })
          execResult = siegeResult
          execConfirm = siegeConfirm
          break
        }

        case 'ascend': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const { result: ascendResult, confirm: ascendConfirm } = await kit.exec('actions', 'ascend', {
            mint: faction.mint,
            payer: publicKey,
          })
          execResult = ascendResult
          execConfirm = ascendConfirm
          break
        }

        case 'raze': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const { result: razeResult, confirm: razeConfirm } = await kit.exec('actions', 'raze', {
            payer: publicKey,
            mint: faction.mint,
          })
          execResult = razeResult
          execConfirm = razeConfirm
          break
        }

        case 'tithe': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const { result: titheResult, confirm: titheConfirm } = await kit.exec('actions', 'tithe', {
            mint: faction.mint,
            payer: publicKey,
            harvest: true,
          })
          execResult = titheResult
          execConfirm = titheConfirm
          break
        }

        case 'war_loan': {
          if (!faction) return { success: false, error: 'No faction selected' }
          const balance = await kit.state.getBalance(faction.mint)
          if (balance <= 0) return { success: false, error: 'No balance to collateralize' }
          const collateral = Math.max(1, Math.floor(balance * 0.9))
          let borrowLamports: number
          try {
            const quote = await kit.actions.getWarLoanQuote(faction.mint, collateral)
            if (quote.max_borrow_sol < 0.1 * LAMPORTS_PER_SOL)
              return { success: false, error: 'Loan too small' }
            borrowLamports = Math.floor(quote.max_borrow_sol * 0.8)
          } catch {
            borrowLamports = Math.floor(0.1 * LAMPORTS_PER_SOL)
          }
          const { result: loanResult, confirm: loanConfirm } = await kit.exec('actions', 'requestWarLoan', {
            mint: faction.mint,
            borrower: publicKey,
            collateral_amount: collateral,
            sol_to_borrow: borrowLamports,
            stronghold,
          })
          execResult = loanResult
          execConfirm = loanConfirm
          break
        }

        case 'repay_loan': {
          if (!faction) return { success: false, error: 'No faction selected' }
          let loan
          try {
            loan = await kit.actions.getWarLoan(faction.mint, publicKey)
          } catch {
            return { success: false, error: 'No active loan found' }
          }
          if (loan.total_owed <= 0) return { success: false, error: 'Nothing owed' }
          const { result: repayResult, confirm: repayConfirm } = await kit.exec('actions', 'repayWarLoan', {
            mint: faction.mint,
            borrower: publicKey,
            sol_amount: Math.ceil(loan.total_owed),
            stronghold,
          })
          execResult = repayResult
          execConfirm = repayConfirm
          break
        }

        case 'scout': {
          if (!faction) return { success: false, error: 'No faction selected' }
          log(`Scouting ${faction.symbol}...`)
          // Scout is read-only — just fetch intel
          return { success: true }
        }

        default:
          return { success: false, error: `Unknown action: ${action}` }
      }

      if (!execResult) return { success: false, error: 'No transaction result' }

      // Sign and send
      await walletSignAndSend(connection, signer, execResult)
      if (execConfirm) await execConfirm()

      log(`${action} ${faction?.symbol ?? ''} — OK`)

      // Refresh state after execution
      await refreshData()

      return { success: true }
    } catch (err: any) {
      const msg = err.message?.slice(0, 100) ?? 'Unknown error'
      log(`${action} failed: ${msg}`)
      return { success: false, error: msg }
    }
  }, [holdings, connection, log, refreshData])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      llmRef.current?.destroy()
    }
  }, [])

  return {
    factions,
    holdings,
    availableActions,
    loading,
    prompt,
    controllerStatus,
    controllerPublicKey,
    controllerBalance,
    modelStatus,
    pnl,
    logs,
    setupController,
    linkController,
    init,
    generateMessage,
    execute,
    refresh,
  }
}
