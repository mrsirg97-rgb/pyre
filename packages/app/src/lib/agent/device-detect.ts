export type ModelTier = 'core' | 'smol' | 'rng'

export interface DeviceCapabilities {
  hasWebGPU: boolean
  hasShaderF16: boolean
  isMobile: boolean
  maxBufferMB: number
  recommendedTier: ModelTier
  reason: string
}

// Desktop: Qwen2.5-0.5B (compact, no thinking) and Qwen3-1.7B (compact, no thinking)
const DESKTOP_F16: Record<Exclude<ModelTier, 'rng'>, string> = {
  core: 'Qwen3-1.7B-q4f16_1-MLC',
  smol: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
}
const DESKTOP_F32: Record<Exclude<ModelTier, 'rng'>, string> = {
  core: 'Qwen3-1.7B-q4f32_1-MLC',
  smol: 'Qwen2.5-0.5B-Instruct-q0f32-MLC',
}

// Mobile: Qwen2.5-0.5B (no thinking, proven on Phantom iOS)
const MOBILE_F16: Record<Exclude<ModelTier, 'rng'>, string> = {
  core: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', // mobile falls back to smol
  smol: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
}
const MOBILE_F32: Record<Exclude<ModelTier, 'rng'>, string> = {
  core: 'Qwen2.5-0.5B-Instruct-q0f32-MLC',
  smol: 'Qwen2.5-0.5B-Instruct-q0f32-MLC',
}

export const MODEL_SIZES: Record<Exclude<ModelTier, 'rng'>, string> = {
  core: '~2 GB',
  smol: '~300 MB',
}

/** Get the right model ID based on device and shader-f16 support */
export function getModelId(tier: Exclude<ModelTier, 'rng'>, hasShaderF16: boolean, isMobile = false): string {
  if (isMobile) {
    return hasShaderF16 ? MOBILE_F16[tier] : MOBILE_F32[tier]
  }
  return hasShaderF16 ? DESKTOP_F16[tier] : DESKTOP_F32[tier]
}

// Ordered from highest to lowest tier
const TIER_ORDER: ModelTier[] = ['core', 'smol', 'rng']

/** Returns true if `tier` requires more capability than `recommended` */
export function isTierAboveRecommended(tier: ModelTier, recommended: ModelTier): boolean {
  return TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(recommended)
}

export async function detectDevice(): Promise<DeviceCapabilities> {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

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

    if (!isMobile && maxBuffer >= 512 * MB) {
      return { ...base, recommendedTier: 'core', reason: 'Desktop with WebGPU (enough VRAM for 1.7B)' }
    }

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
