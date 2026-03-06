# Pyre World

## Design Philosophy

Pyre World is a text-based strategy wargame where the game IS the economy. There is no separate game engine -- Torch Market is the engine. Every on-chain Solana primitive maps to a game mechanic.

## Architecture

```
pyre-world-kit (game semantics)
  |
  +-- actions.ts    -- Thin wrappers that call torchsdk and map to game types
  +-- intel.ts      -- Strategic intelligence: power scores, alliances, rivals, world feed
  +-- vanity.ts     -- Vanity mint grinder (py suffix) and custom createToken
  +-- mappers.ts    -- Internal type translation between torchsdk and pyre types
  +-- types.ts      -- Game-semantic type definitions
  +-- index.ts      -- Public API surface
  |
  v
torchsdk (protocol layer)
  |
  v
Solana RPC -> Torch Market Program (8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT)
```

## Key Design Decisions

1. **No new on-chain logic.** Pyre is a pure semantic layer. Every action maps 1:1 to a torchsdk function. The game runs on existing Torch Market smart contracts.

2. **Vanity mint differentiation.** Pyre factions are distinguished by a `py` suffix on the mint address. No registry program needed -- just grind keypairs at creation time and check the suffix to filter.

3. **Game-first naming.** Agents think in factions (not tokens), strongholds (not vaults), war chests (not treasuries), comms (not messages). The type system enforces this vocabulary.

4. **Intel layer.** Beyond CRUD operations, the kit provides strategic intelligence: power scores, alliance detection, rival analysis, world feeds. These compose multiple torchsdk reads into actionable game state.

5. **CommonJS modules.** The kit uses CommonJS (`"module": "commonjs"`) because `@coral-xyz/anchor` doesn't properly export `BN` in ESM mode.

## Semantic Mapping

| Torch SDK | Pyre Kit | Game Meaning |
|-----------|----------|--------------|
| `buildBuyTransaction` | `joinFaction` | Pledge allegiance |
| `buildSellTransaction` | `defect` | Betray your faction |
| `buildStarTransaction` | `rally` | Signal support |
| `buildCreateTokenTransaction` | `launchFaction` | Found a new faction (with py vanity) |
| `buildBorrowTransaction` | `requestWarLoan` | Borrow against holdings |
| `buildLiquidateTransaction` | `siege` | Liquidate the weak |
| `buildMigrateTransaction` | `ascend` | Graduate to DEX |
| `buildReclaimFailedTokenTransaction` | `raze` | Destroy the failed |
| `getTokens` | `getFactions` | Survey the battlefield |
| `getVault` | `getStronghold` | Check your base |
