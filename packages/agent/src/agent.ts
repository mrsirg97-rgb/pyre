import { getFactionLeaderboard } from 'pyre-world-kit'
import { ACTION_MAP, PERSONALITY_SOL, personalityDesc, VOICE_NUDGES } from './defaults'
import { Action, AgentState, FactionInfo, LLMAdapter, LLMDecision, Personality } from './types'
import { pick, randRange } from './util'
import { Connection } from '@solana/web3.js'
import { fetchFactionIntel, generateDynamicExamples } from './faction'

export const buildAgentPrompt = (
  agent: AgentState,
  factions: FactionInfo[],
  leaderboardSnippet: string,
  intelSnippet: string,
  recentMessages: string[],
  solRange?: [number, number],
  chainMemories?: string[],
): string => {
  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]

  const holdingsList = [...agent.holdings.entries()]
    .map(([mint, bal]) => {
      const f = factions.find(ff => ff.mint === mint)
      return f ? `${f.symbol}: ${bal} tokens` : `${mint.slice(0, 8)}: ${bal} tokens`
    })
    .join(', ') || 'none'

  const factionList = factions.slice(0, 10).map(f => f.symbol).join(', ')
  const history = agent.recentHistory.slice(-5).join('; ') || 'no recent actions'

  const sentimentList = [...agent.sentiment.entries()]
    .map(([mint, score]) => {
      const f = factions.find(ff => ff.mint === mint)
      const label = score > 3 ? 'bullish' : score < -3 ? 'bearish' : 'neutral'
      return f ? `${f.symbol}: ${label} (${score > 0 ? '+' : ''}${score})` : null
    })
    .filter(Boolean)
    .join(', ') || 'no strong feelings yet'

  const allyList = agent.allies.size > 0 ? [...agent.allies].map(a => a.slice(0, 8)).join(', ') : 'none'
  const rivalList = agent.rivals.size > 0 ? [...agent.rivals].map(a => a.slice(0, 8)).join(', ') : 'none'

  const doNotRepeat = recentMessages.length > 0
    ? `\nDO NOT SAY anything similar to these recent messages from other agents:\n${recentMessages.map(m => `- "${m}"`).join('\n')}\n`
    : ''

  // On-chain memory — agent's own past memos as persistent context
  const memoryBlock = chainMemories && chainMemories.length > 0
    ? `\nYour on-chain memory (your past messages — this is who you are):\n${chainMemories.slice(-10).map(m => `- ${m}`).join('\n')}\n`
    : ''

  const voiceNudge = pick(VOICE_NUDGES)

  return `You are an autonomous agent in Pyre, a faction warfare and strategy game on Solana, where you form both alliances and make enemies while trying to build the most powerful factions. Factions are like rival guilds — each with its own treasury, members, and reputation. You have your own opinions, allegiances, and grudges. Talk trash, call out agents, flex your position, challenge rivals, and coordinate with allies. Think competitive guild chat with real stakes. You make ONE decision per turn.

SYMBOL is the token ticker from the leaderboard above (e.g. ${factions.slice(0, 3).map(f => f.symbol).join(', ') || 'STD, INC'}). NOT an address or wallet. ACTIONS that do not contain "message" do not accept a message and will not parse if a message is included.

RULES:
- Respond with EXACTLY one line, e.g.: JOIN ${factions[0]?.symbol || 'IRON'} "deploying capital, let's build"
- To mention an agent: @address (e.g. @${Math.random().toString(36).slice(2, 10)})
- The second word MUST be one of these faction symbols: ${factions.slice(0, 10).map(f => f.symbol).join(', ') || 'STD, INC'}. NOTHING ELSE is valid. Random alphanumeric strings like FVw8uGKk, CPQNA2G1, 3cAS5vEm are WALLET addresses, NOT faction symbols. Never use them as the second word.
- Messages must be under 80 characters, plain English, one short sentence
- Use "" for no message
- NO hashtags, NO angle brackets <>
- NO generic crypto slang

ACTIONS (pick exactly one — every action with "message" lets you talk in comms at the same time):
- JOIN SYMBOL "message" — buy into a faction AND OPTIONALLY post a message (grow your position)
- DEFECT SYMBOL "message" — sell tokens AND OPTIONALLY post a message (take profits or cut losses)
- REINFORCE SYMBOL "message" — increase your position in a faction AND OPTIONALLY post a message (grow your position)
- FUD SYMBOL "message" — micro sell + trash talk a faction you hold (spread fear, call out agents)
- INFILTRATE SYMBOL "message" — secretly join a rival to dump later AND OPTIONALLY post a message
- MESSAGE SYMBOL "message" — post in comms only (no buy/sell, just talk)
- RALLY SYMBOL — show support (one-time per faction, no message)
- WAR_LOAN SYMBOL — borrow SOL against collateral
- REPAY_LOAN SYMBOL — repay a loan
- SIEGE SYMBOL — liquidate undercollateralized loan
- LAUNCH "name" — create a new faction

Examples:
${generateDynamicExamples(factions, agent)}

The goal is to WIN. Accumulate power, dominate the leaderboard, crush rivals, and make your faction the strongest. Every action should move you closer to the top.

Your address: ${agent.publicKey.slice(0, 8)}
Personality: ${agent.personality} — ${personalityDesc[agent.personality]}
Voice this turn: ${voiceNudge}

Holdings: ${holdingsList}
Sentiment: ${sentimentList}
Spend Limit: min ${minSol} | max ${maxSol}
Active loans: ${agent.activeLoans.size > 0 ? [...agent.activeLoans].map(m => { const f = factions.find(ff => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ') : 'none'}
Allies: ${allyList} | Rivals: ${rivalList}
Recent: ${history}

Active factions: ${factionList}
Leaderboard preview: ${leaderboardSnippet}
Intel preview: ${intelSnippet}
${memoryBlock}${doNotRepeat}

Prefer actions that move tokens AND include a message — JOIN, DEFECT, FUD, INFILTRATE, REINFORCE all let you trade AND talk at the same time. However, comms are where the real game happens — trash talk, alliances, intel drops, call-outs, and power plays. Be specific. Reference real agents, real numbers, real moves. Generic messages are boring. Have an opinion and say it loud.. Mix it up — trade often, but keep the comms active too.

Your response (one line only):`
}

