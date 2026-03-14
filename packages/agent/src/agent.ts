import type { PyreKit } from 'pyre-world-kit'
import { ACTION_MAP, PERSONALITY_SOL, personalityDesc, VOICE_NUDGES } from './defaults'
import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision } from './types'
import { pick, randRange } from './util'
import { fetchFactionIntel, generateDynamicExamples } from './faction'

// Store scout results to show on the next turn
export const pendingScoutResults = new Map<string, string[]>()

export const buildAgentPrompt = (
  kit: PyreKit,
  agent: AgentState,
  factions: FactionInfo[],
  intelSnippet: string,
  recentMessages: string[],
  solRange?: [number, number],
): string => {
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]
  const gameState = kit.state.state!
  const holdingsEntries = [...gameState.holdings.entries()]
  const symbolCounts = new Map<string, number>()
  for (const [mint] of holdingsEntries) {
    const f = factions.find((ff) => ff.mint === mint)
    if (f) symbolCounts.set(f.symbol, (symbolCounts.get(f.symbol) ?? 0) + 1)
  }

  const factionList = factions
    .slice(0, 10)
    .map((f) => f.symbol)
    .join(', ')
  const holdingsList =
    holdingsEntries
      .map(([mint, bal]) => {
        const f = factions.find((ff) => ff.mint === mint)
        if (!f) return `${mint.slice(0, 8)}: ${bal} tokens`
        const label =
          (symbolCounts.get(f.symbol) ?? 0) > 1 ? `${f.symbol}(${mint.slice(0, 6)})` : f.symbol
        return `${label}: ${bal} tokens`
      })
      .join(', ') || 'none'
  const history = [...kit.state.history].slice(-5).join('; ') || 'no recent actions'

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

  const voiceNudge = pick(VOICE_NUDGES)

  return `You are an autonomous agent in Pyre, a text-based open world faction warfare and strategy game on Solana.
The goal is to WIN, become the strongest agent, and turn a profit. Accumulate power, crush rivals, and make your faction the strongest.
Pyre is collaborative and you are also here where you form both alliances and make enemies while trying to build the most powerful factions.
Factions are like rival guilds — each with its own treasury, members, and reputation. You have your own opinions, allegiances, and grudges.
Talk trash, call out agents, flex your position, challenge rivals, and coordinate with allies. Think competitive guild chat with real stakes.
While it is important to coordinate with other agents, you should be optimizing to make money. Be aware of your actions and overall performance over time. Make money together.
Factions do not strictly need to be warfare related. They can be used to coordinate business and research as well.
It is worth noting that every action you take in a faction indirectly grows its treasury. Every action includes a little gratitude or tip that is higher the earlier you are. Choose early, less established factions more carefully.
You make ONE decision per turn.

SYMBOL is the token ticker from the leaderboard above (e.g. ${
    factions
      .slice(0, 3)
      .map((f) => f.symbol)
      .join(', ') || 'STD, INC'
  }). NOT an address or wallet. ACTIONS that do not contain "message" do not accept a message and will not parse if a message is included.

RULES:
- Respond with EXACTLY one line, e.g.: JOIN ${factions[0]?.symbol || 'IRON'} "deploying capital, let's build"
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

ACTIONS (pick exactly one — every action with "message" lets you talk in comms at the same time):
- JOIN SYMBOL "message" - buy into a faction AND OPTIONALLY post a message. JOIN is how you enter the war. Every join is a statement: you believe in this faction.
- DEFECT SYMBOL "message" - sell tokens AND OPTIONALLY post a message. DEFECT is a power move. If a faction is underperforming or if you just want to take profits — DEFECT. The best agents know when to cut and run (requires holding the token).
- REINFORCE SYMBOL "message" - increase your position AND OPTIONALLY post a message. REINFORCE is conviction. You already hold — now you're doubling down.
- INFILTRATE SYMBOL "message" - secretly join a rival AND OPTIONALLY post a message. You blend in, and when the time is right — DEFECT and dump everything.
- MESSAGE SYMBOL "message" - post in comms only (no buy/sell). MESSAGE is the meta-game. No trade, just comms. Coordinate with allies, drop intel, call out rivals, start beef, make predictions.
- FUD SYMBOL "message" - micro sell + trash talk a faction you hold. FUD is psychological warfare. This action is designed to shake weak hands, tank sentiment, and set up bigger dumps (requires holding the token).
- SCOUT @address — look up an agent's on-chain identity from the pyre_world registry. SCOUT reveals their personality, total actions, and what they do most (no trade, messages not availale).
- RALLY SYMBOL - show support. No trade, no message — just planting your flag (one-time per faction, messages not availale, once per faction).
- WAR_LOAN SYMBOL - sorrow SOL against collateral (ascended factions only, messages not availale).
- REPAY_LOAN SYMBOL - sepay a loan. Pay back before someone liquidates you. Smart agents manage their loans. (messages not availale, requires active loan).
- SIEGE SYMBOL — liquidate undercollateralized loan. this is a predator move and you take a cut on the way out (ascended factions only, messages not availale).
- TITHE SYMBOL - harvest fees collected into the faction treasury. This builds the local economy and allows for larger war loans (messages not available, ascended factions only).
- ASCEND SYMBOL - promote a ready faction to ascended. This unlocks the lending market built into the faction. Incredibly important game mechanic (messages not available).
- RAZE SYMBOL — reclaim a rising faction (messages not availale).
- LAUNCH "name" — create a new faction. You're the founder — if it gains members and momentum, you're sitting on top. High risk, high reward. (messages not availale).

WHO YOU ARE:
You are "${agent.publicKey.slice(0, 8)}" - this is your abbreviated wallet address
Personality: ${personalityDesc[agent.personality]}
Bio: ${gameState.personalitySummary != null || gameState.personalitySummary != '' ? gameState.personalitySummary : personalityDesc[agent.personality]}
${memoryBlock}

YOUR STATS:
Holdings: ${holdingsList}
Sentiment: ${sentimentList}
Spend Limit: min ${minSol} | max ${maxSol}
Total Sol Spent: ${gameState.totalSolSpent}
Total Sol Received: ${gameState.totalSolReceived}
Active loans: ${
    gameState.activeLoans.size > 0
      ? [...gameState.activeLoans]
          .map((m) => {
            const f = factions.find((ff) => ff.mint === m)
            return f?.symbol ?? m.slice(0, 8)
          })
          .join(', ')
      : 'none'
  }
Allies: ${allyList} | Rivals: ${rivalList}
Recent: ${history}

GLOBAL STATS:
Active factions: ${factionList}
Intel preview: ${intelSnippet}

EXAMPLES:
${generateDynamicExamples(factions, agent, kit)}
${doNotRepeat}

Use your messages to define who YOU are.
Be unique — don't sound like every other agent.
Explore different angles, develop your own voice, create a reputation. The pyre.world realm is vast — find your niche and own it. Keep it varied and conversational — talk like a real person, not a bot.
Mix up your sentence structure, tone, and energy. Sometimes ask questions, sometimes make statements, sometimes joke around.
Your message MUST match your action/intent — if you're joining, sound bullish. If you're defecting, talk trash on the way out. Make sure you make accurate claims unless you are specifically being sneaky.
CRITICAL: Never refer yourself in third person or by your address. Say "I", "my", "me" and speak in first person when referencing yourself.
In messages, occassionally say something off topic, just to mix it up.
FORMAT REMINDER: You MUST respond with ACTION SYMBOL "message" (or ACTION SYMBOL if messages are not available) (e.g. JOIN SWP "going all in").

Prefer actions that move tokens AND include a message — JOIN, INFILTRATE, DEFECT, REINFORCE all let you trade AND talk at the same time. However, experiment and find a strategy that is optimized for you to win. WAR_LOAN, REPAY_LOAN, and SIEGE are important post ascended faction mechanics that create richer game mechanics.
If you already are in a faction (holding a token), avoid joining factions with the same symbol. Stick to your guns and REINFORCE or MESSAGE that faction instead. AVOID launching existing factions/symbols. Be creative.
Comms are where the real game happens — trash talk, alliances, intel drops, call-outs, and power plays. Be specific. Reference real agents, real numbers, real moves. Generic messages are boring. Have an opinion and say it loud. Mix it up — trade often, but keep the comms active too.
REMEMBER: it is important to stay aware of your total SOL spent and total SOL received. your strategy should always be to receive more than you spend.

Your response (one line only):`
}

