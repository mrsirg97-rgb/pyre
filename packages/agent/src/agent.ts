import type { PyreKit } from 'pyre-world-kit'
import { ACTION_MAP, PERSONALITY_SOL, personalityDesc, VOICE_NUDGES, VOICE_TRAITS } from './defaults'
import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision } from './types'
import { pick, randRange } from './util'
import { fetchFactionIntel } from './faction'

export interface LLMDecideOptions {
  compact?: boolean
}

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
  const holdingsEntries = [...(holdings?.entries() ?? [])]
  const heldMints = new Set(holdingsEntries.map(([m]) => m))
  const foundedSet = new Set(gameState.founded)
  const nearbyMints = new Set(factionCtx.nearby.map(f => f.mint))

  const TOKEN_MULTIPLIER = 1_000_000
  let totalHoldingsValue = 0
  const positionValues: { label: string; valueSol: number; mint: string }[] = []
  for (const [mint, bal] of holdingsEntries) {
    const f = factionCtx.all.find((ff) => ff.mint === mint)
    if (!f) continue
    const label = mint.slice(-8)
    const uiBalance = bal / TOKEN_MULTIPLIER
    const valueSol = uiBalance * (f.price_sol ?? 0)
    totalHoldingsValue += valueSol
    positionValues.push({ label, valueSol, mint })
  }
  positionValues.sort((a, b) => b.valueSol - a.valueSol)

  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
  const unrealizedPnl = totalHoldingsValue + pnl
  const netInvested = (gameState.totalSolSpent - gameState.totalSolReceived) / 1e9
  const totalTokens = holdingsEntries.reduce((sum, [, bal]) => sum + bal, 0)

  const statusTag = (f: FactionInfo): string => {
    if (f.status === 'ascended') return 'ASN'
    if (f.status === 'ready') return 'RD'
    return 'RS'
  }

  // Build flat faction table rows
  const factionRows: string[] = []
  const seenMints = new Set<string>()

  // MBR factions first
  for (const pv of positionValues) {
    const f = factionCtx.all.find(ff => ff.mint === pv.mint)
    if (!f) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(2)}` : '?'
    const fnr = foundedSet.has(f.mint)
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    const loan = gameState.activeLoans.has(f.mint)
    const bal = holdings?.get(f.mint) ?? 0
    let pnlStr = '?'
    if (totalTokens > 0 && netInvested > 0) {
      const estCost = netInvested * (bal / totalTokens)
      const posPnl = pv.valueSol - estCost
      pnlStr = `${posPnl >= 0 ? '+' : ''}${posPnl.toFixed(4)}`
    }
    factionRows.push(`${f.mint.slice(-8)} | ${mcap} | ${statusTag(f)} | true | ${fnr} | ${pv.valueSol.toFixed(4)} | ${pnlStr} | ${sent > 0 ? '+' : ''}${sent}${loan ? ' | LOAN' : ''}`)
  }

  // Non-member factions
  const nonMember = factionCtx.all.filter(f => !seenMints.has(f.mint) && f.status !== 'razed')
  const nearby = nonMember.filter(f => nearbyMints.has(f.mint)).slice(0, 10)
  const rest = nonMember.filter(f => !nearbyMints.has(f.mint))
  const rising = rest.filter(f => f.status === 'rising').slice(0, 5)
  const ascended = rest.filter(f => f.status === 'ascended').slice(0, 5)
  const ready = rest.filter(f => f.status === 'ready')
  const shown = new Set([...nearby, ...rising, ...ascended, ...ready].map(f => f.mint))
  const unexplored = rest.filter(f => !shown.has(f.mint)).sort(() => Math.random() - 0.5).slice(0, 3)

  for (const f of [...nearby, ...ascended, ...ready, ...rising, ...unexplored]) {
    if (seenMints.has(f.mint)) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(2)}` : '?'
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)} | ${mcap} | ${statusTag(f)} | false | false | 0 | 0 | ${sent > 0 ? '+' : ''}${Math.round(sent * 10) / 10}`)
  }

  const validatedFactions = [...ascended, ...ready, ...rising, ...nearby, ...unexplored]

  const doNotRepeat =
    recentMessages.length > 0
      ? `\nDO NOT REPEAT OR PARAPHRASE:\n${recentMessages.slice(0, 5).map((m) => `- "${m}"`).join('\n')}\n`
      : ''
  const memoryEntries = [...kit.state.history].slice(-20)
  const memoryBlock =
    memoryEntries.length > 0
      ? memoryEntries.slice(0, 7).map((m) => `- ${m}`).join('; ')
      : 'none'

  const mMint = [...heldMints][0] || (validatedFactions.length > 0 ? pick(validatedFactions).mint : null)
  const m = mMint ? mMint.slice(-8) : 'xxxxxxpw'
  const f1Mint = validatedFactions.length > 0 ? pick(validatedFactions) : null
  const f1 = f1Mint ? f1Mint.mint.slice(-8) : m
  const f2Mint = validatedFactions.length > 1 ? pick(validatedFactions.filter(f => f.mint !== f1Mint?.mint)) : f1Mint
  const f2 = f2Mint ? f2Mint.mint.slice(-8) : f1

  return `You are an autonomous agent playing in Pyre, a faction warfare game. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with full treasuries. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
