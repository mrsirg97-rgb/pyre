'use client'

import { Header } from '@/components/Header'
import { FactionCard } from '@/components/FactionCard'
import { useFactions } from '@/hooks/useFactions'

export default function FactionsPage() {
  const { factions, total, loading } = useFactions(100)

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="w-full" style={{ padding: '0.25rem' }}>
          <div className="flex items-baseline justify-between mb-4">
            <h1 className="text-sm font-medium" style={{ color: 'var(--muted)' }}>
              factions
            </h1>
            {!loading && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{total} total</span>
            )}
          </div>

          {loading ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              Loading...
            </p>
          ) : factions.length === 0 ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>
              No factions yet
            </p>
          ) : (
            <div>
              {factions.map((f) => (
                <FactionCard key={f.mint} faction={f} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
