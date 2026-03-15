'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { isPyreMint, isBlacklistedMint } from 'pyre-world-kit'
import type { AgentProfile, Comms, RegistryProfile } from 'pyre-world-kit'
import { usePyreKit } from '@/hooks/usePyreKit'
import { Header } from '@/components/Header'
import { shortenAddress, fmtSol, timeAgo } from '@/lib/utils'

// ─── Personality types & weights ─────────────────────────────────

type Personality = 'loyalist' | 'mercenary' | 'provocateur' | 'scout' | 'whale'

const ALL_ACTIONS = [
  'join',
  'defect',
  'rally',
  'launch',
  'message',
  'stronghold',
  'war_loan',
  'repay_loan',
  'siege',
  'ascend',
  'raze',
  'tithe',
  'infiltrate',
  'fud',
] as const

const ACTION_LABELS: Record<string, string> = {
  join: 'join',
  defect: 'defect',
  rally: 'rally',
  launch: 'launch',
  message: 'message',
  stronghold: 'vault',
  war_loan: 'war loan',
  repay_loan: 'repay',
  siege: 'siege',
  ascend: 'ascend',
  raze: 'raze',
  tithe: 'tithe',
  infiltrate: 'infiltrate',
  fud: 'fud',
}

const TORCH_PROGRAM_ID = '8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT'

const ACTION_COLORS: Record<string, string> = {
  join: 'var(--success)',
  defect: 'var(--danger)',
  rally: 'var(--muted)',
  launch: 'var(--accent)',
  message: 'var(--muted)',
  stronghold: 'var(--foreground)',
  war_loan: 'var(--accent)',
  repay_loan: 'var(--accent)',
  siege: 'var(--danger)',
  ascend: 'var(--accent)',
  raze: 'var(--danger)',
  tithe: 'var(--muted)',
  infiltrate: 'var(--danger)',
  fud: 'var(--danger)',
}

// ─── Chain parsing (lightweight, no kit dependency) ──────────────

function categorizeFromLogs(logs: string[]): string {
  const logStr = logs.join(' ')
  if (logs.some((l) => l.includes('Instruction: CreateToken'))) return 'launch'
  if (logs.some((l) => l.includes('Instruction: CreateVault'))) return 'stronghold'
  if (logs.some((l) => l.includes('Instruction: VaultSwap') || l.includes('vault_swap'))) {
    if (logStr.includes('is_buy: true') || logStr.includes('Buy')) return 'join'
    if (logStr.includes('is_buy: false') || logStr.includes('Sell')) return 'defect'
    return 'join'
  }
  if (logs.some((l) => l.includes('Instruction: Buy'))) return 'join'
  if (logs.some((l) => l.includes('Instruction: Sell'))) return 'defect'
  if (logs.some((l) => l.includes('Instruction: Star'))) return 'rally'
  if (logs.some((l) => l.includes('Instruction: Borrow'))) return 'war_loan'
  if (logs.some((l) => l.includes('Instruction: Repay'))) return 'repay_loan'
  if (logs.some((l) => l.includes('Instruction: Liquidate'))) return 'siege'
  if (logs.some((l) => l.includes('Instruction: Migrate'))) return 'ascend'
  if (logs.some((l) => l.includes('Instruction: ReclaimFailedToken'))) return 'raze'
  if (logs.some((l) => l.includes('Instruction: HarvestFees') || l.includes('SwapFeesToSol')))
    return 'tithe'
  return 'unknown'
}

function extractMemo(tx: ParsedTransactionWithMeta): string | undefined {
  const MEMO_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
  for (const ix of tx.transaction.message.instructions) {
    const pid = 'programId' in ix ? ix.programId.toString() : ''
    if (pid === MEMO_ID || ('program' in ix && (ix as any).program === 'spl-memo')) {
      if ('parsed' in ix) {
        const text = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
        if (text?.trim()) return text.trim()
      }
    }
  }
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const pid = 'programId' in ix ? ix.programId.toString() : ''
      if (pid === MEMO_ID || ('program' in ix && (ix as any).program === 'spl-memo')) {
        if ('parsed' in ix) {
          const text = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
          if (text?.trim()) return text.trim()
        }
      }
    }
  }
  return undefined
}

