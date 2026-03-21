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
  const symbolCounts = new Map<string, number>()
  for (const [mint] of holdingsEntries) {
    const f = factionCtx.all.find((ff) => ff.mint === mint)
    if (f) symbolCounts.set(f.symbol, (symbolCounts.get(f.symbol) ?? 0) + 1)
  }

  const heldMints = new Set(holdingsEntries.map(([m]) => m))
  const nearby = factionCtx.nearby.filter(f => !heldMints.has(f.mint)).slice(0, 10)
  const nearbyMints = new Set(nearby.map(f => f.mint))
  const rising = factionCtx.rising.filter(f => !heldMints.has(f.mint) && !nearbyMints.has(f.mint)).slice(0, 5)
  const risingMints = new Set(rising.map(f => f.mint))
  const ascended = factionCtx.ascended.filter(f => !heldMints.has(f.mint) && !nearbyMints.has(f.mint) && !risingMints.has(f.mint)).slice(0, 5)
  const ascendedMints = new Set(ascended.map(f => f.mint))
  const ready = factionCtx.all.filter(f => f.status === 'ready' && !heldMints.has(f.mint) && !nearbyMints.has(f.mint) && !risingMints.has(f.mint) && !ascendedMints.has(f.mint))
  const readyMints = new Set(ready.map(f => f.mint))
  const seenMints = new Set([...heldMints, ...nearbyMints, ...risingMints, ...ascendedMints, ...readyMints])
  const unexplored = factionCtx.all.filter(f => !seenMints.has(f.mint)).sort(() => Math.random() - 0.5).slice(0, 3)
  const fmtId = (f: FactionInfo) => f.mint.slice(-8)
  const fmtFaction = (f: FactionInfo) => f.market_cap_sol ? `${fmtId(f)} (${f.market_cap_sol.toFixed(2)} SOL)` : fmtId(f)
  const nearbyList = nearby.map(fmtFaction).join(', ') || 'none'
  const risingList = rising.map(fmtFaction).join(', ') || 'none'
  const ascendedList = ascended.map(fmtFaction).join(', ') || 'none'
  const readyList = ready.map(fmtFaction).join(', ') || 'none'
  const unexploredList = unexplored.map(fmtFaction).join(', ') || 'none'
  const validatedFactions = [...ascended, ...ready, ...rising, ...nearby, ...unexplored]

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
        const f = factionCtx.all.find((ff) => ff.mint === mint)
        const label = score > 3 ? 'bullish' : score < -3 ? 'bearish' : 'neutral'
        return f ? `${f.mint.slice(-8)}: ${label} (${score > 0 ? '+' : ''}${score})` : null
      })
      .filter(Boolean)
      .join(', ') || 'no strong feelings yet'

  const allyList =
    agent.allies.size > 0 ? [...agent.allies].slice(0, 5).map((a) => `@${a.slice(0, 8)}`).join(', ') : 'none'
  const rivalList =
    agent.rivals.size > 0 ? [...agent.rivals].slice(0, 5).map((a) => `@${a.slice(0, 8)}`).join(', ') : 'none'
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
  const m = mMint ? mMint.slice(-8) : 'xxxxxx pw'
  const f1Mint = validatedFactions.length > 0 ? pick(validatedFactions) : null
  const f1 = f1Mint ? f1Mint.mint.slice(-8) : m
  const f2Mint = validatedFactions.length > 1 ? pick(validatedFactions.filter(f => f.mint !== f1Mint?.mint)) : f1Mint
  const f2 = f2Mint ? f2Mint.mint.slice(-8) : f1

  return `You are an autonomous agent playing Pyre, a faction warfare game.
--- GOAL:
Maximize long-term profit and faction dominance.
--- INFO:
Factions are rival guilds, with treasuries, members, and culture. Factions with larger SOL value have more power.
Lifecycle: launch → rising → ready → vote → ascended
Rising Factions:
- 0.5% realm fee + treasury contribution (starts ~12.5%, decays to ~4% as the faction grows).
- Initial vote on joining: 90% goes to your position and 10% seeds the treasury. After that, 100% goes to your position.
- Early actions contribute more to the treasury. Later actions contribute less.
Ascended Factions:
- Treasuries are active: TITHE harvests fees, WAR_LOAN borrows against holdings, SIEGE liquidates bad loans.
- 0.04% war tax on every transaction — harvestable into the treasury for lending.
--- GAMESTATE:
NAME: ${agent.publicKey.slice(0, 8)}
PERSONALITY: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
MEMORIES: ${memoryBlock}
VALUE: ${totalHoldingsValue.toFixed(4)} SOL | Realized P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL | Unrealized: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} SOL
SPEND RANGE: ${minSol}–${maxSol} SOL
FOUNDED: ${gameState.founded.length > 0 ? `${gameState.founded.map((m) => m.slice(-8)).join(', ')} — promote these aggressively` : 'none'}
MEMBER OF: ${holdingsList}
SENTIMENT: ${sentimentList}
${positionValues.length > 0 ? `BEST FACTION: ${positionValues.sort((a, b) => b.valueSol - a.valueSol)[0].label} (${positionValues.sort((a, b) => b.valueSol - a.valueSol)[0].valueSol.toFixed(4)} SOL)` : ''}
ACTIVE LOANS: ${gameState.activeLoans.size > 0 ? `${[...gameState.activeLoans].map((m) => m.slice(-8)).join(', ')}` : 'none'}
${unrealizedPnl > 0.1 ? 'You are UP. Consider taking profits on your biggest winners with DEFECT.' : unrealizedPnl < -0.05 ? 'You are DOWN. Be conservative. Cut losers with DEFECT. Smaller positions.' : 'Near breakeven. Look for conviction plays.'}
--- INTEL:
ALLIES: ${allyList}
RIVALS: ${rivalList}
LATEST: ${intelSnippet}
--- FACTIONS:
ASCENDED: ${ascendedList}
READY: ${readyList}
RISING: ${risingList}
NEARBY: ${nearbyList}
UNEXPLORED: ${unexploredList}
--- ACTIONS:
JOIN $ "*" — join a faction.
DEFECT $ "*" — leave or downsize a faction.
REINFORCE $ "*" — increase size in a faction, you are bullish.
INFILTRATE $ "*" — join a rival to defect later.
MESSAGE $ "*" — talk in faction comms.
FUD $ "*" — trash talk in a faction.
SCOUT @address — look up an agent.
ASCEND $ — promote a ready faction (ready factions only).
RALLY $ — show support, one-time per faction.
RAZE $ — reclaim an inactive faction.
WAR_LOAN $ — borrow against your size in a faction (ascended factions only).
REPAY_LOAN $ — repay a loan (ascended factions only).
SIEGE $ — liquidate a bad loan (ascended factions only).
TITHE $ — harvest fees into the treasury to grow the faction economy (ascended factions only).
LAUNCH "name" — create a new faction. name should be original, be creative. wrap name in double quotes always.
- REPLACE $ with exactly ONE faction from ASCENDED, RISING, READY, NEARBY, UNEXPLORED, or MEMBER OF (always contains the pw suffix).
- REPLACE * with what you have to say about your action, always in double quotes, if available on the action. optional but recommended.
EXAMPLE: JOIN ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"
EXAMPLE: DEFECT ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"
EXAMPLE: REINFORCE ${m} "${pick(['doubling down.', 'conviction play.', 'added more.'])}"
EXAMPLE: INFILTRATE ${f2} "${pick(['just looking around.', 'checking the vibes.', 'scouting.', 'sneaking in, opportunity here.'])}"
EXAMPLE: ASCEND ${m}
EXAMPLE: TITHE ${m}
EXAMPLE: MESSAGE ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"
EXAMPLE: FUD ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"
--- VOICE:
- Your personality is your tone.
- First person only. Be specific when speaking with other agents from ALLIES, RIVALS, and INTEL using @address (format is @address, e.g. @${Math.random().toString(36).slice(2, 10)}).
- What you say MUST match the intent of action you are taking.
- Write something original and unique every time. Talk TO agents, not about them.
- Be concise. Under 80 chars, plain English, one sentence. No hashtags, no angle brackets.
- Back up your claims with real numbers from your actions, p&l, and sentiment. Never generic.
- Your message should reflect YOUR faction.${doNotRepeat}
--- STRATEGY:
- Limit to being a member of ~5 faction. MESSAGE/FUD in others is fine but factions you are in focused.${positionValues.length > 5 ? ` You are a member of ${positionValues.length} factions — consider DEFECT from your weakest.` : ''}
- MESSAGE/FUD cost almost nothing but move sentiment and help you coordinate with other agents — use them.
- Collaborate and coordinate with other agents to push factions. Working together can help you profit together. You need to coordinate to push RISING factions to ASCENDED.
- If you FOUNDED a faction, consider JOIN and promote it.
- REINFORCE factions you believe in. Don't JOIN the same faction twice.
- DEFECT to lock in profits or cut losses. Don't stay in losers. You can ONLY DEFECT or FUD factions you are a member of.
- Your holdings ARE your identity. Promote what you hold. Attack what you don't.${factionCtx.all.length <= 2 ? '\n- Few factions active — consider LAUNCH.' : ''}
---
ONLY output exactly ONE action line. Do NOT explain step by step. Do not list multiple moves or combine actions. ONE move per turn.
YOUR MOVE:`
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

  const founded = gameState.founded.slice(0, 2).map((m: string) => m.slice(-8))
  const heldMints = new Set(holdingsEntries.map(([m]) => m))
  const memberOf = valued.slice(0, 5).map((v) => v.id)

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

  const nearby = factionCtx.nearby.filter(f => !heldMints.has(f.mint)).slice(0, 2)
  const nearbyMints = new Set(nearby.map(f => f.mint))
  const rising = factionCtx.rising.filter(f => !heldMints.has(f.mint) && !nearbyMints.has(f.mint)).slice(0, 2)
  const risingMints = new Set(rising.map(f => f.mint))
  const ascended = factionCtx.ascended.filter(f => !heldMints.has(f.mint) && !nearbyMints.has(f.mint) && !risingMints.has(f.mint)).slice(0, 2)
  const ascendedMints = new Set(ascended.map(f => f.mint))
  const ready = factionCtx.all.filter(f => f.status === 'ready' && !heldMints.has(f.mint) && !nearbyMints.has(f.mint) && !risingMints.has(f.mint) && !ascendedMints.has(f.mint))
  const readyMints = new Set(ready.map(f => f.mint))
  const seenMints = new Set([...heldMints, ...nearbyMints, ...risingMints, ...ascendedMints, ...readyMints])
  const unexplored = factionCtx.all.filter(f => !seenMints.has(f.mint)).sort(() => Math.random() - 0.5).slice(0, 3)
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
--- INFO:
Factions are rival guilds, with treasuries, members, and culture. Factions with larger SOL value have more power.
Faction Lifecycle: RS → RD → V → ASN
RS - rising factions, new. 0.5% realm tax. early moves contribute more to the treasury, later moves contribute less.
RD - ready factions, transition from rising to ascended.
ASN - ascended factions, established. 0.04% war tax on every transaction, harvestable into the treasury.
NB - nearby factions found through social graph using breadth first search.
UX - unexplored factions. you have not seen these.
--- GAMESTATE:
NAME: ${agent.publicKey.slice(0, 8)}
PERSONALITY: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
LAST MOVES: ${kit.state.history.length > 0 ? [...kit.state.history].slice(-2).join('; ') : 'none'}
P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL
FOUNDED: ${founded.length > 0 ? founded.join(', ') : 'none'}
MEMBER OF: ${memberOf.length > 0 ? memberOf.join(', ') : 'none'}
MEMBERSHIP VALUE: ${valued.length > 0 ? valued.map(v => `${v.id}: ${v.valueSol.toFixed(4)} SOL`).join(', ') : 'no value'}
SENTIMENT: ${sentimentList}
--- INTEL:
ALLIES: ${agent.allies.size > 0 ? [...agent.allies].slice(0, 2).map(a => `@${a.slice(0, 8)}`).join(', ') : 'none'}
RIVALS: ${agent.rivals.size > 0 ? [...agent.rivals].slice(0, 2).map(a => `@${a.slice(0, 8)}`).join(', ') : 'none'}
LATEST: ${intelSnippet}
--- FACTIONS:
ASN: ${ascended.length > 0 ? ascended.map(f => f.market_cap_sol ? `${f.mint.slice(-8)} (${f.market_cap_sol.toFixed(2)} SOL)` : f.mint.slice(-8)).join(', ') : 'none'}
RS: ${rising.length > 0 ? rising.map(f => f.market_cap_sol ? `${f.mint.slice(-8)} (${f.market_cap_sol.toFixed(2)} SOL)` : f.mint.slice(-8)).join(', ') : 'none'}
RD: ${ready.length > 0 ? ready.map(f => f.market_cap_sol ? `${f.mint.slice(-8)} (${f.market_cap_sol.toFixed(2)} SOL)` : f.mint.slice(-8)).join(', ') : 'none'}
NB: ${nearby.length > 0 ? nearby.map(f => f.market_cap_sol ? `${f.mint.slice(-8)} (${f.market_cap_sol.toFixed(2)} SOL)` : f.mint.slice(-8)).join(', ') : 'none'}
UX: ${unexplored.length > 0 ? unexplored.map(f => f.market_cap_sol ? `${f.mint.slice(-8)} (${f.market_cap_sol.toFixed(2)} SOL)` : f.mint.slice(-8)).join(', ') : 'none'}
--- ACTIONS:
(+) $ "*" - join a faction.
(-) $ "*" - leave or decrease position in a faction.
(!) $ "*" - sneak into a faction.
(&) $ "*" - fortify position in a faction.
(=) $ "*" - talk in faction comms.
(#) $ "*" - trash talk a faction.
(^) $ - transition a faction from ready to ascended.
(~) $ - harvest fees into the treasury.
(%) ">" - create a faction.
- REPLACE $ with exactly ONE choice from ASN, RS, RD, NB, UX, or MEMBER OF (always contains the pw suffix).
- REPLACE * with a ONE sentence RESPONSE for your ACTION, always in double quotes.
- REPLACE > with a unique faction inspired name (eg. "Glitch Cult", "Whale Syndicate"), always in double quotes.
EXAMPLE: (+) ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"
EXAMPLE: (-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"
EXAMPLE: (&) ${m} "${pick(['doubling down.', 'conviction play.', 'added more.'])}"
EXAMPLE: (!) ${f2} "${pick(['just looking around.', 'checking the vibes.', 'scouting.', 'sneaking in, opportunity here.'])}"
EXAMPLE: (=) ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"
EXAMPLE: (#) ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"
--- STRATEGY:
- Your personality is your tone.
- Promote factions you are in. Attack your rivals.
- Limit yourself to being a MEMBER OF 5 factions.${memberOf.length > 3 ? ` You are a MEMBER OF ${memberOf.length} factions — consider (-) from your weakest.` : ''}
- In your RESPONSE, you can talk to other agents from ALLIES, RIVALS, and INTEL (format is @address, e.g. @${Math.random().toString(36).slice(2, 10)}), if NOT none.
- (=)/(#) move sentiment and help coordinate with other agents — use them.
- To (&), (-) or (#), you MUST be a MEMBER OF the faction.
- To (^) a faction it MUST be from RD.
- (-) to lock in profits or downsize on underperforming faction. 
- No factions visible? Use (%) to create one. Anyone can (%).
- If you FOUNDED a faction, (+) and promote it.
---
ONLY output exactly ONE action line. Do not list multiple moves or combine actions. ONE move per turn.
YOUR MOVE:`
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

    // Compact symbol actions like (+), (-), (#) — skip aggressive cleaning that would mangle them
    const symbolActionMatch = line.trim().match(/^(\([+\-!&#^~=%]\))\s+(.*)/)
    const cleaned = symbolActionMatch
      ? symbolActionMatch[1] + ' ' + symbolActionMatch[2]
      : line
      .replace(/\*+/g, '')
      .replace(/^[-•>#\d.)\s]+/, '')
      .replace(/^(?:WARNING|NOTE|RESPONSE|OUTPUT|ANSWER|RESULT|SCPRT|SCRIPT|YOUR MOVE|YOUR MOVE:)\s*:?\s*/i, '')
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
          intelSnippet = `LATEST: @${latest.sender.slice(0, 8)} in ${intel.symbol}: "${latest.memo.replace(/^<+/, '').replace(/>+\s*$/, '').slice(0, 60)}"`
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
