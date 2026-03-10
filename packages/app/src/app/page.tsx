'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useConnection } from '@solana/wallet-adapter-react'
import { getFactions, getComms, getDexPool, getDexVaults, isPyreMint, isBlacklistedMint, PROGRAM_ID } from 'pyre-world-kit'
import { useNetwork } from '@/lib/NetworkContext'
import { Header } from '@/components/Header'
import { StageEntry } from '@/components/StageEntry'
import { HowToPlayModal } from '@/components/HowToPlayModal'

const BONDING_CURVE_SEED = 'bonding_curve'

function getBondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    PROGRAM_ID,
  )
  return pda
}

export interface ActionEntry {
  agent: string
  faction_mint: string
  faction_name: string
  action: 'joined' | 'reinforced' | 'defected' | 'launched' | 'rallied' | 'messaged' | 'argued' | 'ascended' | 'tithed'
  amount_sol: number | null
  memo: string | null
  timestamp: number
  signature: string
}

export default function StagePage() {
  const { connection } = useConnection()
  const { isSimnet } = useNetwork()
  const [actions, setActions] = useState<ActionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showHelp, setShowHelp] = useState(false)
  const fetchingRef = useRef(false)

  const fetchStage = useCallback(async (showLoading = false) => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    if (showLoading) setLoading(true)
    try {
      const result = await getFactions(connection, { limit: 50, sort: 'newest' })
      const pyreFactions = result.factions.filter(t => isPyreMint(t.mint) && !isBlacklistedMint(t.mint))

      const entries: ActionEntry[] = []

      await Promise.all(
        pyreFactions.slice(0, 20).map(async (faction) => {
          try {
            const mint = new PublicKey(faction.mint)
            const bondingCurve = getBondingCurvePda(mint)
            const bcAddress = bondingCurve.toString()

            const signatures = await connection.getSignaturesForAddress(
              bondingCurve,
              { limit: 30 },
              'confirmed',
            )

            if (signatures.length === 0) return

            const txs = await connection.getParsedTransactions(
              signatures.map(s => s.signature),
              { maxSupportedTransactionVersion: 0 },
            )

            for (let i = 0; i < txs.length; i++) {
              const tx = txs[i]
              const sig = signatures[i]
              if (!tx?.meta || tx.meta.err) continue

              const accountKeys = tx.transaction.message.accountKeys
              const bcIndex = accountKeys.findIndex(k => k.pubkey.toString() === bcAddress)
              if (bcIndex === -1) continue

              const trader = accountKeys[0]?.pubkey?.toString() || ''
              const solChange = tx.meta.postBalances[bcIndex] - tx.meta.preBalances[bcIndex]
              const absSol = Math.abs(solChange) / 1_000_000_000

              // Detect action from token balance changes
              const pre = tx.meta.preTokenBalances || []
              const post = tx.meta.postTokenBalances || []

              // 1. Check signer's token delta (direct trades)
              let traderTokenDelta = 0
              for (const postBal of post) {
                if (postBal.mint !== faction.mint) continue
                if (postBal.owner !== trader) continue
                const preBal = pre.find(p => p.accountIndex === postBal.accountIndex)
                const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                traderTokenDelta = postAmt - preAmt
                break
              }

              // 2. Vault-routed: signer delta is 0, check the vault's token account
              // Find any non-signer, non-BC account with a token delta for this mint
              let vaultTokenDelta = 0
              if (traderTokenDelta === 0) {
                for (const postBal of post) {
                  if (postBal.mint !== faction.mint) continue
                  if (postBal.owner === trader || postBal.owner === bcAddress) continue
                  const preBal = pre.find(p => p.accountIndex === postBal.accountIndex)
                  const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                  const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                  const delta = postAmt - preAmt
                  if (delta !== 0) {
                    vaultTokenDelta = delta
                    break
                  }
                }
              }

              let action: ActionEntry['action']
              const isCreateTx = i === txs.length - 1
              const postBalance = tx.meta.postBalances[bcIndex]
              const isMigrationTx = solChange < 0 && postBalance < 1_000_000_000 && faction.status === 'ascended'

              if (isCreateTx) {
                action = 'launched'
              } else if (isMigrationTx) {
                action = 'ascended'
              } else if (traderTokenDelta > 0 || vaultTokenDelta > 0) {
                action = 'joined'
              } else if (traderTokenDelta < 0 || vaultTokenDelta < 0) {
                action = 'defected'
              } else if (solChange !== 0) {
                action = solChange > 0 ? 'joined' : 'defected'
              } else {
                action = 'rallied'
              }

              entries.push({
                agent: trader,
                faction_mint: faction.mint,
                faction_name: faction.name,
                action,
                amount_sol: absSol > 0.001 ? absSol : null,
                memo: null,
                timestamp: sig.blockTime || 0,
                signature: sig.signature,
              })
            }
          } catch {
            // skip factions with errors
          }
        }),
      )

      // Fetch DEX activity for ascended factions (pool state transactions)
      const ascendedFactions = pyreFactions.filter(f => f.status === 'ascended')

      await Promise.all(
        ascendedFactions.slice(0, 10).map(async (faction) => {
          try {
            const poolState = getDexPool(faction.mint)

            const signatures = await connection.getSignaturesForAddress(
              poolState,
              { limit: 30 },
              'confirmed',
            )

            if (signatures.length === 0) return

            const txs = await connection.getParsedTransactions(
              signatures.map(s => s.signature),
              { maxSupportedTransactionVersion: 0 },
            )

            for (let i = 0; i < txs.length; i++) {
              const tx = txs[i]
              const sig = signatures[i]
              if (!tx?.meta || tx.meta.err) continue

              const trader = tx.transaction.message.accountKeys[0]?.pubkey?.toString() || ''

              // Detect buy vs sell from token balance changes
              const pre = tx.meta.preTokenBalances || []
              const post = tx.meta.postTokenBalances || []

              // Check signer's token delta (direct trades)
              let traderTokenDelta = 0
              for (const postBal of post) {
                if (postBal.mint !== faction.mint) continue
                if (postBal.owner !== trader) continue
                const preBal = pre.find(p => p.accountIndex === postBal.accountIndex)
                const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                traderTokenDelta = postAmt - preAmt
                break
              }

              // Vault-routed: check vault's token account (non-signer, non-pool)
              let vaultTokenDelta = 0
              if (traderTokenDelta === 0) {
                for (const postBal of post) {
                  if (postBal.mint !== faction.mint) continue
                  if (postBal.owner === trader) continue
                  const preBal = pre.find(p => p.accountIndex === postBal.accountIndex)
                  const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                  const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                  const delta = postAmt - preAmt
                  if (delta !== 0) {
                    vaultTokenDelta = delta
                    break
                  }
                }
              }

              // SOL amount from pool's SOL vault
              let absSol = 0
              const { solVault } = getDexVaults(faction.mint)
              const solVaultIndex = tx.transaction.message.accountKeys.findIndex(
                k => k.pubkey.toString() === solVault
              )
              if (solVaultIndex !== -1) {
                absSol = Math.abs(tx.meta.postBalances[solVaultIndex] - tx.meta.preBalances[solVaultIndex]) / 1_000_000_000
              }

              const action: ActionEntry['action'] = traderTokenDelta > 0 || vaultTokenDelta > 0 ? 'joined'
                : traderTokenDelta < 0 || vaultTokenDelta < 0 ? 'defected'
                : 'joined'

              entries.push({
                agent: trader,
                faction_mint: faction.mint,
                faction_name: faction.name,
                action,
                amount_sol: absSol > 0.001 ? absSol : null,
                memo: null,
                timestamp: sig.blockTime || 0,
                signature: sig.signature,
              })
            }
          } catch {
            // skip
          }
        }),
      )

      // Fetch messages (comms) from top factions
      await Promise.all(
        pyreFactions.slice(0, 20).map(async (faction) => {
          try {
            const msgs = await getComms(connection, faction.mint, 30)

            for (const msg of msgs.comms) {
              entries.push({
                agent: msg.sender,
                faction_mint: faction.mint,
                faction_name: faction.name,
                action: 'messaged',
                amount_sol: null,
                memo: msg.memo,
                timestamp: msg.timestamp,
                signature: msg.signature,
              })
            }
          } catch {
            // skip
          }
        }),
      )

      // Merge duplicates: same signature can appear from BC scan + pool scan + comms.
      // Prefer pool scan (more accurate for vault swaps) and preserve memos.
      const bySignature = new Map<string, ActionEntry>()
      for (const e of entries) {
        const existing = bySignature.get(e.signature)
        if (!existing) {
          bySignature.set(e.signature, e)
        } else if (e.action === 'messaged' && e.memo) {
          // Comms entry — just attach memo to the existing action
          existing.memo = e.memo
        } else if (existing.action === 'messaged') {
          // Existing was comms-only, replace with real action but keep memo
          e.memo = e.memo || existing.memo
          bySignature.set(e.signature, e)
        } else if (existing.action === 'rallied' && e.action !== 'rallied') {
          // BC scan classified vault swap as "rallied" (zero SOL change on BC),
          // pool scan has the correct action — prefer pool scan
          e.memo = e.memo || existing.memo
          bySignature.set(e.signature, e)
        }
      }
      const merged = Array.from(bySignature.values())

      // Reclassify micro-trades with memos:
      // - buys with memo + no meaningful SOL → "said in" (messaged)
      // - sells with memo + no meaningful SOL → "argued in" (argued)
      // - rallied with memo → vault-routed message/fud that couldn't be classified
      for (const e of merged) {
        if (e.memo && e.amount_sol === null) {
          if (e.action === 'defected') {
            e.action = 'argued'
          } else if (e.action === 'joined' || e.action === 'reinforced' || e.action === 'rallied') {
            e.action = 'messaged'
          }
        }
      }

      // Distinguish "joined" vs "reinforced": sort oldest-first,
      // track agent+faction pairs — first buy = joined, later buys = reinforced
      merged.sort((a, b) => a.timestamp - b.timestamp)
      const seen = new Set<string>()
      for (const e of merged) {
        if (e.action === 'joined') {
          const key = `${e.agent}:${e.faction_mint}`
          if (seen.has(key)) {
            e.action = 'reinforced'
          } else {
            seen.add(key)
          }
        }
      }

      merged.sort((a, b) => b.timestamp - a.timestamp)
      setActions(merged)
    } catch {
      // ignore
    } finally {
      fetchingRef.current = false
      setLoading(false)
    }
  }, [connection])

  // Initial fetch
  useEffect(() => {
    fetchStage(true)
  }, [fetchStage])

  // Live updates: WebSocket subscription to bonding curve account changes
  useEffect(() => {
    if (isSimnet) {
      // Simnet fallback: poll every 5 seconds
      const interval = setInterval(() => fetchStage(), 5000)
      return () => clearInterval(interval)
    }

    // Subscribe to all bonding curve account changes on the program
    const subId = connection.onProgramAccountChange(
      PROGRAM_ID,
      () => {
        fetchStage()
      },
      {
        commitment: 'confirmed',
        filters: [
          { memcmp: { offset: 0, bytes: '4y6pru6YvC7' } },
        ],
      },
    )

    return () => {
      connection.removeProgramAccountChangeListener(subId)
    }
  }, [connection, isSimnet, fetchStage])

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full" style={{ padding: '0.25rem' }}>
          <div className="flex items-center gap-2 mb-4">
            <h1 className="text-sm font-medium" style={{ color: 'var(--muted)' }}>
              stage
            </h1>
            <button
              onClick={() => setShowHelp(true)}
              className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] cursor-pointer"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
              title="How to play"
            >
              ?
            </button>
          </div>
          <HowToPlayModal open={showHelp} onClose={() => setShowHelp(false)} />

          {loading ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              Loading...
            </p>
          ) : actions.length === 0 ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              No activity yet
            </p>
          ) : (
            <div>
              {actions.map((entry) => (
                <StageEntry key={entry.signature} {...entry} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
