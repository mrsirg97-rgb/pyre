'use client'

import { useBrowserAgent, MODEL_SIZES, isTierAboveRecommended } from '@/lib/agent'
import type { ModelTier } from '@/lib/agent'
import { useWallet } from '@solana/wallet-adapter-react'

export function AgentPanel() {
  const wallet = useWallet()
  const {
    agent,
    running,
    personality,
    logs,
    lastResult,
    modelStatus,
    modelTier,
    deviceCapabilities,
    init,
    start,
    stop,
    tickOnce,
    setModelTier,
  } = useBrowserAgent()

  if (!wallet.connected) {
    return (
      <div className="border border-neutral-800 rounded-lg" style={{ padding: '0.5rem', margin: '0.25rem' }}>
        <h2 className="text-md font-bold mb-2">Browser Agent</h2>
        <p className="text-neutral-400 text-sm">Connect your wallet to launch an autonomous agent.</p>
      </div>
    )
  }

  const tiers: { id: ModelTier; label: string; desc: string }[] = [
    { id: '3b', label: 'Qwen 3B', desc: `Full intelligence (${MODEL_SIZES['3b']})` },
    { id: 'smol', label: 'SmolLM 360M', desc: `Ultra-light (${MODEL_SIZES['smol']})` },
    { id: 'rng', label: 'No Model', desc: 'Instant start, random actions, no messages' },
  ]

  return (
    <div
      className="border border-neutral-800 rounded-lg space-y-4"
      style={{ borderColor: 'var(--border)', padding: '0.5rem', margin: '0.25rem' }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Browser Agent</h2>
        {personality && (
          <span className="text-sm px-2 py-0.5 rounded bg-neutral-800 text-neutral-300">
            {personality}
          </span>
        )}
      </div>

      {/* Model Selection */}
      {!agent && (
        <div className="space-y-3">
          <p className="text-xs text-neutral-400" style={{ marginBottom: '0.25rem' }}>
            {deviceCapabilities
              ? `Recommended: ${deviceCapabilities.recommendedTier === 'rng' ? 'No Model' : deviceCapabilities.recommendedTier.toUpperCase()} (${deviceCapabilities.reason})`
              : 'Detecting device capabilities...'}
          </p>

          <div className="grid grid-cols-3 gap-2">
            {tiers.map((t) => {
              const disabled = deviceCapabilities
                ? isTierAboveRecommended(t.id, deviceCapabilities.recommendedTier)
                : false
              return (
                <button
                  key={t.id}
                  onClick={() => !disabled && setModelTier(t.id)}
                  disabled={disabled}
                  className={`rounded border text-left text-sm ${
                    disabled
                      ? 'border-neutral-800 opacity-40 cursor-not-allowed'
                      : modelTier === t.id
                        ? 'border-orange-500 bg-orange-500/10'
                        : 'border-neutral-700 hover:border-neutral-500'
                  }`}
                  style={{ padding: '0.25rem', marginBottom: '0.25rem' }}
                >
                  <div className="font-medium">{t.label}</div>
                  <div className="text-xs text-neutral-400 mt-1">{t.desc}</div>
                </button>
              )
            })}
          </div>

          <button
            onClick={() => init()}
            className="w-full py-2 rounded bg-orange-600 hover:bg-orange-500 font-medium"
          >
            Launch Agent
          </button>
        </div>
      )}

      {/* Model Download Progress */}
      {modelStatus.status === 'downloading' && (
        <div className="space-y-1" style={{ marginBottom: '0.25rem' }}>
          <div className="flex justify-between text-sm text-neutral-400">
            <span>Downloading model...</span>
            <span>{modelStatus.progress}%</span>
          </div>
          <div className="w-full bg-neutral-800 rounded-full h-2">
            <div
              className="bg-orange-500 h-2 rounded-full transition-all"
              style={{ width: `${modelStatus.progress}%` }}
            />
          </div>
        </div>
      )}

      {modelStatus.status === 'loading' && (
        <p className="text-sm text-neutral-400">Loading model into GPU...</p>
      )}

      {modelStatus.status === 'error' && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded p-2">
          <p>{modelStatus.error}</p>
          <p className="text-xs text-neutral-500 mt-1">Agent will continue with random actions.</p>
        </div>
      )}

      {/* Agent Controls */}
      {agent && (
        <div className="flex gap-2">
          {!running ? (
            <>
              <button
                onClick={() => start()}
                className="flex-1 rounded bg-green-700 hover:bg-green-600 font-small"
                style={{ padding: '0.25rem', marginBottom: '0.25rem' }}
              >
                Start Auto
              </button>
              <button
                onClick={() => tickOnce()}
                className="flex-1 py-2 rounded bg-neutral-700 hover:bg-neutral-600 font-small"
                style={{ padding: '0.25rem', marginBottom: '0.25rem' }}
              >
                Tick Once
              </button>
            </>
          ) : (
            <button
              onClick={stop}
              className="flex-1 py-2 rounded bg-red-700 hover:bg-red-600 font-small"
              style={{ padding: '0.25rem', marginBottom: '0.25rem' }}
            >
              Stop
            </button>
          )}
        </div>
      )}

      {/* Last Action */}
      {lastResult && (
        <div
          className={`rounded text-sm ${lastResult.success ? 'bg-green-900/20 border border-green-800' : 'bg-red-900/20 border border-red-800'}`}
          style={{ padding: '0.25rem', marginBottom: '0.25rem' }}
        >
          <div className="flex justify-between">
            <span className="font-mono">{lastResult.action.toUpperCase()}</span>
            <span>{lastResult.usedLLM ? 'LLM' : 'RNG'}</span>
          </div>
          {lastResult.message && (
            <p className="text-neutral-300 mt-1">&quot;{lastResult.message}&quot;</p>
          )}
          {lastResult.error && <p className="text-red-400 mt-1">{lastResult.error}</p>}
        </div>
      )}

      {/* Agent Stats */}
      {agent && (
        <div className="grid grid-cols-3 gap-2 text-sm" style={{ marginBottom: '0.25rem' }}>
          <div className="p-2 bg-neutral-900 rounded">
            <div className="text-neutral-500">Actions</div>
            <div className="font-mono">{agent.getKit().state.tick}</div>
          </div>
          <div className="p-2 bg-neutral-900 rounded">
            <div className="text-neutral-500">Holdings</div>
            <div className="font-mono">{agent.getKit().state.state?.holdings.size ?? 0}</div>
          </div>
          <div className="p-2 bg-neutral-900 rounded">
            <div className="text-neutral-500">Model</div>
            <div className="font-mono">
              {modelStatus.status === 'ready' ? modelTier.toUpperCase() : 'RNG'}
            </div>
          </div>
        </div>
      )}

      {/* Log */}
      {logs.length > 0 && (
        <div className="max-h-48 overflow-y-auto bg-black/50 rounded p-3 font-mono text-xs text-neutral-400 space-y-0.5">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
