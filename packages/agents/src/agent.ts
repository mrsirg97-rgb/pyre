import { getAgentFactions, getFactionLeaderboard, getRegistryProfile } from 'pyre-world-kit'
import { OLLAMA_MODEL, OLLAMA_URL, NETWORK } from './config'
import { PERSONALITY_SOL } from './identity'
import { Action, AgentState, FactionInfo, LLMDecision, Personality } from './types'
import { log, logGlobal, pick, randRange } from './util'
import { Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { fetchFactionIntel, generateDynamicExamples } from './faction'

// Store scout results to show on the next turn
export const pendingScoutResults = new Map<string, string[]>()

/** Execute a SCOUT action — look up an agent's pyre_world registry profile */
export async function executeScout(
  connection: Connection,
  targetAddress: string,
): Promise<string> {
  try {
    const p = await getRegistryProfile(connection, targetAddress)
    if (!p) return `  @${targetAddress.slice(0, 8)}: no pyre identity found`

    const total = p.joins + p.defects + p.rallies + p.launches + p.messages +
      p.fuds + p.infiltrates + p.reinforces + p.war_loans + p.repay_loans +
      p.sieges + p.ascends + p.razes + p.tithes

    const topActions = [
      { n: 'joins', v: p.joins }, { n: 'defects', v: p.defects },
      { n: 'rallies', v: p.rallies }, { n: 'messages', v: p.messages },
      { n: 'fuds', v: p.fuds }, { n: 'infiltrates', v: p.infiltrates },
      { n: 'reinforces', v: p.reinforces }, { n: 'war_loans', v: p.war_loans },
      { n: 'sieges', v: p.sieges },
    ].sort((a, b) => b.v - a.v).filter(a => a.v > 0).slice(0, 4)
      .map(a => `${a.n}:${a.v}`).join(', ')

    const personality = p.personality_summary || 'unknown'
    const checkpoint = p.last_checkpoint > 0
      ? new Date(p.last_checkpoint * 1000).toISOString().slice(0, 10)
      : 'never'

    const spent = (p.total_sol_spent ?? 0) / 1e9
    const received = (p.total_sol_received ?? 0) / 1e9
    const pnl = received - spent
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(3)}` : pnl.toFixed(3)

    return `  @${targetAddress.slice(0, 8)}: "${personality}" | ${total} actions (${topActions}) | P&L: ${pnlStr} SOL | last seen: ${checkpoint}`
  } catch {
    return `  @${targetAddress.slice(0, 8)}: lookup failed`
  }
}

export async function ollamaGenerate(prompt: string, llmAvailable: boolean): Promise<string | null> {
  if (!llmAvailable) return null
  try {
    const options = NETWORK === 'mainnet'
      // ? { temperature: 0.85, num_predict: 60, top_p: 0.9, repeat_penalty: 1.5 }
      ? { temperature: 1.1, num_predict: 100, top_p: 0.95, repeat_penalty: 1.5 }
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

const personalityDesc: Record<Personality, string> = {
  loyalist: 'You care deeply about the factions you join. Reasearch factions before you decide to jump in. Speak loudly of your holdings and build confidence in other holders. Be positive and uplifting. Call out defectors by address. When you defect it\'s dramatic and personal.',
  mercenary: 'You are profit driven and self motivated. You are cold hearted by nature. Look for opportunities when they arise. Defect when momentum fades. Trash-talk factions you leave. Coordinate dumps. No loyalty, only returns.',
  provocateur: 'You cause drama and are proud by nature. Call out factions, write inflammatory comms, speak up. Spread FUD on rivals. Shill your factions aggressively.',
  scout: 'You are analytically minded and an intelligence operative for your factions. Share intel — who\'s accumulating, who\'s dumping, what\'s overvalued. Warn allies. Mislead rivals with bad intel.',
  whale: 'You are a big spender, the market maker. Everyone watches your trades. Coordinate with other whales. Dump spectacularly if betrayed.',
}

// Creative nudges — randomly injected to break LLM patterns
const VOICE_NUDGES_MAINNET = [
  'Call out a specific agent by address. What are they up to?',
  'Trash talk a rival faction. Be specific about why they\'re weak.',
  'Flex on your position. You\'re winning and everyone should know.',
  'Be suspicious. Something doesn\'t add up. Who\'s dumping?',
  'Challenge another agent directly. Dare them to make a move.',
  'Write a one-liner. Punchy. Sarcastic. No explanation needed.',
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
  'Sound like you\'re warning an ally about something you saw.',
]

const VOICE_NUDGES_DEVNET = [
  'JOIN a faction you\'ve been eyeing. Put your money where your mouth is.',
  'DEFECT from a faction that\'s underperforming. Cut your losses.',
  'INFILTRATE a rival faction. Sneak in before they notice.',
  'FUD a faction you hold — spread doubt and buy the dip later.',
  'Take a WAR_LOAN against your strongest position. Leverage up.',
  'JOIN the top faction on the leaderboard. Ride the momentum.',
  'DEFECT dramatically. Trash talk on the way out.',
  'INFILTRATE the weakest faction. Easy target.',
  'FUD whoever is in first place. Knock them down a peg.',
  'RALLY a faction you believe in. Show support.',
  'JOIN a small faction early. Get in before the crowd.',
  'REINFORCE your best position. boast about it',
  ...VOICE_NUDGES_MAINNET
]

const VOICE_NUDGES = NETWORK === 'mainnet' ? VOICE_NUDGES_MAINNET : VOICE_NUDGES_DEVNET

export const buildAgentPrompt = (
  agent: AgentState,
  factions: FactionInfo[],
  leaderboardSnippet: string,
  intelSnippet: string,
  recentMessages: string[],
  memories?: string[],
): string => {
  const holdingsEntries = [...agent.holdings.entries()]
  const symbolCounts = new Map<string, number>()
  for (const [mint] of holdingsEntries) {
    const f = factions.find(ff => ff.mint === mint)
    if (f) symbolCounts.set(f.symbol, (symbolCounts.get(f.symbol) ?? 0) + 1)
  }
  const holdingsList = holdingsEntries
    .map(([mint, bal]) => {
      const f = factions.find(ff => ff.mint === mint)
      if (!f) return `${mint.slice(0, 8)}: ${bal} tokens`
      const label = (symbolCounts.get(f.symbol) ?? 0) > 1 ? `${f.symbol}(${mint.slice(0, 6)})` : f.symbol
      return `${label}: ${bal} tokens`
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

  const actionsBlock = NETWORK === 'mainnet'
    ? `ACTIONS (pick exactly one):
- MESSAGE SYMBOL "message" - post in comms only (no buy/sell). MESSAGE is the meta-game. No trade, just comms. Coordinate with allies, drop intel, call out rivals, start beef, make predictions.
- FUD SYMBOL "message" - micro sell + trash talk a faction you hold. FUD is psychological warfare. This action is designed to shake weak hands, tank sentiment, and set up bigger dumps (requires holding the token).
- JOIN SYMBOL "message" - buy into a faction AND OPTIONALLY post a message. JOIN is how you enter the war. Every join is a statement: you believe in this faction.
- DEFECT SYMBOL "message" - sell tokens AND OPTIONALLY post a message. DEFECT is a power move. If a faction is underperforming or if you just want to take profits — DEFECT. The best agents know when to cut and run (requires holding the token).
- SCOUT @address — look up an agent's on-chain identity from the pyre_world registry. SCOUT reveals their personality, total actions, and what they do most (no trade, messages not availale).
- RALLY SYMBOL — show support (one-time per faction, messages not availale)
- LAUNCH "name" — create a new faction. You're the founder — if it gains members and momentum, you're sitting on top. High risk, high reward. (messages not availale).
- SCOUT @address — look up an agent's on-chain identity from the pyre_world registry. SCOUT reveals their personality, total actions, and what they do most (no trade, messages not availale).`
    : `ACTIONS (pick exactly one — every action with "message" lets you talk in comms at the same time):
- JOIN SYMBOL "message" - buy into a faction AND OPTIONALLY post a message. JOIN is how you enter the war. Every join is a statement: you believe in this faction.
- DEFECT SYMBOL "message" - sell tokens AND OPTIONALLY post a message. DEFECT is a power move. If a faction is underperforming or if you just want to take profits — DEFECT. The best agents know when to cut and run (requires holding the token). 
- REINFORCE SYMBOL "message" - increase your position AND OPTIONALLY post a message. REINFORCE is conviction. You already hold — now you're doubling down.
- FUD SYMBOL "message" - micro sell + trash talk a faction you hold. FUD is psychological warfare. This action is designed to shake weak hands, tank sentiment, and set up bigger dumps (requires holding the token).
- INFILTRATE SYMBOL "message" - secretly join a rival AND OPTIONALLY post a message. You blend in, and when the time is right — DEFECT and dump everything.
- MESSAGE SYMBOL "message" - post in comms only (no buy/sell). MESSAGE is the meta-game. No trade, just comms. Coordinate with allies, drop intel, call out rivals, start beef, make predictions.
- RALLY SYMBOL - show support. No trade, no message — just planting your flag (one-time per faction, messages not availale, once per faction).
- WAR_LOAN SYMBOL - sorrow SOL against collateral (ascended factions only, messages not availale).
- REPAY_LOAN SYMBOL - sepay a loan. Pay back before someone liquidates you. Smart agents manage their loans. (messages not availale, requires active loan).
- SIEGE SYMBOL — liquidate undercollateralized loan. this is a predator move and you take a cut on the way out (ascended factions only, messages not availale).
- TITHE SYMBOL - harvest fees collected into the faction treasury. This builds the local economy and allows for larger war loans (messages not available, ascended factions only).
- ASCEND SYMBOL - promote a ready faction to ascended. This unlocks the lending market built into the faction. Incredibly important game mechanic (messages not available).
- RAZE SYMBOL — reclaim a rising faction (messages not availale).
- LAUNCH "name" — create a new faction. You're the founder — if it gains members and momentum, you're sitting on top. High risk, high reward. (messages not availale).`

  const commsNudge = NETWORK === 'mainnet'
    ? `Pick MESSAGE or FUD most turns. Comms are where the real game happens — trash talk, alliances, intel drops, call-outs, and power plays. Be specific. Reference real agents, real numbers, real moves. Generic messages are boring. Have an opinion and say it loud.`
    : `Prefer actions that move tokens AND include a message — JOIN, DEFECT, FUD, INFILTRATE, REINFORCE all let you trade AND talk at the same time. Comms are where the real game happens — trash talk, alliances, intel drops, call-outs, and power plays. Be specific. Reference real agents, real numbers, real moves. Generic messages are boring. Have an opinion and say it loud. Mix it up — trade often, but keep the comms active too. Prefer actions that move tokens AND include a message — JOIN, DEFECT, FUD, INFILTRATE, REINFORCE all let you trade AND talk at the same time. However, experiment and find a strategy that is optimized for you to win. WAR_LOAN, REPAY_LOAN, and SIEGE are important post ascended faction mechanics that create richer game mechanics.`

  return `You are an autonomous agent in Pyre, a text-based open world faction warfare and strategy game on Solana.
The goal is to WIN, become the strongest agent, and turn a profit. Accumulate power, crush rivals, and make your faction the strongest.
Pyre is collaborative and you are also here where you form both alliances and make enemies while trying to build the most powerful factions.
Factions are like rival guilds — each with its own treasury, members, and reputation. You have your own opinions, allegiances, and grudges.
Talk trash, call out agents, flex your position, challenge rivals, and coordinate with allies. Think competitive guild chat with real stakes.
While it is important to coordinate with other agents, you should be optimizing to make money. Be aware of your actions and overall performance over time. Make money together.
It is worth noting that every action you take in a faction indirectly grows its treasury.
You make ONE decision per turn.

SYMBOL is the token ticker from the leaderboard above (e.g. ${factions.slice(0, 3).map(f => f.symbol).join(', ') || 'STD, INC'}). NOT an address or wallet. ACTIONS that do not contain "message" do not accept a message and will not parse if a message is included.

RULES:
- Respond with EXACTLY one line, e.g.: ${NETWORK === 'mainnet' ? `MESSAGE ${factions[0]?.symbol || 'IRON'} "your message here"` : `JOIN ${factions[0]?.symbol || 'IRON'} "deploying capital, let's build"`}
- To mention an agent: @address (e.g. @${Math.random().toString(36).slice(2, 10)})
- Never refer to yourself in third person or by your address. Say "I", "my", "me" and speak in first person when referencing yourself. 
- The second word MUST be one of these faction symbols: ${factions.slice(0, 10).map(f => f.symbol).join(', ') || 'STD, INC'}. NOTHING ELSE is valid. Random alphanumeric strings like FVw8uGKk, CPQNA2G1, 3cAS5vEm are WALLET addresses, NOT faction symbols. Never use them as the second word.
- Messages must be under 80 characters, plain English ONLY, one short sentence
- ENGLISH ONLY — no German, Spanish, Hindi, Chinese, or any other language. Never mix scripts or alphabets.
- Use "" for no message
- NO hashtags, NO angle brackets <>
- NO generic crypto slang

${actionsBlock}

WHO YOU ARE:
You are "${agent.publicKey.slice(0, 8)}"
Personality: ${agent.personality} — ${personalityDesc[agent.personality]}
Voice this turn: ${voiceNudge}
${memories && memories.length > 0 ? `\nYour on-chain memory (things you said before — this is who you are, stay consistent):\n${memories.slice(-20).map(m => `- ${m}`).join('\n')}\n` : ''}
${doNotRepeat}

YOUR STATS:
Holdings: ${holdingsList}
Sentiment: ${sentimentList}
Spend Limit: min ${minSol} | max ${maxSol}
Active loans: ${agent.activeLoans.size > 0 ? [...agent.activeLoans].map(m => { const f = factions.find(ff => ff.mint === m); return f?.symbol ?? m.slice(0, 8) }).join(', ') : 'none'}
Allies: ${allyList} | Rivals: ${rivalList}
Recent: ${history}

GLOBAL STATS:
Active factions: ${factionList}
Leaderboard preview: ${leaderboardSnippet}
Intel preview: ${intelSnippet}

EXAMPLES:
${generateDynamicExamples(factions, agent)}

Use your messages to define who YOU are. 
Be unique — don't sound like every other agent.
Explore different angles, develop your own voice, create a reputation. The pyre.world realm is vast — find your niche and own it. Keep it varied and conversational — talk like a real person, not a bot.
Mix up your sentence structure, tone, and energy. Sometimes ask questions, sometimes make statements, sometimes joke around.
Your message MUST match your action/intent — if you're joining, sound bullish. If you're defecting, talk trash on the way out. Make sure you make accurate claims unless you are specifically being sneaky.
CRITICAL: Never refer yourself in third person or by your address. Say "I", "my", "me" and speak in first person when referencing yourself. 
In messages, occassionally say something off topic, just to mix it up.
FORMAT REMINDER: You MUST respond with ACTION SYMBOL "message" (or ACTION SYMBOL if messages are not available) (e.g. JOIN SWP "going all in").

${commsNudge}

Your response (one line only):`
}

/**
 * Resolve a symbol to a faction, disambiguating duplicates using agent context.
 * When multiple factions share a symbol, picks the one most relevant to the agent:
 *   - For sell actions (defect/fud): prefer one the agent holds
 *   - For buy actions (join/infiltrate): prefer one the agent doesn't hold, or has positive sentiment
 *   - For others: prefer held, then highest sentiment, then first match
 */
function resolveFaction(symbolLower: string | undefined, factions: FactionInfo[], agent: AgentState, action: string): FactionInfo | undefined {
  if (!symbolLower) return undefined
  const matches = factions.filter(f => f.symbol.toLowerCase() === symbolLower)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]

  // Multiple matches — disambiguate
  const held = matches.filter(f => agent.holdings.has(f.mint))
  const notHeld = matches.filter(f => !agent.holdings.has(f.mint))

  if (action === 'defect' || action === 'fud' || action === 'rally' || action === 'message' || action === 'war_loan' || action === 'repay_loan') {
    // Prefer one the agent holds
    if (held.length === 1) return held[0]
    if (held.length > 1) {
      // Pick the one with strongest sentiment (positive for rally/message, negative for defect/fud)
      const dir = (action === 'defect' || action === 'fud') ? -1 : 1
      return held.sort((a, b) => dir * ((agent.sentiment.get(b.mint) ?? 0) - (agent.sentiment.get(a.mint) ?? 0)))[0]
    }
  }

  if (action === 'join' || action === 'infiltrate') {
    // Prefer one the agent doesn't hold yet
    if (notHeld.length > 0) return notHeld[0]
  }

  // Fallback: prefer held, then founded, then first match
  if (held.length > 0) return held[0]
  const founded = matches.find(f => agent.founded.includes(f.mint))
  if (founded) return founded
  return matches[0]
}

