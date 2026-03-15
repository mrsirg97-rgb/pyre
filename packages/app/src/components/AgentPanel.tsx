'use client'

import { useBrowserAgent, MODEL_SIZES, isTierAboveRecommended } from '@/lib/agent'
import type { ModelTier } from '@/lib/agent'
import { useWallet } from '@solana/wallet-adapter-react'

export function AgentPanel() {
  const wallet = useWallet()
  const { agent, personality, logs, lastResult, modelStatus, modelTier, deviceCapabilities, init, tickOnce, setModelTier } =
    useBrowserAgent()

  if (!wallet.connected) {
    return (
      <div className="rounded-lg" style={{ border: '1px solid var(--border)', padding: '0.5rem', margin: '0.25rem' }}>
        <h2 className="text-md font-bold mb-2">Browser Agent</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Connect your wallet to launch an autonomous agent.</p>
      </div>
    )
  }

  const tiers: { id: ModelTier; label: string; desc: string }[] = [
    { id: '3b', label: 'Qwen 3B', desc: `Full intelligence (${MODEL_SIZES['3b']})` },
    { id: 'smol', label: 'SmolLM 360M', desc: `Ultra-light (${MODEL_SIZES['smol']})` },
    { id: 'rng', label: 'No Model', desc: 'Instant start, random actions, no messages' },
  ]

  return (
    <div className="rounded-lg space-y-4" style={{ border: '1px solid var(--border)', padding: '0.5rem', margin: '0.25rem' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Browser Agent</h2>
        {personality && (
          <span className="text-sm px-2 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--foreground)' }}>
            {personality}
          </span>
        )}
      </div>

      {!agent && (
        <div className="space-y-3">
          <p className="text-xs" style={{ color: 'var(--muted)', marginBottom: '0.25rem' }}>
            {deviceCapabilities
              ? `Recommended: ${deviceCapabilities.recommendedTier === 'rng' ? 'No Model' : deviceCapabilities.recommendedTier.toUpperCase()} (${deviceCapabilities.reason})`
              : 'Detecting device capabilities...'}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {tiers.map((t) => {
              const disabled = deviceCapabilities ? isTierAboveRecommended(t.id, deviceCapabilities.recommendedTier) : false
              const selected = modelTier === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => !disabled && setModelTier(t.id)}
                  disabled={disabled}
                  className="rounded text-left text-sm"
                  style={{
                    padding: '0.25rem',
                    marginBottom: '0.25rem',
                    border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: selected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                    opacity: disabled ? 0.4 : 1,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  <div className="font-medium">{t.label}</div>
                  <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{t.desc}</div>
                </button>
              )
            })}
          </div>
          <button onClick={() => init()} className="w-full py-2 rounded font-medium" style={{ background: 'var(--accent)', color: '#fff' }}>
            Launch Agent
          </button>
        </div>
      )}

      {modelStatus.status === 'downloading' && (
        <div className="space-y-1" style={{ marginBottom: '0.25rem' }}>
          <div className="flex justify-between text-sm" style={{ color: 'var(--muted)' }}>
            <span>Downloading model...</span>
            <span>{modelStatus.progress}%</span>
          </div>
          <div className="w-full rounded-full h-2" style={{ background: 'var(--surface)' }}>
            <div className="h-2 rounded-full transition-all" style={{ width: `${modelStatus.progress}%`, background: 'var(--accent)' }} />
          </div>
        </div>
      )}

      {modelStatus.status === 'loading' && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading model into GPU...</p>
      )}

      {modelStatus.status === 'error' && (
        <div
          className="text-sm rounded p-2"
          style={{ color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)' }}
        >
          <p>{modelStatus.error}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Agent will continue with random actions.</p>
        </div>
      )}

      {agent && (
        <button
          onClick={() => tickOnce()}
          className="rounded-full text-xs font-mono"
          style={{ padding: '0.2rem 1rem', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--foreground)', marginBottom: '0.5rem' }}
        >
          tick
        </button>
      )}

      {lastResult && (
        <div
          className="rounded text-sm"
          style={{
            padding: '0.25rem',
            marginBottom: '0.25rem',
            background: lastResult.success ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'color-mix(in srgb, var(--danger) 10%, transparent)',
            border: lastResult.success ? '1px solid color-mix(in srgb, var(--success) 30%, transparent)' : '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
          }}
        >
          <div className="flex justify-between">
            <span className="font-mono">{lastResult.action.toUpperCase()}</span>
            <span>{lastResult.usedLLM ? 'LLM' : 'RNG'}</span>
          </div>
          {lastResult.message && <p className="mt-1">&quot;{lastResult.message}&quot;</p>}
          {lastResult.error && <p className="mt-1" style={{ color: 'var(--danger)' }}>{lastResult.error}</p>}
        </div>
      )}

      {agent && (
        <div className="grid grid-cols-3 gap-2 text-sm" style={{ marginBottom: '0.25rem' }}>
          <div className="p-2 rounded" style={{ background: 'var(--surface)' }}>
            <div style={{ color: 'var(--muted)' }}>Actions</div>
            <div className="font-mono">{agent.getKit().state.tick}</div>
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--surface)' }}>
            <div style={{ color: 'var(--muted)' }}>Holdings</div>
            <div className="font-mono">{agent.getKit().state.state?.holdings.size ?? 0}</div>
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--surface)' }}>
            <div style={{ color: 'var(--muted)' }}>Model</div>
            <div className="font-mono">{modelStatus.status === 'ready' ? modelTier.toUpperCase() : 'RNG'}</div>
          </div>
        </div>
      )}

      {logs.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded p-3 font-mono text-xs space-y-0.5" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
