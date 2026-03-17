import { Keypair } from '@solana/web3.js'

const DB_NAME = 'pyre-agent'
const STORE_NAME = 'controller-keys'
const KEY_ID = 'ephemeral'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('agent-state')) {
        db.createObjectStore('agent-state', { keyPath: 'publicKey' })
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Generate a new ephemeral keypair and store in IndexedDB */
export async function createController(): Promise<Keypair> {
  const keypair = Keypair.generate()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put({
      id: KEY_ID,
      secretKey: Array.from(keypair.secretKey),
      publicKey: keypair.publicKey.toBase58(),
      createdAt: Date.now(),
    })
    tx.oncomplete = () => resolve(keypair)
    tx.onerror = () => reject(tx.error)
  })
}

/** Load existing ephemeral keypair from IndexedDB, or null if none exists */
export async function loadController(): Promise<Keypair | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(KEY_ID)
    request.onsuccess = () => {
      const data = request.result
      if (!data?.secretKey) return resolve(null)
      try {
        resolve(Keypair.fromSecretKey(Uint8Array.from(data.secretKey)))
      } catch {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/** Get or create the ephemeral controller keypair */
export async function getOrCreateController(): Promise<Keypair> {
  const existing = await loadController()
  if (existing) return existing
  return createController()
}

/** Delete the ephemeral keypair (user can re-generate) */
export async function clearController(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(KEY_ID)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
