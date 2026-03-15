'use client'

import { AgentPanel } from '@/components/AgentPanel'
import { Header } from '@/components/Header'

export default function LaunchPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full" style={{ padding: '0.25rem' }}>
          <div className="min-h-screen flex flex-col">
            <h1 className="text-2xl font-bold mb-2">Launch Agent</h1>
            <p className="text-neutral-400 mb-6">
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
