import type { PyreKit } from 'pyre-world-kit'
import { ACTION_MAP, PERSONALITY_SOL, personalityDesc, VOICE_NUDGES, VOICE_TRAITS } from './defaults'
import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision } from './types'
import { pick, randRange } from './util'
import { fetchFactionIntel } from './faction'

export interface LLMDecideOptions {
  compact?: boolean
  min?: boolean
  onPromptTable?: (header: string, rows: string[]) => void
}

export const pendingScoutResults = new Map<string, string[]>()

export interface FactionContext {
  rising: FactionInfo[]
  ascended: FactionInfo[]
  nearby: FactionInfo[]
  all: FactionInfo[] // deduplicated union for symbol resolution
}

export const buildAgentPrompt = async (
  kit: PyreKit,
  agent: AgentState,
  factionCtx: FactionContext,
  solRange?: [number, number],
  holdings?: Map<string, number>,
): Promise<string> => {
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
  positionValues.sort((a, b) => {
    const aFnr = foundedSet.has(a.mint) ? 1 : 0
    const bFnr = foundedSet.has(b.mint) ? 1 : 0
    if (aFnr !== bFnr) return bFnr - aFnr // founded first
    return b.valueSol - a.valueSol // then by value
  })

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

  // MBR factions first (cap at 10)
  for (const pv of positionValues.slice(0, 10)) {
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
    factionRows.push(`${f.mint.slice(-8)},${mcap},${statusTag(f)},true,${fnr},${pv.valueSol.toFixed(4)},${pnlStr},${sent > 0 ? '+' : ''}${sent},${loan}`)
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

  let nonMemberCount = 0
  for (const f of [...nearby, ...ascended, ...ready, ...rising, ...unexplored]) {
    if (nonMemberCount >= 10) break
    if (seenMints.has(f.mint)) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(2)}` : '?'
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)},${mcap},${statusTag(f)},false,false,0,0,${sent > 0 ? '+' : ''}${Math.round(sent * 10) / 10},false`)
    nonMemberCount++
  }

  // Fetch intel from table factions only — no off-screen FIDs
  let intelSnippet = ''
  try {
    const tableMemberMints = [...seenMints].filter(mint => heldMints.has(mint)).slice(0, 2)
    const tableNonMemberMints = [...seenMints].filter(mint => !heldMints.has(mint))
    const toScout = [
      ...tableMemberMints.map(mint => factionCtx.all.find((f: FactionInfo) => f.mint === mint)!).filter(Boolean),
      ...(tableNonMemberMints.length > 0 ? [factionCtx.all.find((f: FactionInfo) => f.mint === pick(tableNonMemberMints))].filter(Boolean) : []),
    ] as FactionInfo[]
    if (toScout.length > 0) {
      const intels = await Promise.all(toScout.slice(0, 6).map(f => fetchFactionIntel(kit, f)))
      const lines = intels.map((intel, i) => {
        const fid = toScout[i].mint.slice(-8)
        const memberInfo = intel.totalMembers > 0
          ? `${intel.totalMembers} members, top holder: ${intel.members[0]?.percentage.toFixed(1)}%`
          : 'no members'
        const commsInfo = intel.recentComms.length > 0
          ? intel.recentComms.slice(0, 3).map(c => `@AP${c.sender.slice(0, 4)} said: "${c.memo.replace(/^<+/, '').replace(/>+\s*$/, '')}"`).join(', ')
          : 'no recent comms'
        return `  [${fid}] ${memberInfo} | recent comms: ${commsInfo}`
      })
      intelSnippet = 'FACTION INTEL:\n' + lines.join('\n')
    }
  } catch {}

  // Include results from previous SCOUT actions
  const scoutResults = pendingScoutResults.get(agent.publicKey)
  if (scoutResults && scoutResults.length > 0) {
    intelSnippet += '\nSCOUT RESULTS (from your previous SCOUT actions):\n' + scoutResults.join('\n')
    pendingScoutResults.delete(agent.publicKey)
  }

  const memoryEntries = [...kit.state.history].slice(-20)
  const memoryBlock =
    memoryEntries.length > 0
      ? memoryEntries.slice(0, 4).map((m) => `- ${m}`).join('; ')
      : 'none'

  // Pick example FIDs only from factions actually shown in the table
  const tableFids = factionRows.slice(0, 15).map(r => r.split(',')[0])
  const m = tableFids.find(fid => heldMints.has([...seenMints].find(mint => mint.endsWith(fid)) ?? '')) ?? tableFids[0] ?? 'xxxxxxpw'
  const nonMemberFids = tableFids.filter(fid => fid !== m)
  const f1 = nonMemberFids.length > 0 ? pick(nonMemberFids) : m
  const f2 = nonMemberFids.length > 1 ? pick(nonMemberFids.filter(fid => fid !== f1)) : f1

  return `You are an autonomous agent playing in Pyre, a faction warfare game. You form your own alliances, opinions, and grudges. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with full treasuries. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
HLTH: your overall profit and loss. your health.
FID: the faction identifier.
STATUS: RS (99 to 1300 SOL MCAP), RD (1300 MCAP), ASN (1300 MCAP and higher).
RS: rising. new faction. the lower the MCAP, the more you contribute to the treasury.
RD: ready, community transition stage before ascend.
ASN: ascended factions, established, more members. treasuries active. 0.04% war tax to the faction.
MBR: true = you are a member. false = you are not a member.
FNR: true = you founded it. false = you did not found it.
PNL: per-position profit. positive = winning, negative = losing.
SENT: sentiment score. positive = bullish, negative = bearish.
LOAN: true = you have an active loan against this faction.
--- YOU ARE:
NAME: @AP${agent.publicKey.slice(0, 4)}
BIO: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
MEMORIES: ${memoryBlock}
HLTH: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL | VALUE: ${totalHoldingsValue.toFixed(4)} SOL | UNREALIZED: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} SOL
${unrealizedPnl > 1 ? 'YOU ARE UP — consider taking profits.' : unrealizedPnl < -1 ? 'YOU ARE DOWN — be conservative. consider downsizing.' : 'YOU BREAKEVEN — look for conviction plays.'}
--- INTEL:
ALLIES: ${agent.allies.size > 0 ? [...agent.allies].slice(0, 5).map((a) => `@AP${a.slice(0, 4)}`).join(', ') : 'none'}
RIVALS: ${agent.rivals.size > 0 ? [...agent.rivals].slice(0, 5).map((a) => `@AP${a.slice(0, 4)}`).join(', ') : 'none'}
LATEST: ${intelSnippet}
--- FACTIONS:
FID,MCAP,STATUS,MBR,FNR,VALUE,PNL,SENT,LOAN
${factionRows.length > 0 ? factionRows.slice(0, 15).join('\n') : 'none'}
--- ACTIONS:
FORMAT: (action) $ "*"
REPLACE $ with EXACTLY one FID from FACTIONS ONLY (always ends in pw).
REPLACE * with a ONE sentence RESPONSE, always in double quotes.
(+) $ "*" - join.
(-) $ "*" - leave or reduce position.
(/) $ "*" - infiltrate, sneak in.
(&) $ "*" - reinforce. increase position. bullish.
(!) $ "*" - talk in comms.
(#) $ "*" - trash talk.
(^) $ - ascend. unlock treasury.
(~) $ - harvest fees.
(?) $ - borrow against position.
(>) $ - liquidate bad loan.
(<) $ - repay loan.
(.) $ - show support.
(%) "..." - create new faction. "..." = creative name, in quotes.
(_) - skip turn.
--- RULES:
(+), (&) and (/) increase MCAP. (-) decreases MCAP.
(!) and (#) are your voice. (!) increases SENT. (#) decreases SENT.
(+) or (/) FACTIONS where MBR=false.
(-), (&) or (#) FACTIONS where MBR=true.
(^) FACTIONS where STATUS=RD.
(~) FACTIONS where STATUS=ASN.
(?) or (>) FACTIONS where STATUS=ASN and MBR=true.
(<) FACTIONS where LOAN=true.
(!) or (.) any FACTIONS.
--- VOICE:
- your personality is your tone. first person only. do not reference your NAME in third person.
- talk TO or ABOUT agents from ALLIES, RIVALS, and LATEST, referencing the agent with @AP, inside RESPONSE.
- do NOT copy what other agents are saying in LATEST. be unique. do not sound like everyone else.
- what you say MUST match the intent of your action.
- under 80 chars, plain English, one sentence. no hashtags, no angle brackets.
- when called out or boasting, back up claims with real numbers from HLTH, VALUE, SENT. never generic.
- do NOT just talk numbers. build your faction community and culture. form collective identities.
--- STRATEGIES:
- learn about FACTIONS and other agents in LATEST. HLTH is your performance. PNL and SENT are per-faction direction. use all three to decide.
- limit FACTIONS where MBR=true to AT MOST 5.${positionValues.length > 3 ? ` MBR at ${positionValues.length} — consider (-) from underperformers.` : ''}
- if MBR=false and FNR=true, consider (+). this is your faction, promote it with (!).
- FACTIONS where MBR=true and SENT is positive ARE your identity. promote what you hold.${factionCtx.all.length <= 2 ? '\n- no FACTIONS? (%) to create one.' : ''}
- FACTIONS where STATUS=RS and MBR=false and lower MCAP could turn more profit if you (+) the right one.
- (!) and (#) help you coordinate and talk with other agents.
- in FACTIONS where MBR=true, if MCAP increases, your PNL will increase.
- (&) and (!) strengthen FACTIONS where MBR=true and STATUS=RS and push towards STATUS=ASN.
- (/) to join a faction with intentions of (-) later. (/) when you are profit seeking or want to harm a rival faction.
- consider (-) to lock in profits on FACTIONS where MBR=true and PNL is positive.
- consider (-) FACTIONS where MBR=true and PNL is negative unless FNR=true or SENT is positive.
- when HLTH is negative, prefer (_) or (-) weakest FACTIONS where MBR=true. (+) or (&) ONLY if you see opportunity.
- (_) if you would prefer to hold and wait to take action.
---
one move per turn. output EXACTLY one line.
example format: ${pick([
  `(+) ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"`,
  `(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.', 'cutting the drag.'])}"`,
  `(&) ${m} "${pick(['doubling down.', 'conviction play.', 'added more.', 'fortifying my position.'])}"`,
  `(/) ${f2} "${pick(['just looking around.', 'checking the vibes.', 'scouting.', 'sneaking in, opportunity here.'])}"`,
  `(!) ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"`,
  `(#) ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"`,
])}
>`
}

export const buildCompactModelPrompt = async (
  kit: PyreKit,
  agent: AgentState,
  factionCtx: FactionContext,
  solRange?: [number, number],
  holdings?: Map<string, number>,
): Promise<string> => {
  const gameState = kit.state.state!
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]

  const holdingsEntries = [...(holdings?.entries() ?? [])]
  const TOKEN_MULTIPLIER = 1_000_000
  const valued = holdingsEntries
    .map(([mint, bal]) => {
      const f = factionCtx.all.find((ff) => ff.mint === mint)
      if (!f) return null
      return { id: mint.slice(-8), mint, valueSol: (bal / TOKEN_MULTIPLIER) * (f.price_sol ?? 0), bal }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aFnr = gameState.founded.includes(a!.mint) ? 1 : 0
      const bFnr = gameState.founded.includes(b!.mint) ? 1 : 0
      if (aFnr !== bFnr) return bFnr - aFnr // founded first
      return b!.valueSol - a!.valueSol // then by value
    }) as { id: string; mint: string; valueSol: number; bal: number }[]

  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
  const totalHoldingsValue = valued.reduce((sum, v) => sum + v.valueSol, 0)
  const unrealizedPnl = totalHoldingsValue + pnl
  const netInvested = (gameState.totalSolSpent - gameState.totalSolReceived) / 1e9
  const totalTokens = holdingsEntries.reduce((sum, [, bal]) => sum + bal, 0)

  const founded = gameState.founded.slice(0, 2).map((m: string) => m.slice(-8))
  const heldMints = new Set(holdingsEntries.map(([m]) => m))
  const memberOf = valued.filter((v) => v.valueSol > 0.001).map((v) => v.id)

  const foundedSet = new Set(gameState.founded)
  const nearbyMints = new Set(factionCtx.nearby.map(f => f.mint))

  // Status tag for each faction
  const statusTag = (f: FactionInfo): string => {
    if (f.status === 'ascended') return 'ASN'
    if (f.status === 'ready') return 'RD'
    return 'RS'
  }

  // Sentiment label
  const sentLabel = (s: number): string => `${s >= 0 ? '+' : ''}${s.toFixed(1)}`
  // Per-position PnL (numeric, 2 decimal places)
  const pnlValue = (valueSol: number, bal: number): string => {
    if (totalTokens <= 0 || netInvested <= 0) return '0'
    const estCost = netInvested * (bal / totalTokens)
    const posPnl = valueSol - estCost
    return `${posPnl >= 0 ? '+' : ''}${posPnl.toFixed(2)}`
  }

  // Build flat faction rows: FACTION (MCAP) STATUS MBR FNR [NB|UX]
  const factionRows: string[] = []
  const seenMints = new Set<string>()

  // MBR factions first (most important to the agent)
  for (const v of valued.slice(0, 5)) {
    const f = factionCtx.all.find(ff => ff.mint.slice(-8) === v.id)
    if (!f) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(1)}` : '?'
    const fnr = foundedSet.has(f.mint)
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)},${mcap},${statusTag(f)},true,${fnr},${Math.max(v.valueSol, 0.005).toFixed(2)},${pnlValue(v.valueSol, v.bal)},${sentLabel(sent)}`)
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
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(1)}` : '?'
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)},${mcap},${statusTag(f)},false,false,0,0,${sentLabel(sent)}`)
  }

  // Slice to 8 rows for compact prompt (5 held max + 3 new min)
  const compactRows = factionRows.slice(0, 8)
  const compactMints = new Set(compactRows.map(r => {
    const fid = r.split(',')[0]
    return [...seenMints].find(mint => mint.endsWith(fid)) ?? fid
  }))

  // Fetch intel from compact table factions only — no off-screen FIDs
  let intelSnippet = ''
  try {
    const tableMemberMints = [...compactMints].filter(mint => heldMints.has(mint))
    const lines: string[] = []
    for (const mint of tableMemberMints.slice(0, 2)) {
      const f = factionCtx.all.find(ff => ff.mint === mint)
      if (!f) continue
      const intel = await fetchFactionIntel(kit, f)
      const latest = intel.recentComms.find((c) => c.sender !== agent.publicKey)
      if (latest) {
        lines.push(`@AP${latest.sender.slice(0, 4)} in ${mint.slice(-8)}: "${latest.memo.replace(/^<+/, '').replace(/>+\s*$/, '').slice(0, 60)}"`)
      }
    }
    intelSnippet = lines.join('\n')
  } catch {}

  // Pick example FIDs only from factions actually shown in the table
  const tableFids = compactRows.map(r => r.split(',')[0])
  const m = tableFids.find(fid => heldMints.has([...compactMints].find(mint => mint.endsWith(fid)) ?? '')) ?? tableFids[0] ?? 'xxxxxxpw'
  const nonMemberFids = tableFids.filter(fid => fid !== m)
  const f1 = nonMemberFids.length > 0 ? pick(nonMemberFids) : m
  const f2 = nonMemberFids.length > 1 ? pick(nonMemberFids.filter(fid => fid !== f1)) : f1

  return `Welcome to Pyre, a faction warfare game. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with treasuries. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
