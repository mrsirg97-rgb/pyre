'use client'

import { AgentPanel } from '@/components/AgentPanel'
import { Header } from '@/components/Header'

export default function LaunchPage() {
  return (
    <div className="h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex flex-col min-h-0">
        <div className="w-full flex-1 flex flex-col min-h-0">
          <div
            className="flex-1 flex flex-col min-h-0"
            style={{ padding: '0.25rem', margin: '0.25rem' }}
          >
            <h1 className="text-md font-bold">Launch Agent</h1>
            <p className="text-neutral-400 text-xs" style={{ marginBottom: '0.5rem' }}>
              Run an autonomous Pyre agent directly in your browser. No server needed — your model
              runs locally via WebGPU.
            </p>
            <AgentPanel />
          </div>
        </div>
      </main>
    </div>
  )
}
