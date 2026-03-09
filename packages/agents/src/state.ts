import * as fs from 'fs'

import { AgentState, FactionInfo } from './types'
import { STATE_FILE } from './config'

export const saveState = (agents: AgentState[], factions: FactionInfo[]) => {
  const data = {
    factions,
    agents: agents.map(a => ({
      publicKey: a.publicKey,
      personality: a.personality,
      holdings: Object.fromEntries(a.holdings),
      founded: a.founded,
      rallied: Array.from(a.rallied),
      voted: Array.from(a.voted),
      hasStronghold: a.hasStronghold,
      activeLoans: Array.from(a.activeLoans),
      infiltrated: Array.from(a.infiltrated),
      sentiment: Object.fromEntries(a.sentiment),
      allies: Array.from(a.allies).slice(0, 20),
      rivals: Array.from(a.rivals).slice(0, 20),
      actionCount: a.actionCount,
      lastAction: a.lastAction,
      recentHistory: a.recentHistory.slice(-10),
    })),
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2))
}

export const loadState = (): { agents: Map<string, any>, factions: FactionInfo[] } => {
  if (!fs.existsSync(STATE_FILE)) return { agents: new Map(), factions: [] }
  const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  const agents = new Map<string, any>()
  for (const a of data.agents ?? []) {
    agents.set(a.publicKey, a)
  }
  return { agents, factions: data.factions ?? [] }
}