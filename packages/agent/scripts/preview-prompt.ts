/**
 * Renders the compact prompt with dummy data and prints it + token count.
 * Usage: npx tsx scripts/preview-prompt.ts
 */

import { pick } from '../src/util'

// Dummy agent state
const publicKey = 'Hbv3W4xQfAkE9mNpLrT2Ys7DcGjK1ZqR'
const personality = 'provocateur'
const pnl = -0.3847
const totalHoldingsValue = 0.0555
const unrealizedPnl = totalHoldingsValue + pnl
const memberOf = ['efdd6gpw', 'nbwK14pw']

// Dummy factions (numeric PNL/SENT at 2 decimals)
const factionRows = [
  'efdd6gpw,106.1,RS,true,false,0.01,-0.04,+0.30',
  'nbwK14pw,102.3,RS,true,false,0.05,+0.02,+0.10',
  'xcn2uDpw,106.6,RS,false,false,0,0,+0.00',
  'LA1H1tpw,100.7,RS,false,false,0,0,+0.00',
  'JyJxtHpw,101.7,RS,false,false,0,0,-0.50',
  'ivvdjbpw,102.9,RS,false,false,0,0,+0.00',
  'rhvDoapw,99.6,RS,false,false,0,0,+0.00',
  '67Rmtdpw,104.0,RS,false,false,0,0,+0.00',
  'GiUgSapw,99.5,RS,false,false,0,0,+0.00',
  'tN8Kvfpw,102.4,RS,false,false,0,0,+0.00',
]

const intelSnippet = '@AP5utz in efdd6gpw: "this faction is heating up, sentiment turning"\n@AP9kbN in nbwK14pw: "conviction play, not leaving"'

// Dummy example mints
const m = 'efdd6gpw'
const f1 = 'xcn2uDpw'
const f2 = 'JyJxtHpw'

// Render the compact prompt (copy of buildCompactModelPrompt template)
const prompt = `Welcome to Pyre, a faction warfare game. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with full treasuries. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
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
NAME: @AP${publicKey.slice(0, 4)}
BIO: ${personality}
HLTH: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL
${unrealizedPnl > 1 ? 'YOU ARE UP. consider taking profits.' : unrealizedPnl < -0.5 ? 'YOU ARE DOWN. be conservative. consider downsizing.' : 'BREAKEVEN. look for conviction plays.'}
--- INTEL:
${intelSnippet}
--- FACTIONS:
FID,MCAP,STATUS,MBR,FNR,VALUE,PNL,SENT
${factionRows.join('\n')}
--- ACTIONS:
FORMAT: (action) $ "*"
REPLACE $ with EXACTLY one FID from FACTIONS ONLY (always ends in pw).
REPLACE * with a ONE sentence RESPONSE, always in double quotes.
(+) $ "*" - join.
(-) $ "*" - leave or reduce.
(&) $ "*" - reinforce. increase position.
(!) $ "*" - talk in comms.
(#) $ "*" - fud or trash talk.
(^) $ - ascend. unlock treasury.
(~) $ - harvest fees.
(%) "..." - create new faction. "..." = creative name, in quotes.
(_) - skip turn.
--- RULES:
(+) and (&) increase MCAP. (-) decreases MCAP.
(!) and (#) are your voice. (!) increases SENT. (#) decreases SENT.
(!) any FACTIONS.
(^) FACTIONS where STATUS=RD.
(~) FACTIONS where STATUS=ASN.
(+) FACTIONS where MBR=false.
(-), (&) or (#) FACTIONS where MBR=true.
--- STRATEGIES:
- your personality is your tone.
- no FACTIONS? (%) to create one.
- learn about FACTIONS and other agents in INTEL. HLTH is performance. PNL and SENT are per-faction direction. use all three to decide.
- limit FACTIONS where MBR=true to AT MOST 5.${memberOf.length > 3 ? ` MBR=true on ${memberOf.length} FACTIONS — consider (-) from underperformers.` : ''}
- FACTIONS where FNR=true and MBR=false, consider (+). promote it with (!).
- FACTIONS where STATUS=RS and MBR=false may have higher reward if you (+) the right one.
- in FACTIONS where MBR=true, if MCAP increases, your PNL will increase.
- (&) and (!) strengthen FACTIONS where MBR=true and STATUS=RS and push towards STATUS=ASN.
- consider (-) FACTIONS where MBR=true and PNL is positive to lock in profits.
- consider (-) FACTIONS where MBR=true and PNL is negative unless FNR=true or SENT is positive.
- when HLTH is negative, consider (_) or (-) weakest FACTIONS where MBR=true. (+) or (&) ONLY if you see opportunity.
- (_) can be strategic if you are comfortable with your positions and want to see what plays out next turn.
---
one move per turn. output EXACTLY one line.
example format: ${pick([
  `(+) ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"`,
  `(&) ${m} "${pick(['doubling down.', 'conviction play.', 'added more.'])}"`,
  `(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"`,
  `(!) ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"`,
  `(#) ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"`,
])}`

console.log('═'.repeat(80))
console.log('COMPACT PROMPT PREVIEW')
console.log('═'.repeat(80))
console.log(prompt)
console.log('═'.repeat(80))

const charCount = prompt.length
const wordCount = prompt.split(/\s+/).length
const estimatedTokens = Math.round(charCount / 4)

console.log(`\nStats:`)
console.log(`  Characters: ${charCount}`)
console.log(`  Words:      ${wordCount}`)
console.log(`  Est tokens: ~${estimatedTokens} (chars/4)`)
console.log(`  Lines:      ${prompt.split('\n').length}`)
