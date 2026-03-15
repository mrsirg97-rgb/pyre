'use client'

import { useMemo } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { ActionProvider, IntelProvider, RegistryProvider } from 'pyre-world-kit'

export function usePyreKit() {
  const { connection } = useConnection()

  const registry = useMemo(() => new RegistryProvider(connection), [connection])
  const actions = useMemo(() => new ActionProvider(connection, registry), [connection, registry])
  const intel = useMemo(() => new IntelProvider(connection, actions), [connection, actions])

  return { actions, intel, registry, connection }
}
