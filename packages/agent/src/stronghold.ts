import { Connection, PublicKey } from '@solana/web3.js'
import { fundStronghold, getStronghold, getStrongholdForAgent, LAMPORTS_PER_SOL } from 'pyre-world-kit'

import { AgentState } from './types'
import { sendAndConfirm } from './tx'
import { STRONGHOLD_TOPUP_THRESHOLD_SOL, STRONGHOLD_TOPUP_RESERVE_SOL } from './defaults'

export const ensureStronghold = async (
  connection: Connection,
  agent: AgentState,
  log: (msg: string) => void,
  opts?: { fundSol?: number, topupThresholdSol?: number, topupReserveSol?: number },
): Promise<void> => {
  const short = agent.publicKey.slice(0, 8)
  const topupThreshold = opts?.topupThresholdSol ?? STRONGHOLD_TOPUP_THRESHOLD_SOL
  const topupReserve = opts?.topupReserveSol ?? STRONGHOLD_TOPUP_RESERVE_SOL

  // Check if stronghold exists on-chain (try creator lookup, then linked agent lookup)
  let existing: Awaited<ReturnType<typeof getStronghold>> = null
  try { existing = await getStronghold(connection, agent.publicKey) } catch { /* fetch failed */ }
  if (!existing) {
    try { existing = await getStrongholdForAgent(connection, agent.publicKey) } catch { /* fetch failed */ }
  }

  if (existing) {
    agent.hasStronghold = true
    // Track vault creator for use in tx params (may differ from agent key for linked vaults)
    agent.vaultCreator = existing.creator

    // Top up if below threshold
    const vaultBal = existing.sol_balance ?? 0
    const threshold = topupThreshold * LAMPORTS_PER_SOL
    if (vaultBal < threshold) {
      try {
        const walletBal = await connection.getBalance(new PublicKey(agent.publicKey))
        const reserve = topupReserve * LAMPORTS_PER_SOL
        const available = walletBal - reserve
        if (available > 0.01 * LAMPORTS_PER_SOL) {
          const fundAmt = Math.floor(available)
          const fundResult = await fundStronghold(connection, {
            depositor: agent.publicKey,
            stronghold_creator: existing.creator,
            amount_sol: fundAmt,
          })
          await sendAndConfirm(connection, agent.keypair, fundResult)
          log(`[${short}] topped up vault with ${(fundAmt / LAMPORTS_PER_SOL).toFixed(2)} SOL`)
        }
      } catch { /* top-up failed, continue anyway */ }
    }
    return
  }

  // No vault found — user needs to create one on pyre.world
  log(`[${short}] no vault found — create one at pyre.world and link agent key ${agent.publicKey}`)
}
