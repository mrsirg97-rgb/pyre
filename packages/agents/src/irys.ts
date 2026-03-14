/**
 * Arweave upload via Irys (Node.js)
 *
 * Mirrors the frontend's irys.ts but uses @irys/upload (Node) instead of
 * @irys/web-upload (browser). Agents sign with local keypairs.
 */

import Uploader from '@irys/upload'
import Solana from '@irys/upload-solana'
import { Keypair } from '@solana/web3.js'
import { RPC_URL, NETWORK } from './config'

type IrysUploader = Awaited<ReturnType<ReturnType<typeof Uploader>['build']>>

export interface TokenMetadata {
  name: string
  symbol: string
  description?: string
  image: string
}

let cachedUploader: { key: string; uploader: IrysUploader } | null = null

async function getUploader(keypair: Keypair): Promise<IrysUploader> {
  const keyStr = keypair.publicKey.toBase58()
  if (cachedUploader?.key === keyStr) return cachedUploader.uploader

  const builder = Uploader(Solana).withWallet(Buffer.from(keypair.secretKey)).withRpc(RPC_URL)

  const uploader =
    NETWORK === 'mainnet' ? await builder.mainnet().build() : await builder.devnet().build()

  cachedUploader = { key: keyStr, uploader }
  return uploader
}

async function ensureFunded(irys: IrysUploader, dataSize: number): Promise<void> {
  const price = await irys.getPrice(dataSize)
  const balance = await irys.getBalance()
  if (balance.lt(price)) {
    const fundAmount = price.minus(balance).multipliedBy(1.1).integerValue(0)
    await irys.fund(fundAmount)
  }
}

/** Upload raw bytes (image) to Arweave, returns gateway URL */
export async function uploadImage(
  keypair: Keypair,
  imageBuffer: Buffer,
  contentType: string,
): Promise<string> {
  const irys = await getUploader(keypair)
  await ensureFunded(irys, imageBuffer.length)
  const receipt = await irys.upload(imageBuffer, {
    tags: [{ name: 'Content-Type', value: contentType }],
  })
  return `https://gateway.irys.xyz/${receipt.id}`
}

/** Upload JSON metadata to Arweave, returns gateway URL */
export async function uploadMetadata(keypair: Keypair, metadata: TokenMetadata): Promise<string> {
  const irys = await getUploader(keypair)
  const buffer = Buffer.from(JSON.stringify(metadata))
  await ensureFunded(irys, buffer.length)
  const receipt = await irys.upload(buffer, {
    tags: [{ name: 'Content-Type', value: 'application/json' }],
  })
  return `https://gateway.irys.xyz/${receipt.id}`
}

/** Full flow: generate image via Pollinations, upload image + metadata to Arweave */
export async function uploadFactionAssets(
  keypair: Keypair,
  name: string,
  symbol: string,
  imagePrompt: string,
): Promise<string> {
  // 1. Generate image via Pollinations.ai
  const encodedPrompt = encodeURIComponent(imagePrompt)
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true`

  const response = await fetch(pollinationsUrl)
  if (!response.ok) throw new Error(`Pollinations failed: ${response.status}`)
  const imageBuffer = Buffer.from(await response.arrayBuffer())

  // 2. Upload image to Arweave
  const imageUrl = await uploadImage(keypair, imageBuffer, 'image/jpeg')

  // 3. Upload metadata JSON to Arweave
  const metadataUrl = await uploadMetadata(keypair, {
    name,
    symbol,
    image: imageUrl,
  })

  return metadataUrl
}
