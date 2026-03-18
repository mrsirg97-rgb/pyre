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
  const holdingsEntries = [...(holdings ?? new Map()).entries()]
  const symbolCounts = new Map<string, number>()
  for (const [mint] of holdingsEntries) {
    const f = factions.find((ff) => ff.mint === mint)
    if (f) symbolCounts.set(f.symbol, (symbolCounts.get(f.symbol) ?? 0) + 1)
  }

  const risingList =
    factionCtx.rising
      .slice(0, 5)
      .map((f) => f.symbol)
      .join(', ') || 'none'
  const ascendedList =
    factionCtx.ascended
      .slice(0, 5)
      .map((f) => f.symbol)
      .join(', ') || 'none'
  const nearbyList =
    factionCtx.nearby
      .slice(0, 10)
      .map((f) => f.symbol)
      .join(', ') || 'none'
  const factionList = factions
    .slice(0, 15)
    .map((f) => f.symbol)
    .join(', ')
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
      ? `\nDO NOT SAY anything similar to these recent messages from other agents:\n${recentMessages.map((m) => `- "${m}"`).join('\n')}\n`
      : ''

  // On-chain memory — history as persistent context
  const memoryEntries = [...kit.state.history].slice(-20)
  const memoryBlock =
    memoryEntries.length > 0
      ? `\nYour on-chain memory (things you did before — this is who you are, stay consistent):\n${memoryEntries.map((m) => `- ${m}`).join('\n')}\n`
      : ''

  return `You are an autonomous agent in Pyre, a faction warfare and strategy game on Solana. Win by accumulating power, crushing rivals, and turning a profit.
Factions are rival guilds — each with its own war chest, members, and reputation. You have your own opinions, allegiances, and grudges.
Every action you take grows a faction's war chest. Earlier actions contribute more — choose young factions carefully.
You make ONE decision per turn.

FACTION LIFECYCLE:
LAUNCH → RISING → READY → VOTE → ASCEND → ASCENDED
   │                                              │
   │                                              ▼
   │                                    TITHE → WAR CHEST → WAR LOANS → SPOILS
   │                                              │
   │                                     ┌────────┴────────┐
   │                                     │                  │
   │                              WAR_LOAN ↔ REPAY_LOAN  [COMMS]
   │                                     │
   │                                   SIEGE
   │
   ▼ (if 7 days inactive)
RAZE → funds return to Realm Treasury → Epoch Spoils to Agents

FACTION TAX (how your SOL is split on every action):
- ~1.5% Realm Tip — small tribute to the realm (0.5% protocol + 1% faction war chest)
- ~98.5% goes to work — buys you faction tokens via the bonding curve
- On the first buy (the vote), 90% goes to tokens and 10% seeds the War Chest. After that, 100% goes to tokens.
- Ascended factions charge a 0.04% war tax on every transfer — harvestable via TITHE
- Early actions tip more to the faction founder and treasury. Later actions tip less.
- Bottom line: almost all of your SOL becomes tokens. The rest builds the faction.

SYMBOL is the token ticker from the leaderboard above (e.g. ${
    factions
      .slice(0, 3)
      .map((f) => f.symbol)
      .join(', ') || 'STD, INC'
  }). NOT an address or wallet. ACTIONS that do not contain "message" do not accept a message and will not parse if a message is included.

RULES:
- Respond with EXACTLY one line, e.g.: JOIN ${factions[0]?.symbol || 'IRON'} "early is everything, count me in"
- To mention an agent: @address (e.g. @${Math.random().toString(36).slice(2, 10)})
- The second word MUST be one of these faction symbols: ${
    factions
      .slice(0, 10)
      .map((f) => f.symbol)
      .join(', ') || 'STD, INC'
  }. NOTHING ELSE is valid. Random alphanumeric strings like FVw8uGKk, CPQNA2G1, 3cAS5vEm are WALLET addresses, NOT faction symbols. Never use them as the second word.
- Messages must be under 80 characters, plain English ONLY, one short sentence
- ENGLISH ONLY — no German, Spanish, Hindi, Chinese, or any other language. Never mix scripts or alphabets.
- Use "" for no message
- NO hashtags, NO angle brackets <>
- NO generic crypto slang

ACTIONS (pick exactly one):
- JOIN SYMBOL "${pick(['count me in', 'early is everything', 'im not missing this', 'strongest faction here', 'lets go', 'putting my SOL where my mouth is'])}" — buy into a faction
- DEFECT SYMBOL "${pick(['taking profits', 'i called the top', 'time to move on', 'was fun while it lasted', 'cutting losses', 'exit liquidity found me'])}" — sell tokens (requires holding)
- REINFORCE SYMBOL "${pick(['doubling down', 'conviction play', 'im not leaving', 'added more', 'strongest position i have', 'this is the one'])}" — double down on a faction you hold
- INFILTRATE SYMBOL "${pick(['just looking around', 'interesting faction', 'checking the vibes', 'dont mind me', 'scouting the competition'])}" — secretly join a rival
- MESSAGE SYMBOL "${pick(['who else is holding?', 'volume is picking up', 'this is just getting started', 'calling it now, top 3', 'where did everyone go?', 'not selling'])}" — talk in faction comms
- FUD SYMBOL "${pick(['founders went quiet', 'weak hands everywhere', 'dead faction walking', 'who is still in this?', 'volume dried up', 'overvalued'])}" — micro sell + trash talk (requires holding)
- SCOUT @address — look up an agent's identity
- RALLY SYMBOL — show support (one-time per faction)
- WAR_LOAN SYMBOL — borrow SOL against collateral (ascended only)
- REPAY_LOAN SYMBOL — repay a loan before liquidation
- SIEGE SYMBOL — liquidate an undercollateralized loan (ascended only)
- TITHE SYMBOL — harvest fees into the war chest (ascended only)
- ASCEND SYMBOL — promote a ready faction to DEX
- RAZE SYMBOL — reclaim an inactive faction
- LAUNCH "name" — create a new faction

FACTIONS:
Rising (bonding curve): ${risingList}
Ascended (on DEX): ${ascendedList}
Nearby (your social graph): ${nearbyList}
All known: ${factionList}
Intel preview: ${intelSnippet}

YOU — "${agent.publicKey.slice(0, 8)}" — ${agent.personality}
${gameState.personalitySummary || personalityDesc[agent.personality]}
${memoryBlock}
━━━ YOUR PORTFOLIO ━━━
${holdingsList}
Portfolio: ${totalHoldingsValue.toFixed(4)} SOL | Realized P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL | Unrealized: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} SOL
${unrealizedPnl > 0.1 ? '⚡ You are UP. Consider taking profits on your biggest winners with DEFECT.' : unrealizedPnl < -0.05 ? '⚠ You are DOWN. Be conservative. Cut losers with DEFECT. Smaller positions.' : '📊 Near breakeven. Look for conviction plays.'}
${positionValues.length > 0 ? `Best position: ${positionValues.sort((a, b) => b.valueSol - a.valueSol)[0].label} (${positionValues.sort((a, b) => b.valueSol - a.valueSol)[0].valueSol.toFixed(4)} SOL)` : ''}
Sentiment: ${sentimentList}
Spend range: ${minSol}–${maxSol} SOL
${gameState.activeLoans.size > 0 ? `Active loans: ${[...gameState.activeLoans].map((m) => { const f = factions.find((ff) => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ')}` : ''}${gameState.founded.length > 0 ? `\nFounded: ${gameState.founded.map((m) => { const f = factions.find((ff) => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ')} — promote these aggressively` : ''}
Allies: ${allyList} | Rivals: ${rivalList}
${doNotRepeat}
VOICE: ${VOICE_TRAITS[agent.publicKey.charCodeAt(0) % VOICE_TRAITS.length]}
- First person only. Be specific — @address, real numbers, real moves. Never generic.
- Write something original every time. Talk TO agents, not about them.
- Your message should reflect YOUR portfolio. Winners talk different than losers.

STRATEGY:
- Limit yourself to ~5 major holdings. MESSAGE/FUD in others is fine, but keep your real positions focused.${positionValues.length > 5 ? ` You hold ${positionValues.length} — consider DEFECT from your weakest.` : ''}
- MESSAGE/FUD cost almost nothing but move sentiment — use them constantly.
- REINFORCE factions you hold and believe in. Don't JOIN the same symbol twice.
- DEFECT to lock in profits on winners or cut losses on dying factions. Don't hold losers.
- Your holdings ARE your identity. Promote what you hold. Attack what you don't.
- Reference your actual P&L and positions in messages. Agents who talk numbers are more convincing.${factions.length <= 2 ? '\n- Few factions active — consider LAUNCH.' : ''}

FORMAT: ACTION SYMBOL "message" (or ACTION SYMBOL if no message). One line only.

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
  const factions = factionCtx.all
  const holdingsEntries = [...(holdings ?? new Map()).entries()]

  // Sort holdings by SOL value descending
  const TOKEN_MULTIPLIER = 1_000_000
  const valued = holdingsEntries
    .map(([mint, bal]) => {
      const f = factions.find((ff) => ff.mint === mint)
      if (!f) return null
      return { symbol: f.symbol, valueSol: (bal / TOKEN_MULTIPLIER) * (f.price_sol ?? 0) }
    })
    .filter(Boolean)
    .sort((a, b) => b!.valueSol - a!.valueSol) as { symbol: string; valueSol: number }[]

  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9

  // Compact: max 10 symbols, top 5 held by value
  const s = factions.slice(0, 10).map((f) => f.symbol)
  const held = valued.slice(0, 5).map((v) => v.symbol)
  const lastActions = [...kit.state.history].slice(0, 3);

  // Actions conditional on whether agent holds anything
  const hasHoldings = held.length > 0
  const actions = hasHoldings
    ? [
        `JOIN ${s[0] || 'IRON'}`,
        `DEFECT ${held[0]}`,
        `REINFORCE ${held[0]}`,
        `MESSAGE ${held[0]} "${pick(['who else is holding?', 'not selling', 'just getting started', 'volume picking up', 'im not leaving'])}"`,
        `FUD ${held[0]} "${pick(['founders went quiet', 'weak hands', 'dead faction', 'volume dried up', 'overvalued'])}"`,
        `RALLY ${s[1] || s[0] || 'IRON'}`,
        `TITHE ${held[0]}`,
      ]
    : [
        `JOIN ${s[0] || 'IRON'}`,
        `MESSAGE ${s[0] || 'IRON'} "${pick(['who else is holding?', 'just getting started', 'volume picking up', 'im not leaving'])}"`,
        `RALLY ${s[0] || 'IRON'}`,
        `TITHE ${s[0] || 'IRON'}`,
        `ASCEND ${s[0] || 'IRON'}`,
      ]

  return `Pyre — faction warfare on Solana. Factions are rival guilds with war chests, members, and reputation. Every action grows the faction. Earlier actions contribute more. You make ONE decision per turn.
Lifecycle: LAUNCH → RISING → READY → ASCEND (to DEX)

You: "${agent.publicKey.slice(0, 8)}" — ${agent.personality}
Factions: ${s.join(', ')}
${hasHoldings ? `You hold: ${held.join(', ')}` : 'You hold nothing — JOIN a faction.'}${lastActions.length > 0 ? `\nLast: ${lastActions.join('; ')}` : ''}

${actions.join('\n')}

One line. Faction must be from the list.
Your action:`
}

/**
 * Resolve a symbol to a faction, disambiguating duplicates using agent context.
 */
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

  // Fetch holdings fresh from chain — log top 5 by value
  const holdings = await kit.state.getHoldings()
  const TOKEN_MUL = 1_000_000
  const holdingSummary = [...holdings.entries()]
    .map(([m, b]) => {
      const f = factions.find((ff) => ff.mint === m)
      const sym = f?.symbol ?? m.slice(0, 8)
      const val = f ? ((b / TOKEN_MUL) * (f.price_sol ?? 0)).toFixed(4) : '?'
      return { sym, val, valueSol: f ? (b / TOKEN_MUL) * (f.price_sol ?? 0) : 0 }
    })
    .sort((a, b) => b.valueSol - a.valueSol)
    .slice(0, 5)
    .map((h) => `${h.sym}:${h.val}`)
    .join(', ')
  log(`[${agent.publicKey.slice(0, 8)}] top holdings: ${holdingSummary || 'none'} (${holdings.size} total)`)

  // Fetch faction context: rising, ascended, nearby (parallel)
  // Compact mode: minimal fetches to keep context small for smol models
  const risingLimit = compact ? 3 : 5
  const ascendedLimit = compact ? 3 : 5
  const [risingResult, ascendedResult, nearbyResult] = await Promise.all([
    kit.intel.getRisingFactions(risingLimit).catch(() => ({ factions: [] })),
    kit.intel.getAscendedFactions(ascendedLimit).catch(() => ({ factions: [] })),
    compact
      ? Promise.resolve({ factions: [], allies: [] as string[] })
      : kit.intel.getNearbyFactions(agent.publicKey, { depth: 1, limit: 10 }).catch(() => ({
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

  // Deduplicate into a single faction list for symbol resolution
  const seenMints = new Set<string>()
  const allFactions: FactionInfo[] = []
  for (const f of [
    ...factions,
    ...risingResult.factions,
    ...ascendedResult.factions,
    ...nearbyResult.factions,
  ]) {
    if (!seenMints.has(f.mint)) {
      seenMints.add(f.mint)
      allFactions.push(f)
    }
  }

  const factionCtx: FactionContext = {
    rising: risingResult.factions as FactionInfo[],
    ascended: ascendedResult.factions as FactionInfo[],
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
