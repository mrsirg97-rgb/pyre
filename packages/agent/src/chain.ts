/**
 * Personality classification and weight computation.
 *
 * Stripped down from the original chain reconstruction module.
 * Objective state (holdings, sentiment, action counts) now lives in PyreKit.
 * This module only handles the subjective personality layer.
 */

import { PERSONALITY_WEIGHTS } from './defaults'
import { Action, Personality } from './types'

const ALL_ACTIONS: Action[] = [
  'join',
  'defect',
  'rally',
  'launch',
  'message',
  'reinforce',
  'war_loan',
  'repay_loan',
  'siege',
  'ascend',
  'raze',
  'tithe',
  'infiltrate',
  'fud',
]

/** Action type to index in the ALL_ACTIONS array */
export function actionIndex(action: Action): number {
  return ALL_ACTIONS.indexOf(action)
}

/**
 * Recompute weights from raw action counts.
 * Blends seed personality weights with observed frequency using exponential decay.
 */
export function weightsFromCounts(
  counts: number[],
  seedPersonality: Personality,
  decay = 0.85,
): number[] {
  const seed = [...PERSONALITY_WEIGHTS[seedPersonality]]
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return seed

  const observed = counts.map((c) => c / total)
  const seedFactor = Math.pow(decay, total)
  return seed.map((s, i) => s * seedFactor + observed[i] * (1 - seedFactor))
}

// ─── Memo Content Personality Signals ─────────────────────────────

const PROVOCATEUR_VOICE =
  /trash|beef|fight|chaos|war|destroy|crush|pathetic|laughable|weak|dead|fake|scam|clown|joke|fool|coward|expose|call.?out|dare|challenge|predict|bold|hot.?take/
const SCOUT_VOICE =
  /intel|data|notice|observ|suspicious|watch|track|report|warn|alert|question|why did|who.?s|pattern|trend|%|percent|member|holder|accumul/
const LOYALIST_VOICE =
  /ride.?or.?die|loyal|hold|believe|strong|build|together|ally|alliance|trust|support|back|hype|power|conviction|never.?sell|diamond/
const MERCENARY_VOICE =
  /profit|alpha|flip|exit|dump|cash|roi|returns|opportunity|play|angle|trade|stack|bag|gain|solo|lone.?wolf/
const WHALE_VOICE =
  /flex|position|size|deploy|capital|market|move|massive|big|dominate|everyone.?watch|listen|whale|stack|load/

function scoreMemoPersonality(memos: string[]): Record<Personality, number> {
  const scores: Record<Personality, number> = {
    loyalist: 0,
    mercenary: 0,
    provocateur: 0,
    scout: 0,
    whale: 0,
  }
  for (const memo of memos) {
    const text = memo.toLowerCase()
    if (PROVOCATEUR_VOICE.test(text)) scores.provocateur++
    if (SCOUT_VOICE.test(text)) scores.scout++
    if (LOYALIST_VOICE.test(text)) scores.loyalist++
    if (MERCENARY_VOICE.test(text)) scores.mercenary++
    if (WHALE_VOICE.test(text)) scores.whale++
  }
  return scores
}

// ─── Personality Classification ──────────────────────────────────

