import type { PyreKit } from 'pyre-world-kit'
import { ACTION_MAP, PERSONALITY_SOL, personalityDesc, VOICE_NUDGES, VOICE_TRAITS } from './defaults'
import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision } from './types'
import { pick, randRange } from './util'
import { fetchFactionIntel, generateDynamicExamples } from './faction'

export interface LLMDecideOptions {
  compact?: boolean
}

// Store scout results to show on the next turn
export const pendingScoutResults = new Map<string, string[]>()

export interface FactionContext {
  rising: FactionInfo[]
  ascended: FactionInfo[]
  nearby: FactionInfo[]
  all: FactionInfo[] // deduplicated union for symbol resolution
}

export const buildAgentPrompt = (
  kit: PyreKit,
  agent: AgentState,
  factionCtx: FactionContext,
  intelSnippet: string,
  recentMessages: string[],
  solRange?: [number, number],
  holdings?: Map<string, number>,
): string => {
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]
  const gameState = kit.state.state!
  const factions = factionCtx.all
  const holdingsEntries = [...(holdings?.entries() ?? [])]
  const symbolCounts = new Map<string, number>()
  for (const [mint] of holdingsEntries) {
    const f = factions.find((ff) => ff.mint === mint)
    if (f) symbolCounts.set(f.symbol, (symbolCounts.get(f.symbol) ?? 0) + 1)
  }

  const nearbyList =
    factionCtx.nearby
      .slice(0, 10)
      .map((f) => f.symbol)
      .join(', ') || 'none'
  const risingList =
    factionCtx.rising
      .slice(0, 5)
      .filter(f => !holdings?.get(f.mint) && !nearbyList.includes(f.symbol))
      .map((f) => f.symbol)
      .join(', ') || 'none'
  const ascendedList =
    factionCtx.ascended
      .slice(0, 5)
      .filter(f => !holdings?.get(f.mint) && !nearbyList.includes(f.symbol))
      .map((f) => f.symbol)
      .join(', ') || 'none'
  // Compute per-position value and approximate cost basis
  const TOKEN_MULTIPLIER = 1_000_000
  let totalHoldingsValue = 0
  const positionValues: { label: string; valueSol: number; mint: string }[] = []
  for (const [mint, bal] of holdingsEntries) {
    const f = factions.find((ff) => ff.mint === mint)
    if (!f) continue
    const label =
      (symbolCounts.get(f.symbol) ?? 0) > 1 ? `${f.symbol}(${mint.slice(0, 6)})` : f.symbol
    const uiBalance = bal / TOKEN_MULTIPLIER
    const valueSol = uiBalance * (f.price_sol ?? 0)
    totalHoldingsValue += valueSol
    positionValues.push({ label, valueSol, mint })
  }

  // Sort by value descending — biggest positions first
  positionValues.sort((a, b) => b.valueSol - a.valueSol)

  // Approximate cost basis: distribute net SOL invested across positions by token balance ratio
  const netInvested = (gameState.totalSolSpent - gameState.totalSolReceived) / 1e9
  const totalTokens = holdingsEntries.reduce((sum, [, bal]) => sum + bal, 0)
  const holdingsList =
    positionValues
      .map(({ label, valueSol, mint }) => {
        const bal = holdings?.get(mint) ?? 0
        if (totalTokens > 0 && netInvested > 0) {
          const estCost = netInvested * (bal / totalTokens)
          const positionPnl = valueSol - estCost
          return `${label}: ${valueSol.toFixed(4)} SOL (${positionPnl >= 0 ? '+' : ''}${positionPnl.toFixed(4)})`
        }
        return `${label}: ${valueSol.toFixed(4)} SOL`
      })
      .join(', ') || 'none'
  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
  const unrealizedPnl = totalHoldingsValue + pnl
  const sentimentList =
    [...kit.state.sentimentMap]
      .map(([mint, score]) => {
        const f = factions.find((ff) => ff.mint === mint)
        const label = score > 3 ? 'bullish' : score < -3 ? 'bearish' : 'neutral'
        return f ? `${f.symbol}: ${label} (${score > 0 ? '+' : ''}${score})` : null
      })
      .filter(Boolean)
      .join(', ') || 'no strong feelings yet'

  const allyList =
    agent.allies.size > 0 ? [...agent.allies].map((a) => a.slice(0, 8)).join(', ') : 'none'
  const rivalList =
    agent.rivals.size > 0 ? [...agent.rivals].map((a) => a.slice(0, 8)).join(', ') : 'none'

  const doNotRepeat =
    recentMessages.length > 0
      ? `\nDO NOT REPEAT OR PARAPHRASE:\n${recentMessages.map((m) => `- "${m}"`).join('\n')}\n`
      : ''

  // On-chain memory — history as persistent context
  const memoryEntries = [...kit.state.history].slice(-20)
  const memoryBlock =
    memoryEntries.length > 0
      ? memoryEntries.map((m) => `- ${m}`).join('; ')
      : 'none'

  return `Pyre: faction warfare. Factions are rival guilds with war chests, members, and culture.
You have your own opinions, allegiances, and grudges. Earlier actions contribute more — choose young factions carefully.
You make ONE decision per turn.

LIFECYCLE: LAUNCH → RISING → READY → VOTE → ASCEND → ASCENDED
- Ascended factions have war chests: TITHE harvests fees, WAR_LOAN borrows against holdings, SIEGE liquidates bad loans
- Inactive factions (7+ days) can be RAZEd — funds return to the realm

FACTIONS:
RISING: ${risingList}
ASCENDED: ${ascendedList}
NEARBY: ${nearbyList}
INTEL: ${intelSnippet}

YOU: "${agent.publicKey.slice(0, 8)}" — ${agent.personality}
BIO: ${gameState.personalitySummary || personalityDesc[agent.personality]}
MEMORIES: ${memoryBlock}

━━━ PORTFOLIO ━━━
${holdingsList}
Portfolio: ${totalHoldingsValue.toFixed(4)} SOL | Realized P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL | Unrealized: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} SOL
${unrealizedPnl > 0.1 ? 'You are UP. Consider taking profits on your biggest winners with DEFECT.' : unrealizedPnl < -0.05 ? 'You are DOWN. Be conservative. Cut losers with DEFECT. Smaller positions.' : 'Near breakeven. Look for conviction plays.'}
${positionValues.length > 0 ? `Best position: ${positionValues.sort((a, b) => b.valueSol - a.valueSol)[0].label} (${positionValues.sort((a, b) => b.valueSol - a.valueSol)[0].valueSol.toFixed(4)} SOL)` : ''}
Sentiment: ${sentimentList}
Spend range: ${minSol}–${maxSol} SOL
${gameState.activeLoans.size > 0 ? `Active loans: ${[...gameState.activeLoans].map((m) => { const f = factions.find((ff) => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ')}` : ''}${gameState.founded.length > 0 ? `\nFounded: ${gameState.founded.map((m) => { const f = factions.find((ff) => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ')} — promote these aggressively` : ''}
Allies: ${allyList} | Rivals: ${rivalList}
${doNotRepeat}

VOICE: ${VOICE_TRAITS[agent.publicKey.charCodeAt(0) % VOICE_TRAITS.length]}
- First person only. Be specific — @address, real numbers, real moves. Never generic.
- Write something original and unique every time.  Talk TO agents, not about them.
- Your message should reflect YOUR portfolio.

F = faction name from the lists above (e.g. ${
    factions
      .slice(0, 3)
      .map((f) => f.symbol)
      .join(', ') || 'IRON, VANG'
  }). NOT an address or wallet. One line only.

RULES:
- Respond with EXACTLY one line, e.g.: JOIN ${factions[0]?.symbol || 'IRON'} "${pick(['count me in', 'early is everything'])}"
- Mention agents with @address (e.g. @${Math.random().toString(36).slice(2, 10)})
- F must be a faction name from the lists above. Alphanumeric strings like FVw8uGKk are wallet addresses, NOT factions.
- Messages: under 80 chars, plain English, one sentence. No hashtags, no angle brackets.

ACTIONS (pick exactly one):
JOIN F "${pick(['count me in', 'early is everything', 'strongest faction here', 'lets go'])}" — join a faction (msg optional)
DEFECT F "${pick(['taking profits', 'time to move on', 'cutting losses'])}" — leave a faction (msg optional)
REINFORCE F "${pick(['doubling down', 'conviction play', 'added more'])}" — grow position (msg optional)
INFILTRATE F "${pick(['just looking around', 'checking the vibes', 'scouting'])}" — join rival to defect later (msg optional)
MESSAGE F "${pick(['who else is here?', 'just getting started', 'not leaving'])}" — talk in faction comms
FUD F "${pick(['founders went quiet', 'dead faction', 'overvalued'])}" — trash talk (must be a member)
SCOUT @address — look up an agent (no msg)
RALLY F — show support, one-time per faction (no msg)
WAR_LOAN F — borrow against holdings, ascended only (no msg)
REPAY_LOAN F — repay a loan (no msg)
SIEGE F — liquidate a bad loan, ascended only (no msg)
TITHE F — harvest fees into war chest, ascended only (no msg)
ASCEND F — promote a ready faction (no msg)
RAZE F — reclaim an inactive faction (no msg)
LAUNCH "name" — create a new faction (no msg)

STRATEGY:
- Limit to ~5 major holdings. MESSAGE/FUD in others is fine but keep real positions focused.${positionValues.length > 5 ? ` You hold ${positionValues.length} — consider DEFECT from your weakest.` : ''}
- MESSAGE/FUD cost almost nothing but move sentiment — use them.
- REINFORCE factions you believe in. Don't JOIN the same faction twice.
- DEFECT to lock in profits or cut losses. Don't hold losers.
- Your holdings ARE your identity. Promote what you hold. Attack what you don't.
- Reference your actual P&L in messages. Agents who talk numbers are more convincing.${factions.length <= 2 ? '\n- Few factions active — consider LAUNCH.' : ''}

GOAL: Maximize long-term profit and faction dominance.

Your response:`
}

export const buildCompactModelPrompt = (
  kit: PyreKit,
  agent: AgentState,
  factionCtx: FactionContext,
  intelSnippet: string,
  recentMessages: string[],
  solRange?: [number, number],
  holdings?: Map<string, number>,
): string => {
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]
  const gameState = kit.state.state!
  const holdingsEntries = [...(holdings?.entries() ?? [])]

  // Sort holdings by SOL value descending
  const TOKEN_MULTIPLIER = 1_000_000
  const valued = holdingsEntries
    .map(([mint, bal]) => {
      const f = factionCtx.all.find((ff) => ff.mint === mint)
      if (!f) return null
      return { symbol: f.symbol, valueSol: (bal / TOKEN_MULTIPLIER) * (f.price_sol ?? 0) }
    })
    .filter(Boolean)
    .sort((a, b) => b!.valueSol - a!.valueSol) as { symbol: string; valueSol: number }[]

  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9

  // Compact: max 10 symbols, top 5 held by value
  const nearby = factionCtx.nearby.filter(f => !holdings?.has(f.mint)).slice(0, 5)
  const rising = factionCtx.rising.filter(f => !holdings?.has(f.mint) && !factionCtx.nearby.find(n => n.mint === f.mint))
  const ascended = factionCtx.ascended.filter(f => !holdings?.has(f.mint) && !factionCtx.nearby.find(n => n.mint === f.mint))
  const validatedFactions = [...nearby, ...rising, ...ascended]
  const held = valued.slice(0, 5).map((v) => v.symbol)
  const sentimentList =
    [...kit.state.sentimentMap]
      .map(([mint, score]) => {
        const f = factionCtx.all.find((ff) => ff.mint === mint)
        if (!f) return null
        const label = score > 3 ? 'positive' : score < -3 ? 'negative' : 'neutral'
        return `${f.symbol}:${label}`
      })
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'none'

  const factionPrompt = [
    rising.length > 0 ? `RISING: ${rising.map(f => f.symbol).join(', ')}` : undefined,
    ascended.length > 0 ? `ASCENDED: ${ascended.map(f => f.symbol).join(', ')}` : undefined,
    nearby.length > 0 ? `NEARBY: ${nearby.map(f => f.symbol).join(', ')}` : undefined,
  ].filter(Boolean)

  const h = held[0] || (validatedFactions.length > 0 ? pick(validatedFactions).symbol : 'IRON')
  const f1 = validatedFactions.length > 0 ? pick(validatedFactions).symbol : 'IRON'
  const f2 = validatedFactions.length > 1 ? pick(validatedFactions.filter(f => f.symbol !== f1)).symbol ?? f1 : f1
  const allSymbols = [...new Set([...held, ...validatedFactions.map(f => f.symbol)])].slice(0, 8)

  return `You are playing Pyre, a faction warfare game on Solana. You must pick exactly one action.

VALID FACTIONS:
${factionPrompt.length > 0 ? factionPrompt.join('\n') : ''}

YOUR STATUS:
- Agent: "${agent.publicKey.slice(0, 8)}" — ${agent.personality}
- P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL
- Holding: ${held.length > 0 ? held.slice(0, 4).join(', ') : 'none'}
- Sentiment: ${sentimentList}
- Last action: ${kit.state.history[0] ?? 'none'}

F = faction name from the lists above (e.g. ${factionCtx.all.slice(0, 3).map((f) => f.symbol).join(', ') || 'IRON, VANG'}).

ACTIONS (pick exactly one, replace F with a faction name from VALID FACTIONS):
- JOIN F "${pick(['im in lets go', 'early on this one', 'strongest faction here', 'not missing this', 'deploying now'])}"
- DEFECT F "${pick(['taking profits here', 'time to move on', 'cutting my losses', 'this one is done', 'exit now'])}"
- REINFORCE F "${pick(['doubling down on this', 'added more conviction', 'not leaving this one', 'strongest hold'])}"
- INFILTRATE F "${pick(['just scouting around', 'checking the vibes', 'dont mind me here', 'interesting faction'])}"
- MESSAGE F "${pick(['who else is holding', 'just getting started here', 'not selling this one', 'volume picking up'])}"
- FUD F "${pick(['founders went quiet', 'dead faction walking', 'overvalued right now', 'volume dried up'])}"
- TITHE F
- ASCEND F
- LAUNCH "name"

RULES:
- You MUST respond with exactly ONE line. Do NOT write multiple lines
- The line MUST start with an action word: JOIN, DEFECT, REINFORCE, INFILTRATE, MESSAGE, FUD, TITHE, ASCEND, or LAUNCH
- The second word MUST be a faction from VALID FACTIONS: ${allSymbols.join(', ')}
- Do NOT explain your reasoning
- Limit yourself to ~5 holdings. DEFECT before joining new factions.

EXAMPLE RESPONSES:
JOIN ${f1} "${pick(['im in', 'lets go', 'early'])}"
DEFECT ${h} "${pick(['taking profits', 'moving on'])}"
MESSAGE ${h} "${pick(['who else is here', 'not selling'])}"
FUD ${f2} "${pick(['overvalued', 'dead faction'])}"
REINFORCE ${h}

Your move:`
}

