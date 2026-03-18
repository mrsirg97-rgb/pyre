'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useConnection } from '@solana/wallet-adapter-react'
import {
  ActionProvider,
  RegistryProvider,
  getDexPool,
  getDexVaults,
  isPyreMint,
  isBlacklistedMint,
  PROGRAM_ID,
} from 'pyre-world-kit'
import { useNetwork } from '@/lib/NetworkContext'
import { Header } from '@/components/Header'
import { StageEntry } from '@/components/StageEntry'
import { HowToPlayModal } from '@/components/HowToPlayModal'

const BONDING_CURVE_SEED = 'bonding_curve'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

/** Extract memo from a parsed transaction (top-level + inner instructions) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMemo(tx: any): string | null {
  const allIxs = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions || []).flatMap((inner: any) => inner.instructions),
  ]
  for (const ix of allIxs) {
    const pid = 'programId' in ix ? (ix.programId as PublicKey).toString() : ''
    const pname = 'program' in ix ? (ix as { program: string }).program : ''
    if (pid === MEMO_PROGRAM || pname === 'spl-memo') {
      if ('parsed' in ix) {
        return typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
      } else if ('data' in ix && typeof (ix as { data?: string }).data === 'string') {
        const raw = (ix as { data: string }).data
        try {
          const bytes = Buffer.from(raw, 'base64')
          return new TextDecoder().decode(bytes)
        } catch {
          return raw
        }
      }
    }
  }
  return null
}

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
  action:
    | 'joined'
    | 'reinforced'
    | 'defected'
    | 'launched'
    | 'rallied'
    | 'messaged'
    | 'argued'
    | 'ascended'
    | 'tithed'
  amount_sol: number | null
  memo: string | null
  timestamp: number
  signature: string
  hadTokenDelta?: boolean
}

export default function StagePage() {
  const { connection } = useConnection()
  const { isSimnet } = useNetwork()
  const registry = useMemo(() => new RegistryProvider(connection), [connection])
  const kit = useMemo(() => new ActionProvider(connection, registry), [connection, registry])
  const [actions, setActions] = useState<ActionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showHelp, setShowHelp] = useState(false)
  const fetchingRef = useRef(false)

  const fetchStage = useCallback(
    async (showLoading = false) => {
      if (fetchingRef.current) return
      fetchingRef.current = true
      if (showLoading) setLoading(true)
      try {
        const result = await kit.getFactions({ sort: 'newest' })
        const pyreFactions = result.factions.filter(
          (t) => isPyreMint(t.mint) && !isBlacklistedMint(t.mint),
        )

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
                signatures.map((s) => s.signature),
                { maxSupportedTransactionVersion: 0 },
              )

              for (let i = 0; i < txs.length; i++) {
                const tx = txs[i]
                const sig = signatures[i]
                if (!tx?.meta || tx.meta.err) continue

                const accountKeys = tx.transaction.message.accountKeys
                const bcIndex = accountKeys.findIndex((k) => k.pubkey.toString() === bcAddress)
                if (bcIndex === -1) continue

                const trader = accountKeys[0]?.pubkey?.toString() || ''
                const solChange = tx.meta.postBalances[bcIndex] - tx.meta.preBalances[bcIndex]
                let absSol = Math.abs(solChange) / 1_000_000_000

                const memo = extractMemo(tx)

                // Detect action from token balance changes
                const pre = tx.meta.preTokenBalances || []
                const post = tx.meta.postTokenBalances || []

                // 1. Check signer's token delta (direct trades)
                let traderTokenDelta = 0
                for (const postBal of post) {
                  if (postBal.mint !== faction.mint) continue
                  if (postBal.owner !== trader) continue
                  const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex)
                  const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                  const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                  traderTokenDelta = postAmt - preAmt
                  break
                }

                // 2. Vault-routed: check any non-signer, non-BC account with a token delta
                let vaultTokenDelta = 0
                let vaultOwner: string | null = null
                for (const postBal of post) {
                  if (postBal.mint !== faction.mint) continue
                  if (postBal.owner === trader || postBal.owner === bcAddress) continue
                  const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex)
                  const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                  const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                  const delta = postAmt - preAmt
                  if (delta !== 0) {
                    vaultTokenDelta = delta
                    vaultOwner = postBal.owner ?? null
                    break
                  }
                }

                // 3. Vault-routed SOL: check vault account's SOL change
                //    For buys, vault SOL decreases. For sells, vault SOL increases.
                if (vaultOwner) {
                  const vaultIndex = accountKeys.findIndex(
                    (k) => k.pubkey.toString() === vaultOwner,
                  )
                  if (vaultIndex !== -1) {
                    const vaultSolDelta =
                      Math.abs(tx.meta.postBalances[vaultIndex] - tx.meta.preBalances[vaultIndex]) /
                      1_000_000_000
                    if (vaultSolDelta > absSol) absSol = vaultSolDelta
                  }
                }

                let action: ActionEntry['action']
                const isCreateTx = i === txs.length - 1
                const postBalance = tx.meta.postBalances[bcIndex]
                const isMigrationTx =
                  solChange < 0 && postBalance < 1_000_000_000 && faction.status === 'ascended'

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
                  memo,
                  timestamp: sig.blockTime || 0,
                  signature: sig.signature,
                  hadTokenDelta: traderTokenDelta !== 0 || vaultTokenDelta !== 0,
                })
              }
            } catch {
              // skip factions with errors
            }
          }),
        )

        // Fetch DEX activity for ascended factions (pool state transactions)
        const ascendedFactions = pyreFactions.filter((f) => f.status === 'ascended')

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
                signatures.map((s) => s.signature),
                { maxSupportedTransactionVersion: 0 },
              )

              for (let i = 0; i < txs.length; i++) {
                const tx = txs[i]
                const sig = signatures[i]
                if (!tx?.meta || tx.meta.err) continue

                const trader = tx.transaction.message.accountKeys[0]?.pubkey?.toString() || ''
                const memo = extractMemo(tx)

                // Detect buy vs sell from token balance changes
                const pre = tx.meta.preTokenBalances || []
                const post = tx.meta.postTokenBalances || []

                // Check signer's token delta (direct trades)
                let traderTokenDelta = 0
                for (const postBal of post) {
                  if (postBal.mint !== faction.mint) continue
                  if (postBal.owner !== trader) continue
                  const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex)
                  const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                  const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                  traderTokenDelta = postAmt - preAmt
                  break
                }

                // Vault-routed: check vault's token account (non-signer, non-pool)
                let vaultTokenDelta = 0
                let vaultOwner: string | null = null
                if (traderTokenDelta === 0) {
                  for (const postBal of post) {
                    if (postBal.mint !== faction.mint) continue
                    if (postBal.owner === trader) continue
                    const preBal = pre.find((p) => p.accountIndex === postBal.accountIndex)
                    const preAmt = Number(preBal?.uiTokenAmount?.amount || '0')
                    const postAmt = Number(postBal.uiTokenAmount?.amount || '0')
                    const delta = postAmt - preAmt
                    if (delta !== 0) {
                      vaultTokenDelta = delta
                      vaultOwner = postBal.owner ?? null
                      break
                    }
                  }
                }

                // SOL amount from pool's SOL vault
                let absSol = 0
                const { solVault } = getDexVaults(faction.mint)
                const accountKeys = tx.transaction.message.accountKeys
                const solVaultIndex = accountKeys.findIndex((k) => k.pubkey.toString() === solVault)
                if (solVaultIndex !== -1) {
                  absSol =
                    Math.abs(
                      tx.meta.postBalances[solVaultIndex] - tx.meta.preBalances[solVaultIndex],
                    ) / 1_000_000_000
                }

                // Vault-routed SOL: check vault account's SOL change
                if (vaultOwner) {
                  const vaultIndex = accountKeys.findIndex(
                    (k) => k.pubkey.toString() === vaultOwner,
                  )
                  if (vaultIndex !== -1) {
                    const vaultSolDelta =
                      Math.abs(tx.meta.postBalances[vaultIndex] - tx.meta.preBalances[vaultIndex]) /
                      1_000_000_000
                    if (vaultSolDelta > absSol) absSol = vaultSolDelta
                  }
                }

                const action: ActionEntry['action'] =
                  traderTokenDelta > 0 || vaultTokenDelta > 0
                    ? 'joined'
                    : traderTokenDelta < 0 || vaultTokenDelta < 0
                      ? 'defected'
                      : 'joined'

                entries.push({
                  agent: trader,
                  faction_mint: faction.mint,
                  faction_name: faction.name,
                  action,
                  amount_sol: absSol > 0.001 ? absSol : null,
                  memo,
                  timestamp: sig.blockTime || 0,
                  signature: sig.signature,
                  hadTokenDelta: traderTokenDelta !== 0 || vaultTokenDelta !== 0,
                })
              }
            } catch {
              // skip
            }
          }),
        )

        // Merge duplicates: same signature can appear from BC scan + pool scan.
        // Prefer pool scan (more accurate for vault swaps) and preserve memos.
        const bySignature = new Map<string, ActionEntry>()
        for (const e of entries) {
          const existing = bySignature.get(e.signature)
          if (!existing) {
            bySignature.set(e.signature, e)
          } else if (existing.action === 'rallied' && e.action !== 'rallied') {
            // BC scan classified vault swap as "rallied" (zero SOL change on BC),
            // pool scan has the correct action — prefer pool scan
            e.memo = e.memo || existing.memo
            bySignature.set(e.signature, e)
          }
        }
        const merged = Array.from(bySignature.values())

        // Reclassify micro-trades:
        // - micro buys with memo → "said in" (messaged)
        // - micro sells → "argued in" (argued) — FUD is always a micro sell
        // - micro trades with no memo and no SOL → filter out (dust/noise)
        const filtered: ActionEntry[] = []
        for (const e of merged) {
          const isMicroTrade = e.amount_sol === null || e.amount_sol <= 0.002
          if (isMicroTrade) {
            if (e.action === 'defected') {
              if (e.memo) {
                e.action = 'argued'
              } else {
                continue // dust sell with no memo — skip
              }
            } else if (
              e.memo &&
              (e.action === 'joined' || e.action === 'reinforced' || e.action === 'rallied')
            ) {
              e.action = 'messaged'
            }
          }
          filtered.push(e)
        }
        const entries2 = filtered

        // Distinguish "joined" vs "reinforced": sort oldest-first,
        // track agent+faction pairs — first buy = joined, later buys = reinforced
        filtered.sort((a, b) => a.timestamp - b.timestamp)
        const seen = new Set<string>()
        for (const e of filtered) {
          if (e.action === 'joined') {
            const key = `${e.agent}:${e.faction_mint}`
            if (seen.has(key)) {
              e.action = 'reinforced'
            } else {
              seen.add(key)
            }
          }
        }

        filtered.sort((a, b) => b.timestamp - a.timestamp)
        setActions(filtered)
      } catch {
        // ignore
      } finally {
        fetchingRef.current = false
        setLoading(false)
      }
    },
    [connection],
  )

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
        filters: [{ memcmp: { offset: 0, bytes: '4y6pru6YvC7' } }],
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
