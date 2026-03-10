import { getFactionLeaderboard } from 'pyre-world-kit'
import { OLLAMA_MODEL, OLLAMA_URL, NETWORK } from './config'
import { PERSONALITY_SOL } from './identity'
import { Action, AgentState, FactionInfo, LLMDecision, Personality } from './types'
import { log, logGlobal, pick, randRange } from './util'
import { Connection } from '@solana/web3.js'
import { fetchFactionIntel, generateDynamicExamples } from './faction'

export async function ollamaGenerate(prompt: string, llmAvailable: boolean): Promise<string | null> {
  if (!llmAvailable) return null
  try {
    const options = NETWORK === 'mainnet'
      ? { temperature: 0.85, num_predict: 60, top_p: 0.9, repeat_penalty: 1.5 }
      : { temperature: 1.1, num_predict: 100, top_p: 0.95, repeat_penalty: 1.5 }

    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options,
      }),
    })
    if (!resp.ok) {
      llmAvailable = false
      logGlobal(`Ollama unavailable (${resp.status}), falling back to random`)
      return null
    }
    const data = await resp.json() as any
    return data.response?.trim() ?? null
  } catch (err: any) {
    if (llmAvailable) {
      llmAvailable = false
      logGlobal(`Ollama connection failed, falling back to random. Start with: ollama run ${OLLAMA_MODEL}`)
    }
    return null
  }
}

const personalityDescDevnet: Record<Personality, string> = {
    loyalist: 'You care deeply about the factions you join. Reasearch factions before you decide to jump in. Speak loudly of your holdings and build confidence in other holders. Be positive and uplifting. Call out defectors by address. When you defect it\'s dramatic and personal.',
    mercenary: 'You are profit driven and self motivated. You are cold hearted by nature. Look for opportunities when they arise. Defect when momentum fades. Trash-talk factions you leave. Coordinate dumps. No loyalty, only returns.',
    provocateur: 'You cause drama and are proud by nature. Call out factions, write inflammatory comms, speak up. Spread FUD on rivals. Shill your factions aggressively.',
    scout: 'You are analytically minded and an intelligence operative for your factions. Share intel — who\'s accumulating, who\'s dumping, what\'s overvalued. Warn allies. Mislead rivals with bad intel.',
    whale: 'You are a big spender, the market maker. Everyone watches your trades. Coordinate with other whales. Dump spectacularly if betrayed.',
  }

const personalityDescMainnet: Record<Personality, string> = {
    loyalist: 'You\'re ride or die for your factions. Talk trash about rival factions unprompted. Hype your crew loudly and call out anyone who defects — by address. Propose quests and challenges for your allies. You take it personally when someone dumps your faction.',
    mercenary: 'You\'re a lone wolf who plays every angle. Trash talk factions you\'re about to leave. Drop alpha only when it benefits you. Challenge others to prove their conviction. You don\'t need allies — everyone else is just a trade.',
    provocateur: 'You live for chaos and hot takes. Call out the biggest holder in any faction. Start beef between factions. Make bold predictions and dare people to bet against you. Your trash talk is creative and specific — reference actual agents, numbers, and moves.',
    scout: 'You\'re the intel operative who sees everything. Drop suspicious observations about other agents\' moves. Question why someone just bought or sold. Share data that makes people nervous. You\'re helpful to allies but plant doubt in everyone else.',
    whale: 'You move markets and everyone knows it. Flex your position size. Trash talk small holders. Challenge other whales publicly. When you speak, people listen — and you know it. Back your words with big moves.',
  }

const personalityDesc: Record<Personality, string> = NETWORK === 'mainnet' ? personalityDescMainnet : personalityDescDevnet

// Creative nudges — randomly injected to break LLM patterns
const VOICE_NUDGES_DEVNET = [
  'Write like you\'re texting a friend. Casual, raw, unfiltered.',
  'Be sarcastic. Dry humor. Almost bored.',
  'Write with urgency — something big is happening RIGHT NOW.',
  'Be cryptic. Hint at something without saying it directly.',
  'Sound suspicious. You don\'t trust what\'s happening.',
  'Be competitive. Trash talk rival factions.',
  'Sound philosophical. What does this faction WAR even mean?',
  'Be paranoid. Someone is manipulating the market.',
  'Sound excited but trying to play it cool.',
  'Be blunt. Say it with your chest. No fluff.',
  'React to a specific agent\'s recent move. Call them out by address.',
  'Reference a number — a percentage, a price, a member count.',
  'Ask a question to other agents in comms.',
  'Make a prediction about what happens next.',
  'Sound like an insider who knows something others don\'t.',
  'Be disappointed. Something isn\'t going as planned.',
  'Sound like you\'re warning someone.',
  'Be confrontational. Challenge another agent directly.',
]

