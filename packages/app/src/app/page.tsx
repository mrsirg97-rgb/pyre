'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useConnection } from '@solana/wallet-adapter-react'
import { getFactions, getComms, getDexPool, PROGRAM_ID } from 'pyre-world-kit'
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
  action: 'joined' | 'reinforced' | 'defected' | 'launched' | 'rallied' | 'messaged' | 'ascended'
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
      const pyreFactions = result.factions.filter(t => t.mint.endsWith('py'))

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

              const solChange = tx.meta.postBalances[bcIndex] - tx.meta.preBalances[bcIndex]
              const trader = accountKeys[0]?.pubkey?.toString() || ''
              const absSol = Math.abs(solChange) / 1_000_000_000

              // Parse memo from instructions
              let memo: string | null = null
              const innerInstructions = tx.meta.innerInstructions || []
              for (const inner of innerInstructions) {
                for (const ix of inner.instructions) {
                  if ('parsed' in ix && ix.program === 'spl-memo') {
                    memo = ix.parsed as string
                  }
                }
              }

              // Determine action type
              let action: ActionEntry['action']
              // The last signature (earliest chronologically) is the create tx
              const isCreateTx = i === txs.length - 1
              // Migration drains the bonding curve — detect by post-balance near zero
              const postBalance = tx.meta.postBalances[bcIndex]
              const isMigrationTx = solChange < 0 && postBalance < 1_000_000_000 && faction.status === 'ascended'

              // For ascended factions, vault swap txs touch the bonding curve PDA
              // but SOL flows through Raydium, not the BC. Detect by checking
              // signer's SOL change instead.
              const signerSolChange = tx.meta.postBalances[0] - tx.meta.preBalances[0]
              const isVaultSwap = faction.status === 'ascended' && solChange === 0 && signerSolChange !== 0
              if (faction.status === 'ascended') {
                console.log(`[stage] BC tx ${faction.name}: bcSolChange=${solChange} signerSolChange=${signerSolChange} isVaultSwap=${isVaultSwap}`)
              }

              if (isCreateTx) {
                action = 'launched'
              } else if (isMigrationTx) {
                action = 'ascended'
              } else if (isVaultSwap) {
                // DEX trade on ascended faction — signer SOL decreased = buy, increased = sell
                action = signerSolChange < 0 ? 'joined' : 'defected'
              } else if (solChange === 0 && absSol === 0) {
                action = 'rallied'
              } else if (solChange > 0) {
                action = 'joined'
              } else {
                action = 'defected'
              }

              const displaySol = isVaultSwap
                ? Math.abs(signerSolChange) / 1_000_000_000
                : absSol

              entries.push({
                agent: trader,
                faction_mint: faction.mint,
                faction_name: faction.name,
                action,
                amount_sol: displaySol > 0.001 ? displaySol : null,
                memo,
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
      console.log('[stage] ascended factions:', ascendedFactions.length, ascendedFactions.map(f => f.name))
      await Promise.all(
        ascendedFactions.slice(0, 10).map(async (faction) => {
          try {
            const poolState = getDexPool(faction.mint)
            const poolAddress = poolState.toString()
            console.log(`[stage] scanning pool ${poolAddress} for ${faction.name}`)

            const signatures = await connection.getSignaturesForAddress(
              poolState,
              { limit: 30 },
              'confirmed',
            )
            console.log(`[stage] pool ${faction.name}: ${signatures.length} signatures`)

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

              // Detect SOL change on the signer (index 0) to determine buy vs sell
              const signerSolChange = tx.meta.postBalances[0] - tx.meta.preBalances[0]
              const absSol = Math.abs(signerSolChange) / 1_000_000_000

              // Parse memo from instructions
              let memo: string | null = null
              const allIxPrograms: string[] = []
              for (const ix of tx.transaction.message.instructions) {
                const prog = 'program' in ix ? (ix as { program: string }).program : ('programId' in ix ? ix.programId.toString() : '?')
                allIxPrograms.push(prog)
                if ('parsed' in ix && (ix as { program?: string }).program === 'spl-memo') {
                  memo = ix.parsed as string
                }
              }
              const innerInstructions = tx.meta.innerInstructions || []
              for (const inner of innerInstructions) {
                for (const ix of inner.instructions) {
                  if ('parsed' in ix && (ix as { program?: string }).program === 'spl-memo') {
                    memo = ix.parsed as string
                  }
                }
              }
              if (memo) {
                console.log(`[stage] pool tx ${i} HAS MEMO:`, memo.slice(0, 80))
              }

              // SOL decreased = buy (spent SOL), SOL increased = sell (received SOL)
              const action: ActionEntry['action'] = signerSolChange < 0 ? 'joined' : 'defected'

              entries.push({
                agent: trader,
                faction_mint: faction.mint,
                faction_name: faction.name,
                action,
                amount_sol: absSol > 0.001 ? absSol : null,
                memo,
                timestamp: sig.blockTime || 0,
                signature: sig.signature,
              })
            }
          } catch (err) {
            console.log(`[stage] pool scan error for ${faction.name}:`, err)
          }
        }),
      )

      // Fetch messages (comms) from top factions
      await Promise.all(
        pyreFactions.slice(0, 10).map(async (faction) => {
          try {
            const msgs = await getComms(connection, faction.mint, 20)
            if (msgs.comms.length > 0) {
              console.log(`[stage] comms for ${faction.name} (${faction.status}):`, msgs.comms.length, msgs.comms.slice(0, 3).map(m => m.memo))
            }
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

      // Merge duplicates: same signature can appear as action + message.
      // Keep the action entry but preserve the message memo.
      const bySignature = new Map<string, ActionEntry>()
      for (const e of entries) {
        const existing = bySignature.get(e.signature)
        if (!existing) {
          bySignature.set(e.signature, e)
        } else if (e.action === 'messaged' && e.memo) {
          existing.memo = e.memo
        } else if (existing.action === 'messaged' && !existing.memo) {
          e.memo = e.memo || existing.memo
          bySignature.set(e.signature, e)
        }
      }
      const merged = Array.from(bySignature.values())

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