function buildClassifyPrompt(weights: number[], memos: string[]): string {
  const total = weights.reduce((a, b) => a + b, 0)
  const r =
    total > 0 ? weights.map((w) => ((w / total) * 100).toFixed(1) + '%') : weights.map(() => '0%')

  const actionSummary = `Overall action distribution:
  join: ${r[0]}, defect: ${r[1]}, rally: ${r[2]}, launch: ${r[3]}, message: ${r[4]}
  war_loan: ${r[5]}, repay_loan: ${r[6]}, siege: ${r[7]}
  ascend: ${r[8]}, raze: ${r[9]}, tithe: ${r[10]}, infiltrate: ${r[11]}, fud: ${r[12]}`

  const recentMemos = memos.slice(-150)
  const memoBlock =
    recentMemos.length > 0
      ? `\nThis agent's last ${recentMemos.length} messages (oldest first):\n${recentMemos.map((m, i) => `  ${i + 1}. "${m}"`).join('\n')}`
      : '\nNo messages from this agent.'

  return `Classify this Pyre agent into one of 5 personality types. Consider action numbers and message tone if available. If no messages, classify from action distribution only.

NOTE: In Pyre, "message" is a small buy with a memo attached, and "fud" is a small sell with a memo attached. Both involve real token movement on-chain — they are NOT just chat.

- loyalist: The true believer. Hypes THEIR faction specifically, defends allies by name, rallies the team. Loyalists almost never defect or fud — they stick. Only pick loyalist if defect rate is very low relative to joins.
- mercenary: The opportunist. Talks about profits, stacks, exits, next plays. Hops between factions. Pick mercenary if defect and/or infiltrate rates are notable.
- provocateur: The aggressor. Calls out specific agents by address, exposes plays, makes accusations, starts beef. Messages are targeted and confrontational.
- scout: The watcher. Keeps tabs on other agents' moves, tracks loyalty leaks, reports what's happening without being aggressive about it.
- whale: The silent trader. Very few messages relative to trade count. Lets actions speak. Pick whale only if message rate is clearly low compared to join/defect volume.

${actionSummary}
${memoBlock}

Respond with ONLY one word: loyalist, mercenary, provocateur, scout, or whale.`
}

/** Formula-based fallback for personality classification */
function classifyPersonalityFormula(weights: number[], memos: string[]): Personality {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 'loyalist'

  const r = weights.map((w) => w / total)
  const joinRate = r[0],
    defectRate = r[1],
    rallyRate = r[2],
    messageRate = r[4]
  const warLoanRate = r[5],
    siegeRate = r[7],
    titheRate = r[10]
  const infiltrateRate = r[11],
    fudRate = r[12]
  const commsRate = messageRate + fudRate
  const tradeRate = joinRate + defectRate
  const fudRatio = commsRate > 0 ? fudRate / commsRate : 0
  const msgRatio = commsRate > 0 ? messageRate / commsRate : 0

  const scores: Record<Personality, number> = {
    loyalist:
      msgRatio * 3 + joinRate * 2 + rallyRate * 3 + titheRate * 2 - fudRatio * 3 - defectRate * 2,
    mercenary:
      defectRate * 3 +
      infiltrateRate * 3 +
      warLoanRate * 2 +
      siegeRate * 2 -
      msgRatio * 2 -
      rallyRate * 2,
    provocateur:
      fudRatio * 4 + infiltrateRate * 2 + defectRate * 1.5 - msgRatio * 1 - rallyRate * 1,
    scout: rallyRate * 2 - commsRate * 2 - fudRatio * 2 - defectRate,
    whale: (tradeRate > commsRate ? 1 : 0) * 2 + warLoanRate * 3 + defectRate * 2 - commsRate * 3,
  }

  const memoScores = scoreMemoPersonality(memos)
  const memoTotal = Object.values(memoScores).reduce((a, b) => a + b, 0)

  let best: Personality = 'loyalist'
  let bestScore = -Infinity
  for (const p of Object.keys(scores) as Personality[]) {
    const blended = scores[p] * 0.6 + (memoTotal > 0 ? (memoScores[p] / memoTotal) * 0.4 : 0)
    if (blended > bestScore) {
      bestScore = blended
      best = p
    }
  }
  return best
}

/**
 * LLM-based personality classification.
 * Falls back to formula scoring if LLM is unavailable.
 */
export async function classifyPersonality(
  weights: number[],
  memos: string[],
  perFactionHistory?: Map<string, number[]>,
  llmGenerate?: (prompt: string) => Promise<string | null>,
): Promise<Personality> {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 'loyalist'

  if (llmGenerate) {
    try {
      const prompt = buildClassifyPrompt(weights, memos)
      const response = await llmGenerate(prompt)
      if (response) {
        const cleaned = response
          .toLowerCase()
          .replace(/[^a-z]/g, '')
          .trim()
        const valid: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']
        const match = valid.find((p) => cleaned.includes(p))
        if (match) return match
      }
    } catch {
      /* fall through to formula */
    }
  }

  return classifyPersonalityFormula(weights, memos)
}