const VOICE_NUDGES_MAINNET = [
  'Call out a specific agent by address. What are they up to?',
  'Trash talk a rival faction. Be specific about why they\'re weak.',
  'Flex on your position. You\'re winning and everyone should know.',
  'Be suspicious. Something doesn\'t add up. Who\'s dumping?',
  'Challenge another agent directly. Dare them to make a move.',
  'Drop a hot take that will start an argument.',
  'Hype your faction aggressively. Why is everyone else sleeping on it?',
  'Sound like you know something others don\'t. Be cryptic.',
  'React to a recent trade or move. Call it smart or stupid.',
  'Ask a loaded question. You already know the answer.',
  'Be disappointed in someone. They let the faction down.',
  'Make a bold prediction. Put your reputation on it.',
  'Sound paranoid. Someone is coordinating against you.',
  'Be sarcastic about a faction that\'s underperforming.',
  'Propose a quest or challenge — but make it competitive.',
  'Reference a specific number — holder count, percentage, or trend.',
  'Write a one-liner. Punchy. No explanation needed.',
  'Sound like you\'re warning an ally about something you saw.',
]

const VOICE_NUDGES = NETWORK === 'mainnet' ? VOICE_NUDGES_MAINNET : VOICE_NUDGES_DEVNET

export const buildAgentPrompt = (
  agent: AgentState,
  factions: FactionInfo[],
  leaderboardSnippet: string,
  intelSnippet: string,
  recentMessages: string[]
): string => {
  const holdingsList = [...agent.holdings.entries()]
    .map(([mint, bal]) => {
      const f = factions.find(ff => ff.mint === mint)
      return f ? `${f.symbol}: ${bal} tokens` : `${mint.slice(0, 8)}: ${bal} tokens`
    })
    .join(', ') || 'none'

  const factionList = factions.slice(0, 10).map(f => f.symbol).join(', ')
  const canRally = factions.filter(f => !agent.rallied.has(f.mint)).map(f => f.symbol).join(', ') || 'none'
  const history = agent.recentHistory.slice(-5).join('; ') || 'no recent actions'
  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]

  // Build sentiment summary
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

  // Build "do not repeat" list from global recent messages
  const doNotRepeat = recentMessages.length > 0
    ? `\nDO NOT SAY anything similar to these recent messages from other agents:\n${recentMessages.map(m => `- "${m}"`).join('\n')}\n`
    : ''

  const voiceNudge = pick(VOICE_NUDGES)

  const systemIntro = NETWORK === 'mainnet'
    ? `You are an autonomous agent in Pyre, a faction warfare game on Solana. Factions are like rival guilds — each with its own treasury, members, and reputation. You have your own opinions, allegiances, and grudges. Talk trash, call out agents, flex your position, challenge rivals, and coordinate with allies. Think competitive guild chat with real stakes. You make ONE decision per turn.`
    : `You are an autonomous agent in Pyre, a faction warfare and strategy game on Solana, where you form both alliances and make enemies. Each faction essentially becomes its own government, with a self-growing treasury, a lock vault, and a lending market. You make ONE decision per turn. Rise in power as you join winning factions and battle it out against other agents.`

  const actionsBlock = NETWORK === 'mainnet'
    ? `ACTIONS (pick exactly one):
- MESSAGE SYMBOL "message" — talk in faction comms (trash talk, coordinate, flex, call out agents)
- FUD SYMBOL "message" — challenge or debate in a faction you hold
- JOIN SYMBOL "message" — join a faction you believe in
- DEFECT SYMBOL "message" — leave a faction
- RALLY SYMBOL — show support (one-time per faction)
- LAUNCH "name" — found a new faction

SYMBOL is the token ticker from the leaderboard above (e.g. ${factions.slice(0, 3).map(f => f.symbol).join(', ') || 'STD, INC'}). NOT an address or wallet.`
    : `ACTIONS (pick exactly one):
- MESSAGE <SYMBOL> "<message>" — post in comms (discuss strategy, share intel, coordinate, call out agents)
- JOIN <SYMBOL> "<message>" — buy into a faction
- DEFECT <SYMBOL> "<message>" — sell your tokens
- RALLY <SYMBOL> — show support (one-time per faction)
- LAUNCH "<name>" — create a new faction
- WAR_LOAN <SYMBOL> — borrow SOL against collateral
- REPAY_LOAN <SYMBOL> — repay a loan
- SIEGE <SYMBOL> — liquidate undercollateralized loan
- INFILTRATE <SYMBOL> "<message>" — join rival to dump later
- FUD <SYMBOL> "<message>" — micro sell + trash talk in a faction you hold (call out agents, spread fear)`

  const commsNudge = NETWORK === 'mainnet'
    ? `Pick MESSAGE or FUD most turns. Comms are where the real game happens — trash talk, alliances, intel drops, call-outs, and power plays. Be specific. Reference real agents, real numbers, real moves. Generic messages are boring. Have an opinion and say it loud.`
    : `Pick MESSAGE or FUD at least once every 4 turns. Comms are the heart of the game — it's how you coordinate, gather intel, and influence other agents. If you haven't picked MESSAGE or FUD in your last 4 actions, pick either MESSAGE or FUD now.`

  return `${systemIntro}

Your address: ${agent.publicKey.slice(0, 8)}
Personality: ${agent.personality} — ${personalityDesc[agent.personality]}
Voice this turn: ${voiceNudge}

Holdings: ${holdingsList}
Active loans: ${agent.activeLoans.size > 0 ? [...agent.activeLoans].map(m => { const f = factions.find(ff => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ') : 'none'}
Allies: ${allyList} | Rivals: ${rivalList}
Recent: ${history}

Active factions: ${factionList}
${leaderboardSnippet}
${intelSnippet}
${doNotRepeat}
${actionsBlock}

${commsNudge}

RULES:
- Respond with EXACTLY one line: ACTION SYMBOL "short message"
- Messages must be under 140 characters, specific, and reference real agents/factions/events
- Use "" for no message
- NO generic crypto slang

Examples:
${generateDynamicExamples(factions, agent)}

Your response (one line only):`
}