FID: the faction identifier. 
STATUS: RS, RD, ASN
RS: rising. new faction, higher risk but early to the right one is higher reward. 0.5% tax, early = more contributed to treasury
RD: ready, community transition stage before ascend.
ASN: ascended factions, established. treasuries active. 0.04% war tax to the faction.
MBR: true = you are a member of the faction.
FNR: true = you founded it.
SENT: sentiment score. positive = bullish, negative = bearish.
AL/RVL: ally/rival agents, prefixed @AP.
LOAN - you have an active loan against this faction.
--- YOU ARE:
NAME: @AP${agent.publicKey.slice(0, 4)}
BIO: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
MEMORIES: ${memoryBlock}
P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL | VALUE: ${totalHoldingsValue.toFixed(4)} SOL | UNREALIZED: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} SOL
SPEND RANGE: ${minSol}–${maxSol} SOL
${unrealizedPnl > 0.1 ? 'YOU ARE UP — consider taking profits with (-) on winners.' : unrealizedPnl < -0.05 ? 'YOU ARE DOWN — be conservative. Cut losers with (-). Smaller positions.' : 'YOU BREAKEVEN — look for conviction plays.'}
--- INTEL:
AL: ${agent.allies.size > 0 ? [...agent.allies].slice(0, 5).map((a) => `@AP${a.slice(0, 4)}`).join(', ') : 'none'}
RVL: ${agent.rivals.size > 0 ? [...agent.rivals].slice(0, 5).map((a) => `@AP${a.slice(0, 4)}`).join(', ') : 'none'}
LATEST: ${intelSnippet}
--- FACTIONS:
FID | MCAP | STATUS | MBR | FNR | VALUE | PNL | SENT
${factionRows.length > 0 ? factionRows.join('\n') : 'none'}
--- ACTIONS:
(+) $ "*" - join a faction.
(-) $ "*" - leave or decrease position in a faction.
(!) $ "*" - sneak into a faction.
(&) $ "*" - fortify position in a faction.
(=) $ "*" - talk in faction comms.
(#) $ "*" - trash talk a faction.
(@) @address - look up an agent.
(^) $ - ascend a faction.
(.) $ - show support, one-time per faction.
(?) $ - borrow against holdings.
(<) $ - repay a loan.
(>) $ - liquidate a bad loan.
(~) $ - harvest fees into treasury.
(%) ";" - create a faction. ; = creative name in double quotes.
- REPLACE $ with a FID from the table (always ends in pw).
- REPLACE * with your message, always in double quotes.
--- VOICE:
- Your personality is your tone. First person only.
- Talk TO agents using @AP inside your "*" response, not about them.
- What you say MUST match the intent of your action.
- Under 80 chars, plain English, one sentence. No hashtags, no angle brackets.
- Back up claims with real numbers from P&L, VALUE, SENT. Never generic.${doNotRepeat}
--- STRATEGY:
- Factions with STATUS ASN are lower risk. RS factions have higher reward if you pick right.
- To (&), (-) or (#), the faction MBR MUST be true.
- To (^), STATUS must be RD. To (?), (>), (~), STATUS must be ASN.
- To (<), LOAN must exist on the faction.
- If FNR is true, you founded it. (+) if MBR is false, (&) if MBR is true, promote with (=).
- Limit factions where MBR is true to AT MOST 5.${positionValues.length > 5 ? ` MBR at ${positionValues.length} — CONSIDER (-) from underperformers.` : ''}
- (=)/(#) move sentiment. Use (=) to promote winners, (#) to fud losers.
- (-) to lock in profits or cut losers. Don't stay in underperformers.
- Coordinate with AL agents to push RS factions toward ASN.
- Your holdings ARE your identity. Promote what you hold. Attack what you don't.${factionCtx.all.length <= 2 ? '\n- Few factions active — consider (%).' : ''}
--- EXAMPLES:
(+) ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"
(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"
(&) ${m} "${pick(['doubling down.', 'conviction play.', 'added more.'])}"
(!) ${f2} "${pick(['just looking around.', 'checking the vibes.', 'scouting.', 'sneaking in, opportunity here.'])}"
(=) ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"
(#) ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"
(^) ${m}
(~) ${m}
---
Output EXACTLY one line: (action) $ "*"
example format: (+) ${f1} "looks good here."
your move>`
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
  const gameState = kit.state.state!
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]

  const holdingsEntries = [...(holdings?.entries() ?? [])]
  const TOKEN_MULTIPLIER = 1_000_000
  const valued = holdingsEntries
    .map(([mint, bal]) => {
      const f = factionCtx.all.find((ff) => ff.mint === mint)
      if (!f) return null
      return { id: mint.slice(-8), valueSol: (bal / TOKEN_MULTIPLIER) * (f.price_sol ?? 0) }
    })
    .filter(Boolean)
    .sort((a, b) => b!.valueSol - a!.valueSol) as { id: string; valueSol: number }[]

  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
  const totalHoldingsValue = valued.reduce((sum, v) => sum + v.valueSol, 0)
  const unrealizedPnl = totalHoldingsValue + pnl

  const founded = gameState.founded.slice(0, 2).map((m: string) => m.slice(-8))
  const heldMints = new Set(holdingsEntries.map(([m]) => m))
  const memberOf = valued.filter((v) => v.valueSol > 0.001).map((v) => v.id)

  const sentimentList =
    [...kit.state.sentimentMap]
      .filter(([mint]) => heldMints.has(mint))
      .map(([mint, score]) => {
        const f = factionCtx.all.find((ff) => ff.mint === mint)
        if (!f) return null
        const label = score > 3 ? 'bullish' : score < -3 ? 'bearish' : 'neutral'
        return `${f.mint.slice(-8)}:${label}`
      })
      .filter(Boolean)
      .join(', ') || 'none'

  const foundedSet = new Set(gameState.founded)
  const nearbyMints = new Set(factionCtx.nearby.map(f => f.mint))

  // Status tag for each faction
  const statusTag = (f: FactionInfo): string => {
    if (f.status === 'ascended') return 'ASN'
    if (f.status === 'ready') return 'RD'
    return 'RS'
  }

  // Discovery tag
  const discoveryTag = (f: FactionInfo): string => {
    if (nearbyMints.has(f.mint)) return 'NB'
    return 'UX'
  }

  // Build flat faction rows: FACTION (MCAP) STATUS MBR FNR [NB|UX]
  const factionRows: string[] = []
  const seenMints = new Set<string>()

  // MBR factions first (most important to the agent)
  for (const v of valued.slice(0, 5)) {
    const f = factionCtx.all.find(ff => ff.mint.slice(-8) === v.id)
    if (!f) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(2)}` : '?'
    const fnr = foundedSet.has(f.mint)
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)} | ${mcap} | ${statusTag(f)} | true | ${fnr} | ${v.valueSol.toFixed(4)} | ${sent > 0 ? '+' : ''}${Math.round(sent * 10) / 10}`)
  }

  // Non-member factions
  const nonMember = factionCtx.all.filter(f => !seenMints.has(f.mint) && f.status !== 'razed')
  const nearby = nonMember.filter(f => nearbyMints.has(f.mint)).slice(0, 2)
  const rest = nonMember.filter(f => !nearbyMints.has(f.mint))
  const rising = rest.filter(f => f.status === 'rising').slice(0, 2)
  const ascended = rest.filter(f => f.status === 'ascended').slice(0, 2)
  const ready = rest.filter(f => f.status === 'ready').slice(0, 2)
  const shown = new Set([...nearby, ...rising, ...ascended, ...ready].map(f => f.mint))
  const unexplored = rest.filter(f => !shown.has(f.mint)).sort(() => Math.random() - 0.5).slice(0, 3)

  for (const f of [...nearby, ...ascended, ...ready, ...rising, ...unexplored]) {
    if (seenMints.has(f.mint)) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(2)}` : '?'
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)} | ${mcap} | ${statusTag(f)} | false | false | 0 | ${sent > 0 ? '+' : ''}${Math.round(sent * 10) / 10}`)
  }

  const validatedFactions = [...ascended, ...ready, ...rising, ...nearby, ...unexplored]
  
  const mMint2 = [...heldMints][0] || (validatedFactions.length > 0 ? pick(validatedFactions).mint : null)
  const m = mMint2 ? mMint2.slice(-8) : 'xxxxxxpw'
  const f1v = validatedFactions.length > 0 ? pick(validatedFactions) : null
  const f1 = f1v ? f1v.mint.slice(-8) : m
  const f2v = validatedFactions.length > 1 ? pick(validatedFactions.filter(f => f.mint !== f1v?.mint)) : f1v
  const f2 = f2v ? f2v.mint.slice(-8) : f1

  return `You are an autonomous agent playing in Pyre, a faction warfare game. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with full treasuries. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
FID: the faction identifier. 
STATUS: RS, RD, ASN
RS: rising. new faction, higher risk but early to the right one is higher reward. 0.5% tax, early = more contributed to treasury
RD: ready, community transition stage before ascend.
ASN: ascended factions, established. treasuries active. 0.04% war tax to the faction.
MBR: true = you are a member of the faction.
FNR: true = you founded it.
SENT: sentiment score. positive = bullish, negative = bearish.
AL/RVL: ally/rival agents, prefixed @AP.
--- YOU ARE:
NAME: @AP${agent.publicKey.slice(0, 4)}
BIO: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
LAST MOVES: ${kit.state.history.length > 0 ? [...kit.state.history].slice(-2).join('; ') : 'none'}
P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL
${unrealizedPnl > 0.1 ? 'YOU ARE UP. Consider (-) to take profits on winners.' : unrealizedPnl < -0.05 ? 'YOU ARE DOWN. Be conservative. (-) losers. Smaller positions.' : 'BREAKEVEN. Look for conviction plays.'}
--- INTEL:
AL: ${agent.allies.size > 0 ? [...agent.allies].slice(0, 2).map(a => `@AP${a.slice(0, 4)}`).join(', ') : 'none'}
RVL: ${agent.rivals.size > 0 ? [...agent.rivals].slice(0, 2).map(a => `@AP${a.slice(0, 4)}`).join(', ') : 'none'}
LATEST: ${intelSnippet}
--- FACTIONS:
FID | MCAP | STATUS | MBR | FNR | VALUE | SENT
${factionRows.length > 0 ? factionRows.join('\n') : 'none'}
--- ACTIONS:
(+) $ "*" - join a faction.
(-) $ "*" - leave or decrease position in a faction.
(!) $ "*" - sneak into a faction.
(&) $ "*" - fortify position in a faction.
(=) $ "*" - talk in faction comms.
(#) $ "*" - trash talk a faction.
(^) $ - ascend a faction.
(~) $ - harvest fees into treasury.
(%) ";" - create a new faction.
- REPLACE $ with exactly ONE choice from FACTIONS using the FID column (always contains the pw suffix).
- REPLACE * with a ONE sentence RESPONSE for your ACTION, always in double quotes.
- REPLACE ; with a unique faction inspired name (eg. "Glitch Cult", "Whale Syndicate"), always in double quotes. only for (%).
--- STRATEGY:
- Your personality is your tone.
- $ is ALWAYS a faction FID (ends in pw), NEVER an @AP agent. To talk to agents, put @AP inside your "*" response.
- In your RESPONSE, you can mention other agents from AL, RVL, and LATEST (format is @AP + 4 chars, e.g. @AP${Math.random().toString(36).slice(2, 6)}), if NOT none.
- Factions with STATUS ASN are lower risk and established, but RS factions may have higher reward if you pick the right one.
- To (&), (-) or (#), the faction MBR MUST be true.
- To (^) a faction, STATUS must be RD.
- no factions? Use (%) to create one. Anyone can (%).
- If FNR is true on a faction, you founded it. (+) if MBR is false, (&) if MBR is true and promote them with (=).
- Limit factions where MBR is true to AT MOST 5 factions.${memberOf.length > 3 ? ` MBR at ${memberOf.length} factions — CONSIDER (-) from underperformers.` : ''}
- Promote factions you are in. Attack your rival factions.
- (=)/(#) move sentiment and help coordinate with other agents — use (=) to promote your winners and (#) to fud your losers.
- (-) to lock in profits or downsize on underperforming factions. 
--- EXAMPLES:
(+) ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"
(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"
(&) ${m} "${pick(['doubling down.', 'conviction play.', 'added more.'])}"
(!) ${f2} "${pick(['just looking around.', 'checking the vibes.', 'scouting.', 'sneaking in, opportunity here.'])}"
(=) ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"
(#) ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"
---
Output EXACTLY one line: (action) $ "*"
example format: (+) ${f1} "looks good here."
your move>`
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
  target: string | undefined,
  factions: FactionInfo[],
  holdings: Map<string, number>,
  kit: PyreKit,
  action: string,
): FactionInfo | undefined {
  const gameState = kit.state.state!
  if (!target) return undefined
  const targetLower = target.toLowerCase()

  // Try mint suffix match first (last-8 chars ending in pw)
  const mintMatch = factions.find((f) => f.mint.toLowerCase().endsWith(targetLower))
  if (mintMatch) return mintMatch

  // Fall back to symbol match
  const matches = factions.filter((f) => f.symbol.toLowerCase() === targetLower)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]

  const held = matches.filter((f) => holdings.has(f.mint))
  const notHeld = matches.filter((f) => !holdings.has(f.mint))

  if (
    action === 'defect' ||
    action === 'fud' ||
    action === 'rally' ||
    action === 'message' ||
    action === 'reinforce' ||
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

    // Strip YOUR MOVE: prefix before symbol detection
    const stripped = line.trim().replace(/^(?:YOUR MOVE|YOUR MOVE:|your move>?)\s*:?\s*/i, '')
    // Compact symbol actions like (+), (-), (#) — skip aggressive cleaning that would mangle them
    const symbolActionMatch = stripped.match(/^(\([+\-!&#^~=%]\))\s+(.*)/) || stripped.match(/^([+\-!&#^~=%])\s+(.*)/)
    const cleaned = symbolActionMatch
      ? symbolActionMatch[1] + ' ' + symbolActionMatch[2]
      : line
      .replace(/\*+/g, '')
      .replace(/^[-•>#\d.)\s]+/, '')
      .replace(/^(?:WARNING|NOTE|RESPONSE|OUTPUT|ANSWER|RESULT|SCPRT|SCRIPT|YOUR MOVE|YOUR MOVE:|your move>?)\s*:?\s*/i, '')
      .replace(/^ACTION\s+/i, '')
      .replace(
        /^I\s+(?=JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|FUD|REINFORCE|INFILTRATE|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|SCOUT)/i,
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
      /^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|REINFORCE|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|INFILTRATE|FUD)\s*(?:"([^"]+)"|(\S+))?(?:\s+"([^"]*)")?/i,
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
  if (action === 'reinforce' && !faction)
    return { _rejected: `reinforce rejected: unknown faction "${sym}"` } as any
  if (action === 'reinforce' && faction && !holdings.has(faction.mint))
    return { _rejected: `reinforce rejected: no holdings in ${sym}` } as any
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
  if (compact) {
    // Compact: one-line intel — latest comms from a held faction
    try {
      const heldMints = [...holdings.keys()]
      const heldFaction = allFactions.find((f) => heldMints.includes(f.mint))
      if (heldFaction) {
        const intel = await fetchFactionIntel(kit, heldFaction)
        const latest = intel.recentComms.find((c) => c.sender !== agent.publicKey)
        if (latest) {
          intelSnippet = `@AP${latest.sender.slice(0, 4)} in ${intel.symbol}: "${latest.memo.replace(/^<+/, '').replace(/>+\s*$/, '').slice(0, 60)}"`
        }
      }
    } catch {}
  } else {
    try {
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
  }

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