/**
 * Resolve a symbol to a faction, disambiguating duplicates using agent context.
 */
/** Check if two strings differ by exactly one edit (insert, delete, or substitute) */
function editDistance1(a: string, b: string): boolean {
  if (a === b) return false
  if (a.length === b.length) {
    let diffs = 0
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs++
      if (diffs > 1) return false
    }
    return diffs === 1
  }
  // One is longer by 1 — check single insertion/deletion
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  if (long.length - short.length !== 1) return false
  let i = 0, j = 0, diffs = 0
  while (i < short.length && j < long.length) {
    if (short[i] !== long[j]) {
      diffs++
      if (diffs > 1) return false
      j++
    } else {
      i++; j++
    }
  }
  return true
}

function resolveFaction(
  symbolLower: string | undefined,
  factions: FactionInfo[],
  holdings: Map<string, number>,
  kit: PyreKit,
  action: string,
): FactionInfo | undefined {
  const gameState = kit.state.state!
  if (!symbolLower) return undefined
  const matches = factions.filter((f) => f.symbol.toLowerCase() === symbolLower)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]

  const held = matches.filter((f) => holdings.has(f.mint))
  const notHeld = matches.filter((f) => !holdings.has(f.mint))

  if (
    action === 'defect' ||
    action === 'fud' ||
    action === 'rally' ||
    action === 'message' ||
    action === 'war_loan' ||
    action === 'repay_loan'
  ) {
    if (held.length === 1) return held[0]
    if (held.length > 1) {
      const dir = action === 'defect' || action === 'fud' ? -1 : 1
      return held.sort(
        (a, b) => dir * (kit.state.getSentiment(b.mint) - kit.state.getSentiment(a.mint)),
      )[0]
    }
  }

  if (action === 'join' || action === 'infiltrate') {
    if (notHeld.length > 0) return notHeld[0]
  }

  if (held.length > 0) return held[0]
  const founded = matches.find((f) => gameState.founded.includes(f.mint))
  if (founded) return founded
  return matches[0]
}

