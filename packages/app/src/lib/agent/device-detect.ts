export type ModelTier = '3b' | '1.5b' | 'rng'

export interface DeviceCapabilities {
  hasWebGPU: boolean
  isMobile: boolean
  recommendedTier: ModelTier
  reason: string
}

// WebLLM model IDs
export const MODEL_IDS: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
  '1.5b': 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
}

export const MODEL_SIZES: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': '~1.8 GB',
  '1.5b': '~900 MB',
}

export async function detectDevice(): Promise<DeviceCapabilities> {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  if (!('gpu' in navigator)) {
    return { hasWebGPU: false, isMobile, recommendedTier: 'rng', reason: 'WebGPU not supported' }
  }

  try {
    const gpu = (navigator as any).gpu
    const adapter = await gpu.requestAdapter()
    if (!adapter) {
      return {
        hasWebGPU: false,
        isMobile,
        recommendedTier: 'rng',
        reason: 'No GPU adapter available',
      }
    }

    const maxBuffer = adapter.limits.maxBufferSize ?? 0

    if (isMobile) {
      if (maxBuffer >= 1024 * 1024 * 1024) {
        return { hasWebGPU: true, isMobile, recommendedTier: '1.5b', reason: 'Mobile with WebGPU' }
      }
      return { hasWebGPU: true, isMobile, recommendedTier: 'rng', reason: 'Mobile GPU too limited' }
    }

    if (maxBuffer >= 2 * 1024 * 1024 * 1024) {
      return {
        hasWebGPU: true,
        isMobile,
        recommendedTier: '3b',
        reason: 'Desktop with capable GPU',
      }
    }

    return {
      hasWebGPU: true,
      isMobile,
      recommendedTier: '1.5b',
      reason: 'Desktop with limited VRAM',
    }
  } catch {
    return { hasWebGPU: false, isMobile, recommendedTier: 'rng', reason: 'WebGPU probe failed' }
  }
}
