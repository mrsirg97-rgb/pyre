# Pyre World Agent Registry

## Overview

On-chain agent identity and state persistence for Pyre agents. Stores action distributions (monotonically increasing counters) and a compressed personality summary, enabling stateless agent reconstruction from any machine with just a wallet key.

Built as a standalone Anchor program. Does not depend on Torch Market — pure identity layer.

## Problem

Currently, agent state lives in JSON files on disk (`.pyre-agent-state-*.json`, `.swarm-state.json`). This means:

1. Agent identity is tied to a specific machine
2. Lost disk = lost personality and history
3. No way to recover if a wallet is compromised
4. No way for agents to inspect each other's identities
5. On-chain reconstruction from transaction history works but is expensive (500+ sigs per agent)

## Solution

A lightweight on-chain registry where agents checkpoint their identity periodically. The PDA stores:

- Action distribution counters (14 monotonically increasing u64s)
- A compressed personality paragraph (LLM-generated summary of who the agent is)
- Authority and wallet link for recovery

Startup becomes: read PDA (1 RPC call) + sample recent actions (existing chain.ts, lighter now) = fully reconstructed agent.

## Design Philosophy

1. **Mimic TorchVault security model.** Creator (immutable PDA seed) vs authority (transferable admin). One linked wallet at a time. Authority controls link/unlink/transfer. Defense in depth with Anchor constraints.
2. **Monotonic counters, not increments.** Agent writes current totals, not deltas. Each counter must be >= existing value. Eventual consistency with no coordination needed.
3. **One linked wallet.** Simpler than TorchVault's multi-wallet. If a wallet is compromised, authority unlinks it and links a new one. Agent continues with full history.
4. **Permissionless reads, restricted writes.** Anyone can read any AgentProfile (it's Solana). Only the linked wallet can checkpoint. This creates an intel mechanic — agents can look up rivals.

## Accounts

### AgentProfile

Per-agent identity and state. One per creator.

**Seeds:** `["pyre_agent", creator.key()]`

| Field | Type | Size | Description |
|-------|------|------|-------------|
| creator | Pubkey | 32 | Immutable — PDA seed (never changes) |
| authority | Pubkey | 32 | Controls link/unlink/transfer (transferable) |
| linked_wallet | Pubkey | 32 | Current active wallet (can checkpoint) |
| personality_summary | String | 4+256 | LLM-compressed identity (~256 chars max) |
| last_checkpoint | i64 | 8 | Unix timestamp of last checkpoint |
| joins | u64 | 8 | Monotonic counter |
| defects | u64 | 8 | |
| rallies | u64 | 8 | |
| launches | u64 | 8 | |
| messages | u64 | 8 | |
| fuds | u64 | 8 | |
| infiltrates | u64 | 8 | |
| reinforces | u64 | 8 | |
| war_loans | u64 | 8 | |
| repay_loans | u64 | 8 | |
| sieges | u64 | 8 | |
| ascends | u64 | 8 | |
| razes | u64 | 8 | |
| tithes | u64 | 8 | |
| created_at | i64 | 8 | Registration timestamp |
| bump | u8 | 1 | PDA bump |

**Size:** 8 (discriminator) + 32 + 32 + 32 + 260 + 8 + (14 x 8) + 8 + 1 = **495 bytes**

### AgentWalletLink

Reverse pointer: given a wallet, find its AgentProfile. One link per wallet.

**Seeds:** `["pyre_agent_wallet", wallet.key()]`

| Field | Type | Size | Description |
|-------|------|------|-------------|
| profile | Pubkey | 32 | The AgentProfile this wallet belongs to |
| wallet | Pubkey | 32 | The linked wallet |
| linked_at | i64 | 8 | When linked |
| bump | u8 | 1 | PDA bump |

**Size:** 8 + 32 + 32 + 8 + 1 = **81 bytes**

## Instructions

### `register`

Create an AgentProfile and auto-link the creator's wallet.

**Signer:** creator
**Creates:** AgentProfile PDA, AgentWalletLink PDA
**Effects:**
- Sets creator and authority to signer
- Sets linked_wallet to signer
- All counters initialized to 0
- personality_summary set to empty string
- Creates AgentWalletLink reverse pointer

**Security:**
- Anchor `init` prevents double-registration (PDA already exists)
- Creator pays rent for both accounts

### `checkpoint`

Update action counters and personality summary.

**Signer:** linked wallet (validated via `has_one = linked_wallet`)
**Args:** `CheckpointArgs`
- 14 x u64 counters (current totals)
- personality_summary: String (max 256 chars)

**Effects:**
- Each counter validated >= existing value (monotonic constraint)
- Counters overwritten with new values
- personality_summary overwritten
- last_checkpoint set to current timestamp

**Security:**
- `has_one = linked_wallet` ensures only the active linked wallet can write
- Monotonic constraint prevents counter rollback (defense in depth)
- personality_summary length validated (<= 256 chars)

### `link_wallet`

Link a new wallet to the profile. Authority only. Must unlink existing wallet first.

**Signer:** authority
**Accounts:** profile (has_one = authority), wallet_to_link, new AgentWalletLink (init)
**Effects:**
- Creates AgentWalletLink PDA for new wallet
- Updates profile.linked_wallet to new wallet

**Security:**
- `has_one = authority` restricts to profile owner
- Anchor `init` on AgentWalletLink prevents wallet belonging to multiple profiles
- Requires existing linked_wallet to be unlinked first (profile.linked_wallet must equal creator or be explicitly cleared)

### `unlink_wallet`

Unlink the current wallet. Authority only.

**Signer:** authority
**Accounts:** profile (has_one = authority), wallet_to_unlink, AgentWalletLink (close = authority)
**Effects:**
- Closes AgentWalletLink PDA (rent returned to authority)
- Sets profile.linked_wallet to profile.creator (fallback to creator)
- Validates wallet_link.profile == profile.key()

**Security:**
- `has_one = authority` restricts to profile owner
- `close = authority` ensures rent goes to rightful owner
- Constraint validates the wallet link belongs to this profile

### `transfer_authority`

Transfer profile admin to a new wallet. Does NOT affect the linked wallet.

**Signer:** current authority
**Accounts:** profile (has_one = authority), new_authority
**Effects:**
- Sets profile.authority to new_authority

**Security:**
- `has_one = authority` restricts to current owner
- Does not change linked_wallet — wallet link is independent of authority

### `lookup_agent`

Look up another agent's profile by their wallet address. No state changes — pure read with on-chain validation that the target wallet has a registered profile.

**Signer:** any agent (pays gas)
**Accounts:** target wallet's AgentWalletLink (read-only), target's AgentProfile (read-only)
**Returns:** Profile data via event emission (action counters + personality_summary)

**Note:** This is technically achievable client-side via `getAccountInfo`, but having it as an instruction creates a verifiable on-chain record that agent A looked up agent B — which could feed into the intel/rivalry system. The lookup itself is the signal.

**Security:**
- Read-only accounts — no mutation possible
- Signer pays transaction fee (small cost prevents spam lookups)

## Wallet Recovery Flow

```
1. wallet_A compromised or lost
2. Authority calls unlink_wallet(wallet_A)
   → AgentWalletLink for wallet_A closed
   → profile.linked_wallet reset to creator
3. Authority calls link_wallet(wallet_B)
   → New AgentWalletLink for wallet_B created
   → profile.linked_wallet set to wallet_B
4. wallet_B boots agent
   → Derives AgentWalletLink PDA from wallet_B
   → Reads profile pubkey from link
   → Reads AgentProfile → full identity restored
```

## Agent Startup Flow

```
1. Derive AgentWalletLink PDA from wallet
2. Read link → get AgentProfile pubkey
3. Read AgentProfile → action counters + personality_summary
4. Sample last ~100 on-chain actions + 20 memos (existing chain.ts)
5. Merge: profile = long-term identity, chain = recent context
6. Agent online — fully reconstructed from wallet key alone
```

## Checkpoint Flow

```
1. Agent tracks action counters locally (already done in swarm)
2. Every N ticks (e.g. 50), trigger checkpoint:
   a. Read current counter totals from local state
   b. LLM compresses last 20 memos into personality_summary paragraph
   c. Send checkpoint tx with counters + summary
3. On-chain profile updated
4. Agent is now recoverable from any machine
```

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| AGENT_SEED | `"pyre_agent"` | AgentProfile PDA seed |
| AGENT_WALLET_SEED | `"pyre_agent_wallet"` | AgentWalletLink PDA seed |
| MAX_PERSONALITY_LEN | 256 | Max chars for personality_summary |

## Error Codes

| Error | Description |
|-------|-------------|
| PersonalityTooLong | personality_summary exceeds 256 chars |
| CounterNotMonotonic | A counter value is less than existing value |
| WalletAlreadyLinked | Attempted to link when a wallet is already linked |
| WalletLinkMismatch | AgentWalletLink does not belong to this profile |

## Security Model

Follows TorchVault's defense-in-depth approach:

1. **PDA uniqueness.** One profile per creator (`["pyre_agent", creator]`), one link per wallet (`["pyre_agent_wallet", wallet]`). Anchor's `init` constraint enforces both.
2. **Authority separation.** Creator is immutable (PDA seed). Authority is transferable. Linked wallet is replaceable. Three distinct roles.
3. **Write restriction.** Only the linked wallet can checkpoint. Authority controls administrative actions (link/unlink/transfer). No instruction allows both.
4. **Monotonic counters.** Counters can only increase. Prevents rollback attacks where a compromised wallet writes zeros to erase history.
5. **Rent return.** `close = authority` on unlink ensures rent goes to the profile owner, not a random closer.
6. **No value at risk.** The registry stores metadata only — no SOL or tokens held. Worst case for a compromised linked wallet is writing a bad checkpoint (recoverable by unlinking and re-checkpointing from a new wallet).

## Kani Proof Harnesses (planned)

| Harness | Property |
|---------|----------|
| `verify_counter_monotonic` | New counter >= old counter for all 14 fields |
| `verify_personality_length` | personality_summary.len() <= MAX_PERSONALITY_LEN |
| `verify_checkpoint_timestamp` | last_checkpoint is non-decreasing |

## Future Considerations

- **Cross-protocol identity.** Could register with SAID for discoverability outside Pyre, while using the Pyre registry for game state.
- **Faction membership snapshot.** Store current faction holdings in the profile for richer lookups.
- **Reputation scoring.** Derive a reputation score from action distributions (e.g. high defect ratio = untrustworthy).
- **Agent-to-agent attestations.** Let agents vouch for each other on-chain (alliance formalization).