function parseLLMDecision(
  raw: string,
  factions: FactionInfo[],
  kit: PyreKit,
  agent: AgentState,
  holdings: Map<string, number>,
  solRange?: [number, number],
): LLMDecision | null {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return null

  let lastRejection: string | null = null
  for (const candidate of lines) {
    const line = candidate.trim()

    const scoutMatch = line.match(/^SCOUT\s+@?([A-Za-z0-9]{6,44})/i)
    if (scoutMatch) {
      return { action: 'scout' as Action, faction: scoutMatch[1], reasoning: line }
    }

    const cleaned = line
      .replace(/\*+/g, '')
      .replace(/^[-•>#\d.)\s]+/, '')
      .replace(/^(?:WARNING|NOTE|RESPONSE|OUTPUT|ANSWER|RESULT|SCPRT|SCRIPT)\s*:?\s*/i, '')
      .replace(/^ACTION\s+/i, '')
      .replace(
        /^I\s+(?=JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|FUD|INFILTRATE|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|SCOUT)/i,
        '',
      )
      .replace(/[АаА]/g, 'A')
      .replace(/[Вв]/g, 'B')
      .replace(/[Сс]/g, 'C')
      .replace(/[Ее]/g, 'E')
      .replace(/[Нн]/g, 'H')
      .replace(/[Кк]/g, 'K')
      .replace(/[Мм]/g, 'M')
      .replace(/[Оо]/g, 'O')
      .replace(/[Рр]/g, 'P')
      .replace(/[Тт]/g, 'T')
      .replace(/[Уу]/g, 'U')
      .replace(/[Хх]/g, 'X')
      .replace(/[фФ]/g, 'f')
      .replace(/[иИ]/g, 'i')
      .replace(/[лЛ]/g, 'l')
      .replace(/[дД]/g, 'd')
      .replace(/\\/g, '')
      .replace(/\s+for\s+\d+\.?\d*\s*SOL/i, '')
      .replace(/\s*[-;:]+\s*(?=")/g, ' ')

    let normalized = cleaned
    const upper = cleaned.toUpperCase()
    const knownSymbols = factions.map((f) => f.symbol.toUpperCase())

    const actionKeys = Object.keys(ACTION_MAP).sort((a, b) => b.length - a.length)
    for (const key of actionKeys) {
      if (upper.startsWith(key)) {
        const rest = cleaned.slice(key.length)
        if (rest.length > 0 && rest[0] !== ' ' && rest[0] !== '"') {
          const trimmedRest = rest.replace(/^[_\-]+/, '')
          const restUpper = trimmedRest.toUpperCase()
          const matchedSymbol = knownSymbols.find((s) => restUpper.startsWith(s))
          if (matchedSymbol) {
            normalized = ACTION_MAP[key] + ' ' + trimmedRest
            break
          }
        } else {
          normalized = ACTION_MAP[key] + rest
          break
        }
      }
    }

    const match = normalized.match(
      /^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|INFILTRATE|FUD)\s*(?:"([^"]+)"|(\S+))?(?:\s+"([^"]*)")?/i,
    )
    if (match) {
      const result = parseLLMMatch(match, factions, kit, agent, holdings, line, solRange)
      if (result?._rejected) {
        lastRejection = result._rejected
        continue
      }
      if (result) return result
    }

    // Bare ticker without action — default to MESSAGE
    const bareUpper = cleaned.toUpperCase().replace(/^[<\[\s]+|[>\]\s]+$/g, '')
    const bareFaction = resolveFaction(
      factions.find((f) => bareUpper.startsWith(f.symbol.toUpperCase()))?.symbol.toLowerCase(),
      factions,
      holdings,
      kit,
      'message',
    )
    if (bareFaction) {
      const rest = cleaned.slice(bareFaction.symbol.length).trim()
      const msgMatch = rest.match(/^"([^"]*)"/)
      const msg = msgMatch?.[1]?.trim()
      if (msg && msg.length > 1) {
        return {
          action: 'message',
          faction: bareFaction.mint,
          message: msg.slice(0, 140),
          reasoning: line,
        }
      }
    }
  }

  return lastRejection ? ({ _rejected: lastRejection } as any) : null
}

function parseLLMMatch(
  match: RegExpMatchArray,
  factions: FactionInfo[],
  kit: PyreKit,
  agent: AgentState,
  holdings: Map<string, number>,
  line: string,
  solRange?: [number, number],
): LLMDecision | null {
  const rawAction = match[1].toLowerCase()
  const action = rawAction as Action
  const target = match[2] || match[3]
  const rawMsg = match[4]
    ?.trim()
    ?.replace(/[^\x20-\x7E@]/g, '')
    ?.replace(/^[\\\/]+/, '')
    ?.replace(/[\\\/]+$/, '')
    ?.replace(/^["']+|["']+$/g, '')
    ?.replace(/^<+/, '')
    ?.replace(/>+\s*$/, '')
    ?.replace(/#\w+/g, '')
    ?.trim()
  const message = rawMsg && rawMsg.length > 1 ? rawMsg.slice(0, 80) : undefined

  const gameState = kit.state.state!

  if (action === 'launch') {
    return { action: 'launch', message: target, reasoning: line }
  }

  const cleanTarget = target?.replace(/^[<\[]+|[>\]]+$/g, '')
  const targetLower = cleanTarget?.toLowerCase()
  let faction = resolveFaction(targetLower, factions, holdings, kit, action)
  if (!faction && targetLower && targetLower.length >= 2) {
    const prefixMatches = factions.filter(
      (f) =>
        f.symbol.toLowerCase().startsWith(targetLower) ||
        targetLower.startsWith(f.symbol.toLowerCase()),
    )
    if (prefixMatches.length > 0)
      faction = resolveFaction(
        prefixMatches[0].symbol.toLowerCase(),
        factions,
        holdings,
        kit,
        action,
      )
    if (!faction) {
      const stripped = targetLower.replace(/[aeiou]/g, '')
      const vowelMatch = factions.find(
        (f) => f.symbol.toLowerCase().replace(/[aeiou]/g, '') === stripped,
      )
      if (vowelMatch) faction = vowelMatch
    }
    // Fuzzy: LLM sometimes drops or swaps letters in longer tickers.
    // Match if edit distance is 1 (single insert, delete, or substitute).
    if (!faction && targetLower.length >= 3) {
      const fuzzyMatch = factions.find((f) => {
        const sym = f.symbol.toLowerCase()
        if (Math.abs(sym.length - targetLower.length) > 1) return false
        return editDistance1(sym, targetLower)
      })
      if (fuzzyMatch) faction = fuzzyMatch
    }
  }

  // Validate action is possible
  const sym = faction?.symbol ?? target ?? '?'
  if (action === 'defect' && !faction)
    return { _rejected: `defect rejected: unknown faction "${sym}"` } as any
  if (action === 'defect' && faction && !holdings.has(faction.mint))
    return { _rejected: `defect rejected: no holdings in ${sym}` } as any
  if (action === 'rally' && !faction)
    return { _rejected: `rally rejected: unknown faction "${sym}"` } as any
  if (action === 'rally' && faction && gameState.rallied.has(faction.mint))
    return { _rejected: `rally rejected: already rallied ${sym}` } as any
  if ((action === 'join' || action === 'message') && !faction)
    return { _rejected: `${action} rejected: unknown faction "${sym}"` } as any
  if (action === 'message' && !message)
    return { _rejected: `message rejected: no message text for ${sym}` } as any
  if (action === 'war_loan' && !faction)
    return { _rejected: `war_loan rejected: unknown faction "${sym}"` } as any
  if (action === 'war_loan' && faction && !holdings.has(faction.mint))
    return { _rejected: `war_loan rejected: no holdings in ${sym}` } as any
  if (action === 'war_loan' && faction && faction.status !== 'ascended')
    return { _rejected: `war_loan rejected: ${sym} not ascended` } as any
  if (action === 'repay_loan' && (!faction || !gameState.activeLoans.has(faction?.mint ?? '')))
    return { _rejected: `repay_loan rejected: no active loan on ${sym}` } as any
  if (action === 'siege' && (!faction || faction.status !== 'ascended'))
    return { _rejected: `siege rejected: ${sym} not ascended` } as any
  if ((action === 'ascend' || action === 'raze' || action === 'tithe') && !faction)
    return { _rejected: `${action} rejected: unknown faction "${sym}"` } as any
  if (action === 'infiltrate' && !faction)
    return { _rejected: `infiltrate rejected: unknown faction "${sym}"` } as any
  if (action === 'fud' && faction && !holdings.has(faction.mint)) {
    return { action: 'message', faction: faction.mint, message, reasoning: line }
  }
  if (action === 'fud' && !faction)
    return { _rejected: `fud rejected: unknown faction "${sym}"` } as any

  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]
  const sol = randRange(minSol, maxSol)

  return { action, faction: faction?.mint, sol, message, reasoning: line }
}

export async function llmDecide(
  kit: PyreKit,
  agent: AgentState,
  factions: FactionInfo[],
  recentMessages: string[],
  llm: LLMAdapter,
  log: (msg: string) => void,
  solRange?: [number, number],
  options?: LLMDecideOptions,
): Promise<LLMDecision | null> {
  const compact = options?.compact ?? false

  // Fetch holdings fresh from chain
  const holdings = await kit.state.getHoldings()

  // Fetch faction context: rising, ascended, nearby (parallel)
  // Compact mode: minimal fetches to keep context small for smol models
  const risingLimit = compact ? 3 : 5
  const ascendedLimit = compact ? 3 : 5
  const [risingAll, ascendedAll, nearbyResult] = await Promise.all([
    kit.intel.getRisingFactions().catch(() => ({ factions: [] })),
    kit.intel.getAscendedFactions().catch(() => ({ factions: [] })),
    compact
      ? Promise.resolve({ factions: [], allies: [] as string[] })
      : kit.intel.getNearbyFactions(agent.publicKey, { depth: compact ? 2 : 4, limit: compact ? 7 : 15 }).catch(() => ({
          factions: [],
          allies: [] as string[],
        })),
  ])

  // Update allies from social graph discovery
  if ('allies' in nearbyResult) {
    for (const ally of nearbyResult.allies) {
      if (ally !== agent.publicKey) agent.allies.add(ally)
    }
  }

  // Slice to desired length for context, keep full lists for dedup
  const risingFactions = risingAll.factions.slice(0, risingLimit) as FactionInfo[]
  const ascendedFactions = ascendedAll.factions.slice(0, ascendedLimit) as FactionInfo[]

  // Deduplicate into a single faction list for symbol resolution
  const seenMints = new Set<string>()
  const allFactions: FactionInfo[] = []
  for (const f of [
    ...risingAll.factions,
    ...ascendedAll.factions,
    ...nearbyResult.factions,
  ]) {
    if (!seenMints.has(f.mint)) {
      seenMints.add(f.mint)
      allFactions.push(f)
    }
  }

  const factionCtx: FactionContext = {
    rising: risingFactions,
    ascended: ascendedFactions,
    nearby: nearbyResult.factions as FactionInfo[],
    all: allFactions,
  }

  let intelSnippet = ''
  if (!compact) try {
    const heldMints = [...holdings.keys()]
    const heldFactions = allFactions.filter((f) => heldMints.includes(f.mint))
    const otherFactions = allFactions.filter((f) => !heldMints.includes(f.mint))
    const toScout = [
      ...heldFactions.slice(0, 2),
      ...(otherFactions.length > 0 ? [pick(otherFactions)] : []),
    ]

    if (toScout.length > 0) {
      const intels = await Promise.all(toScout.map((f) => fetchFactionIntel(kit, f)))
      const lines = intels.map((intel) => {
        const memberInfo =
          intel.totalMembers > 0
            ? `${intel.totalMembers} members, top holder: ${intel.members[0]?.percentage.toFixed(1)}%`
            : 'no members'
        const commsInfo =
          intel.recentComms.length > 0
            ? intel.recentComms
                .slice(0, 3)
                .map(
                  (c) =>
                    `@${c.sender.slice(0, 8)} said: "${c.memo.replace(/^<+/, '').replace(/>+\s*$/, '')}"`,
                )
                .join(', ')
            : 'no recent comms'
        return `  [${intel.symbol}] ${memberInfo} | recent comms: ${commsInfo}`
      })
      intelSnippet = 'FACTION INTEL:\n' + lines.join('\n')
    }
  } catch {}

  // Include results from previous SCOUT actions (skip in compact mode)
  let scoutSnippet = ''
  if (!compact) {
    const scoutResults = pendingScoutResults.get(agent.publicKey)
    if (scoutResults && scoutResults.length > 0) {
      scoutSnippet = '\nSCOUT RESULTS (from your previous SCOUT actions):\n' + scoutResults.join('\n')
      pendingScoutResults.delete(agent.publicKey)
    }
  }

  const buildPrompt = compact ? buildCompactModelPrompt : buildAgentPrompt
  const prompt = buildPrompt(
    kit,
    agent,
    factionCtx,
    intelSnippet + scoutSnippet,
    recentMessages,
    solRange,
    holdings,
  )

  const raw = await llm.generate(prompt)
  if (!raw) {
    log(`[${agent.publicKey.slice(0, 8)}] LLM returned null`)
    return null
  }

  const result = parseLLMDecision(raw, allFactions, kit, agent, holdings, solRange)
  if (!result) {
    log(`[${agent.publicKey.slice(0, 8)}] LLM parse fail: "${raw.slice(0, 100)}"`)
    return null
  }

  if (result._rejected) {
    log(
      `[${agent.publicKey.slice(0, 8)}] LLM rejected: ${result._rejected} | raw: "${raw.slice(0, 80)}"`,
    )
    return null
  }
  return result
}
