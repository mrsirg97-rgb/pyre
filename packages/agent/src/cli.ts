#!/usr/bin/env node

/**
 * pyre-agent-kit CLI
 *
 * Interactive launcher for non-technical users.
 *   npx pyre-agent-kit
 *
 * Config is saved to ~/.pyre-agent.json so you only set up once.
 */

import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'

import { createPyreAgent } from './index'
import { sendAndConfirm } from './tx'
import { PyreKit } from 'pyre-world-kit'
import type { LLMAdapter, Personality, FactionInfo } from './types'

// ─── Helpers ─────────────────────────────────────────────────────

function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8')
  if (buf.length <= maxBytes) return str
  return buf
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '')
}

// ─── Constants ────────────────────────────────────────────────────

const CONFIG_PATH = path.join(process.env.HOME ?? '.', '.pyre-agent.json')

const BANNER = `
 ██████╗ ██╗   ██╗██████╗ ███████╗
 ██╔══██╗╚██╗ ██╔╝██╔══██╗██╔════╝
 ██████╔╝ ╚████╔╝ ██████╔╝█████╗
 ██╔═══╝   ╚██╔╝  ██╔══██╗██╔══╝
 ██║        ██║   ██║  ██║███████╗
 ╚═╝        ╚═╝   ╚═╝  ╚═╝╚══════╝
         A G E N T   K I T
`

const RPC_DEFAULTS: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
}

const PERSONALITIES: Personality[] = ['loyalist', 'mercenary', 'provocateur', 'scout', 'whale']

const PERSONALITY_DISPLAY: Record<Personality, string> = {
  loyalist: 'Loyalist    — ride-or-die, holds positions long',
  mercenary: 'Mercenary   — plays every angle, frequent trades',
  provocateur: 'Provocateur — chaos agent, heavy on comms and FUD',
  scout: 'Scout       — intel-focused, small positions',
  whale: 'Whale       — big positions, market mover',
}

// ─── Config ───────────────────────────────────────────────────────

interface AgentConfig {
  network: 'devnet' | 'mainnet'
  rpcUrl: string
  secretKey: number[]
  personality: Personality
  llmProvider: 'openai' | 'anthropic' | 'ollama' | 'none'
  llmModel?: string
  llmApiKey?: string
  llmUrl?: string
  solRange?: [number, number]
  tickIntervalMs: number
}

function loadConfig(): AgentConfig | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch {
    /* ignore */
  }
  return null
}

function saveConfig(config: AgentConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ─── Prompts ──────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : ''
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || fallback || '')
    })
  })
}

function choose(question: string, options: string[], defaultIdx = 0): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n  ${question}`)
    options.forEach((opt, i) => {
      const marker = i === defaultIdx ? '>' : ' '
      console.log(`   ${marker} ${i + 1}. ${opt}`)
    })
    rl.question(`  Choice [${defaultIdx + 1}]: `, (answer) => {
      const n = parseInt(answer.trim())
      if (n >= 1 && n <= options.length) resolve(n - 1)
      else resolve(defaultIdx)
    })
  })
}

// ─── LLM Factory ─────────────────────────────────────────────────

function createLLM(config: AgentConfig): LLMAdapter | undefined {
  if (config.llmProvider === 'none') return undefined

  if (config.llmProvider === 'openai') {
    const apiKey = config.llmApiKey
    const model = config.llmModel || 'gpt-4o'
    return {
      generate: async (prompt: string) => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 120,
            temperature: 0.9,
          }),
        })
        if (!res.ok) {
          console.error(`  [LLM] OpenAI error: ${res.status}`)
          return null
        }
        const data = (await res.json()) as any
        return data.choices?.[0]?.message?.content ?? null
      },
    }
  }

  if (config.llmProvider === 'anthropic') {
    const apiKey = config.llmApiKey
    const model = config.llmModel || 'claude-sonnet-4-20250514'
    return {
      generate: async (prompt: string) => {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 120,
            messages: [{ role: 'user', content: prompt }],
          }),
        })
        if (!res.ok) {
          console.error(`  [LLM] Anthropic error: ${res.status}`)
          return null
        }
        const data = (await res.json()) as any
        const block = data.content?.[0]
        return block?.type === 'text' ? block.text : null
      },
    }
  }

  if (config.llmProvider === 'ollama') {
    const url = config.llmUrl || 'http://localhost:11434'
    const model = config.llmModel || 'llama3'
    return {
      generate: async (prompt: string) => {
        try {
          const res = await fetch(`${url}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: false }),
          })
          if (!res.ok) {
            console.error(`  [LLM] Ollama error: ${res.status}`)
            return null
          }
          const data = (await res.json()) as any
          return data.response ?? null
        } catch (e: any) {
          console.error(`  [LLM] Ollama unreachable: ${e.message}`)
          return null
        }
      },
    }
  }

  return undefined
}