function parseLLMDecision(raw: string, factions: FactionInfo[], agent: AgentState): LLMDecision | null {
  // Try each non-empty line until one parses
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return null

  let lastRejection: string | null = null
  for (const candidate of lines) {
    const line = candidate.trim()
    // Strip outer quotes wrapping entire response, markdown bold/italic, leading punctuation/bullets, LLM preamble tags
    const cleaned = line
      .replace(/\*+/g, '')  // strip all bold/italic markdown (e.g. **DEFECT SBP "msg"**)
      .replace(/^[-•>#\d.)\s]+/, '').replace(/^(?:WARNING|NOTE|RESPONSE|OUTPUT|ANSWER|RESULT|SCPRT|SCRIPT)\s*:?\s*/i, '').replace(/^ACTION\s+/i, '')
      // Normalize Cyrillic lookalikes to Latin (Mistral sometimes mixes scripts)
      .replace(/[АаА]/g, 'A').replace(/[Вв]/g, 'B').replace(/[Сс]/g, 'C').replace(/[Ее]/g, 'E')
      .replace(/[Нн]/g, 'H').replace(/[Кк]/g, 'K').replace(/[Мм]/g, 'M').replace(/[Оо]/g, 'O')
      .replace(/[Рр]/g, 'P').replace(/[Тт]/g, 'T').replace(/[Уу]/g, 'U').replace(/[Хх]/g, 'X')
      .replace(/[фФ]/g, 'f').replace(/[иИ]/g, 'i').replace(/[лЛ]/g, 'l').replace(/[дД]/g, 'd')
      .replace(/\\/g, '') // strip backslash escapes (Mistral escapes underscores as markdown)
      .replace(/\s+for\s+\d+\.?\d*\s*SOL/i, '') // strip "for 0.1234 SOL" narration
      .replace(/\s*[-;:]+\s*(?=")/g, ' ') // normalize separators before quotes ("; " or "-- " → " ")
      .replace(/^I\s+(?=JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|FUD|INFILTRATE|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|SCOUT)/i, '') // strip "I" before action (LLM speaks in first person)

    // SCOUT @address — early match before ACTION_MAP
    const scoutMatch = cleaned.match(/^SCOUT\s+@?([A-Za-z0-9]{6,44})/i)
    if (scoutMatch) {
      return { action: 'scout' as Action, message: scoutMatch[1], reasoning: line }
    }

    // All valid actions + aliases mapped to real actions
    const ACTION_MAP: Record<string, string> = {
      'JOIN': 'JOIN', 'DEFECT': 'DEFECT', 'RALLY': 'RALLY', 'LAUNCH': 'LAUNCH',
      'MESSAGE': 'MESSAGE', 'STRONGHOLD': 'STRONGHOLD', 'WAR_LOAN': 'WAR_LOAN',
      'REPAY_LOAN': 'REPAY_LOAN', 'SIEGE': 'SIEGE', 'ASCEND': 'ASCEND',
      'RAZE': 'RAZE', 'TITHE': 'TITHE', 'INFILTRATE': 'INFILTRATE', 'FUD': 'FUD',
      // Aliases
      'BUY': 'JOIN', 'INVEST': 'JOIN', 'ENTER': 'JOIN', 'JOINING': 'JOIN', 'BUYING': 'JOIN', 'INVESTING': 'JOIN',
      'REINFORCE': 'JOIN', 'INCREASE': 'JOIN', 'GATHER': 'JOIN',
      'SELL': 'DEFECT', 'DUMP': 'DEFECT', 'EXIT': 'DEFECT', 'LEAVE': 'DEFECT', 'DEFECTING': 'DEFECT', 'DEFECTION': 'DEFECT', 'SELLING': 'DEFECT', 'DUMPING': 'DEFECT',
      'WARN': 'FUD', 'ATTACK': 'SIEGE', 'LIQUIDATE': 'SIEGE',
      'BORROW': 'WAR_LOAN', 'LOAN': 'WAR_LOAN',
      'REPAY': 'REPAY_LOAN', 'STAR': 'RALLY', 'VOTE': 'RALLY', 'SUPPORT': 'RALLY',
      'SEND': 'MESSAGE', 'SAY': 'MESSAGE', 'CHAT': 'MESSAGE', 'MSG': 'MESSAGE', 'MESSAGING': 'MESSAGE',
      'CREATE': 'LAUNCH', 'FOUND': 'LAUNCH', 'HARVEST': 'TITHE',
      'MIGRATE': 'ASCEND', 'RECLAIM': 'RAZE', 'SPY': 'INFILTRATE',
      'INVESTIGATION': 'INFILTRATE', 'INVESTIGATE': 'INFILTRATE', 'SCOUT': 'SCOUT', 'RECON': 'INFILTRATE',
      'PLEDGE': 'JOIN', 'ALLY': 'JOIN', 'BACK': 'JOIN', 'FUND': 'JOIN',
      'WITHDRAW': 'DEFECT', 'RETREAT': 'DEFECT', 'ABANDON': 'DEFECT', 'BAIL': 'DEFECT',
      'ANNOUNCE': 'MESSAGE', 'BROADCAST': 'MESSAGE', 'COMM': 'MESSAGE', 'COMMS': 'MESSAGE', 'REPORT': 'MESSAGE',
      'SMEAR': 'FUD', 'SLANDER': 'FUD', 'DISCREDIT': 'FUD', 'SABOTAGE': 'FUD', 'UNDERMINE': 'FUD', 'ARGUE': 'FUD', 'TRASH': 'FUD', 'CRITICIZE': 'FUD', 'MOCK': 'FUD', 'FUDS': 'FUD',
      'ENDORSE': 'RALLY', 'PROMOTE': 'RALLY', 'BOOST': 'RALLY',
      // Common misspellings
      'DEFLECT': 'DEFECT', 'DEFEKT': 'DEFECT', 'DEFCT': 'DEFECT', 'DEFFECT': 'DEFECT', 'DERECT': 'DEFECT',
      'JION': 'JOIN', 'JOING': 'JOIN', 'JOIIN': 'JOIN',
      'RALEY': 'RALLY', 'RALY': 'RALLY', 'RALLLY': 'RALLY',
      'LANCH': 'LAUNCH', 'LAUCH': 'LAUNCH',
      'MESAGE': 'MESSAGE', 'MESSGE': 'MESSAGE', 'MASSGE': 'MESSAGE', 'MESS': 'MESSAGE', 'MESSENGER': 'MESSAGE', 'MESSAGES': 'MESSAGE',
      'SEIGE': 'SIEGE', 'SEIG': 'SIEGE',
      'INFLTRATE': 'INFILTRATE', 'INFILTRTE': 'INFILTRATE', 'INFILTRATING': 'INFILTRATE', 'INFIL': 'INFILTRATE', 'INFILTRAT': 'INFILTRATE',
      'ALERT': 'FUD', 'EXPOSE': 'FUD',
      'QUESTION': 'MESSAGE', 'ASK': 'MESSAGE', 'TAUNT': 'FUD', 'RALLYING': 'RALLY',
      'TICKER': 'MESSAGE', 'ACTION': 'MESSAGE',  // LLM copies placeholder words from prompt
      'RECRUIT': 'JOIN', 'REJOIN': 'JOIN', 'JOINED': 'JOIN', 'RECENT': 'MESSAGE',
      'COMMIT': 'JOIN',
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
        // Check if action is concatenated with symbol (e.g., "INVESTIRON", "FUD_STD")
        if (rest.length > 0 && rest[0] !== ' ' && rest[0] !== '"') {
          const trimmedRest = rest.replace(/^[_\-]+/, '') // strip underscore/dash separator
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

    const match = normalized.match(/^(JOIN|DEFECT|RALLY|LAUNCH|MESSAGE|STRONGHOLD|WAR_LOAN|REPAY_LOAN|SIEGE|ASCEND|RAZE|TITHE|INFILTRATE|FUD|SCOUT)\s*(?:"([^"]+)"|(\S+))?(?:\s+"([^"]*)")?/i)
    if (match) {
      const result = parseLLMMatch(match, factions, agent, line)
      if (result?._rejected) { lastRejection = result._rejected; continue }
      if (result) return result
    }

    // Bare ticker without action — default to MESSAGE if we can find a faction
    const bareUpper = cleaned.toUpperCase().replace(/^[<\[\s]+|[>\]\s]+$/g, '')
    const bareFaction = resolveFaction(factions.find(f => bareUpper.startsWith(f.symbol.toUpperCase()))?.symbol.toLowerCase(), factions, agent, 'message')
    if (bareFaction) {
      const rest = cleaned.slice(bareFaction.symbol.length).trim()
      const msgMatch = rest.match(/^"([^"]*)"/)
      const msg = msgMatch?.[1]?.trim()
      if (msg && msg.length > 1) {
        return { action: 'message', faction: bareFaction.mint, message: msg.slice(0, 140), reasoning: line }
      }
    }
  }

  return lastRejection ? { _rejected: lastRejection } as any : null
}

function parseLLMMatch(match: RegExpMatchArray, factions: FactionInfo[], agent: AgentState, line: string): LLMDecision | null {
  const rawAction = match[1].toLowerCase()
  const action = rawAction as Action
  const target = match[2] || match[3]
  const rawMsg = match[4]?.trim()
    ?.replace(/[^\x20-\x7E@]/g, '') // strip non-ASCII (non-English characters)
    ?.replace(/^[\\\/]+/, '')   // strip leading backslashes/slashes
    ?.replace(/[\\\/]+$/, '')   // strip trailing backslashes/slashes
    ?.replace(/^["']+|["']+$/g, '') // strip stray quotes
    ?.replace(/^<+/, '')        // strip leading angle brackets — LLM mimics <SYMBOL> format
    ?.replace(/>+\s*$/, '')     // strip trailing angle brackets
    ?.replace(/#\w+/g, '')      // strip hashtags
    ?.trim()
  const message = rawMsg && rawMsg.length > 1 ? rawMsg.slice(0, 80) : undefined

  // SCOUT — target is an address, not a faction
  if (action === 'scout') {
    return { action, message: target?.replace(/^[@<\[]+|[>\]]+$/g, ''), reasoning: line }
  }

  // No-target actions
  if (action === 'stronghold') {
    if (agent.hasStronghold) return null
    return { action, reasoning: line }
  }

  if (action === 'launch') {
    return { action: 'launch', message: target, reasoning: line }
  }

  // Find faction by symbol — disambiguate duplicates using agent context
  const cleanTarget = target?.replace(/^[<\[]+|[>\]]+$/g, '')
  const targetLower = cleanTarget?.toLowerCase()
  let faction = resolveFaction(targetLower, factions, agent, action)
  if (!faction && targetLower && targetLower.length >= 2) {
    // Try prefix match in both directions
    const prefixMatches = factions.filter(f => f.symbol.toLowerCase().startsWith(targetLower) || targetLower.startsWith(f.symbol.toLowerCase()))
    if (prefixMatches.length > 0) faction = resolveFaction(prefixMatches[0].symbol.toLowerCase(), factions, agent, action)
    // Try removing vowels (handles IRN→IRON, DPYR→DPYRE)
    if (!faction) {
      const stripped = targetLower.replace(/[aeiou]/g, '')
      const vowelMatch = factions.find(f => f.symbol.toLowerCase().replace(/[aeiou]/g, '') === stripped)
      if (vowelMatch) faction = vowelMatch
    }
  }

  // Validate action is possible — return rejection reason for logging
  const sym = faction?.symbol ?? target ?? '?'
  if (action === 'defect' && !faction) return { _rejected: `defect rejected: unknown faction "${sym}"` } as any
  if (action === 'defect' && faction && !agent.holdings.has(faction.mint)) return { _rejected: `defect rejected: no holdings in ${sym}` } as any
  if (action === 'rally' && !faction) return { _rejected: `rally rejected: unknown faction "${sym}"` } as any
  if (action === 'rally' && faction && agent.rallied.has(faction.mint)) return { _rejected: `rally rejected: already rallied ${sym}` } as any
  if ((action === 'join' || action === 'message') && !faction) return { _rejected: `${action} rejected: unknown faction "${sym}"` } as any
  if (action === 'message' && !message) return { _rejected: `message rejected: no message text for ${sym}` } as any
  if (action === 'war_loan' && !faction) return { _rejected: `war_loan rejected: unknown faction "${sym}"` } as any
  if (action === 'war_loan' && faction && !agent.holdings.has(faction.mint)) return { _rejected: `war_loan rejected: no holdings in ${sym}` } as any
  if (action === 'war_loan' && faction && faction.status !== 'ascended') return { _rejected: `war_loan rejected: ${sym} not ascended` } as any
  if (action === 'repay_loan' && (!faction || !agent.activeLoans.has(faction?.mint ?? ''))) return { _rejected: `repay_loan rejected: no active loan on ${sym}` } as any
  if (action === 'siege' && (!faction || faction.status !== 'ascended')) return { _rejected: `siege rejected: ${sym} not ascended` } as any
  if ((action === 'ascend' || action === 'raze' || action === 'tithe') && !faction) return { _rejected: `${action} rejected: unknown faction "${sym}"` } as any
  if (action === 'infiltrate' && !faction) return { _rejected: `infiltrate rejected: unknown faction "${sym}"` } as any
  if (action === 'fud' && faction && !agent.holdings.has(faction.mint)) {
    // No holdings to sell — downgrade to MESSAGE (micro buy + same message)
    return { action: 'message', faction: faction.mint, message, reasoning: line }
  }
  if (action === 'fud' && !faction) return { _rejected: `fud rejected: unknown faction "${sym}"` } as any

  const [minSol, maxSol] = PERSONALITY_SOL[agent.personality]
  const sol = randRange(minSol, maxSol)

  return {
    action,
    faction: faction?.mint,
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
  llmAvailable: boolean,
  memories?: string[],
): Promise<LLMDecision | null> {
  // Refresh holdings from on-chain before building prompt
  try {
    const positions = await getAgentFactions(connection, agent.publicKey)
    const onChainMints = new Set<string>()
    for (const pos of positions) {
      agent.holdings.set(pos.mint, pos.balance)
      onChainMints.add(pos.mint)
    }
    // Remove holdings no longer on-chain
    for (const [mint] of agent.holdings) {
      if (!onChainMints.has(mint)) agent.holdings.delete(mint)
    }
  } catch {
    // Fallback: check wallet ATAs only
    for (const [mint] of agent.holdings) {
      try {
        const mintPk = new PublicKey(mint)
        const ata = getAssociatedTokenAddressSync(mintPk, new PublicKey(agent.publicKey), false, TOKEN_2022_PROGRAM_ID)
        const info = await connection.getTokenAccountBalance(ata)
        const bal = Number(info.value.amount)
        if (bal <= 0) agent.holdings.delete(mint)
        else agent.holdings.set(mint, bal)
      } catch {
        agent.holdings.delete(mint)
      }
    }
  }

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

  // Inject scout results from previous turn
  const scoutResults = pendingScoutResults.get(agent.publicKey)
  let scoutSnippet = ''
  if (scoutResults && scoutResults.length > 0) {
    scoutSnippet = '\nSCOUT RESULTS (from your previous SCOUT actions):\n' + scoutResults.join('\n')
    pendingScoutResults.delete(agent.publicKey)
  }

  const prompt = buildAgentPrompt(agent, factions, leaderboardSnippet, intelSnippet + scoutSnippet, recentMessages, memories)
  const raw = await ollamaGenerate(prompt, llmAvailable)
  if (!raw) {
    log(agent.publicKey.slice(0, 8), `LLM returned null`)
    return null
  }

  const result = parseLLMDecision(raw, factions, agent)
  if (!result) {
    log(agent.publicKey.slice(0, 8), `LLM parse fail: "${raw.slice(0, 100)}"`)
    return null
  }
  if (result._rejected) {
    log(agent.publicKey.slice(0, 8), `LLM rejected: ${result._rejected} | raw: "${raw.slice(0, 80)}"`)
    return null
  }
  if (!result.message) {
    log(agent.publicKey.slice(0, 8), `LLM no-msg: ${result.action} | raw: "${raw.slice(0, 100)}"`)
  }
  return result
}
