import * as fs from 'fs'
import { Keypair } from '@solana/web3.js'

import { KEYS_FILE } from './config'

// ─── Key Management ──────────────────────────────────────────────────

export const generateKeys = (count: number): Keypair[] => {
  const keypairs: Keypair[] = []
  for (let i = 0; i < count; i++) {
    keypairs.push(Keypair.generate())
  }
  return keypairs
}

export const saveKeys = (keypairs: Keypair[]) => {
  const data = keypairs.map((kp) => ({
    publicKey: kp.publicKey.toBase58(),
    secretKey: Array.from(kp.secretKey),
  }))
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2))
}

export const loadKeys = (): Keypair[] => {
  if (!fs.existsSync(KEYS_FILE)) return []
  const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'))
  return data.map((d: any) => Keypair.fromSecretKey(Uint8Array.from(d.secretKey)))
}