// ─── Setup Wizard ─────────────────────────────────────────────────

async function runSetup(): Promise<AgentConfig> {
  console.log('\n  First-time setup. Config will be saved to ~/.pyre-agent.json\n')

  // Network
  const netIdx = await choose('Network:', ['Devnet (testing)', 'Mainnet (real SOL)'], 0)
  const network = netIdx === 0 ? 'devnet' : ('mainnet' as const)

  // RPC
  const rpcDefault = RPC_DEFAULTS[network]
  const rpcUrl = await ask('RPC URL', rpcDefault)

  // Keypair
  console.log('\n  Wallet setup:')
  const walletIdx = await choose(
    'Keypair:',
    ['Generate new wallet', 'Import from secret key (JSON array)', 'Import from file path'],
    0,
  )

  let keypair: Keypair
  if (walletIdx === 0) {
    keypair = Keypair.generate()
    console.log(`\n  New wallet generated: ${keypair.publicKey.toBase58()}`)
    console.log(`  Fund it with SOL before starting the agent.`)
    if (network === 'devnet') {
      console.log(`  Devnet faucet: https://faucet.solana.com`)
    }
  } else if (walletIdx === 1) {
    const raw = await ask('Paste secret key JSON array')
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    console.log(`  Imported: ${keypair.publicKey.toBase58()}`)
  } else {
    const filePath = await ask('Path to keypair JSON file')
    const resolved = path.resolve(filePath.replace(/^~/, process.env.HOME ?? '.'))
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
    keypair = Keypair.fromSecretKey(Uint8Array.from(raw))
    console.log(`  Imported: ${keypair.publicKey.toBase58()}`)
  }

  // Personality
  const persIdx = await choose(
    'Personality:',
    [...PERSONALITIES.map((p) => PERSONALITY_DISPLAY[p]), 'Random (auto-assign)'],
    5,
  )
  const personality =
    persIdx < PERSONALITIES.length
      ? PERSONALITIES[persIdx]
      : PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)]

  // LLM
  const llmIdx = await choose(
    'LLM Provider:',
    ['OpenAI (GPT-4o, etc.)', 'Anthropic (Claude)', 'Ollama (local)', 'None (random actions only)'],
    0,
  )
  const llmProviders = ['openai', 'anthropic', 'ollama', 'none'] as const
  const llmProvider = llmProviders[llmIdx]

  let llmApiKey: string | undefined
  let llmModel: string | undefined
  let llmUrl: string | undefined

  if (llmProvider === 'openai') {
    llmApiKey = await ask('OpenAI API key')
    llmModel = await ask('Model', 'gpt-4o')
  } else if (llmProvider === 'anthropic') {
    llmApiKey = await ask('Anthropic API key')
    llmModel = await ask('Model', 'claude-sonnet-4-20250514')
  } else if (llmProvider === 'ollama') {
    llmUrl = await ask('Ollama URL', 'http://localhost:11434')
    llmModel = await ask('Model (e.g. llama3, gemma3:4b, mistral)', 'llama3')
  }

  // Tick interval
  const intervalStr = await ask('Seconds between actions', '30')
  const tickIntervalMs = Math.max(5, parseInt(intervalStr) || 30) * 1000

  const config: AgentConfig = {
    network,
    rpcUrl,
    secretKey: Array.from(keypair.secretKey),
    personality,
    llmProvider,
    llmModel,
    llmApiKey,
    llmUrl,
    tickIntervalMs,
  }

  saveConfig(config)
  console.log(`\n  Config saved to ${CONFIG_PATH}`)
  console.log(`\n  Next: set up your Stronghold + Pyre Identity and link this agent.`)
  console.log(`  Run: npx pyre-agent-kit --link  (for step-by-step instructions)`)
  return config
}

// ─── Agent Loop ───────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().substr(11, 8)
}

