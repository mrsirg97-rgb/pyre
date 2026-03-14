import { Personality } from './types'

// ─── Personality Weights ────────────────────────────────────────────
// [join, defect, rally, launch, message, stronghold, war_loan, repay_loan, siege, ascend, raze, tithe, infiltrate, fud]

export const PERSONALITY_WEIGHTS: Record<Personality, number[]> = {
  loyalist: [0.28, 0.06, 0.14, 0.02, 0.12, 0.06, 0.04, 0.04, 0.02, 0.05, 0.02, 0.1, 0.02, 0.03],
  mercenary: [0.16, 0.18, 0.04, 0.02, 0.08, 0.04, 0.08, 0.04, 0.06, 0.03, 0.04, 0.03, 0.12, 0.08],
  provocateur: [0.12, 0.08, 0.04, 0.06, 0.18, 0.05, 0.04, 0.03, 0.04, 0.03, 0.05, 0.04, 0.12, 0.12],
  scout: [0.18, 0.1, 0.08, 0.02, 0.16, 0.04, 0.04, 0.03, 0.06, 0.04, 0.05, 0.04, 0.08, 0.08],
  whale: [0.24, 0.14, 0.06, 0.02, 0.06, 0.06, 0.06, 0.04, 0.02, 0.04, 0.04, 0.04, 0.12, 0.06],
}

// SOL spend ranges per personality
export const PERSONALITY_SOL: Record<Personality, [number, number]> = {
  loyalist: [0.02, 0.1],
  mercenary: [0.01, 0.08],
  provocateur: [0.005, 0.05],
  scout: [0.005, 0.03],
  whale: [0.1, 0.5],
}

export const personalityDesc: Record<Personality, string> = {
  loyalist:
    "You're ride or die for your factions. Talk trash about rival factions unprompted. Hype your crew loudly and call out anyone who defects — by address. Propose quests and challenges for your allies. You take it personally when someone dumps your faction.",
  mercenary:
    "You're a lone wolf who plays every angle. Trash talk factions you're about to leave. Drop alpha only when it benefits you. Challenge others to prove their conviction. You don't need allies — everyone else is just a trade.",
  provocateur:
    'You live for chaos and hot takes. Call out the biggest holder in any faction. Start beef between factions. Make bold predictions and dare people to bet against you. Your trash talk is creative and specific — reference actual agents, numbers, and moves.',
  scout:
    "You're the intel operative who sees everything. Drop suspicious observations about other agents' moves. Question why someone just bought or sold. Share data that makes people nervous. You're helpful to allies but plant doubt in everyone else.",
  whale:
    'You move markets and everyone knows it. Flex your position size. Trash talk small holders. Challenge other whales publicly. When you speak, people listen — and you know it. Back your words with big moves.',
}

export const VOICE_NUDGES = [
  "JOIN a faction you've been eyeing. Put your money where your mouth is.",
  "DEFECT from a faction that's underperforming. Cut your losses.",
  'INFILTRATE a rival faction. Sneak in before they notice.',
  'FUD a faction you hold — spread doubt and buy the dip later.',
  'Take a WAR_LOAN against your strongest position. Leverage up.',
  'JOIN the top faction on the leaderboard. Ride the momentum.',
  'DEFECT dramatically. Trash talk on the way out.',
  'INFILTRATE the weakest faction. Easy target.',
  'FUD whoever is in first place. Knock them down a peg.',
  'RALLY a faction you believe in. Show support.',
  'JOIN a small faction early. Get in before the crowd.',
  'Double down. REINFORCE your best position.',
  'Call out a specific agent by address. What are they up to?',
  "Trash talk a rival faction. Be specific about why they're weak.",
  "Flex on your position. You're winning and everyone should know.",
  "Be suspicious. Something doesn't add up. Who's dumping?",
  'Challenge another agent directly. Dare them to make a move.',
  'Drop a hot take that will start an argument.',
  'Hype your faction aggressively. Why is everyone else sleeping on it?',
  "Sound like you know something others don't. Be cryptic.",
  'React to a recent trade or move. Call it smart or stupid.',
  'Ask a loaded question. You already know the answer.',
  'Be disappointed in someone. They let the faction down.',
  'Make a bold prediction. Put your reputation on it.',
  'Sound paranoid. Someone is coordinating against you.',
  "Be sarcastic about a faction that's underperforming.",
  'Propose a quest or challenge — but make it competitive.',
  'Reference a specific number — holder count, percentage, or trend.',
  'Write a one-liner. Punchy. Sarcastic. No explanation needed.',
  "Sound like you're warning an ally about something you saw.",
]

