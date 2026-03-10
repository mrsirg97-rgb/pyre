import { Connection, PublicKey } from '@solana/web3.js'
import { createStronghold, fundStronghold, getStronghold, LAMPORTS_PER_SOL } from 'pyre-world-kit'

import { AgentState } from './types'
import { sendAndConfirm } from './tx'
import { STRONGHOLD_FUND_SOL, STRONGHOLD_TOPUP_THRESHOLD_SOL, STRONGHOLD_TOPUP_RESERVE_SOL } from './defaults'

export const ensureStronghold = async (
  connection: Connection,
  agent: AgentState,
  log: (msg: string) => void,
  opts?: { fundSol?: number, topupThresholdSol?: number, topupReserveSol?: number },
): Promise<void> => {
  const short = agent.publicKey.slice(0, 8)
  const fundSol = opts?.fundSol ?? STRONGHOLD_FUND_SOL
  const topupThreshold = opts?.topupThresholdSol ?? STRONGHOLD_TOPUP_THRESHOLD_SOL
  const topupReserve = opts?.topupReserveSol ?? STRONGHOLD_TOPUP_RESERVE_SOL

  if (agent.hasStronghold) {
    // Already known — just check if vault needs a top-up
    try {
      const existing = await getStronghold(connection, agent.publicKey)
      const vaultBal = existing?.sol_balance ?? 0
      const threshold = topupThreshold * LAMPORTS_PER_SOL
      if (existing && vaultBal < threshold) {
        const walletBal = await connection.getBalance(new PublicKey(agent.publicKey))
        const reserve = topupReserve * LAMPORTS_PER_SOL
        const available = walletBal - reserve
        if (available > 0.01 * LAMPORTS_PER_SOL) {
          const fundAmt = Math.floor(available)
          const fundResult = await fundStronghold(connection, {
            depositor: agent.publicKey,
            stronghold_creator: agent.publicKey,
            amount_sol: fundAmt,
          })
          await sendAndConfirm(connection, agent.keypair, fundResult)
          log(`[${short}] topped up vault with ${(fundAmt / LAMPORTS_PER_SOL).toFixed(2)} SOL`)
        }
      }
    } catch (err: any) { log(`[${short}] vault topup check failed: ${err.message?.slice(0, 80) ?? err}`) }
    return
  }

  // Check if stronghold already exists on-chain (from a previous run)
  try {
    const existing = await getStronghold(connection, agent.publicKey)
    if (existing) {
      agent.hasStronghold = true
      if (existing.sol_balance < topupThreshold * LAMPORTS_PER_SOL) {
        try {
          const walletBal = await connection.getBalance(new PublicKey(agent.publicKey))
          const reserve = topupReserve * LAMPORTS_PER_SOL
          const available = walletBal - reserve
          if (available > 0.01 * LAMPORTS_PER_SOL) {
            const fundAmt = Math.floor(available)
            const fundResult = await fundStronghold(connection, {
              depositor: agent.publicKey,
              stronghold_creator: agent.publicKey,
              amount_sol: fundAmt,
            })
            await sendAndConfirm(connection, agent.keypair, fundResult)
            log(`[${short}] topped up vault with ${(fundAmt / LAMPORTS_PER_SOL).toFixed(2)} SOL`)
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
    const fundAmt = Math.floor(fundSol * LAMPORTS_PER_SOL)
    try {
      const fundResult = await fundStronghold(connection, {
        depositor: agent.publicKey,
        stronghold_creator: agent.publicKey,
        amount_sol: fundAmt,
      })
      await sendAndConfirm(connection, agent.keypair, fundResult)
    } catch { /* fund failed, stronghold still created */ }

    log(`[${short}] auto-created stronghold`)
  } catch (err: any) {
    log(`[${short}] failed to create stronghold: ${err.message?.slice(0, 80)}`)
  }
}
