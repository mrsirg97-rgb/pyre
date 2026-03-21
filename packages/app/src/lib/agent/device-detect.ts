export type ModelTier = 'smol' | 'rng'

export interface DeviceCapabilities {
  hasWebGPU: boolean
  hasShaderF16: boolean
  isMobile: boolean
  maxBufferMB: number
  recommendedTier: ModelTier
  reason: string
}

// Qwen3-0.6B — single model, thinking controlled via /no_think
const MODEL_IDS_F16: Record<Exclude<ModelTier, 'rng'>, string> = {
  smol: 'Qwen3-0.6B-q4f16_1-MLC',
}
const MODEL_IDS_F32: Record<Exclude<ModelTier, 'rng'>, string> = {
  smol: 'Qwen3-0.6B-q0f32-MLC',
}

export const MODEL_SIZES: Record<Exclude<ModelTier, 'rng'>, string> = {
  smol: '~400 MB',
}

/** Get the right model ID based on shader-f16 support */
export function getModelId(tier: Exclude<ModelTier, 'rng'>, hasShaderF16: boolean): string {
  return hasShaderF16 ? MODEL_IDS_F16[tier] : MODEL_IDS_F32[tier]
}

// Ordered from highest to lowest tier
const TIER_ORDER: ModelTier[] = ['smol', 'rng']

/** Returns true if `tier` requires more capability than `recommended` */
export function isTierAboveRecommended(tier: ModelTier, recommended: ModelTier): boolean {
  return TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(recommended)
}

export async function detectDevice(): Promise<DeviceCapabilities> {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  // Mobile: RNG only for now (WASM solution coming)
  if (isMobile) {
    return {
      hasWebGPU: false,
      hasShaderF16: false,
      isMobile,
      maxBufferMB: 0,
      recommendedTier: 'rng',
      reason: 'Mobile — RNG only',
    }
  }

  if (!('gpu' in navigator)) {
    return {
      hasWebGPU: false,
      hasShaderF16: false,
      isMobile,
      maxBufferMB: 0,
      recommendedTier: 'rng',
      reason: 'WebGPU not supported',
    }
  }

  try {
    const gpu = (navigator as any).gpu
    const adapter = await gpu.requestAdapter()
    if (!adapter) {
      return {
        hasWebGPU: false,
        hasShaderF16: false,
        isMobile,
        maxBufferMB: 0,
        recommendedTier: 'rng',
        reason: 'No GPU adapter available',
      }
    }

    const maxBuffer = adapter.limits.maxBufferSize ?? 0
    const maxBufferMB = Math.round(maxBuffer / (1024 * 1024))
    const hasShaderF16 = adapter.features.has('shader-f16')
    const MB = 1024 * 1024

    const base = { hasWebGPU: true, hasShaderF16, isMobile, maxBufferMB }

    if (maxBuffer >= 256 * MB) {
      return { ...base, recommendedTier: 'smol', reason: 'Desktop with WebGPU' }
    }

    return { ...base, recommendedTier: 'rng', reason: 'GPU memory too limited' }
  } catch {
    return {
      hasWebGPU: false,
      hasShaderF16: false,
      isMobile,
      maxBufferMB: 0,
      recommendedTier: 'rng',
      reason: 'WebGPU probe failed',
    }
  }
}
