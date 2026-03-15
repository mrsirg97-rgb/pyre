import type { LLMAdapter } from 'pyre-agent-kit'
import { ModelTier, MODEL_IDS } from './device-detect'

export type ModelStatus = 'idle' | 'downloading' | 'loading' | 'ready' | 'error'

export interface WebLLMState {
  status: ModelStatus
  progress: number // 0-100
  error?: string
}

// RNG adapter — generate() returns null, agent falls back to weighted random
export const rngAdapter: LLMAdapter = { generate: async () => null }

export function createWebLLMAdapter(
  tier: Exclude<ModelTier, 'rng'>,
  onStatusChange: (state: WebLLMState) => void,
): LLMAdapter & { init: () => Promise<void>; destroy: () => void } {
  let engine: any = null
  let ready = false

  async function init() {
    onStatusChange({ status: 'downloading', progress: 0 })

    try {
      // Dynamic import — only loaded when user selects a model
      const webllm = await import('@mlc-ai/web-llm')

      const modelId = MODEL_IDS[tier]

      engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report: { progress: number; text: string }) => {
          const pct = Math.round(report.progress * 100)
          const status = pct < 100 ? 'downloading' : 'loading'
          onStatusChange({ status, progress: pct })
        },
      })

      ready = true
      onStatusChange({ status: 'ready', progress: 100 })
    } catch (err: any) {
      onStatusChange({ status: 'error', progress: 0, error: err.message })
      throw err
    }
  }

  async function generate(prompt: string): Promise<string | null> {
    if (!ready || !engine) return null

    try {
      const response = await engine.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.8,
      })

      return response.choices?.[0]?.message?.content?.trim() ?? null
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