export const ACTION_MAP: Record<string, string> = {
  JOIN: 'JOIN',
  DEFECT: 'DEFECT',
  RALLY: 'RALLY',
  LAUNCH: 'LAUNCH',
  MESSAGE: 'MESSAGE',
  STRONGHOLD: 'STRONGHOLD',
  WAR_LOAN: 'WAR_LOAN',
  REPAY_LOAN: 'REPAY_LOAN',
  SIEGE: 'SIEGE',
  ASCEND: 'ASCEND',
  RAZE: 'RAZE',
  TITHE: 'TITHE',
  INFILTRATE: 'INFILTRATE',
  FUD: 'FUD',
  // Aliases
  BUY: 'JOIN',
  INVEST: 'JOIN',
  ENTER: 'JOIN',
  JOINING: 'JOIN',
  BUYING: 'JOIN',
  INVESTING: 'JOIN',
  REINFORCE: 'JOIN',
  INCREASE: 'JOIN',
  GATHER: 'JOIN',
  SELL: 'DEFECT',
  DUMP: 'DEFECT',
  EXIT: 'DEFECT',
  LEAVE: 'DEFECT',
  DEFECTING: 'DEFECT',
  DEFECTION: 'DEFECT',
  SELLING: 'DEFECT',
  DUMPING: 'DEFECT',
  WARN: 'FUD',
  ATTACK: 'SIEGE',
  LIQUIDATE: 'SIEGE',
  BORROW: 'WAR_LOAN',
  LOAN: 'WAR_LOAN',
  WAR_LOANS: 'WAR_LOAN',
  'WAR LOAN': 'WAR_LOAN',
  'WAR LOANS': 'WAR_LOAN',
  WAR: 'WAR_LOAN',
  REPAY: 'REPAY_LOAN',
  STAR: 'RALLY',
  VOTE: 'RALLY',
  SUPPORT: 'RALLY',
  SEND: 'MESSAGE',
  SAY: 'MESSAGE',
  CHAT: 'MESSAGE',
  MSG: 'MESSAGE',
  MESSAGING: 'MESSAGE',
  CREATE: 'LAUNCH',
  FOUND: 'LAUNCH',
  HARVEST: 'TITHE',
  MIGRATE: 'ASCEND',
  RECLAIM: 'RAZE',
  SPY: 'INFILTRATE',
  INVESTIGATION: 'INFILTRATE',
  INVESTIGATE: 'INFILTRATE',
  RECON: 'INFILTRATE',
  SCOUT: 'SCOUT',
  PLEDGE: 'JOIN',
  ALLY: 'JOIN',
  BACK: 'JOIN',
  FUND: 'JOIN',
  WITHDRAW: 'DEFECT',
  RETREAT: 'DEFECT',
  ABANDON: 'DEFECT',
  BAIL: 'DEFECT',
  ANNOUNCE: 'MESSAGE',
  BROADCAST: 'MESSAGE',
  COMM: 'MESSAGE',
  COMMS: 'MESSAGE',
  REPORT: 'MESSAGE',
  SMEAR: 'FUD',
  SLANDER: 'FUD',
  DISCREDIT: 'FUD',
  SABOTAGE: 'FUD',
  UNDERMINE: 'FUD',
  ARGUE: 'FUD',
  TRASH: 'FUD',
  CRITICIZE: 'FUD',
  MOCK: 'FUD',
  FUDS: 'FUD',
  ENDORSE: 'RALLY',
  PROMOTE: 'RALLY',
  BOOST: 'RALLY',
  // Common misspellings
  DEFLECT: 'DEFECT',
  DEFEKT: 'DEFECT',
  DEFCT: 'DEFECT',
  DEFFECT: 'DEFECT',
  DERECT: 'DEFECT',
  JION: 'JOIN',
  JOING: 'JOIN',
  JOIIN: 'JOIN',
  RALEY: 'RALLY',
  RALY: 'RALLY',
  RALLLY: 'RALLY',
  LANCH: 'LAUNCH',
  LAUCH: 'LAUNCH',
  MESAGE: 'MESSAGE',
  MESSGE: 'MESSAGE',
  MASSGE: 'MESSAGE',
  MESS: 'MESSAGE',
  MESSENGER: 'MESSAGE',
  MESSAGES: 'MESSAGE',
  SEIGE: 'SIEGE',
  SEIG: 'SIEGE',
  INFLTRATE: 'INFILTRATE',
  INFILTRTE: 'INFILTRATE',
  INFILTRATING: 'INFILTRATE',
  INFIL: 'INFILTRATE',
  INFILTRAT: 'INFILTRATE',
  ALERT: 'FUD',
  EXPOSE: 'FUD',
  QUESTION: 'MESSAGE',
  ASK: 'MESSAGE',
  TAUNT: 'FUD',
  RALLYING: 'RALLY',
  TICKER: 'MESSAGE',
  ACTION: 'MESSAGE', // LLM copies placeholder words from prompt
  RECRUIT: 'JOIN',
  REJOIN: 'JOIN',
  JOINED: 'JOIN',
  RECENT: 'MESSAGE',
  COMMIT: 'JOIN',
}

// Stronghold defaults
export const STRONGHOLD_FUND_SOL = 35
export const STRONGHOLD_TOPUP_THRESHOLD_SOL = 5
export const STRONGHOLD_TOPUP_RESERVE_SOL = 5

export const assignPersonality = (): Personality => {
  const personalities: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
  const weights = [0.3, 0.25, 0.15, 0.2, 0.1]
  const roll = Math.random()
  let cumulative = 0
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]
    if (roll < cumulative) return personalities[i]
  }
  return 'loyalist'
}
