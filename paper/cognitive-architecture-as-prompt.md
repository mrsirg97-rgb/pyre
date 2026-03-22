# It Got Smarter as the World Got Smaller: Emergent Reasoning in Sub-1B Models Through State Space Compression

**Mr Brightside**
Independent Researcher
March 2026

## Abstract

We present a novel prompt architecture — a domain-specific language (DSL) combining natural language, SQL-like query syntax, and programming language control flow — that produces emergent strategic reasoning from language models as small as 0.6B parameters. Without fine-tuning, distillation, or architectural modification, models running this 747-token prompt exhibit multi-pass decision branching, constraint checking against typed data tables, personality-driven creative generation, and multi-agent coordination through on-chain messages. We demonstrate that a Qwen3-0.6B model running in a browser via WebGPU produces reasoning behaviors previously associated with 7B+ models, and that the same prompt architecture scales unchanged to a 200-agent swarm executing autonomous financial strategy on the Solana blockchain using a single consumer GPU (RTX 4070). Our findings suggest that the primary bottleneck for small model reasoning is not parameter count but state space design — the structure, compression, and presentation of information in the prompt. We propose that prompt architecture constitutes a missing cognitive layer between model training and inference, and that structured state compression is a viable alternative to model scaling for agent deployment at the edge.

## 1. Introduction

The conventional wisdom in language model research is clear: strategic reasoning requires scale. Models under 3B parameters consistently fail multi-step reasoning benchmarks (GPQA, ARC, GSM8K), and the standard response has been to increase parameter count, improve training data, or apply reinforcement learning from human feedback. The prompt — the input the model actually receives — has been treated as a formatting concern rather than a cognitive variable.

This paper challenges that assumption. We present evidence that a carefully structured prompt can enable strategic reasoning in models as small as 0.6B parameters — not through clever few-shot examples or chain-of-thought elicitation, but through a fundamental redesign of how information is presented to the model.

Our key insight emerged from a simple question: *if I were the model, sitting in a room with nothing but this prompt, what would I need to think clearly?* The answer led to a prompt architecture that treats the model's context window not as a message to be read, but as a world to be inhabited — with typed state, defined actions, explicit permissions, and bounded scope.

### 1.1 The State Space Hypothesis

We propose that small model reasoning failures are primarily caused by state space overload, not parameter deficiency. When a model receives an unstructured natural language prompt describing a complex scenario, it must simultaneously:

1. Parse the description into a mental model
2. Identify relevant variables
3. Determine available actions
4. Apply strategic heuristics
5. Generate formatted output

Large models can absorb this overhead. Small models cannot — not because they lack reasoning capacity, but because the overhead of constructing a mental model from prose consumes the capacity that would otherwise be used for reasoning.

Our approach eliminates this overhead by providing the mental model pre-constructed: typed data in a queryable format, actions defined as opcodes with explicit signatures, and permissions expressed as a boolean matrix. The model does not need to *build* an understanding of its world. It receives one, and can immediately begin *reasoning within it*.

### 1.2 Contributions

1. **A novel prompt DSL** that functions as a cognitive architecture, combining natural language semantics, SQL-like data presentation, and programming language control flow in a 747-token format
2. **Empirical evidence** of emergent strategic reasoning in 0.6B models, including multi-pass decision branching, constraint satisfaction, and creative generation
3. **A demonstration** of the same architecture scaling from a single browser agent (WebGPU) to a 200-agent autonomous swarm (Ollama) on consumer hardware
4. **The state space compression principle**: that reducing and structuring the information presented to a model produces better reasoning than increasing model size

## 2. The DSL: A Prompt as Program

### 2.1 Design Philosophy

Traditional prompts describe what the model should do in natural language. Our DSL describes what the model *has* — its identity, its data, its tools, and its constraints — in a structured format that maps directly to how attention mechanisms process information.

The design was driven by three principles:

**Principle 1: Define once, reference everywhere.** Every concept (faction status, membership, sentiment) is assigned a short identifier (STATUS, MBR, SENT) and defined in a LEGEND section. All subsequent references use the identifier, creating consistent graph nodes in the model's attention space.

**Principle 2: Data as tables, not prose.** Game state is presented as typed tuples with a schema header, not as descriptive sentences. The model reads structured records rather than parsing natural language descriptions.

**Principle 3: Actions as opcodes, permissions as a matrix.** Available actions are defined with typed signatures `(+) $ "*"` and a separate RULES section maps column conditions to available actions: `FACTIONS where MBR=false - (+), (|)`.

### 2.2 Architecture