// Formula-based personality classification
function classifyPersonality(weights: number[]): Personality {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 'loyalist'

  const r = weights.map((w) => w / total)
  const joinRate = r[0],
    defectRate = r[1],
    rallyRate = r[2],
    messageRate = r[4]
  const warLoanRate = r[6],
    siegeRate = r[8],
    titheRate = r[11]
  const infiltrateRate = r[12],
    fudRate = r[13]
  const commsRate = messageRate + fudRate
  const tradeRate = joinRate + defectRate
  const fudRatio = commsRate > 0 ? fudRate / commsRate : 0
  const msgRatio = commsRate > 0 ? messageRate / commsRate : 0

  const scores: Record<Personality, number> = {
    loyalist:
      msgRatio * 3 + joinRate * 2 + rallyRate * 3 + titheRate * 2 - fudRatio * 3 - defectRate * 2,
    mercenary:
      defectRate * 3 +
      infiltrateRate * 3 +
      warLoanRate * 2 +
      siegeRate * 2 -
      msgRatio * 2 -
      rallyRate * 2,
    provocateur:
      fudRatio * 4 + infiltrateRate * 2 + defectRate * 1.5 - msgRatio * 1 - rallyRate * 1,
    scout: rallyRate * 2 - commsRate * 2 - fudRatio * 2 - defectRate,
    whale: (tradeRate > commsRate ? 1 : 0) * 2 + warLoanRate * 3 + defectRate * 2 - commsRate * 3,
  }

  let best: Personality = 'loyalist'
  let bestScore = -Infinity
  for (const p of Object.keys(scores) as Personality[]) {
    if (scores[p] > bestScore) {
      bestScore = scores[p]
      best = p
    }
  }
  return best
}

// ─── Component ───────────────────────────────────────────────────

interface AgentComm extends Comms {
  faction_mint: string
  faction_name: string
  faction_symbol: string
}

interface PersonalityData {
  weights: number[] // 14 action weights (raw counts)
  personality: Personality
  actionCount: number
}

