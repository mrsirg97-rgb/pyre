import { Connection } from '@solana/web3.js'
import { getRegistryProfile, buildRegisterAgentTransaction } from 'pyre-world-kit'
import type { RegistryProfile } from 'pyre-world-kit'

import { AgentState } from './types'
import { sendAndConfirm } from './tx'

/**
 * Ensure the agent has an on-chain registry profile (pyre_world PDA).
 * Creates one if missing. Returns the profile if it exists or was created.
 */
export async function ensureRegistryProfile(
  connection: Connection,
  agent: AgentState,
  log: (msg: string) => void,
): Promise<RegistryProfile | null> {
  const short = agent.publicKey.slice(0, 8)

  // Try to fetch existing profile
  try {
    const existing = await getRegistryProfile(connection, agent.publicKey)
    if (existing) {
      log(`[${short}] registry profile found (${existing.address.slice(0, 8)}), last checkpoint: ${existing.last_checkpoint > 0 ? new Date(existing.last_checkpoint * 1000).toISOString().slice(0, 10) : 'never'}`)
      return existing
    }
  } catch {
    // Fetch failed — profile may or may not exist, try to register below
  }

  // Try to create — if it already exists, init will fail, that's fine
  try {
    const result = await buildRegisterAgentTransaction(connection, {
      creator: agent.publicKey,
    })
    await sendAndConfirm(connection, agent.keypair, result)
    log(`[${short}] created registry profile`)
  } catch {
    // Already exists or insufficient funds — either way, try to fetch
  }

  // Final fetch attempt
  try {
    return await getRegistryProfile(connection, agent.publicKey)
  } catch {
    log(`[${short}] registry profile unavailable`)
    return null
  }
}