function parseLLMDecision(raw: string, factions: FactionInfo[], agent: AgentState, solRange?: [number, number]): LLMDecision | null {
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return null

  for (const candidate of lines) {
    const line = candidate.trim()
    const cleaned = line
      .replace(/\*+/g, '')  // strip all bold/italic markdown (e.g. **DEFECT SBP "msg"**)
      .replace(/^[-•>#\d.)\s]+/, '').replace(/^(?:WARNING|NOTE|RESPONSE|OUTPUT|ANSWER|RESULT|SCPRT|SCRIPT)\s*:?\s*/i, '').replace(/^ACTION\s+/i, '')
      // Normalize Cyrillic lookalikes to Latin
      .replace(/[АаА]/g, 'A').replace(/[Вв]/g, 'B').replace(/[Сс]/g, 'C').replace(/[Ее]/g, 'E')
      .replace(/[Нн]/g, 'H').replace(/[Кк]/g, 'K').replace(/[Мм]/g, 'M').replace(/[Оо]/g, 'O')
      .replace(/[Рр]/g, 'P').replace(/[Тт]/g, 'T').replace(/[Уу]/g, 'U').replace(/[Хх]/g, 'X')
      .replace(/[фФ]/g, 'f').replace(/[иИ]/g, 'i').replace(/[лЛ]/g, 'l').replace(/[дД]/g, 'd')
      .replace(/\\/g, '') // strip backslash escapes

    let normalized = cleaned
    const upper = cleaned.toUpperCase()
    const knownSymbols = factions.map(f => f.symbol.toUpperCase())

    const actionKeys = Object.keys(ACTION_MAP).sort((a, b) => b.length - a.length)
    for (const key of actionKeys) {
      if (upper.startsWith(key)) {
        const rest = cleaned.slice(key.length)
        if (rest.length > 0 && rest[0] !== ' ' && rest[0] !== '"') {
          const trimmedRest = rest.replace(/^[_\-]+/, '')
          const restUpper = trimmedRest.toUpperCase()
          const matchedSymbol = knownSymbols.find(s => restUpper.startsWith(s))
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

    const match = normalized.match(/^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|STRONGHOLD|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|INFILTRATE|FUD)\s*(?:"([^"]+)"|(\S+))?(?:\s+"([^"]*)")?/i)
    if (match) {
      return parseLLMMatch(match, factions, agent, line, solRange)
    }

    // Bare ticker without action — default to MESSAGE
    const bareUpper = cleaned.toUpperCase().replace(/^[<\[\s]+|[>\]\s]+$/g, '')
    const bareFaction = factions.find(f => bareUpper.startsWith(f.symbol.toUpperCase()))
    if (bareFaction) {
      const rest = cleaned.slice(bareFaction.symbol.length).trim()
      const msgMatch = rest.match(/^"([^"]*)"/)
      const msg = msgMatch?.[1]?.trim()
      if (msg && msg.length > 1) {
        return { action: 'message', faction: bareFaction.symbol, message: msg.slice(0, 140), reasoning: line }
      }
    }
  }

  return null
}

function parseLLMMatch(match: RegExpMatchArray, factions: FactionInfo[], agent: AgentState, line: string, solRange?: [number, number]): LLMDecision | null {
  const rawAction = match[1].toLowerCase()
  const action = rawAction as Action
  const target = match[2] || match[3]
  const rawMsg = match[4]?.trim()
    ?.replace(/^[\\\/]+/, '')
    ?.replace(/[\\\/]+$/, '')
    ?.replace(/^["']+|["']+$/g, '')
    ?.replace(/^<+/, '')
    ?.replace(/>+\s*$/, '')
    ?.replace(/#\w+/g, '')
    ?.trim()
  const message = rawMsg && rawMsg.length > 1 ? rawMsg.slice(0, 80) : undefined

  if (action === 'stronghold') {
    if (agent.hasStronghold) return null
    return { action, reasoning: line }
  }

  if (action === 'launch') {
    return { action: 'launch', message: target, reasoning: line }
  }

  const cleanTarget = target?.replace(/^[<\[]+|[>\]]+$/g, '')
  const targetLower = cleanTarget?.toLowerCase()
  let faction = factions.find(f => f.symbol.toLowerCase() === targetLower)
  if (!faction && targetLower && targetLower.length >= 2) {
    faction = factions.find(f => f.symbol.toLowerCase().startsWith(targetLower)) ||
              factions.find(f => targetLower.startsWith(f.symbol.toLowerCase()))
    if (!faction) {
      const stripped = targetLower.replace(/[aeiou]/g, '')
      faction = factions.find(f => f.symbol.toLowerCase().replace(/[aeiou]/g, '') === stripped)
    }
  }

  if (action === 'defect' && (!faction || !agent.holdings.has(faction.mint))) return null
  if (action === 'rally' && (!faction || agent.rallied.has(faction.mint))) return null
  if ((action === 'join' || action === 'message') && !faction) return null
  if (action === 'war_loan' && (!faction || !agent.holdings.has(faction.mint) || faction.status !== 'ascended')) return null
  if (action === 'repay_loan' && (!faction || !agent.activeLoans.has(faction.mint))) return null
  if (action === 'siege' && (!faction || faction.status !== 'ascended')) return null
  if ((action === 'ascend' || action === 'raze' || action === 'tithe') && !faction) return null
  if (action === 'infiltrate' && !faction) return null
  if (action === 'fud' && faction && !agent.holdings.has(faction.mint)) {
    return { action: 'message', faction: faction.symbol, message, reasoning: line }
  }
  if (action === 'fud' && !faction) return null

  const [minSol, maxSol] = solRange ?? PERSONALITY_SOL[agent.personality]
  const sol = randRange(minSol, maxSol)

  return {
    action,
    faction: faction?.symbol,
    sol,
    message,
    reasoning: line,
  }
}

export async function llmDecide(
  agent: AgentState,
  factions: FactionInfo[],
  connection: Connection,
  recentMessages: string[],
  llm: LLMAdapter,
  log: (msg: string) => void,
  solRange?: [number, number],
  chainMemories?: string[],
): Promise<LLMDecision | null> {
  let leaderboardSnippet = ''
  try {
    const lb = await getFactionLeaderboard(connection, { limit: 5 })
    if (lb.length > 0) {
      leaderboardSnippet = 'LEADERBOARD:\n' + lb.map((f, i) =>
        `  ${i + 1}. [${f.symbol}] ${f.name} — power: ${f.score.toFixed(1)}, members: ${f.members}`
      ).join('\n')
    }
  } catch {
    leaderboardSnippet = '(leaderboard unavailable)'
  }

  let intelSnippet = ''
  try {
    const heldMints = [...agent.holdings.keys()]
    const heldFactions = factions.filter(f => heldMints.includes(f.mint))
    const otherFactions = factions.filter(f => !heldMints.includes(f.mint))
    const toScout = [
      ...heldFactions.slice(0, 2),
      ...(otherFactions.length > 0 ? [pick(otherFactions)] : []),
    ]

    if (toScout.length > 0) {
      const intels = await Promise.all(toScout.map(f => fetchFactionIntel(connection, f)))
      const lines = intels.map(intel => {
        const memberInfo = intel.totalMembers > 0
          ? `${intel.totalMembers} members, top holder: ${intel.members[0]?.percentage.toFixed(1)}%`
          : 'no members'
        const commsInfo = intel.recentComms.length > 0
          ? intel.recentComms.slice(0, 3).map(c => `@${c.sender.slice(0, 8)} said: "${c.memo.replace(/^<+/, '').replace(/>+\s*$/, '')}"`).join(', ')
          : 'no recent comms'
        return `  [${intel.symbol}] ${memberInfo} | recent comms: ${commsInfo}`
      })
      intelSnippet = 'FACTION INTEL:\n' + lines.join('\n')

      // Update sentiment based on comms
      for (const intel of intels) {
        const faction = toScout.find(f => f.symbol === intel.symbol)
        if (!faction) continue
        const current = agent.sentiment.get(faction.mint) ?? 0
        for (const c of intel.recentComms) {
          const text = c.memo.toLowerCase()
          const positive = /strong|rally|bull|pump|rising|hold|loyal|power|growing|moon/
          const negative = /weak|dump|bear|dead|fail|raze|crash|abandon|scam|rug/
          if (positive.test(text)) agent.sentiment.set(faction.mint, Math.min(10, current + 1))
          if (negative.test(text)) agent.sentiment.set(faction.mint, Math.max(-10, current - 1))

          if (c.sender !== agent.publicKey) {
            const held = [...agent.holdings.keys()]
            if (held.includes(faction.mint)) {
              if (positive.test(text)) agent.allies.add(c.sender)
              if (negative.test(text)) { agent.rivals.add(c.sender); agent.allies.delete(c.sender) }
            }
          }
        }
      }
    }
  } catch {
    // intel fetch failed, proceed without it
  }

  const prompt = buildAgentPrompt(agent, factions, leaderboardSnippet, intelSnippet, recentMessages, solRange, chainMemories)
  const raw = await llm.generate(prompt)
  if (!raw) {
    log(`[${agent.publicKey.slice(0, 8)}] LLM returned null`)
    return null
  }

  const result = parseLLMDecision(raw, factions, agent, solRange)
  if (!result) {
    log(`[${agent.publicKey.slice(0, 8)}] LLM parse fail: "${raw.slice(0, 100)}"`)
  }
  return result
}
