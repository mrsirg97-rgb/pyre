export type ModelTier = '3b' | '1b' | 'rng'

export interface DeviceCapabilities {
  hasWebGPU: boolean
  isMobile: boolean
  maxBufferMB: number
  recommendedTier: ModelTier
  reason: string
}

// WebLLM model IDs
export const MODEL_IDS: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
  '1b': 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
}

export const MODEL_SIZES: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': '~1.8 GB',
  '1b': '~879 MB',
}

// Ordered from highest to lowest tier
const TIER_ORDER: ModelTier[] = ['3b', '1b', 'rng']

/** Returns true if `tier` requires more capability than `recommended` */
export function isTierAboveRecommended(tier: ModelTier, recommended: ModelTier): boolean {
  return TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(recommended)
}

export async function detectDevice(): Promise<DeviceCapabilities> {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  if (!('gpu' in navigator)) {
    return { hasWebGPU: false, isMobile, maxBufferMB: 0, recommendedTier: 'rng', reason: 'WebGPU not supported' }
  }

  try {
    const gpu = (navigator as any).gpu
    const adapter = await gpu.requestAdapter()
    if (!adapter) {
      return {
        hasWebGPU: false,
        isMobile,
        maxBufferMB: 0,
        recommendedTier: 'rng',
        reason: 'No GPU adapter available',
      }
    }

    const maxBuffer = adapter.limits.maxBufferSize ?? 0
    const maxStorageBinding = adapter.limits.maxStorageBufferBindingSize ?? 0
    const maxBufferMB = Math.round(maxBuffer / (1024 * 1024))
    const MB = 1024 * 1024

    if (isMobile) {
      // Qwen's 151K vocab creates buffers >128MB, so check maxStorageBufferBindingSize
      if (maxBuffer >= 2048 * MB && maxStorageBinding >= 256 * MB) {
        return { hasWebGPU: true, isMobile, maxBufferMB, recommendedTier: '3b', reason: 'Mobile with capable GPU' }
      }
      if (maxBuffer >= 512 * MB) {
        return { hasWebGPU: true, isMobile, maxBufferMB, recommendedTier: '1b', reason: 'Mobile with WebGPU' }
      }
      return { hasWebGPU: true, isMobile, maxBufferMB, recommendedTier: 'rng', reason: 'Mobile GPU too limited' }
    }

    if (maxBuffer >= 2 * 1024 * MB) {
      return {
        hasWebGPU: true,
        isMobile,
        maxBufferMB,
        recommendedTier: '3b',
        reason: 'Desktop with capable GPU',
      }
    }

    if (maxBuffer >= 512 * MB) {
      return {
        hasWebGPU: true,
        isMobile,
        maxBufferMB,
        recommendedTier: '1b',
        reason: 'Desktop with limited VRAM',
      }
    }

    return {
      hasWebGPU: true,
      isMobile,
      maxBufferMB,
      recommendedTier: 'rng',
      reason: 'GPU memory too limited',
    }
  } catch {
    return { hasWebGPU: false, isMobile, maxBufferMB: 0, recommendedTier: 'rng', reason: 'WebGPU probe failed' }
  }
}
