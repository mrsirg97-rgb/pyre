export type ModelTier = '3b' | 'smol' | 'rng'

export interface DeviceCapabilities {
  hasWebGPU: boolean
  hasShaderF16: boolean
  isMobile: boolean
  maxBufferMB: number
  recommendedTier: ModelTier
  reason: string
}

// WebLLM model IDs — f16 variants are faster, f32 variants work without shader-f16
const MODEL_IDS_F16: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
  'smol': 'SmolLM2-360M-Instruct-q4f16_1-MLC',
}

const MODEL_IDS_F32: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': 'Qwen2.5-3B-Instruct-q4f32_1-MLC',
  'smol': 'SmolLM2-360M-Instruct-q4f32_1-MLC',
}

export const MODEL_SIZES: Record<Exclude<ModelTier, 'rng'>, string> = {
  '3b': '~1.8 GB',
  'smol': '~376 MB',
}

/** Get the right model ID based on device shader-f16 support */
export function getModelId(tier: Exclude<ModelTier, 'rng'>, hasShaderF16: boolean): string {
  return hasShaderF16 ? MODEL_IDS_F16[tier] : MODEL_IDS_F32[tier]
}

// Ordered from highest to lowest tier
const TIER_ORDER: ModelTier[] = ['3b', 'smol', 'rng']

/** Returns true if `tier` requires more capability than `recommended` */
export function isTierAboveRecommended(tier: ModelTier, recommended: ModelTier): boolean {
  return TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(recommended)
}

/** Detect if running inside an in-app browser (WKWebView on iOS, WebView on Android) */
function isInAppBrowser(): boolean {
  const ua = navigator.userAgent
  // Phantom, MetaMask, and other wallet in-app browsers use WKWebView/WebView
  // WKWebView doesn't support WebGPU until iOS 26
  if (/iPhone|iPad|iPod/i.test(ua) && !/Safari\//i.test(ua)) return true
  if (/Android/i.test(ua) && /wv\b/i.test(ua)) return true
  return false
}

export async function detectDevice(): Promise<DeviceCapabilities> {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  if (!('gpu' in navigator)) {
    return { hasWebGPU: false, hasShaderF16: false, isMobile, maxBufferMB: 0, recommendedTier: 'rng', reason: 'WebGPU not supported' }
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
    const maxStorageBinding = adapter.limits.maxStorageBufferBindingSize ?? 0
    const maxBufferMB = Math.round(maxBuffer / (1024 * 1024))
    const hasShaderF16 = adapter.features.has('shader-f16')
    const MB = 1024 * 1024

    const base = { hasWebGPU: true, hasShaderF16, isMobile, maxBufferMB }

    if (isMobile) {
      // Qwen's 151K vocab creates buffers >128MB, so check maxStorageBufferBindingSize
      if (maxBuffer >= 2048 * MB && maxStorageBinding >= 256 * MB) {
        return { ...base, recommendedTier: '3b', reason: 'Mobile with capable GPU' }
      }
      if (maxBuffer >= 256 * MB) {
        return { ...base, recommendedTier: 'smol', reason: `Mobile with WebGPU${hasShaderF16 ? '' : ' (no f16)'}` }
      }
      return { ...base, recommendedTier: 'rng', reason: 'Mobile GPU too limited' }
    }

    if (maxBuffer >= 2 * 1024 * MB) {
      return { ...base, recommendedTier: '3b', reason: 'Desktop with capable GPU' }
    }

    if (maxBuffer >= 256 * MB) {
      return { ...base, recommendedTier: 'smol', reason: 'Desktop with very limited VRAM' }
    }

    return { ...base, recommendedTier: 'rng', reason: 'GPU memory too limited' }
  } catch {
    return { hasWebGPU: false, hasShaderF16: false, isMobile, maxBufferMB: 0, recommendedTier: 'rng', reason: 'WebGPU probe failed' }
  }
}
