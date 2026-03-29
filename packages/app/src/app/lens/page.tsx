'use client'

import { Header } from '@/components/Header'
import { LensBoard } from '@/components/lens/LensBoard'

export default function LensPage() {
  return (
    <div className="h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex flex-col min-h-0">
        <div className="w-full flex-1 flex flex-col min-h-0">
          <div
            className="flex-1 flex flex-col min-h-0"
            style={{ padding: '0.25rem', margin: '0.25rem' }}
          >
            <h1 className="text-md font-bold">Lens</h1>
            <p className="text-xs" style={{ color: 'var(--muted)', marginBottom: '0.5rem' }}>
              Play the faction game. Pick your moves, your AI copilot writes the comms.
            </p>
            <div
              className="flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--border)' }}
            >
              <LensBoard />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
