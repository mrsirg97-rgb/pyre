import type { LLMAdapter } from 'pyre-agent-kit'
import { ModelTier, getModelId } from './device-detect'

export type ModelStatus = 'idle' | 'downloading' | 'loading' | 'ready' | 'error'

export interface WebLLMState {
  status: ModelStatus
  progress: number // 0-100
  error?: string
}

// RNG adapter — generate() returns null, agent falls back to weighted random
export const rngAdapter: LLMAdapter = { generate: async () => null }

/** Classify WebGPU/WebLLM errors into user-friendly messages */
function classifyError(err: any, tier: string): string {
  const msg = (err?.message ?? String(err)).toLowerCase()

  if (msg.includes('out of memory') || msg.includes('oom') || msg.includes('allocation failed')) {
    return `GPU out of memory loading ${tier.toUpperCase()} model. Try closing other browser tabs or apps, then retry.`
  }
  if (msg.includes('shader') || msg.includes('compilation') || msg.includes('createshadermodule')) {
    return `GPU shader compilation failed for ${tier.toUpperCase()}. This device's GPU may not support the required WebGPU features. Try the RNG fallback.`
  }
  if (msg.includes('quota') || msg.includes('storage') || msg.includes('disk')) {
    return `Not enough storage to cache the ${tier.toUpperCase()} model. Free up browser storage (Settings > Clear Cache) and retry.`
  }
  if (
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('typeerror: failed to fetch')
  ) {
    return `Network error downloading the ${tier.toUpperCase()} model. Check your connection and retry.`
  }
  if (msg.includes('lost') || msg.includes('destroyed') || msg.includes('device was lost')) {
    return `GPU device lost while loading ${tier.toUpperCase()} model. The browser may have killed the GPU process due to memory pressure. Close other tabs and retry.`
  }

  // Fallback: include the raw error
  return `Failed to load ${tier.toUpperCase()} model: ${err?.message ?? err}`
}

export function createWebLLMAdapter(
  tier: Exclude<ModelTier, 'rng'>,
  hasShaderF16: boolean,
  onStatusChange: (state: WebLLMState) => void,
): LLMAdapter & { init: () => Promise<void>; destroy: () => void } {
  let engine: any = null
  let ready = false

  async function init() {
    onStatusChange({ status: 'downloading', progress: 0 })

    try {
      // Dynamic import — only loaded when user selects a model
      const webllm = await import('@mlc-ai/web-llm')

      const modelId = getModelId(tier, hasShaderF16)

      console.log(`[pyre] Loading model: ${modelId} (tier: ${tier}, f16: ${hasShaderF16})`)

      engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report: { progress: number; text: string }) => {
          const pct = Math.round(report.progress * 100)
          const status = pct < 100 ? 'downloading' : 'loading'
          onStatusChange({ status, progress: pct })
          console.log(`[pyre] Model ${status}: ${pct}% — ${report.text}`)
        },
      })

      ready = true
      onStatusChange({ status: 'ready', progress: 100 })
      console.log(`[pyre] Model ready: ${modelId}`)
    } catch (err: any) {
      const classified = classifyError(err, tier)
      console.error(`[pyre] Model load failed:`, err)
      onStatusChange({ status: 'error', progress: 0, error: classified })
      throw err
    }
  }

  async function generate(prompt: string): Promise<string | null> {
    if (!ready || !engine) return null

    try {
      const response = await engine.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.8,
      })

      let content = response.choices?.[0]?.message?.content?.trim() ?? null
      if (!content) return null

      // Strip Qwen3 thinking tags — extract only the output after </think>
      const thinkEnd = content.indexOf('</think>')
      if (thinkEnd !== -1) {
        content = content.slice(thinkEnd + '</think>'.length).trim()
      }
      // Also strip if it starts with <think> but never closes (truncated)
      if (content.startsWith('<think>')) {
        return null
      }

      return content || null
    } catch {
      return null
    }
  }

  function destroy() {
    if (engine) {
      try {
        engine.unload?.()
      } catch {}
      engine = null
      ready = false
    }
  }

  return { generate, init, destroy }
}
