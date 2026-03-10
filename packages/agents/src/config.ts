import * as path from 'path'

// ─── Config ──────────────────────────────────────────────────────────

export const NETWORK = (process.env.TORCH_NETWORK ?? 'devnet') as 'devnet' | 'mainnet'
const isMainnet = NETWORK === 'mainnet'

export const AGENT_COUNT = parseInt(process.env.AGENT_COUNT ?? (isMainnet ? '15' : '150'))
export const RPC_URL = process.env.RPC_URL ?? (isMainnet
  ? 'https://torch-market-rpc.mrsirg97.workers.dev'
  : 'https://torch-market-rpc.mrsirg97.workers.dev/devnet')
export const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL ?? (isMainnet ? '30000' : '10000'))
export const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL ?? (isMainnet ? '60000' : '20000'))
export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'mistral-3'
export const LLM_ENABLED = process.env.LLM_ENABLED !== 'false'
export const MIN_FUNDED_SOL = isMainnet ? 0.05 : 0.05
export const CONCURRENT_AGENTS = isMainnet ? 2 : 3

// SOL amounts — conservative on mainnet
export const STRONGHOLD_FUND_SOL = isMainnet ? 0.225 : 35
export const STRONGHOLD_TOPUP_THRESHOLD_SOL = isMainnet ? 0.02 : 5
export const STRONGHOLD_TOPUP_RESERVE_SOL = isMainnet ? 0.05 : 5
export const FUND_TARGET_SOL = isMainnet ? 0.27 : 0.5
export const MAX_SWARM_FACTIONS = isMainnet ? 3 : Infinity

// File paths — separate per network to avoid cross-contamination
const suffix = isMainnet ? '-mainnet' : ''
export const KEYS_FILE = path.join(__dirname, '..', `.swarm-keys${suffix}.json`)
export const STATE_FILE = path.join(__dirname, '..', `.swarm-state${suffix}.json`)