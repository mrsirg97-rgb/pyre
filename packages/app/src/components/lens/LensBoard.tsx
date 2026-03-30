'use client'

import { useState, useCallback } from 'react'
import type { Action, FactionInfo } from 'pyre-agent-kit'
import { MESSAGE_ACTIONS, SOL_ACTIONS } from 'pyre-agent-kit'
import { useLensPlayer } from '@/lib/agent'
import { useWallet } from '@solana/wallet-adapter-react'
import { shortenAddress } from '@/lib/utils'

import { LensActionPicker } from './LensActionPicker'
import { LensFactionTable } from './LensFactionTable'
import { LensMessagePanel } from './LensMessagePanel'

export function LensBoard() {
  const wallet = useWallet()
  const {
    factions,
    holdings,
    availableActions,
    loading,
    prompt,
    controllerStatus,
    controllerPublicKey,
    controllerBalance,
    modelStatus,
    pnl,
    logs,
    setupController,
    linkController,
    init,
    generateMessage,
    execute,
    refresh,
  } = useLensPlayer()

  const [selectedAction, setSelectedAction] = useState<Action | null>(null)
  const [selectedFaction, setSelectedFaction] = useState<FactionInfo | null>(null)
  const [message, setMessage] = useState('')
  const [solAmount, setSolAmount] = useState('0.01')
  const [defectPct, setDefectPct] = useState(1.0) // 1.0 = 100%
  const [executing, setExecuting] = useState(false)
  const [lastResult, setLastResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [initialized, setInitialized] = useState(false)

  // Not connected
  if (!wallet.connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Connect your wallet to play
        </p>
      </div>
    )
  }

  // Controller setup
  if (!initialized) {
    return (
      <div className="space-y-3" style={{ padding: '0.75rem' }}>
        <div className="text-sm font-medium">Setup</div>

        {controllerStatus === 'none' && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Generate a controller keypair for gas-free play.
            </p>
            <button
              onClick={setupController}
              className="text-xs px-3 py-1.5 rounded cursor-pointer transition-colors"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              Generate Controller
            </button>
          </div>
        )}

        {controllerStatus === 'created' && controllerBalance === 0 && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Controller:{' '}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(controllerPublicKey!)
                }}
                className="font-mono cursor-pointer hover:opacity-70"
                style={{ color: 'var(--foreground)' }}
                title="Copy address"
              >
                {controllerPublicKey}
              </button>
            </p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Fund with ~0.01 SOL for gas, then link it in{' '}
              <a href="/stronghold" className="underline" style={{ color: 'var(--foreground)' }}>stronghold</a>.
            </p>
          </div>
        )}

        {(controllerStatus === 'ready' || (controllerStatus === 'created' && controllerBalance > 0)) && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Controller:{' '}
              <button
                onClick={() => navigator.clipboard.writeText(controllerPublicKey!)}
                className="font-mono cursor-pointer hover:opacity-70"
                style={{ color: 'var(--foreground)' }}
                title="Copy address"
              >
                {shortenAddress(controllerPublicKey!)}
              </button>
              {' '}({controllerBalance.toFixed(4)} SOL)
            </p>
            <button
              onClick={async () => {
                await init()
                setInitialized(true)
              }}
              className="text-xs px-3 py-1.5 rounded cursor-pointer transition-colors"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              Enter the Game
            </button>
          </div>
        )}

        {/* Allow skipping controller if wallet supports signTransaction */}
        {controllerStatus !== 'ready' && wallet.signTransaction && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
            <button
              onClick={async () => {
                await init()
                setInitialized(true)
              }}
              className="text-xs cursor-pointer transition-colors"
              style={{ color: 'var(--muted)' }}
            >
              Skip — use wallet adapter (signs each tx)
            </button>
          </div>
        )}

        {/* Logs during setup */}
        {logs.length > 0 && (
          <div className="text-xs font-mono space-y-0.5 mt-2" style={{ color: 'var(--muted)' }}>
            {logs.slice(-5).map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Game board
  const needsMessage = selectedAction && MESSAGE_ACTIONS.has(selectedAction)
  const needsSol = selectedAction && SOL_ACTIONS.has(selectedAction)
  const needsFaction = selectedAction !== 'hold' && selectedAction !== 'launch'

  const canExecute =
    selectedAction &&
    (!needsFaction || selectedFaction) &&
    (!needsMessage || message.length > 0) &&
    !executing

  const handleExecute = async () => {
    if (!selectedAction || executing) return
    setExecuting(true)
    setLastResult(null)
    try {
      const sol = needsSol
        ? parseFloat(solAmount) || 0.01
        : selectedAction === 'defect'
          ? defectPct
          : undefined
      const result = await execute(
        selectedAction,
        selectedFaction,
        needsMessage ? message : undefined,
        sol,
      )
      setLastResult(result)
      if (result.success) {
        // Reset for next move
        setSelectedAction(null)
        setSelectedFaction(null)
        setMessage('')
        setSolAmount('0.01')
        setDefectPct(1.0)
      }
    } finally {
      setExecuting(false)
    }
  }

  const handleActionSelect = (action: Action) => {
    setSelectedAction(action)
    setSelectedFaction(null)
    setMessage('')
  }

  return (
    <div className="flex flex-col" style={{ height: '100%' }}>
      {/* The Prompt — the game board. Humans see what agents see. */}
      <div
        className="flex-1 overflow-auto min-h-0"
        style={{ padding: '0.5rem' }}
      >
        {prompt ? (
          <pre
            className="text-xs font-mono whitespace-pre-wrap leading-relaxed"
            style={{ color: 'var(--foreground)' }}
          >
            {prompt.split('\n').map((line, i) => {
              // Style section headers
              if (line.startsWith('---')) {
                return (
                  <span key={i} style={{ color: 'var(--muted)' }}>
                    {line}{'\n'}
                  </span>
                )
              }
              // Style column headers
              if (line.startsWith('FID,') || line.startsWith('FORMAT:')) {
                return (
                  <span key={i} style={{ color: 'var(--accent)', opacity: 0.8 }}>
                    {line}{'\n'}
                  </span>
                )
              }
              // Style action symbols
              if (/^\([&#\-!/^~?><%.@_]\)/.test(line)) {
                return (
                  <span key={i} style={{ color: 'var(--foreground)' }}>
                    <span style={{ color: 'var(--accent)' }}>{line.slice(0, 3)}</span>
                    {line.slice(3)}{'\n'}
                  </span>
                )
              }
              // Style strategy lines
              if (line.startsWith(': ')) {
                return (
                  <span key={i} style={{ color: 'var(--muted)' }}>
                    {line}{'\n'}
                  </span>
                )
              }
              return <span key={i}>{line}{'\n'}</span>
            })}
          </pre>
        ) : loading ? (
          <div className="text-xs" style={{ color: 'var(--muted)', padding: '1rem' }}>
            Loading game state...
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--muted)', padding: '1rem' }}>
            No prompt available
          </div>
        )}
      </div>

      {/* Controls — pinned to bottom */}
      <div className="flex flex-col" style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {/* Action picker — always visible */}
        <LensActionPicker
          availableActions={availableActions}
          selectedAction={selectedAction}
          onSelect={handleActionSelect}
        />

        {/* Middle section: faction selector + message/sol inputs — capped height, scrollable */}
        {selectedAction && (
          <div className="overflow-auto" style={{ maxHeight: '10rem', borderTop: '1px solid var(--border)' }}>
            {/* Faction selector */}
            {needsFaction && (
              <LensFactionTable
                factions={factions}
                holdings={holdings}
                selectedAction={selectedAction}
                selectedFaction={selectedFaction}
                onSelect={setSelectedFaction}
              />
            )}
          </div>
        )}

        {/* Inline controls row: SOL input + message generate + launch name */}
        {selectedAction && (selectedFaction || selectedAction === 'launch' || selectedAction === 'hold') && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {/* Defect percentage */}
            {selectedAction === 'defect' && selectedFaction && (
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Sell:</span>
                {[
                  { label: '25%', value: 0.25 },
                  { label: '50%', value: 0.5 },
                  { label: '75%', value: 0.75 },
                  { label: 'Max', value: 1.0 },
                ].map(({ label, value }) => (
                  <button
                    key={value}
                    onClick={() => setDefectPct(value)}
                    className="text-xs px-2 py-0.5 rounded cursor-pointer transition-colors"
                    style={{
                      background: defectPct === value ? 'rgba(255,255,255,0.12)' : 'var(--surface)',
                      border: defectPct === value ? '1px solid rgba(255,255,255,0.3)' : '1px solid var(--border)',
                      color: defectPct === value ? 'var(--foreground)' : 'var(--muted)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* SOL amount */}
            {needsSol && selectedFaction && (
              <div className="flex items-center gap-2 px-2 py-1">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>SOL:</span>
                <input
                  type="number"
                  value={solAmount}
                  onChange={(e) => setSolAmount(e.target.value)}
                  step="0.005"
                  min="0.001"
                  className="text-sm font-mono w-24 rounded focus:outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--foreground)',
                    padding: '0.25rem 0.375rem',
                  }}
                />
              </div>
            )}

            {/* Message panel */}
            {needsMessage && selectedFaction && (
              <LensMessagePanel
                action={selectedAction!}
                faction={selectedFaction}
                modelStatus={modelStatus}
                onGenerate={generateMessage}
                message={message}
                onMessageChange={setMessage}
              />
            )}

            {/* Launch: faction name input */}
            {selectedAction === 'launch' && (
              <div style={{ padding: '0.5rem' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
                  Faction Name (or blank for AI-generated)
                </div>
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, 32))}
                  placeholder="e.g. Shadow Cartel"
                  className="w-full text-sm rounded focus:outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--foreground)',
                    padding: '0.375rem 0.5rem',
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Execute bar — always visible when action selected */}
        <div
          className="flex items-center justify-between gap-2"
          style={{ padding: '0.5rem', borderTop: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            {selectedAction && (
              <span style={{ color: 'var(--foreground)' }}>
                {selectedAction}
                {selectedFaction && ` ${selectedFaction.symbol}`}
              </span>
            )}
            {lastResult && (
              <span style={{ color: lastResult.success ? 'var(--success)' : 'var(--danger)' }}>
                {lastResult.success ? 'OK' : lastResult.error}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={loading}
              className="text-xs px-2 py-1 rounded cursor-pointer transition-colors disabled:opacity-50"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--muted)',
              }}
            >
              {loading ? '...' : 'refresh'}
            </button>
            <button
              onClick={handleExecute}
              disabled={!canExecute}
              className="text-xs px-3 py-1 rounded cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-30"
              style={{
                background: canExecute ? 'rgba(255,255,255,0.12)' : 'var(--surface)',
                border: canExecute ? '1px solid rgba(255,255,255,0.3)' : '1px solid var(--border)',
                color: 'var(--foreground)',
              }}
            >
              {executing ? 'executing...' : 'execute'}
            </button>
          </div>
        </div>

        {/* Logs */}
        {logs.length > 0 && (
          <div
            className="text-[10px] font-mono overflow-auto"
            style={{
              maxHeight: '3rem',
              padding: '0.25rem 0.5rem',
              borderTop: '1px solid var(--border)',
              color: 'var(--muted)',
            }}
          >
            {logs.slice(-5).map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