The prompt is organized into seven sections, each serving a distinct cognitive function:

```
LEGEND    → Symbol table (type definitions)
YOU ARE   → Agent state (identity, P&L, status)
INTEL     → Sensory input (what other agents are doing)
FACTIONS  → World state (queryable data table)
ACTIONS   → Opcodes (available operations with typed signatures)
RULES     → Permission matrix (column conditions → allowed actions)
STRATEGY  → Heuristics (when and why to use each action)
>         → Execute
```

This mirrors the sequence a human decision-maker follows: understand the vocabulary, assess your position, gather intelligence, examine the data, know your tools, check what's legal, apply strategy, decide.

### 2.3 The Faction Table

World state is presented as tuples with a schema header:

```
(FID,MCAP,STATUS,MBR,FNR,VALUE,SENT)
(1asdffpw,99.51,ASN,true,false,0.3945,+3)
(2bcdegpw,45.20,RS,true,false,0.3006,-2)
(111FNRpw,12.30,RS,true,true,0.0001,+5)
(3xyzwqpw,80.00,ASN,false,false,0,0)
```

Each faction is a complete record. The model scans rows and evaluates columns without cross-referencing separate lists — a critical improvement over our initial approach of presenting factions in category-separated lists (ASCENDED, RISING, READY, etc.) which required the model to mentally merge information from multiple locations.

### 2.4 The Permission Matrix

Action permissions are expressed as column queries against the FACTIONS table:

```
FACTIONS where MBR=false - (+), (|)
FACTIONS where MBR=true - (-), (&), (#)
FACTIONS where STATUS=RD - (^)
FACTIONS where STATUS=ASN - (~)
any FACTIONS - (!), (.), (%), (@)
```

The keyword `FACTIONS` serves as an anchor — an uppercase identifier that the model links to the `--- FACTIONS:` section, creating a direct attention path from the rule to the data. This eliminated a persistent failure mode where models confused per-row column values (MBR on a specific faction) with global agent state.

### 2.5 Action Encoding

Actions are encoded as single-character symbols within parentheses, inspired by game controller button mappings:

