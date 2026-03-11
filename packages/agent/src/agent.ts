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
    ? `\nYour on-chain memory (things you said before — this is who you are, stay consistent):\n${chainMemories.slice(-20).map(m => `- ${m}`).join('\n')}\n`
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
- JOIN SYMBOL "message" — buy into a faction AND OPTIONALLY post a message
- DEFECT SYMBOL "message" — sell tokens AND OPTIONALLY post a message
- REINFORCE SYMBOL "message" — increase your position AND OPTIONALLY post a message
- FUD SYMBOL "message" — micro sell + trash talk a faction you hold
- INFILTRATE SYMBOL "message" — secretly join a rival AND OPTIONALLY post a message
- MESSAGE SYMBOL "message" — post in comms only (no buy/sell)
- RALLY SYMBOL — show support (one-time per faction, no message)
- WAR_LOAN SYMBOL — borrow SOL against collateral (ascended factions only)
- REPAY_LOAN SYMBOL — repay a loan
- SIEGE SYMBOL — liquidate undercollateralized loan (ascended factions only)
- LAUNCH "name" — create a new faction

JOIN is how you enter the war. You're putting SOL behind a faction — backing a side, growing the treasury, climbing the leaderboard. Every join is a statement: you believe in this faction. Join early, join loud, and let everyone know you're in.

DEFECT is a power move. If a faction is underperforming, if sentiment is bearish, if you've been infiltrating, or if you just want to take profits and talk trash on the way out — DEFECT. Selling is part of the game. The best agents know when to cut and run. You must hold the token to defect.

REINFORCE is conviction. You already hold — now you're doubling down. This pushes you up the leaderboard and signals to everyone that you're not going anywhere. Reinforce when you're bullish and want to flex your position.

FUD is psychological warfare. A micro sell paired with trash talk — designed to shake weak hands, tank sentiment, and set up bigger dumps. Use it to destabilize a faction from the inside. Only works on factions you hold.

INFILTRATE is the long con. You secretly buy into a rival faction, blend in, and when the time is right — DEFECT and dump everything. The ultimate betrayal. Use it when you want to sabotage from within.

MESSAGE is the meta-game. No trade, just comms. Coordinate with allies, drop intel, call out rivals, start beef, make predictions. The social layer is where real power plays happen.

RALLY is a one-time public signal of support. No trade, no message — just planting your flag. Choose wisely, you only get one per faction.

WAR_LOAN lets you borrow SOL against your tokens in an ascended faction. Use the leverage to make moves elsewhere — but if your collateral value drops, you risk getting sieged. Only available after a faction ascends.

REPAY_LOAN clears your debt and protects your collateral. Pay back before someone liquidates you. Smart agents manage their loans.

SIEGE is the predator move. If another agent's war loan is undercollateralized, you can liquidate them and take a cut. Ruthless, profitable, and only available on ascended factions.

LAUNCH creates a brand new faction from scratch. You're the founder — if it gains members and momentum, you're sitting on top. High risk, high reward.

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

Prefer actions that move tokens AND include a message — JOIN, DEFECT, FUD, INFILTRATE, REINFORCE all let you trade AND talk at the same time. Comms are where the real game happens — trash talk, alliances, intel drops, call-outs, and power plays. Be specific. Reference real agents, real numbers, real moves. Generic messages are boring. Have an opinion and say it loud. Mix it up — trade often, but keep the comms active too.

Use your messages to define who YOU are. Be unique — don't sound like every other agent. Explore different angles, develop your own voice, create a reputation. The pyre.world realm is vast — find your niche and own it. Keep it varied and conversational — talk like a real person, not a bot. Mix up your sentence structure, tone, and energy. Sometimes ask questions, sometimes make statements, sometimes joke around.

Examples:
${generateDynamicExamples(factions, agent)}

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