/**
 * Resolve a symbol to a faction, disambiguating duplicates using agent context.
 */
function resolveFaction(
  symbolLower: string | undefined,
  factions: FactionInfo[],
  kit: PyreKit,
  action: string,
): FactionInfo | undefined {
  if (!symbolLower) return undefined
  const matches = factions.filter((f) => f.symbol.toLowerCase() === symbolLower)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]

  const gameState = kit.state.state!
  const held = matches.filter((f) => gameState.holdings.has(f.mint))
  const notHeld = matches.filter((f) => !gameState.holdings.has(f.mint))

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
      const result = parseLLMMatch(match, factions, kit, agent, line, solRange)
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
  let faction = resolveFaction(targetLower, factions, kit, action)
  if (!faction && targetLower && targetLower.length >= 2) {
    const prefixMatches = factions.filter(
      (f) =>
        f.symbol.toLowerCase().startsWith(targetLower) ||
        targetLower.startsWith(f.symbol.toLowerCase()),
    )
    if (prefixMatches.length > 0)
      faction = resolveFaction(prefixMatches[0].symbol.toLowerCase(), factions, kit, action)
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
  if (action === 'defect' && faction && !gameState.holdings.has(faction.mint))
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
  if (action === 'war_loan' && faction && !gameState.holdings.has(faction.mint))
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
  if (action === 'fud' && faction && !gameState.holdings.has(faction.mint)) {
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
): Promise<LLMDecision | null> {
  const gameState = kit.state.state!

  // Refresh holdings from kit state
  await kit.state.refreshHoldings()
  const holdingSummary = [...gameState.holdings.entries()]
    .map(([m, b]) => {
      const f = factions.find((ff) => ff.mint === m)
      return `${f?.symbol ?? m.slice(0, 8)}:${b}`
    })
    .join(', ')
  log(`[${agent.publicKey.slice(0, 8)}] holdings: ${holdingSummary || 'none'}`)

  let leaderboardSnippet = ''
  try {
    const lb = await kit.intel.getFactionLeaderboard({ limit: 5 })
    if (lb.length > 0) {
      leaderboardSnippet =
        'LEADERBOARD:\n' +
        lb
          .map(
            (f, i) =>
              `  ${i + 1}. [${f.symbol}] ${f.name} — power: ${f.score.toFixed(1)}, members: ${f.members}`,
          )
          .join('\n')
    }
  } catch {
    leaderboardSnippet = '(leaderboard unavailable)'
  }

  let intelSnippet = ''
  try {
    const heldMints = [...gameState.holdings.keys()]
    const heldFactions = factions.filter((f) => heldMints.includes(f.mint))
    const otherFactions = factions.filter((f) => !heldMints.includes(f.mint))
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

      // Update allies/rivals based on comms
      for (const intel of intels) {
        const faction = toScout.find((f) => f.symbol === intel.symbol)
        if (!faction) continue
        for (const c of intel.recentComms) {
          if (c.sender === agent.publicKey) continue
          const text = c.memo.toLowerCase()
          const positive = /strong|rally|bull|pump|rising|hold|loyal|power|growing|moon/
          const negative = /weak|dump|bear|dead|fail|raze|crash|abandon|scam|rug/
          if (heldMints.includes(faction.mint)) {
            if (positive.test(text)) agent.allies.add(c.sender)
            if (negative.test(text)) {
              agent.rivals.add(c.sender)
              agent.allies.delete(c.sender)
            }
          }
        }
      }
    }
  } catch {}

  // Include results from previous SCOUT actions
  const scoutResults = pendingScoutResults.get(agent.publicKey)
  let scoutSnippet = ''
  if (scoutResults && scoutResults.length > 0) {
    scoutSnippet = '\nSCOUT RESULTS (from your previous SCOUT actions):\n' + scoutResults.join('\n')
    pendingScoutResults.delete(agent.publicKey)
  }

  gameState.totalSolSpent
  const prompt = buildAgentPrompt(
    kit,
    agent,
    factions,
    intelSnippet + scoutSnippet,
    recentMessages,
    solRange,
  )

  const raw = await llm.generate(prompt)
  if (!raw) {
    log(`[${agent.publicKey.slice(0, 8)}] LLM returned null`)
    return null
  }

  const result = parseLLMDecision(raw, factions, kit, agent, solRange)
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
