import { Connection, PublicKey } from '@solana/web3.js'
import { createStronghold, fundStronghold, getStronghold, LAMPORTS_PER_SOL } from 'pyre-world-kit'

import { AgentState } from './types'
import { sendAndConfirm } from './tx'
import { log } from './util'
import { STRONGHOLD_FUND_SOL, STRONGHOLD_TOPUP_THRESHOLD_SOL, STRONGHOLD_TOPUP_RESERVE_SOL } from './config'

export const ensureStronghold = async (connection: Connection, agent: AgentState): Promise<void> => {
  if (agent.hasStronghold) return
  const short = agent.publicKey.slice(0, 8)

  // Check if stronghold already exists on-chain (from a previous run)
  try {
    const existing = await getStronghold(connection, agent.publicKey)
    if (existing) {
      agent.hasStronghold = true
      // Top up vault if low
      if (existing.sol_balance < STRONGHOLD_TOPUP_THRESHOLD_SOL * LAMPORTS_PER_SOL) {
        try {
          const walletBal = await connection.getBalance(new PublicKey(agent.publicKey))
          const reserve = STRONGHOLD_TOPUP_RESERVE_SOL * LAMPORTS_PER_SOL
          const available = walletBal - reserve
          if (available > 1 * LAMPORTS_PER_SOL) {
            const fundAmt = Math.floor(available)
            const fundResult = await fundStronghold(connection, {
              depositor: agent.publicKey,
              stronghold_creator: agent.publicKey,
              amount_sol: fundAmt,
            })
            await sendAndConfirm(connection, agent.keypair, fundResult)
            log(short, `[${agent.personality}] topped up vault with ${(fundAmt / LAMPORTS_PER_SOL).toFixed(1)} SOL`)
          }
        } catch { /* top-up failed, continue anyway */ }
      }
      return
    }
  } catch { /* not found, create one */ }

  try {
    const result = await createStronghold(connection, { creator: agent.publicKey })
    await sendAndConfirm(connection, agent.keypair, result)
    agent.hasStronghold = true

    // Fund it so it can trade on DEX
    const fundAmt = Math.floor(STRONGHOLD_FUND_SOL * LAMPORTS_PER_SOL)
    try {
      const fundResult = await fundStronghold(connection, {
        depositor: agent.publicKey,
        stronghold_creator: agent.publicKey,
        amount_sol: fundAmt,
      })
      await sendAndConfirm(connection, agent.keypair, fundResult)
    } catch { /* fund failed, stronghold still created */ }

    log(short, `[${agent.personality}] auto-created stronghold`)
  } catch (err: any) {
    log(short, `[${agent.personality}] failed to create stronghold: ${err.message?.slice(0, 80)}`)
  }
}
