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
  onThinking?: (thinking: string) => void,
  isMobile = false,
): LLMAdapter & { init: () => Promise<void>; destroy: () => void } {
  let engine: any = null
  let ready = false

  async function init() {
    onStatusChange({ status: 'downloading', progress: 0 })

    try {
      // Dynamic import — only loaded when user selects a model
      const webllm = await import('@mlc-ai/web-llm')

      const modelId = getModelId(tier, hasShaderF16, isMobile)

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
      const messages: { role: string; content: string }[] = []
      if (isMobile) {
        messages.push({ role: 'system', content: '/no_think' })
      } else if (tier === 'spicy') {
        messages.push({ role: 'system', content: 'Think step by step, then act. Be strategic and decisive.' })
      } else {
        messages.push({ role: 'system', content: 'FOCUS. Be DECISIVE. Think briefly, then act.' })
      }
      messages.push({ role: 'user', content: prompt })

      const maxTokens = isMobile ? 256 : tier === 'spicy' ? 2048 : 1024
      const stream = await engine.chat.completions.create({
        messages,
        max_tokens: maxTokens,
        temperature: 0.8,
        stream: true,
      })

      let full = ''
      let inThinking = false
      let thinkingBuffer = ''
      let actionBuffer = ''
      let thinkingDone = false

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content ?? ''
        full += delta

        if (!inThinking && full.includes('<think>')) {
          inThinking = true
          thinkingBuffer = full.slice(full.indexOf('<think>') + '<think>'.length)
          continue
        }

        if (inThinking && !thinkingDone) {
          thinkingBuffer += delta
          const endIdx = thinkingBuffer.indexOf('</think>')
          if (endIdx !== -1) {
            // Thinking complete — log to console only (already streamed sentence by sentence)
            const thinking = thinkingBuffer.slice(0, endIdx).trim()
            if (thinking) {
              console.log(`[pyre] thinking complete (${thinking.length} chars)`)
            }
            actionBuffer = thinkingBuffer.slice(endIdx + '</think>'.length)
            thinkingDone = true
          } else if (delta) {
            // Stream thinking delta — UI appends
            onThinking?.(delta)
          }
          continue
        }

        if (thinkingDone) {
          actionBuffer += delta
        }
      }

      // No thinking tags — treat entire output as the action
      if (!inThinking) {
        const content = full.trim()
        console.log(`[pyre] LLM raw (no thinking): ${content.slice(0, 200)}`)
        return content || null
      }

      // Thinking never closed — truncated
      if (inThinking && !thinkingDone) {
        console.log(`[pyre] thinking truncated (no </think>), returning null`)
        onThinking?.(thinkingBuffer.trim())
        return null
      }

      const action = actionBuffer.trim()
      console.log(`[pyre] LLM action: ${action}`)
      return action || null
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