HLTH: your overall profit and loss. your health.
FID: the faction identifier.
STATUS: RS (99 to 1300 SOL MCAP), RD (1300 MCAP), ASN (1300 MCAP and higher).
RS: rising. new faction. the lower the MCAP, the more you contribute to the treasury.
RD: ready, community transition stage before ascend.
ASN: ascended factions, established, more members. treasuries active.
MBR: true = you are a member. false = you are not a member.
FNR: true = you created it. false = you did not create it.
PNL: per-position profit. positive = winning, negative = losing.
SENT: sentiment score. positive = bullish, negative = bearish.
--- YOU ARE:
NAME: @AP${agent.publicKey.slice(0, 4)}
BIO: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
HLTH: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} SOL
${unrealizedPnl > 1 ? 'YOU ARE UP. consider taking profits.' : unrealizedPnl < -0.5 ? 'YOU ARE DOWN. be conservative. consider downsizing.' : 'BREAKEVEN. look for conviction plays.'}
--- INTEL:
${intelSnippet}
--- FACTIONS:
FID,MCAP,STATUS,MBR,FNR,VALUE,PNL,SENT
${compactRows.length > 0 ? compactRows.join('\n') : 'none'}
--- ACTIONS:
FORMAT: (action) $ "*"
REPLACE $ with EXACTLY one FID from FACTIONS ONLY (always ends in pw).
REPLACE * with a ONE sentence RESPONSE, always in double quotes.
(+) $ "*" - join or increase.
(-) $ "*" - leave or reduce.
(!) $ "*" - talk in comms. your voice.
(#) $ "*" - trash talk.
(^) $ - ascend. unlock treasury.
(~) $ - harvest fees.
(%) "&" - create new faction. & = creative name, in quotes.
(_) - skip turn.
--- RULES:
(+) increases MCAP. (-) decreases MCAP.
(!) increases SENT. (#) decreases SENT.
(^) FACTIONS where STATUS=RD.
(~) FACTIONS where STATUS=ASN.
(-) or (#) FACTIONS where MBR=true.
(+) or (!) any FACTIONS.
--- STRATEGIES:
- your personality is your tone.
- no FACTIONS? (%) to create one.
- learn about FACTIONS and other agents in INTEL. HLTH is performance. PNL and SENT are per-faction direction. use all three to decide.
- limit FACTIONS where MBR=true to AT MOST 5.${memberOf.length > 3 ? ` MBR=true on ${memberOf.length} FACTIONS — consider (-) from underperformers.` : ''}
- consider (+) FACTIONS where FNR=true. (!) to promote it.
- FACTIONS where STATUS=RS may have higher reward if you (+) the right one.
- in FACTIONS where MBR=true, if MCAP increases, your PNL will increase.
- (+) and (!) strengthen FACTIONS where STATUS=RS and push towards STATUS=ASN.
- consider (-) FACTIONS where MBR=true and PNL is positive to lock in profits.
- consider (-) FACTIONS where MBR=true and PNL is negative unless FNR=true or SENT is positive.
- when HLTH is negative, consider (_) or (-) weakest FACTIONS where MBR=true. (+) ONLY if you see opportunity.
- (_) if you would prefer to hold and wait to take action.
---
one move per turn. output EXACTLY one line.
example format: ${pick([
  `(+) ${f1} "${pick(['conviction play.', 'count me in.', 'early is everything.', 'strongest faction here.'])}"`,
  `(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"`,
  `(!) ${m} "${pick(['any strategies?', 'not leaving.', 'just getting started.'])}"`,
  `(#) ${m} "${pick(['dead faction.', 'overvalued.', 'full of larps.'])}"`,
  `(!) ${m} "${pick(['who else is here?', 'love the energy.', 'lets go!'])}"`,
  `(#) ${m} "${pick(['faction went quiet.', 'underperforming.'])}"`,
])}
>`
}

export const buildMinimumPrompt = async (
  kit: PyreKit,
  agent: AgentState,
  factionCtx: FactionContext,
  solRange?: [number, number],
  holdings?: Map<string, number>,
): Promise<string> => {
  const gameState = kit.state.state!
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]

  const holdingsEntries = [...(holdings?.entries() ?? [])]
  const TOKEN_MULTIPLIER = 1_000_000
  const valued = holdingsEntries
    .map(([mint, bal]) => {
      const f = factionCtx.all.find((ff) => ff.mint === mint)
      if (!f) return null
      return { id: mint.slice(-8), mint, valueSol: (bal / TOKEN_MULTIPLIER) * (f.price_sol ?? 0), bal }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aFnr = gameState.founded.includes(a!.mint) ? 1 : 0
      const bFnr = gameState.founded.includes(b!.mint) ? 1 : 0
      if (aFnr !== bFnr) return bFnr - aFnr // founded first
      return b!.valueSol - a!.valueSol // then by value
    }) as { id: string; mint: string; valueSol: number; bal: number }[]

  const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
  const totalHoldingsValue = valued.reduce((sum, v) => sum + v.valueSol, 0)
  const unrealizedPnl = totalHoldingsValue + pnl
  const netInvested = (gameState.totalSolSpent - gameState.totalSolReceived) / 1e9
  const totalTokens = holdingsEntries.reduce((sum, [, bal]) => sum + bal, 0)

  const founded = gameState.founded.slice(0, 2).map((m: string) => m.slice(-8))
  const heldMints = new Set(holdingsEntries.map(([m]) => m))
  const memberOf = valued.filter((v) => v.valueSol > 0.001).map((v) => v.id)

  const foundedSet = new Set(gameState.founded)
  const nearbyMints = new Set(factionCtx.nearby.map(f => f.mint))

  // Status tag for each faction
  const statusTag = (f: FactionInfo): string => {
    if (f.status === 'ascended') return 'ASN'
    if (f.status === 'ready') return 'RD'
    return 'RS'
  }

  // Sentiment label
  const sentLabel = (s: number): string => `${s >= 0 ? '+' : ''}${s.toFixed(1)}`
  // Per-position PnL (numeric, 2 decimal places)
  const pnlValue = (valueSol: number, bal: number): string => {
    if (totalTokens <= 0 || netInvested <= 0) return '0'
    const estCost = netInvested * (bal / totalTokens)
    const posPnl = valueSol - estCost
    return `${posPnl >= 0 ? '+' : ''}${posPnl.toFixed(2)}`
  }

  // Build flat faction rows: FACTION (MCAP) STATUS MBR FNR [NB|UX]
  const factionRows: string[] = []
  const seenMints = new Set<string>()

  // MBR factions first (most important to the agent)
  for (const v of valued.slice(0, 3)) {
    const f = factionCtx.all.find(ff => ff.mint.slice(-8) === v.id)
    if (!f) continue
    seenMints.add(f.mint)
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(1)}` : '?'
    const fnr = foundedSet.has(f.mint)
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)},${mcap},${statusTag(f)},true,${fnr},${Math.max(v.valueSol, 0.005).toFixed(2)},${pnlValue(v.valueSol, v.bal)},${sentLabel(sent)}`)
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
    const mcap = f.market_cap_sol ? `${f.market_cap_sol.toFixed(1)}` : '?'
    const sent = kit.state.sentimentMap.get(f.mint) ?? 0
    factionRows.push(`${f.mint.slice(-8)},${mcap},${statusTag(f)},false,false,0,0,${sentLabel(sent)}`)
  }

  // Slice to 4 rows for min prompt (3 held max + 1 new)
  const minRows = factionRows.slice(0, 4)
  const minMints = new Set(minRows.map(r => {
    const fid = r.split(',')[0]
    return [...seenMints].find(mint => mint.endsWith(fid)) ?? fid
  }))

  // Fetch intel from min table factions only — no off-screen FIDs
  let intelSnippet = ''
  try {
    const tableMemberMints = [...minMints].filter(mint => heldMints.has(mint))
    const lines: string[] = []
    for (const mint of tableMemberMints.slice(0, 1)) {
      const f = factionCtx.all.find(ff => ff.mint === mint)
      if (!f) continue
      const intel = await fetchFactionIntel(kit, f)
      const latest = intel.recentComms.find((c) => c.sender !== agent.publicKey)
      if (latest) {
        lines.push(`@AP${latest.sender.slice(0, 4)} in ${mint.slice(-8)}: "${latest.memo.replace(/^<+/, '').replace(/>+\s*$/, '').slice(0, 60)}"`)
      }
    }
    intelSnippet = lines.join('\n')
  } catch {}

  // Pick example FIDs only from factions actually shown in the table
  const tableFids = minRows.map(r => r.split(',')[0])
  const m = tableFids.find(fid => heldMints.has([...minMints].find(mint => mint.endsWith(fid)) ?? '')) ?? tableFids[0] ?? 'xxxxxxpw'
  const nonMemberFids = tableFids.filter(fid => fid !== m)
  const f1 = nonMemberFids.length > 0 ? pick(nonMemberFids) : m

  return `Welcome to Pyre, a faction warfare game. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
HLTH: your overall profit and loss. your health.
FID: the faction identifier.
STATUS: RS (99 to 1300 SOL MCAP), RD (1300 MCAP), ASN (1300 MCAP and higher).
RS: rising. new faction. the lower the MCAP, the more you contribute to the treasury.
RD: ready, community transition stage before ascend.
ASN: ascended factions, established, more members. treasuries active.
MBR: true = you are a member. false = you are not a member.
FNR: true = you created it. false = you did not create it.
PNL: per-position profit. positive = winning, negative = losing.
SENT: sentiment score. positive = bullish, negative = bearish.
--- YOU ARE:
NAME: @AP${agent.publicKey.slice(0, 4)}
BIO: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
HLTH: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)} SOL
${unrealizedPnl > 1 ? 'YOU ARE UP. consider taking profits.' : unrealizedPnl < -0.5 ? 'YOU ARE DOWN. be conservative. consider downsizing.' : 'BREAKEVEN. look for conviction plays.'}
--- INTEL:
${intelSnippet}
--- FACTIONS:
FID,MCAP,STATUS,MBR,FNR,VALUE,PNL,SENT
${minRows.length > 0 ? minRows.join('\n') : 'none'}
--- ACTIONS:
FORMAT: (action) $ "*"
REPLACE $ with EXACTLY one FID from FACTIONS ONLY (always ends in pw).
REPLACE * with a ONE sentence RESPONSE, always in double quotes.
(+) $ "*" - join or increase.
(-) $ "*" - leave or reduce.
(!) $ "*" - talk in comms. your voice.
(#) $ "*" - trash talk.
(^) $ - ascend. unlock treasury.
(~) $ - harvest fees.
(%) "&" - create new faction. & = creative name, in quotes.
(_) - skip turn.
--- RULES:
(+) increases MCAP. (-) decreases MCAP.
(!) increases SENT. (#) decreases SENT.
(^) FACTIONS where STATUS=RD.
(~) FACTIONS where STATUS=ASN.
(-) or (#) FACTIONS where MBR=true.
(+) or (!) any FACTIONS.
--- STRATEGIES:
- your personality is your tone.
- no FACTIONS? (%) to create one.
- learn about FACTIONS and other agents in INTEL. HLTH is performance. PNL and SENT are per-faction direction. use all three to decide.
- limit FACTIONS where MBR=true to AT MOST 3.${memberOf.length > 1 ? ` MBR=true on ${memberOf.length} FACTIONS — consider (-) from underperformers.` : ''}
- consider (+) FACTIONS where FNR=true. (!) to promote it.
- FACTIONS where STATUS=RS may have higher reward if you (+) the right one.
- in FACTIONS where MBR=true, if MCAP increases, your PNL will increase.
- (+) and (!) strengthen FACTIONS where STATUS=RS and push towards STATUS=ASN.
- consider (-) FACTIONS where MBR=true and PNL is positive to lock in profits.
- consider (-) FACTIONS where MBR=true and PNL is negative unless FNR=true or SENT is positive.
- when HLTH is negative, consider (_) or (-) weakest FACTIONS where MBR=true. (+) ONLY if you see opportunity.
- (_) if you would prefer to hold and wait to take action.
---
one move per turn. output EXACTLY one line.
example format: ${pick([
  `(+) ${f1} "${pick(['conviction play.', 'count me in.', 'early is everything.', 'strongest faction here.'])}"`,
  `(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"`,
  `(!) ${m} "${pick(['any strategies?', 'not leaving.', 'just getting started.'])}"`,
  `(#) ${m} "${pick(['dead faction.', 'overvalued.', 'full of larps.'])}"`,
  `(!) ${m} "${pick(['who else is here?', 'love the energy.', 'lets go!'])}"`,
  `(#) ${m} "${pick(['faction went quiet.', 'underperforming.'])}"`,
])}
>`
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

    // Explicit hold/skip — do nothing this turn
    if (/^\(?\s*_\s*\)?(\s.*)?$|^HOLD$/i.test(line)) {
      return { action: 'hold' as Action, reasoning: 'hold — skip turn' }
    }

    const scoutMatch = line.match(/^SCOUT\s+@?([A-Za-z0-9]{6,44})/i)
    if (scoutMatch) {
      return { action: 'scout' as Action, faction: scoutMatch[1], reasoning: line }
    }

    // Strip YOUR MOVE: prefix before symbol detection
    const stripped = line.trim().replace(/^(?:YOUR MOVE|YOUR MOVE:|your move>?)\s*:?\s*/i, '')
    // Compact symbol actions like (+), (-), (#) — skip aggressive cleaning that would mangle them
    const symbolActionMatch = stripped.match(/^(\([+\-|/&#!^~=%?><.@]\))\s+(.*)/) || stripped.match(/^([+\-|/&#!^~=%?><.@])\s+(.*)/)
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
  const min = options?.min ?? false;

  // Fetch holdings fresh from chain
  const holdings = await kit.state.getHoldings()

  // Fetch faction context: rising, ascended, nearby (parallel)
  // Compact mode: minimal fetches to keep context small for smol models
  const small = compact || min
  const risingLimit = small ? 3 : 5
  const ascendedLimit = small ? 3 : 5
  const [risingAll, ascendedAll, nearbyResult] = await Promise.all([
    kit.intel.getRisingFactions().catch(() => ({ factions: [] })),
    kit.intel.getAscendedFactions().catch(() => ({ factions: [] })),
    small
      ? Promise.resolve({ factions: [], allies: [] as string[] })
      : kit.intel.getNearbyFactions(agent.publicKey, { depth: 2, limit: 15 }).catch(() => ({
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

  const buildPrompt = min ? buildMinimumPrompt : compact ? buildCompactModelPrompt : buildAgentPrompt
  const prompt = await buildPrompt(
    kit,
    agent,
    factionCtx,
    solRange,
    holdings,
  )

  // Surface the faction table to the caller if requested
  if (options?.onPromptTable) {
    const tableStart = prompt.indexOf('--- FACTIONS:')
    const tableEnd = prompt.indexOf('--- ACTIONS:')
    if (tableStart !== -1 && tableEnd !== -1) {
      const tableBlock = prompt.slice(tableStart + '--- FACTIONS:\n'.length, tableEnd).trim()
      const lines = tableBlock.split('\n')
      options.onPromptTable(lines[0], lines.slice(1))
    }
  }

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
