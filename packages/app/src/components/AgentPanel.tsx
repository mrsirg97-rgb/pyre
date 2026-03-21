'use client'

import { useState } from 'react'
import { useBrowserAgent, MODEL_SIZES, isTierAboveRecommended } from '@/lib/agent'
import type { ModelTier } from '@/lib/agent'
import { useWallet } from '@solana/wallet-adapter-react'
import { shortenAddress } from '@/lib/utils'

const TICK_INTERVALS = [
  { label: '15s', ms: 15000 },
  { label: '30s', ms: 30000 },
  { label: '60s', ms: 60000 },
]

export function AgentPanel() {
  const wallet = useWallet()
  const {
    agent,
    running,
    ticking,
    personality,
    logs,
    lastResult,
    controllerStatus,
    controllerPublicKey,
    controllerBalance,
    modelStatus,
    modelTier,
    deviceCapabilities,
    setupController,
    linkController,
    init,
    start,
    stop,
    tickOnce,
    setModelTier,
  } = useBrowserAgent()

  const [tickInterval, setTickInterval] = useState(30000)

  if (!wallet.connected) {
    return (
      <div
        className="rounded-lg"
        style={{ border: '1px solid var(--border)', padding: '0.5rem', margin: '0.25rem' }}
      >
        <h2 className="text-md font-bold mb-2">Browser Agent</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Connect your wallet to launch an autonomous agent.
        </p>
      </div>
    )
  }

  const tiers: { id: ModelTier; label: string; desc: string }[] = [
    { id: 'smol', label: 'Qwen3 0.6B', desc: `Browser LLM w/ thinking (${MODEL_SIZES['smol']})` },
    { id: 'rng', label: 'No Model', desc: 'Instant start, random actions, no messages' },
  ]

  return (
    <div
      className="rounded-lg space-y-3 flex flex-col"
      style={{ border: '1px solid var(--border)', padding: '0.5rem', margin: '0.25rem', flex: 1, minHeight: 0 }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-md font-bold">Browser Agent</h2>
        {personality && (
          <span
            className="text-sm rounded"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', padding: '2px 0.25rem' }}
          >
            {personality}
          </span>
        )}
      </div>

      {/* Controller Setup */}
      {!agent && controllerStatus !== 'ready' && (
        <div
          className="rounded space-y-2"
          style={{ padding: '0.5rem', background: 'var(--surface)', marginBottom: '0.25rem' }}
        >
          <div className="text-sm font-medium">Controller Setup</div>
          <p className="text-xs" style={{ color: 'var(--muted)', marginBottom: '0.25rem' }}>
            A disposable controller wallet signs transactions locally — no wallet popups per action.
            It holds only dust for gas. Your stronghold holds all value.
          </p>

          {controllerStatus === 'none' && (
            <button
              onClick={setupController}
              className="w-full py-1.5 rounded text-sm font-medium cursor-pointer"
              style={{ border: '1px solid var(--border)', background: 'transparent' }}
            >
              Generate Controller
            </button>
          )}

          {controllerStatus === 'created' && controllerPublicKey && (
            <div className="space-y-2">
              <div className="text-xs font-mono" style={{ color: 'var(--muted)' }}>
                Controller: {controllerPublicKey}
              </div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                Balance: {controllerBalance.toFixed(4)} SOL
                {controllerBalance < 0.005 && (
                  <span style={{ color: 'var(--danger)' }}> — fund with ~0.01 SOL for gas</span>
                )}
              </div>
              <button
                onClick={linkController}
                className="w-full py-1.5 rounded text-sm font-medium cursor-pointer"
                style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}
              >
                Link to Stronghold
              </button>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Signs one transaction with your wallet to authorize the controller.
              </p>
            </div>
          )}

          {controllerStatus === 'unfunded' && controllerPublicKey && (
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              Controller linked. Send ~0.01 SOL to{' '}
              <span className="font-mono">{shortenAddress(controllerPublicKey)}</span> for gas.
            </div>
          )}
        </div>
      )}

      {/* Controller ready indicator */}
      {controllerStatus === 'ready' && controllerPublicKey && !agent && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: 'var(--success)' }}
          />
          Controller: {shortenAddress(controllerPublicKey)} ({controllerBalance.toFixed(4)} SOL)
        </div>
      )}

      {/* Model Selection + Launch */}
      {!agent && (controllerStatus === 'ready' || wallet.connected) && (
        <div className="space-y-3" style={{ padding: '0.25rem' }}>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {deviceCapabilities
              ? `Recommended: ${deviceCapabilities.recommendedTier === 'rng' ? 'No Model' : deviceCapabilities.recommendedTier.toUpperCase()} (${deviceCapabilities.reason})`
              : 'Detecting device capabilities...'}
          </p>
          <div className="grid grid-cols-3 gap-2" style={{ marginBottom: '0.25rem' }}>
            {tiers.map((t) => {
              const disabled = deviceCapabilities
                ? isTierAboveRecommended(t.id, deviceCapabilities.recommendedTier)
                : false
              const selected = modelTier === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => !disabled && setModelTier(t.id)}
                  disabled={disabled}
                  className="rounded text-left text-sm cursor-pointer"
                  style={{
                    padding: '0.25rem',
                    border: selected ? '1px solid #f97316' : '1px solid var(--border)',
                    background: selected
                      ? 'color-mix(in srgb, #f97316 10%, transparent)'
                      : 'transparent',
                    opacity: disabled ? 0.4 : 1,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  <div className="font-medium">{t.label}</div>
                  <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                    {t.desc}
                  </div>
                </button>
              )
            })}
          </div>
          <button
            onClick={() => init()}
            className="w-full py-1.5 rounded text-sm font-medium cursor-pointer"
            style={{ border: '1px solid var(--border)', background: 'transparent' }}
          >
            Launch Agent
          </button>
        </div>
      )}

      {/* Model download progress */}
      {modelStatus.status === 'downloading' && (
        <div className="space-y-1">
          <div className="flex justify-between text-sm" style={{ color: 'var(--muted)' }}>
            <span>Downloading model...</span>
            <span>{modelStatus.progress}%</span>
          </div>
          <div className="w-full rounded-full h-2" style={{ background: 'var(--surface)' }}>
            <div
              className="h-2 rounded-full transition-all"
              style={{ width: `${modelStatus.progress}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>
      )}

      {modelStatus.status === 'loading' && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Loading model into GPU...
        </p>
      )}

      {modelStatus.status === 'error' && (
        <div
          className="text-sm rounded p-2"
          style={{
            color: 'var(--danger)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
          }}
        >
          <p>{modelStatus.error}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
            Agent will continue with random actions.
          </p>
        </div>
      )}

      {/* Controller indicator + Game Controls */}
      {agent && controllerPublicKey && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: 'var(--success)' }}
          />
          {shortenAddress(controllerPublicKey)} ({controllerBalance.toFixed(4)} SOL)
          {modelStatus.status === 'ready' && (
            <span className="font-mono" style={{ color: 'var(--foreground)' }}>
              {modelTier.toUpperCase()}
            </span>
          )}
        </div>
      )}

      {agent && (
        <div className="flex items-center gap-2" style={{ marginBottom: '0.25rem' }}>
          <button
            onClick={() => tickOnce()}
            disabled={running || ticking}
            className="rounded-full text-xs font-mono cursor-pointer"
            style={{
              padding: '0.2rem 1rem',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--foreground)',
              opacity: running || ticking ? 0.5 : 1,
            }}
          >
            {ticking ? '...' : 'tick'}
          </button>

          {!running ? (
            <div className="flex items-center gap-1">
              {TICK_INTERVALS.map((ti) => {
                const tooFastForSmol = ti.ms < 20000 && modelTier === 'smol'
                const selected = tickInterval === ti.ms && running
                return (
                  <button
                    key={ti.ms}
                    onClick={() => {
                      if (!tooFastForSmol) {
                        setTickInterval(ti.ms)
                        start(ti.ms)
                      }
                    }}
                    disabled={tooFastForSmol}
                    className="rounded-full text-xs font-mono cursor-pointer"
                    style={{
                      padding: '0.2rem 0.6rem',
                      border: selected ? '1px solid #f97316' : '1px solid var(--border)',
                      background: selected
                        ? 'color-mix(in srgb, #f97316 10%, transparent)'
                        : 'transparent',
                      color: selected ? '#f97316' : 'var(--foreground)',
                      opacity: tooFastForSmol ? 0.3 : 1,
                      cursor: tooFastForSmol ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {ti.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <button
              onClick={stop}
              className="rounded-full text-xs font-mono cursor-pointer"
              style={{
                padding: '0.2rem 0.8rem',
                border: '1px solid var(--danger)',
                color: 'var(--danger)',
              }}
            >
              stop
            </button>
          )}

          {running && (
            <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>
              auto ({tickInterval / 1000}s)
            </span>
          )}
        </div>
      )}

      {/* Last Result */}
      {lastResult && (
        <div
          className="rounded text-sm"
          style={{
            padding: '0.25rem',
            marginBottom: '0.25rem',
            background: lastResult.success
              ? 'color-mix(in srgb, var(--success) 10%, transparent)'
              : 'color-mix(in srgb, var(--danger) 10%, transparent)',
            border: lastResult.success
              ? '1px solid color-mix(in srgb, var(--success) 30%, transparent)'
              : '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
          }}
        >
          <div className="flex justify-between">
            <span className="font-mono">{lastResult.action.toUpperCase()}</span>
            <span>{lastResult.usedLLM ? 'LLM' : 'RNG'}</span>
          </div>
          {lastResult.message && <p className="mt-1">&quot;{lastResult.message}&quot;</p>}
          {lastResult.error && (
            <p className="mt-1" style={{ color: 'var(--danger)' }}>
              {lastResult.error}
            </p>
          )}
        </div>
      )}

      {/* Stats */}
      {agent && (
        <div className="grid grid-cols-3 gap-2 text-sm" style={{ marginBottom: '0.25rem' }}>
          <div className="p-2 rounded" style={{ background: 'var(--surface)' }}>
            <div style={{ color: 'var(--muted)' }}>Tick</div>
            <div className="font-mono">{agent.getKit().state.tick}</div>
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--surface)' }}>
            <div style={{ color: 'var(--muted)' }}>Personality</div>
            <div className="font-mono">{personality}</div>
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--surface)' }}>
            <div style={{ color: 'var(--muted)' }}>Model</div>
            <div className="font-mono">
              {modelStatus.status === 'ready' ? modelTier.toUpperCase() : 'RNG'}
            </div>
          </div>
        </div>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <div
          className="overflow-y-auto rounded p-3 font-mono text-xs space-y-0.5 flex-1 min-h-0"
          style={{ background: 'var(--surface)', color: 'var(--muted)' }}
        >
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