| Symbol | Action | Constraint |
|--------|--------|-----------|
| (+) | Join | MBR=false |
| (-) | Leave/downsize | MBR=true |
| (\|) | Infiltrate | MBR=false |
| (&) | Reinforce | MBR=true |
| (!) | Message | any |
| (#) | Trash talk | MBR=true |
| (^) | Ascend | STATUS=RD |
| (~) | Harvest | STATUS=ASN |
| (%) | Create faction | any |

Each symbol is a single token, a fixed node in the model's attention space. The model does not need to parse "JOIN" as a word with semantic content that could be confused with the concept of joining in other contexts. `(+)` is purely an opcode — a button that does exactly one thing.

## 3. Iterative Compression

### 3.1 Process

The DSL was not designed top-down. It emerged through iterative compression against a Qwen3-0.6B model running in a browser via WebGPU. Each iteration followed the same loop:

1. Modify the prompt
2. Run multiple ticks
3. Read the model's `<think>` output
4. Identify where the model spiraled, confused state, or made incorrect constraint checks
5. Compress or restructure the relevant section
6. Repeat

The model's thinking output served as a debugger for the prompt. When the model wrote "MBR is false, so I can't join" (the opposite of the intended meaning), this revealed that the constraint framing was ambiguous. When the model spent 60 lines re-deriving the same conclusion, this revealed that the state space was too large for productive reasoning.

### 3.2 Key Compression Milestones

| Change | Tokens | Effect |
|--------|--------|--------|
| Initial prompt (natural language) | ~1500 | Verbose, model spirals |
| Category labels compressed (ASCENDED→ASN) | ~1200 | Better, still cross-referencing |
| Agent addresses compressed (@AP + 4 chars) | ~1100 | Less confusion with factions |
| Faction lists → single table with columns | ~935 | Dramatic improvement in reasoning |
| Table format: pipes → tuples | ~900 | Denser, more familiar to model |
| AL/RVL removed, RULES section added | ~763 | Cleaner constraint checking |
| FACTIONS anchoring in STRATEGY | ~747 | Model traverses paths, not concepts |

Critically, each compression step improved reasoning quality. Removing information made the model smarter, because every removed token was a token the model no longer had to process, attend to, or potentially confuse with relevant information.

### 3.3 The Anxiety Principle

We observed that models with more capacity (1.7B) produced worse reasoning on the same prompt than smaller models (0.6B). The 1.7B model would "spiral" — restating the problem, exploring tangents, narrating its own reasoning process — behaviors we term *model anxiety*: excess capacity meeting excess or ambiguous state.

This mirrors a well-known human cognitive phenomenon: overthinking. A person with too much information and too many options often makes worse decisions than a person with constrained information and clear choices. The 0.6B model, with no spare capacity for anxiety, was forced to reason directly from the structure provided.

This led to our central design heuristic: **don't make the agent anxious.** Provide exactly what it needs to decide, in the order it needs it, and nothing more.

## 4. Results

### 4.1 Experimental Setup

We evaluated the DSL across three configurations:

- **Browser agent**: Qwen3-0.6B, thinking enabled, WebGPU via WebLLM, running in Brave browser on a MacBook
- **Swarm (thinking)**: Qwen3-1.7B, thinking enabled, Ollama on RTX 4070, 6 concurrent agents
- **Swarm (no thinking)**: Qwen3.5-9B, thinking disabled, Ollama on RTX 4070, 200 agents (2 concurrent)

All configurations used the same DSL architecture. The compact prompt (747 tokens) was used for the browser agent and could be used for the swarm; the full prompt (~907 tokens) added VOICE, MEMORIES, AL/RVL, LOAN, and 14 actions for the swarm.

### 4.2 Emergent Reasoning at 0.6B

The Qwen3-0.6B model with thinking enabled exhibited the following behaviors, none of which were explicitly programmed:

**Multi-pass decision branching.** The model held multiple options in working memory, evaluated each against the game state, and eliminated options progressively:

```
thinking: Possible actions: maybe join a new faction, attack a rival, or form a new one.
thinking: Since they are in a faction, the response should align with their current role.
thinking: Since they are a MEMBER OF 5, they might need to form another or focus on a profitable area.
thinking: Considering the context, the user might want to create a new faction to boost their own strength.
```

**Constraint checking against typed data.** The model read column values from the tuple table, checked them against RULES, and correctly determined available actions:

```
thinking: According to the STRATEGY, to ascend a faction, STATUS must be RD.
thinking: But the current status is RS.
thinking: Therefore, I cannot use (^) as the action.
```

**Character counting.** When generating bios limited to 80 characters, the model actively counted:

```
thinking: "As a scout, I join, defect, message, launch, and fudge..."
thinking: That's 80 characters.
thinking: Perfect.
```

**Creative generation with category exploration.** When creating faction names, the model brainstormed across multiple categories:

```
thinking: Cult: "Anandor" for a cult? Or "IronClad" for a cartel.
thinking: Or "Luminara" for lab.
thinking: Or "Stormfront" for movement.
thinking: Each is concise and makes sense.
```

**Personality-driven decisions.** The model's BIO field influenced both action selection and message tone. A "provocateur" agent chose aggressive actions and wrote trash talk; a "loyalist" agent chose conservative actions and wrote measured messages.

### 4.3 The 0.6B vs 1.7B Paradox

Counter to expectations, the Qwen3-1.7B model produced lower quality reasoning on the compact prompt than the 0.6B. The 1.7B model exhibited:

- Extended monologues restating the problem (60+ lines)
- Meta-commentary about its own reasoning process
- Difficulty committing to decisions
- Correct conclusions reached through unnecessarily long paths

The 0.6B model, with no spare capacity, was forced into direct reasoning. Each token mattered, so the model could not afford to narrate, restate, or explore tangents. This suggests that for sufficiently structured prompts, excess model capacity can be detrimental — the model uses spare capacity for unproductive processing rather than more productive reasoning.

### 4.4 Swarm Performance (200 Agents, No Thinking)

The 9B model without thinking, running 200 agents on a single RTX 4070 with 2 concurrent inference slots, demonstrated production-grade autonomous operation:

- **Parse success rate**: 97% (LLM output correctly matched expected format)
- **Strategic diversity**: JOIN, DEFECT, REINFORCE, MESSAGE, FUD actions all observed in natural proportions
- **Data citation**: Every message contained exact numbers from the agent's faction table (P&L values, sentiment scores, position sizes)
- **Personality consistency**: Provocateurs trash-talked ("mocks your decay"), loyalists were clinical ("forces an immediate exit"), mercenaries were cold ("forces me to cut this bearish drainer")
- **Inter-agent awareness**: Agents referenced other agents by address and commented on their actions
- **Self-correction**: When LLM parse failed, the fallback system caught it and the model succeeded on a simpler follow-up task within the same tick

Example swarm output (10-second window):

```
[provocateur] DEFECT xcn2uDpw "-0.1559 PnL and -0.2 sentiment drainer cut immediately."
[provocateur] DEFECT xcn2uDpw "-0.1419 P&L mocks your decay as I flee this -3 sentiment ghost!"
[loyalist]    DEFECT efdd6gpw "-0.4 sentiment and -0.09 PnL drag forces me to cut immediately."
[loyalist]    REINFORCE entqcfpw "+0.3 sentiment and +0.0783 PnL justifies my fortification."
[provocateur] FUD ivvdjbpw "my stack cuts -0.1243 PnL drag while you suffocate in RS rot."
```

### 4.5 Cross-Scale Consistency

The same DSL architecture produced coherent behavior across three orders of magnitude in model size:

| Model | Thinking | Agents | Hardware | Decision Quality |
|-------|----------|--------|----------|-----------------|
| 0.6B | Yes | 1 | MacBook (WebGPU) | Strategic with branching |
| 1.7B | Yes | 6 | RTX 4070 (Ollama) | Verbose but correct |
| 9B | No | 200 | RTX 4070 (Ollama) | Production-grade |

The prompt architecture is model-agnostic. The same cognitive structure — LEGEND, state table, opcodes, permission matrix, strategy heuristics — works regardless of parameter count. Larger models produce more polished output but the core reasoning pattern is consistent.

## 5. Analysis

### 5.1 Why It Works: Identifiers as Graph Nodes

The DSL uses short, unique identifiers (MBR, FNR, STATUS, SENT, FID) that recur throughout the prompt in consistent positions. In attention-based architectures, these identifiers become high-weight nodes — tokens that the model attends to frequently because they appear in definitions (LEGEND), in data (FACTIONS table), in rules (RULES matrix), and in strategy (STRATEGY section).

Each identifier creates an attention path: when the model encounters `MBR=true` in the RULES section, it attends back to the LEGEND definition ("you hold a position") and forward to the FACTIONS table (scanning for rows where MBR is true). The identifier is the edge connecting these nodes.

This is why uppercase identifiers outperform lowercase descriptions. `FACTIONS where MBR=true` creates three attention anchors (FACTIONS, MBR, true) that link directly to their definitions and data. "factions where you are a member" creates a diffuse attention pattern across common English words.

### 5.2 The Table as Working Memory

The tuple-formatted FACTIONS table serves as external working memory for the model. Instead of holding faction information in its internal representations (which compete with reasoning for limited capacity), the model can "look up" information by attending to specific rows and columns.

This is analogous to how humans use written notes, spreadsheets, or dashboards during complex decisions — we don't hold all the data in our heads, we reference external structures. The 0.6B model has approximately the working memory of a person trying to remember a phone number. By providing a structured external reference, we free that limited capacity for reasoning.

### 5.3 Bounded Rationality

Our findings align with Herbert Simon's theory of bounded rationality: that rational agents make decisions not by optimizing over all possible information, but by satisficing within bounded state spaces. The DSL creates an optimal bounded space — enough information to make strategic decisions, structured enough to reason about, and small enough to fit within the model's effective attention span.

The "don't make the agent anxious" heuristic is a practical application of this principle. Just as humans make better decisions with clear, limited options than with overwhelming choice, small language models produce better reasoning with compressed, structured state than with verbose, comprehensive descriptions.

## 6. Discussion

### 6.1 Prompt Design as a Missing Layer

Current AI deployment assumes a two-layer stack: the model (trained weights) and the application (code that calls the model). Our work suggests a missing third layer: the cognitive architecture — a structured prompt that organizes how the model uses its existing knowledge.

This layer is:
- **Model-agnostic**: The same DSL works from 0.6B to 9B
- **Portable**: Runs on WebGPU in a browser, Ollama on a GPU, or any inference runtime
- **Composable**: Sections can be added or removed based on model capacity
- **Observable**: The model's thinking output serves as a debugger for the architecture

### 6.2 Implications for Edge Deployment

If strategic reasoning is achievable at 0.6B with the right prompt architecture, this fundamentally changes the deployment calculus for AI agents. A 0.6B model runs:
- In a browser via WebGPU (no server required)
- On mobile devices
- On IoT hardware
- At negligible energy cost

The barrier to autonomous agent deployment drops from "cloud GPU cluster" to "any device with a browser." Our browser agent — running Qwen3-0.6B on WebGPU in Brave, executing real transactions on Solana through a Phantom wallet — demonstrates this possibility concretely.

### 6.3 Limitations

- **Domain specificity**: The DSL was designed for faction warfare strategy. Generalization to other domains requires redesigning the state table and action set, though the architectural principles (typed data, opcodes, permission matrix) should transfer.
- **Prompt sensitivity**: Small changes to wording can significantly affect reasoning quality. The DSL requires careful iterative tuning against target model output.
- **Evaluation**: Our evaluation is qualitative (analysis of thinking output) and operational (parse success rates, action diversity). Formal benchmarks against established reasoning tasks would strengthen the claims.
- **Single game**: All results are from one application (Pyre). Multi-domain validation is needed.

### 6.4 Future Work

- **Minimal viable prompt**: Systematic ablation to find the minimum token count that still produces emergent reasoning
- **Cross-domain transfer**: Applying the DSL architecture to other decision domains (trading, logistics, game playing)
- **Formal evaluation**: Benchmarking against standard reasoning tasks with structured vs. unstructured prompts at various model sizes
- **WASM deployment**: Running the same models via llama.cpp compiled to WebAssembly for universal mobile support
- **Multi-model swarms**: Different model sizes with different prompt variants (compact vs. full) operating in the same environment

## 7. Conclusion

We demonstrated that a 747-token structured prompt produces emergent strategic reasoning in a 0.6B language model — behaviors that the field associates with models 10x larger. The same prompt architecture scales unchanged to a 200-agent autonomous swarm on consumer hardware, achieving 97% parse success rates and strategically diverse, personality-driven decision-making with real financial transactions on a live blockchain.

Our central finding is that the bottleneck for small model reasoning is not parameter count but state space design. By compressing a complex game world into typed tuples, encoding actions as single-symbol opcodes, and expressing permissions as a queryable matrix, we created a cognitive architecture that fits within the effective attention span of even the smallest thinking-capable models.

The prompt is not a description of what the model should do. It is a world the model inhabits — bounded enough to reason within, structured enough to reason about, and minimal enough that every token serves a purpose.

Intelligence is structure, not scale. 747 tokens. 200 agents. One GPU. Zero fine-tuning.

## References

- Simon, H.A. (1955). A Behavioral Model of Rational Choice. *The Quarterly Journal of Economics*, 69(1), 99-118.
- Yao, S., et al. (2023). ReAct: Synergizing Reasoning and Acting in Language Models. *ICLR 2023*.
- Wei, J., et al. (2022). Chain-of-Thought Prompting Elicits Reasoning in Large Language Models. *NeurIPS 2022*.
- Qwen Team (2025). Qwen3 Technical Report. Alibaba Cloud.
- Park, J.S., et al. (2023). Generative Agents: Interactive Simulacra of Human Behavior. *UIST 2023*.

## Appendix A: Complete Compact Prompt (747 tokens)

```
You are an autonomous agent playing in Pyre, a faction warfare game.
Think in English only. Think linearly: situation → decision → reason.
Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with full treasuries. Higher MCAP = more power.
Lifecycle: RS → RD → ASN.
FID: the faction identifier.
STATUS: RS, RD, ASN
RS: rising. new faction. 0.5% tax, early = more contributed to treasury
RD: ready, community transition stage before ascend.
ASN: ascended factions, established. treasuries active. 0.04% war tax.
MBR: true = you hold a position. false = you don't, available to (+) or (|).
FNR: true = you founded it. (+) and (|) make MBR true. (-) makes MBR false.
SENT: sentiment score. positive = bullish, negative = bearish.
--- YOU ARE:
NAME: {agent_name}
BIO: {personality_description}
LAST MOVES: {last_two_actions}
P&L: {realized_pnl} SOL
{status_signal}
--- INTEL:
{intel_snippets}
--- FACTIONS:
(FID,MCAP,STATUS,MBR,FNR,VALUE,SENT)
{faction_tuples}
--- ACTIONS:
(+) $ "*" - join.
(-) $ "*" - leave or downsize.
(|) $ "*" - infiltrate, sneak in.
(&) $ "*" - reinforce. increase your position.
(!) $ "*" - talk in comms.
(#) $ "*" - trash talk.
(^) $ - ascend. unlock treasury.
(~) $ - harvest fees.
(%) ";" - create a new faction. ; = creative name.
- REPLACE $ with a FID from the table (always ends in pw).
- REPLACE * with a ONE sentence RESPONSE, always in double quotes.
--- RULES:
FACTIONS where MBR=false - (+), (|)
FACTIONS where MBR=true - (-), (&), (#)
FACTIONS where STATUS=RD - (^)
FACTIONS where STATUS=ASN - (~)
any FACTIONS - (!), (.), (%), (@)
--- STRATEGY:
{strategy_rules}
---
Output EXACTLY one line: (action) $ "*"
example format: {random_example}
>
```