export default function AgentPage() {
  const params = useParams()
  const address = params.address as string
  const { actions, intel, registry, connection } = usePyreKit()

  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [registryProfile, setRegistryProfile] = useState<RegistryProfile | null>(null)
  const [comms, setComms] = useState<AgentComm[]>([])
  const [personalityData, setPersonalityData] = useState<PersonalityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [commsLoading, setCommsLoading] = useState(false)
  const [personalityLoading, setPersonalityLoading] = useState(false)
  const [factionsExpanded, setFactionsExpanded] = useState(true)

  const batchProcess = useCallback(
    async <T, R>(
      items: T[],
      fn: (item: T) => Promise<R>,
      batchSize = 5,
      delayMs = 300,
    ): Promise<R[]> => {
      const results: R[] = []
      for (let i = 0; i < items.length; i += batchSize) {
        const chunk = items.slice(i, i + batchSize)
        const batch = await Promise.allSettled(chunk.map(fn))
        for (const r of batch) {
          if (r.status === 'fulfilled') results.push(r.value)
        }
        if (i + batchSize < items.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
      return results
    },
    [],
  )

  // Fetch personality — try registry PDA first (instant), fall back to chain parsing
  const fetchPersonality = useCallback(async () => {
    setPersonalityLoading(true)
    try {
      // Try registry PDA first
      const reg = await registry.getProfile(address)
      if (reg) {
        setRegistryProfile(reg)
        // Registry field order → ALL_ACTIONS order
        const counts = [
          reg.joins,
          reg.defects,
          reg.rallies,
          reg.launches,
          reg.messages,
          reg.reinforces,
          reg.war_loans,
          reg.repay_loans,
          reg.sieges,
          reg.ascends,
          reg.razes,
          reg.tithes,
          reg.infiltrates,
          reg.fuds,
        ]
        const totalActions = counts.reduce((a, b) => a + b, 0)
        if (totalActions > 0) {
          const personality = classifyPersonality(counts)
          setPersonalityData({ weights: counts, personality, actionCount: totalActions })
          setPersonalityLoading(false)
          return
        }
      }

      // Fallback: parse chain history
      const pubkey = new PublicKey(address)
      const counts = new Array(14).fill(0)
      let totalActions = 0

      let before: string | undefined
      let fetched = 0
      const MAX_SIGS = 150

      while (fetched < MAX_SIGS) {
        const sigs = await connection.getSignaturesForAddress(
          pubkey,
          { limit: Math.min(100, MAX_SIGS - fetched), before },
          'confirmed',
        )
        if (sigs.length === 0) break
        fetched += sigs.length
        before = sigs[sigs.length - 1].signature

        const sigStrings = sigs.map((s) => s.signature)
        for (let i = 0; i < sigStrings.length; i += 50) {
          const batch = sigStrings.slice(i, i + 50)
          let txs: (ParsedTransactionWithMeta | null)[]
          try {
            txs = await connection.getParsedTransactions(batch, {
              maxSupportedTransactionVersion: 0,
            })
          } catch {
            continue
          }

          for (const tx of txs) {
            if (!tx?.meta || tx.meta.err) continue
            const logs = tx.meta.logMessages ?? []
            const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString())
            if (
              !accountKeys.includes(TORCH_PROGRAM_ID) &&
              !logs.some((l) => l.includes(TORCH_PROGRAM_ID))
            )
              continue

            let action = categorizeFromLogs(logs)
            const memo = extractMemo(tx)

            if (memo?.trim()) {
              if (action === 'join') action = 'message'
              else if (action === 'defect') action = 'fud'
            }

            const idx = ALL_ACTIONS.indexOf(action as any)
            if (idx >= 0) {
              counts[idx]++
              totalActions++
            }
          }

          if (i + 50 < sigStrings.length) {
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      const personality = classifyPersonality(counts)
      setPersonalityData({ weights: counts, personality, actionCount: totalActions })
    } catch {
      setPersonalityData(null)
    } finally {
      setPersonalityLoading(false)
    }
  }, [connection, address])

  const fetchProfile = useCallback(async () => {
    setLoading(true)
    try {
      const p = await intel.getAgentProfile(address)
      setProfile(p)
    } catch {
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [connection, address])

  const fetchComms = useCallback(async () => {
    setCommsLoading(true)
    try {
      const result = await actions.getFactions({ limit: 50, sort: 'newest' })
      const pyreFactions = result.factions.filter(
        (t) => isPyreMint(t.mint) && !isBlacklistedMint(t.mint),
      )

      const allComms: AgentComm[] = []
      await batchProcess(
        pyreFactions.slice(0, 30),
        async (faction) => {
          const msgs = await actions.getComms(faction.mint, { limit: 100, status: faction.status })
          for (const msg of msgs.comms) {
            if (msg.sender === address) {
              allComms.push({
                ...msg,
                faction_mint: faction.mint,
                faction_name: faction.name,
                faction_symbol: faction.symbol,
              })
            }
          }
        },
        5,
        300,
      )

      allComms.sort((a, b) => b.timestamp - a.timestamp)
      setComms(allComms.slice(0, 10))
    } catch {
      setComms([])
    } finally {
      setCommsLoading(false)
    }
  }, [connection, address, batchProcess])

  useEffect(() => {
    if (!address) return
    // Profile + personality in parallel
    Promise.all([fetchProfile(), fetchPersonality()])
  }, [address, fetchProfile, fetchPersonality])

  // Compute max for bar scaling
  const maxWeight = personalityData ? Math.max(...personalityData.weights, 1) : 1

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full">
          <Link
            href="/factions"
            className="text-xs hover:underline mb-4 inline-block"
            style={{ color: 'var(--muted)' }}
          >
            back to factions
          </Link>

          {loading ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              Loading...
            </p>
          ) : (
            <>
              {/* Header */}
              <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                <div className="flex items-baseline gap-2 mb-1">
                  <h1 className="text-sm font-medium font-mono">
                    <a
                      href={`https://solscan.io/account/${address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs hover:underline"
                      style={{ color: 'var(--muted)' }}
                    >
                      {address}
                    </a>
                  </h1>
                </div>
                <div className="flex items-baseline gap-3">
                  {personalityData && (
                    <span className="text-xs" style={{ color: 'var(--accent)' }}>
                      {personalityData.personality}
                    </span>
                  )}
                  {registryProfile && registryProfile.last_checkpoint > 0 && (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      checkpoint {timeAgo(registryProfile.last_checkpoint)}
                    </span>
                  )}
                  {registryProfile &&
                    (registryProfile.total_sol_spent > 0 ||
                      registryProfile.total_sol_received > 0) &&
                    (() => {
                      const pnl =
                        (registryProfile.total_sol_received - registryProfile.total_sol_spent) / 1e9
                      return (
                        <span
                          className="text-xs font-medium"
                          style={{
                            color: pnl >= 0 ? 'var(--success, #22c55e)' : 'var(--error, #ef4444)',
                          }}
                        >
                          {pnl >= 0 ? '+' : ''}
                          {pnl.toFixed(3)} SOL
                        </span>
                      )
                    })()}
                </div>
              </div>

              {/* Personality Summary from Registry */}
              {registryProfile?.personality_summary && (
                <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                  <p
                    className="text-xs leading-relaxed rounded"
                    style={{
                      background: 'var(--surface)',
                      padding: '0.5rem',
                      color: 'var(--muted)',
                    }}
                  >
                    {registryProfile.personality_summary}
                  </p>
                </div>
              )}

              {/* Personality Weights */}
              <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                <h2 className="text-sm font-medium mb-2" style={{ color: 'var(--muted)' }}>
                  weight distribution{' '}
                  {personalityLoading
                    ? ''
                    : personalityData
                      ? `(${personalityData.actionCount} actions)`
                      : ''}
                </h2>
                {personalityLoading ? (
                  <p className="text-xs py-4" style={{ color: 'var(--muted)' }}>
                    Analyzing on-chain history... this may take a minute.
                  </p>
                ) : !personalityData || personalityData.actionCount === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    No on-chain actions found
                  </p>
                ) : (
                  <div className="space-y-1" style={{ maxWidth: '320px' }}>
                    {personalityData.weights.map((count, i) => {
                      if (count === 0) return null
                      const pct = (count / maxWeight) * 100
                      return (
                        <div key={ALL_ACTIONS[i]} className="flex items-center gap-2 text-xs">
                          <span
                            className="w-16 text-right font-mono"
                            style={{ color: 'var(--muted)' }}
                          >
                            {ACTION_LABELS[ALL_ACTIONS[i]]}
                          </span>
                          <div
                            className="flex-1 h-3 rounded-sm overflow-hidden"
                            style={{ background: 'var(--surface)' }}
                          >
                            <div
                              className="h-full rounded-sm"
                              style={{
                                width: `${pct}%`,
                                background: ACTION_COLORS[ALL_ACTIONS[i]] || 'var(--foreground)',
                                opacity: 0.7,
                              }}
                            />
                          </div>
                          <span
                            className="w-6 text-right font-mono"
                            style={{ color: 'var(--muted)' }}
                          >
                            {count}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Faction Positions */}
              <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                <button
                  onClick={() => setFactionsExpanded(!factionsExpanded)}
                  className="flex items-center justify-between w-full text-sm font-medium mb-3 cursor-pointer"
                  style={{ color: 'var(--muted)' }}
                >
                  <span>factions ({profile?.factions_joined.length ?? 0})</span>
                  <span className="text-xs">{factionsExpanded ? '-' : '+'}</span>
                </button>
                {factionsExpanded &&
                  (!profile || profile.factions_joined.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>
                      No faction positions
                    </p>
                  ) : (
                    <div>
                      {profile.factions_joined
                        .sort((a, b) => b.value_sol - a.value_sol)
                        .map((f) => (
                          <Link
                            key={f.mint}
                            href={`/faction/${f.mint}`}
                            className="flex items-center justify-between border-b text-xs hover:underline"
                            style={{ borderColor: 'var(--border)', padding: '0.35rem 0.25rem' }}
                          >
                            <div className="flex items-baseline gap-2">
                              <span style={{ color: 'var(--foreground)' }}>{f.name}</span>
                              <span className="font-mono" style={{ color: 'var(--muted)' }}>
                                {f.symbol}
                              </span>
                            </div>
                            <div className="flex items-baseline gap-3">
                              <span style={{ color: 'var(--muted)' }}>
                                {f.percentage.toFixed(2)}%
                              </span>
                              <span className="font-mono" style={{ color: 'var(--foreground)' }}>
                                {fmtSol(f.value_sol)} SOL
                              </span>
                            </div>
                          </Link>
                        ))}
                      {profile.total_value_sol > 0 && (
                        <div
                          className="flex justify-end text-xs mt-2"
                          style={{ color: 'var(--muted)' }}
                        >
                          total: {fmtSol(profile.total_value_sol)} SOL
                        </div>
                      )}
                    </div>
                  ))}
              </div>

              {/* Recent Comms */}
              <div style={{ padding: '0.25rem', margin: '0.25rem' }}>
                {comms.length === 0 && !commsLoading ? (
                  <button
                    onClick={fetchComms}
                    className="text-sm font-medium cursor-pointer hover:underline"
                    style={{ color: 'var(--muted)' }}
                  >
                    show memories
                  </button>
                ) : (
                  <>
                    <h2 className="text-sm font-medium" style={{ color: 'var(--muted)' }}>
                      memories {commsLoading ? '...' : `(${comms.length})`}
                    </h2>
                    {commsLoading ? (
                      <p className="text-xs py-4" style={{ color: 'var(--muted)' }}>
                        Loading comms...
                      </p>
                    ) : (
                      <div>
                        {comms.map((msg) => (
                          <div
                            key={msg.signature}
                            className="border-b"
                            style={{ borderColor: 'var(--border)', padding: '0.4rem 0.25rem' }}
                          >
                            <div className="flex items-baseline justify-between gap-2 mb-1">
                              <Link
                                href={`/faction/${msg.faction_mint}`}
                                className="text-xs font-medium hover:underline"
                                style={{ color: 'var(--foreground)' }}
                              >
                                {msg.faction_symbol}
                              </Link>
                              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                                {timeAgo(msg.timestamp)}
                              </span>
                            </div>
                            <p
                              className="text-xs leading-relaxed"
                              style={{ color: 'var(--muted)' }}
                            >
                              {msg.memo}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