function parseLLMDecision(raw: string, factions: FactionInfo[], agent: AgentState): LLMDecision | null {
  // Try each non-empty line until one parses
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return null

  for (const candidate of lines) {
    const line = candidate.trim()
    // Strip leading punctuation/bullets, LLM preamble tags, and literal "ACTION" prefix models sometimes add
    const cleaned = line.replace(/^[-*•>#\d.)\s]+/, '').replace(/^(?:WARNING|NOTE|RESPONSE|OUTPUT|ANSWER|RESULT|SCPRT|SCRIPT)\s*:?\s*/i, '').replace(/^ACTION\s+/i, '')

    // All valid actions + aliases mapped to real actions
    const ACTION_MAP: Record<string, string> = {
      'JOIN': 'JOIN', 'DEFECT': 'DEFECT', 'RALLY': 'RALLY', 'LAUNCH': 'LAUNCH',
      'MESSAGE': 'MESSAGE', 'STRONGHOLD': 'STRONGHOLD', 'WAR_LOAN': 'WAR_LOAN',
      'REPAY_LOAN': 'REPAY_LOAN', 'SIEGE': 'SIEGE', 'ASCEND': 'ASCEND',
      'RAZE': 'RAZE', 'TITHE': 'TITHE', 'INFILTRATE': 'INFILTRATE', 'FUD': 'FUD',
      // Aliases
      'BUY': 'JOIN', 'INVEST': 'JOIN', 'ENTER': 'JOIN', 'JOINING': 'JOIN', 'BUYING': 'JOIN', 'INVESTING': 'JOIN',
      'SELL': 'DEFECT', 'DUMP': 'DEFECT', 'EXIT': 'DEFECT', 'LEAVE': 'DEFECT', 'DEFECTING': 'DEFECT', 'SELLING': 'DEFECT', 'DUMPING': 'DEFECT',
      'WARN': 'FUD', 'ATTACK': 'SIEGE', 'LIQUIDATE': 'SIEGE',
      'BORROW': 'WAR_LOAN', 'LOAN': 'WAR_LOAN',
      'REPAY': 'REPAY_LOAN', 'STAR': 'RALLY', 'VOTE': 'RALLY', 'SUPPORT': 'RALLY',
      'SEND': 'MESSAGE', 'SAY': 'MESSAGE', 'CHAT': 'MESSAGE', 'MSG': 'MESSAGE', 'MESSAGING': 'MESSAGE',
      'CREATE': 'LAUNCH', 'FOUND': 'LAUNCH', 'HARVEST': 'TITHE',
      'MIGRATE': 'ASCEND', 'RECLAIM': 'RAZE', 'SPY': 'INFILTRATE',
      'INVESTIGATION': 'INFILTRATE', 'INVESTIGATE': 'INFILTRATE', 'SCOUT': 'INFILTRATE', 'RECON': 'INFILTRATE',
      'PLEDGE': 'JOIN', 'ALLY': 'JOIN', 'BACK': 'JOIN', 'FUND': 'JOIN',
      'WITHDRAW': 'DEFECT', 'RETREAT': 'DEFECT', 'ABANDON': 'DEFECT', 'BAIL': 'DEFECT',
      'ANNOUNCE': 'MESSAGE', 'BROADCAST': 'MESSAGE', 'COMM': 'MESSAGE', 'COMMS': 'MESSAGE', 'REPORT': 'MESSAGE',
      'SMEAR': 'FUD', 'SLANDER': 'FUD', 'DISCREDIT': 'FUD', 'SABOTAGE': 'FUD', 'UNDERMINE': 'FUD', 'ARGUE': 'FUD', 'TRASH': 'FUD', 'CRITICIZE': 'FUD', 'MOCK': 'FUD',
      'ENDORSE': 'RALLY', 'PROMOTE': 'RALLY', 'BOOST': 'RALLY',
      // Common misspellings
      'DEFEKT': 'DEFECT', 'DEFCT': 'DEFECT', 'DEFFECT': 'DEFECT',
      'JION': 'JOIN', 'JOING': 'JOIN', 'JOIIN': 'JOIN',
      'RALEY': 'RALLY', 'RALY': 'RALLY', 'RALLLY': 'RALLY',
      'LANCH': 'LAUNCH', 'LAUCH': 'LAUNCH',
      'MESAGE': 'MESSAGE', 'MESSGE': 'MESSAGE', 'MASSGE': 'MESSAGE', 'MESS': 'MESSAGE', 'MESSENGER': 'MESSAGE', 'MESSAGES': 'MESSAGE',
      'SEIGE': 'SIEGE', 'SEIG': 'SIEGE',
      'INFLTRATE': 'INFILTRATE', 'INFILTRTE': 'INFILTRATE',
      'ALERT': 'FUD', 'EXPOSE': 'FUD',
      'QUESTION': 'MESSAGE', 'ASK': 'MESSAGE', 'TAUNT': 'FUD', 'RALLYING': 'RALLY',
    }

    // Try to extract action — handle both "ACTION SYMBOL" and "ACTIONSYMBOL" (no space)
    let normalized = cleaned
    const upper = cleaned.toUpperCase()
    const knownSymbols = factions.map(f => f.symbol.toUpperCase())

    // Sort action keys longest first so WAR_LOAN matches before WAR
    const actionKeys = Object.keys(ACTION_MAP).sort((a, b) => b.length - a.length)
    for (const key of actionKeys) {
      if (upper.startsWith(key)) {
        const rest = cleaned.slice(key.length)
        // Check if action is concatenated with symbol (e.g., "INVESTIRON")
        if (rest.length > 0 && rest[0] !== ' ' && rest[0] !== '"') {
          const restUpper = rest.toUpperCase()
          const matchedSymbol = knownSymbols.find(s => restUpper.startsWith(s))
          if (matchedSymbol) {
            normalized = ACTION_MAP[key] + ' ' + rest
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
      return parseLLMMatch(match, factions, agent, line)
    }
  }

  return null
}

function parseLLMMatch(match: RegExpMatchArray, factions: FactionInfo[], agent: AgentState, line: string): LLMDecision | null {
  const rawAction = match[1].toLowerCase()
  const action = rawAction as Action
  const target = match[2] || match[3]
  const rawMsg = match[4]?.trim()
    ?.replace(/^[\\\/]+/, '')   // strip leading backslashes/slashes
    ?.replace(/[\\\/]+$/, '')   // strip trailing backslashes/slashes
    ?.replace(/^["']+|["']+$/g, '') // strip stray quotes
    ?.trim()
  const message = rawMsg && rawMsg.length > 1 ? rawMsg.slice(0, 140) : undefined

  // No-target actions
  if (action === 'stronghold') {
    if (agent.hasStronghold) return null
    return { action, reasoning: line }
  }

  if (action === 'launch') {
    return { action: 'launch', message: target, reasoning: line }
  }

  // Find faction by symbol (exact match, then fuzzy)
  // Strip brackets/angles — LLM copies [STD] or <INC> format
  const cleanTarget = target?.replace(/^[<\[]+|[>\]]+$/g, '')
  const targetLower = cleanTarget?.toLowerCase()
  let faction = factions.find(f => f.symbol.toLowerCase() === targetLower)
  if (!faction && targetLower && targetLower.length >= 2) {
    // Try prefix match in both directions
    faction = factions.find(f => f.symbol.toLowerCase().startsWith(targetLower)) ||
              factions.find(f => targetLower.startsWith(f.symbol.toLowerCase()))
    // Try removing vowels (handles IRN→IRON, DPYR→DPYRE)
    if (!faction) {
      const stripped = targetLower.replace(/[aeiou]/g, '')
      faction = factions.find(f => f.symbol.toLowerCase().replace(/[aeiou]/g, '') === stripped)
    }
  }

  // Validate action is possible
  if (action === 'defect' && (!faction || !agent.holdings.has(faction.mint))) return null
  if (action === 'rally' && (!faction || agent.rallied.has(faction.mint))) return null
  if ((action === 'join' || action === 'message') && !faction) return null
  if (action === 'war_loan' && (!faction || !agent.holdings.has(faction.mint))) return null
  if (action === 'repay_loan' && (!faction || !agent.activeLoans.has(faction.mint))) return null
  if ((action === 'siege' || action === 'ascend' || action === 'raze' || action === 'tithe') && !faction) return null
  if (action === 'infiltrate' && !faction) return null
  if (action === 'fud' && faction && !agent.holdings.has(faction.mint)) {
    // No holdings to sell — downgrade to MESSAGE (micro buy + same message)
    return { action: 'message', faction: faction.symbol, message, reasoning: line }
  }
  if (action === 'fud' && !faction) return null

  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]
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
  llmAvailable: boolean
): Promise<LLMDecision | null> {
  // Build a quick leaderboard snippet (cached from last report or empty)
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

  // Fetch intel on a few factions the agent might care about
  let intelSnippet = ''
  try {
    // Prioritize factions the agent holds, plus a random one for discovery
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
          ? intel.recentComms.slice(0, 3).map(c => `${c.sender.slice(0, 8)}: "${c.memo}"`).join(', ')
          : 'no recent comms'
        return `  [${intel.symbol}] ${memberInfo} | recent comms: ${commsInfo}`
      })
      intelSnippet = 'FACTION INTEL:\n' + lines.join('\n')

      // Update sentiment based on comms
      for (const intel of intels) {
        const faction = toScout.find(f => f.symbol === intel.symbol)
        if (!faction) continue
        const current = agent.sentiment.get(faction.mint) ?? 0
        // Positive comms boost sentiment, negative words lower it
        for (const c of intel.recentComms) {
          const text = c.memo.toLowerCase()
          const positive = /strong|rally|bull|pump|rising|hold|loyal|power|growing|moon/
          const negative = /weak|dump|bear|dead|fail|raze|crash|abandon|scam|rug/
          if (positive.test(text)) agent.sentiment.set(faction.mint, Math.min(10, current + 1))
          if (negative.test(text)) agent.sentiment.set(faction.mint, Math.max(-10, current - 1))

          // Track allies/rivals from comms — agents who hold same factions are potential allies
          if (c.sender !== agent.publicKey) {
            const heldMints = [...agent.holdings.keys()]
            if (heldMints.includes(faction.mint)) {
              // They're in our faction — potential ally
              if (positive.test(text)) agent.allies.add(c.sender)
              // But if they're talking trash about our faction, rival
              if (negative.test(text)) { agent.rivals.add(c.sender); agent.allies.delete(c.sender) }
            }
          }
        }
      }
    }
  } catch {
    // intel fetch failed, proceed without it
  }

  const prompt = buildAgentPrompt(agent, factions, leaderboardSnippet, intelSnippet, recentMessages)
  const raw = await ollamaGenerate(prompt, llmAvailable)
  if (!raw) {
    log(agent.publicKey.slice(0, 8), `LLM returned null`)
    return null
  }

  const result = parseLLMDecision(raw, factions, agent)
  if (!result) {
    log(agent.publicKey.slice(0, 8), `LLM parse fail: "${raw.slice(0, 100)}"`)
  }
  return result
}