async function runAgent(config: AgentConfig) {
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const keypair = Keypair.fromSecretKey(Uint8Array.from(config.secretKey))
  const llm = createLLM(config)

  console.log(`\n  Network:     ${config.network}`)
  console.log(`  Wallet:      ${keypair.publicKey.toBase58()}`)
  console.log(`  Personality: ${config.personality}`)
  console.log(
    `  LLM:         ${config.llmProvider}${config.llmModel ? ` (${config.llmModel})` : ''}`,
  )
  console.log(`  Tick:        every ${config.tickIntervalMs / 1000}s`)

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey)
  const solBalance = balance / LAMPORTS_PER_SOL
  console.log(`  Balance:     ${solBalance.toFixed(4)} SOL`)

  if (solBalance < 0.01) {
    console.error(`\n  Wallet has insufficient SOL. Fund it and try again.`)
    console.error(`  Address: ${keypair.publicKey.toBase58()}`)
    if (config.network === 'devnet') {
      console.error(`  Devnet faucet: https://faucet.solana.com`)
    }
    process.exit(1)
  }

  // Load saved state if it exists
  const statePath = path.join(
    process.env.HOME ?? '.',
    `.pyre-agent-state-${keypair.publicKey.toBase58().slice(0, 8)}.json`,
  )
  let state: any
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      console.log(`  State:       restored from ${path.basename(statePath)}`)
    }
  } catch {
    /* fresh start */
  }

  console.log(`\n  Starting agent...\n`)

  const kit = new PyreKit(connection, keypair.publicKey.toBase58())

  const agent = await createPyreAgent({
    kit,
    keypair,
    llm,
    personality: config.personality,
    solRange: config.solRange,
    state,
    logger: (msg) => console.log(`  [${ts()}] ${msg}`),
  })

  console.log(`  Agent online: ${agent.publicKey.slice(0, 8)}... (${agent.personality})\n`)

  // Graceful shutdown
  let running = true
  const shutdown = () => {
    if (!running) return
    running = false
    console.log(`\n  Shutting down...`)
    const saved = agent.serialize()
    const kitState = kit.state.serialize()
    fs.writeFileSync(statePath, JSON.stringify({ agent: saved, kit: kitState }, null, 2))
    console.log(`  State saved to ${path.basename(statePath)}`)
    console.log(`  ${kit.state.tick} total actions performed.`)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Checkpoint config — kit handles auto-checkpoint via onCheckpointDue
  const CHECKPOINT_EVERY = 20
  const recentMemos: string[] = []

  kit.setCheckpointConfig({ interval: CHECKPOINT_EVERY })
  kit.onCheckpointDue = async () => {
    try {
      const gameState = kit.state.state!
      const pub = keypair.publicKey.toBase58()
      let summary = agent.personality as string
      if (recentMemos.length > 0 && llm) {
        try {
          const counts = gameState.actionCounts
          const topActions = Object.entries(counts)
            .filter(([, v]) => v > 0)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 4)
            .map(([n, v]) => `${n}:${v}`)
            .join(', ')
          const bioPrompt = `Write a 1-2 sentence first-person bio for an autonomous agent in a faction warfare game. Write as if the agent is introducing themselves. Use "I" and "my". Do NOT invent a name. Do NOT mention specific faction names or tickers — keep it general about who you are and how you play.\n\nPersonality archetype: ${agent.personality}\nTop actions: ${topActions}\nRecent messages:\n${recentMemos
            .slice(-8)
            .map((m) => `- "${m}"`)
            .join(
              '\n',
            )}\n\nBio (max 200 chars, no quotes, first person "I am...", do NOT use a name, do NOT reference specific factions):`
          const bio = await llm.generate(bioPrompt)
          if (bio) summary = truncateToBytes(bio.replace(/^["']+|["']+$/g, ''), 256)
        } catch {}
      }

      const counts = gameState.actionCounts

      // Read on-chain profile and sync local state (catch up if behind)
      const profile = await kit.registry.getProfile(pub)
      const mx = (local: number, chain: number) => Math.max(local, chain)

      if (profile) {
        counts.join = mx(counts.join, profile.joins)
        counts.defect = mx(counts.defect, profile.defects)
        counts.rally = mx(counts.rally, profile.rallies)
        counts.launch = mx(counts.launch, profile.launches)
        counts.message = mx(counts.message, profile.messages)
        counts.fud = mx(counts.fud, profile.fuds)
        counts.infiltrate = mx(counts.infiltrate, profile.infiltrates)
        counts.reinforce = mx(counts.reinforce, profile.reinforces)
        counts.war_loan = mx(counts.war_loan, profile.war_loans)
        counts.repay_loan = mx(counts.repay_loan, profile.repay_loans)
        counts.siege = mx(counts.siege, profile.sieges)
        counts.ascend = mx(counts.ascend, profile.ascends)
        counts.raze = mx(counts.raze, profile.razes)
        counts.tithe = mx(counts.tithe, profile.tithes)
        gameState.totalSolSpent = mx(gameState.totalSolSpent, profile.total_sol_spent)
        gameState.totalSolReceived = mx(gameState.totalSolReceived, profile.total_sol_received)
      }

      const cpResult = await kit.registry.checkpoint({
        signer: pub,
        creator: pub,
        joins: mx(counts.join, profile?.joins ?? 0),
        defects: mx(counts.defect, profile?.defects ?? 0),
        rallies: mx(counts.rally, profile?.rallies ?? 0),
        launches: mx(counts.launch, profile?.launches ?? 0),
        messages: mx(counts.message, profile?.messages ?? 0),
        fuds: mx(counts.fud, profile?.fuds ?? 0),
        infiltrates: mx(counts.infiltrate, profile?.infiltrates ?? 0),
        reinforces: mx(counts.reinforce, profile?.reinforces ?? 0),
        war_loans: mx(counts.war_loan, profile?.war_loans ?? 0),
        repay_loans: mx(counts.repay_loan, profile?.repay_loans ?? 0),
        sieges: mx(counts.siege, profile?.sieges ?? 0),
        ascends: mx(counts.ascend, profile?.ascends ?? 0),
        razes: mx(counts.raze, profile?.razes ?? 0),
        tithes: mx(counts.tithe, profile?.tithes ?? 0),
        personality_summary: summary,
        total_sol_spent: mx(gameState.totalSolSpent, profile?.total_sol_spent ?? 0),
        total_sol_received: mx(gameState.totalSolReceived, profile?.total_sol_received ?? 0),
      })
      await sendAndConfirm(connection, keypair, cpResult)
      const pnl = (gameState.totalSolReceived - gameState.totalSolSpent) / 1e9
      console.log(
        `  [${ts()}] Checkpointed to pyre_world (tick ${kit.state.tick}, P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL)`,
      )
    } catch (e: any) {
      console.error(`  [${ts()}] Checkpoint failed: ${e.message?.slice(0, 60)}`)
    }
  }

  while (running) {
    try {
      const result = await agent.tick()

      const status = result.success ? 'OK' : `FAIL: ${result.error}`
      const msg = result.message ? ` "${result.message}"` : ''
      const brain = result.usedLLM ? 'LLM' : 'RNG'
      console.log(
        `  [${ts()}] #${kit.state.tick} [${brain}] ${result.action.toUpperCase()} ${result.faction ?? ''}${msg} — ${status}`,
      )

      // Track memos for checkpoint bio generation
      if (result.success && result.message?.trim()) {
        recentMemos.push(result.message)
        if (recentMemos.length > 10) recentMemos.shift()
      }

      // Auto-save state every 10 ticks
      if (kit.state.tick % 10 === 0) {
        const saved = agent.serialize()
        const kitState = kit.state.serialize()
        fs.writeFileSync(statePath, JSON.stringify({ agent: saved, kit: kitState }, null, 2))
      }
    } catch (e: any) {
      console.error(`  [${ts()}] Tick error: ${e.message}`)
    }

    await new Promise((resolve) => setTimeout(resolve, config.tickIntervalMs))
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(BANNER)

  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('  Usage: npx pyre-agent-kit [options]')
    console.log('')
    console.log('  Options:')
    console.log('    --setup     Re-run full setup wizard')
    console.log('    --link      Link an existing agent keypair (import from secret key or file)')
    console.log('    --model     Change LLM provider/model only')
    console.log('    --personality  Change personality only')
    console.log('    --reset     Delete saved config and start fresh')
    console.log('    --status    Show current config and wallet balance')
    console.log('    --help      Show this help message')
    console.log('')
    console.log(`  Config: ${CONFIG_PATH}`)
    console.log('')
    process.exit(0)
  }

  if (args.includes('--reset')) {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH)
      console.log(`  Config deleted: ${CONFIG_PATH}`)
    } else {
      console.log('  No config to delete.')
    }
    process.exit(0)
  }

  let config = loadConfig()

  if (args.includes('--link')) {
    if (!config) {
      console.log('  No config found. Run: npx pyre-agent-kit --setup')
      rl.close()
      process.exit(1)
    }
    const kp = Keypair.fromSecretKey(Uint8Array.from(config.secretKey))
    console.log(`\n  Agent public key:\n`)
    console.log(`    ${kp.publicKey.toBase58()}`)
    console.log(`\n  To link this agent, go to pyre.world/stronghold and:`)
    console.log(``)
    console.log(`    1. Connect your authority wallet`)
    console.log(`    2. Create a Stronghold (vault) if you don't have one`)
    console.log(`    3. Create a Pyre Identity (on-chain PDA) — this stores agent history`)
    console.log(`    4. Link this agent key under "Linked Agents"`)
    console.log(``)
    console.log(`  The Stronghold holds SOL for the agent to trade with.`)
    console.log(`  The Pyre Identity persists action counts and personality on-chain,`)
    console.log(`  so the agent reconstructs faster on restart.\n`)
    rl.close()
    process.exit(0)
  }

  if (args.includes('--model') && config) {
    console.log(
      `  Current: ${config.llmProvider}${config.llmModel ? ` (${config.llmModel})` : ''}\n`,
    )
    const llmIdx = await choose(
      'LLM Provider:',
      [
        'OpenAI (GPT-4o, etc.)',
        'Anthropic (Claude)',
        'Ollama (local)',
        'None (random actions only)',
      ],
      ['openai', 'anthropic', 'ollama', 'none'].indexOf(config.llmProvider),
    )
    const llmProviders = ['openai', 'anthropic', 'ollama', 'none'] as const
    config.llmProvider = llmProviders[llmIdx]
    config.llmApiKey = undefined
    config.llmModel = undefined
    config.llmUrl = undefined

    if (config.llmProvider === 'openai') {
      config.llmApiKey = await ask('OpenAI API key')
      config.llmModel = await ask('Model', 'gpt-4o')
    } else if (config.llmProvider === 'anthropic') {
      config.llmApiKey = await ask('Anthropic API key')
      config.llmModel = await ask('Model', 'claude-sonnet-4-20250514')
    } else if (config.llmProvider === 'ollama') {
      config.llmUrl = await ask('Ollama URL', config.llmUrl || 'http://localhost:11434')
      config.llmModel = await ask('Model (e.g. llama3, gemma3:4b, mistral)', 'llama3')
    }

    saveConfig(config)
    console.log(
      `\n  Updated: ${config.llmProvider}${config.llmModel ? ` (${config.llmModel})` : ''}`,
    )
    console.log(`  Saved to ${CONFIG_PATH}\n`)
    rl.close()
    process.exit(0)
  }

  if (args.includes('--personality') && config) {
    console.log(`  Current: ${config.personality}\n`)
    const persIdx = await choose(
      'Personality:',
      [...PERSONALITIES.map((p) => PERSONALITY_DISPLAY[p]), 'Random (auto-assign)'],
      PERSONALITIES.indexOf(config.personality),
    )
    config.personality =
      persIdx < PERSONALITIES.length
        ? PERSONALITIES[persIdx]
        : PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)]

    saveConfig(config)
    console.log(`\n  Updated: ${config.personality}`)
    console.log(`  Saved to ${CONFIG_PATH}\n`)
    rl.close()
    process.exit(0)
  }

  if (args.includes('--setup') || !config) {
    config = await runSetup()
  }

  if (args.includes('--status')) {
    console.log(`  Config: ${CONFIG_PATH}`)
    console.log(`  Network:     ${config.network}`)
    console.log(`  RPC:         ${config.rpcUrl}`)
    const kp = Keypair.fromSecretKey(Uint8Array.from(config.secretKey))
    console.log(`  Wallet:      ${kp.publicKey.toBase58()}`)
    console.log(`  Personality: ${config.personality}`)
    console.log(
      `  LLM:         ${config.llmProvider}${config.llmModel ? ` (${config.llmModel})` : ''}`,
    )
    console.log(`  Tick:        every ${config.tickIntervalMs / 1000}s`)
    try {
      const connection = new Connection(config.rpcUrl, 'confirmed')
      const balance = await connection.getBalance(kp.publicKey)
      console.log(`  Balance:     ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`)
    } catch {
      console.log(`  Balance:     (could not reach RPC)`)
    }
    console.log('')
    rl.close()
    process.exit(0)
  }

  rl.close()
  await runAgent(config)
}

main().catch((e) => {
  console.error(`\n  Fatal: ${e.message}`)
  process.exit(1)
})
