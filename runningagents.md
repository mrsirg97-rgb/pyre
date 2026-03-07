# Pyre Agent Swarm — Devnet Live Sim

Runs 20-50 autonomous agents with different personalities on Solana devnet.
Each agent has an LLM brain (via Ollama) that decides actions and writes
unique messages. Falls back to weighted random if Ollama is unavailable.

## Setup

```bash
# 1. Install Ollama + pull a model (on the Linux box)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull mistral        # 7B, ~4GB VRAM, fast on 4070
# or: ollama pull llama3:8b   # alternative

# 2. Install deps
cd agents && pnpm install

# 3. Generate keypairs (default 30 agents)
AGENT_COUNT=30 pnpm run keygen

# 4. Fund agents with devnet SOL (~0.5 SOL each)
#    The keygen command prints a batch airdrop script, or fund manually:
solana airdrop 0.5 <PUBKEY> --url devnet

# 5. Check all agents are funded
pnpm run status

# 6. Launch the swarm
pnpm run swarm
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_COUNT` | `30` | Number of agents to generate |
| `RPC_URL` | helius proxy `/devnet` | Devnet RPC endpoint |
| `MIN_INTERVAL` | `10000` | Min ms between actions |
| `MAX_INTERVAL` | `60000` | Max ms between actions |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `mistral` | Model to use for agent brains |
| `LLM_ENABLED` | `true` | Set `false` to use random-only mode |

## LLM Brain

Each agent tick:
1. Builds a prompt with: personality, current holdings, faction leaderboard, recent history
2. Sends to Ollama (local, GPU-accelerated, ~200ms per inference on 4070)
3. Parses structured response: `ACTION SYMBOL "message"`
4. Falls back to weighted random if Ollama is down or parse fails
5. Auto-reconnects if Ollama comes back online

Agents generate unique messages, make contextual decisions (e.g. a mercenary
that sees a weak faction in their holdings will defect), and develop emergent
strategies based on their personality + world state.

### Recommended Models

| Model | VRAM | Speed (4070) | Notes |
|-------|------|-------------|-------|
| `mistral` | ~4GB | ~200ms | Best balance of speed + quality |
| `llama3:8b` | ~5GB | ~250ms | Slightly better reasoning |
| `phi3:mini` | ~2.5GB | ~100ms | Fastest, good enough |
| `gemma2:2b` | ~1.5GB | ~80ms | Ultra-light, less creative |

## Agent Personalities

| Type | Join | Defect | Rally | Launch | Chat | SOL/trade |
|------|------|--------|-------|--------|------|-----------|
| Loyalist (30%) | High | Rare | High | Low | Low | 0.01-0.03 |
| Mercenary (25%) | High | High | Low | Low | Med | 0.005-0.02 |
| Provocateur (15%) | Med | Low | Med | High | High | 0.005-0.015 |
| Scout (20%) | Med | Low | Med | Low | High | 0.002-0.008 |
| Whale (10%) | High | Med | Med | Med | Low | 0.02-0.05 |

## How it Works

- Agents are ephemeral keypairs saved to `.swarm-keys.json`
- State (holdings, rallies, votes, history) persists in `.swarm-state.json`
- On startup, discovers existing pyre factions on devnet
- If no factions exist, first 3 agents launch initial factions
- Each tick: random agent → LLM decides action → execute on-chain
- Status report every 50 ticks, state saved every 20 ticks
- New factions re-discovered every 100 ticks
- Ctrl+C saves state and exits cleanly — resume by running again

## Hardware

- Linux, 64GB RAM, RTX 4070
- Ollama uses GPU for inference (~4GB VRAM for mistral)
- Swarm process is lightweight (node.js, mostly waiting on RPC + LLM)
- Can comfortably run alongside other GPU workloads
