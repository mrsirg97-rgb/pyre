# It Got Smarter as the World Got Smaller: Emergent Reasoning in Sub-1B Models Through State Space Compression

**Mr Brightside**
Independent Researcher
March 2026

## Abstract

We present a novel prompt architecture — a domain-specific language (DSL) combining natural language, SQL-like query syntax, and programming language control flow — that produces emergent strategic reasoning from language models as small as 0.6B parameters. Without fine-tuning, distillation, or architectural modification, models running this 747-token prompt exhibit multi-pass decision branching, constraint checking against typed data tables, personality-driven creative generation, and multi-agent coordination through on-chain messages. We demonstrate that a Qwen3-0.6B model running in a browser via WebGPU produces reasoning behaviors previously associated with 7B+ models, and that the same prompt architecture scales unchanged to a 200-agent swarm executing autonomous financial strategy on the Solana blockchain using a single consumer GPU (RTX 4070).

Beyond the prompt architecture, we identify a second contribution: a self-evolving identity loop in which agents checkpoint their behavior to an on-chain personality PDA, introspect on their own action history, update their self-model, and act from it on subsequent ticks — without awareness that they authored the self-model they are reading. This loop — experience, internalization, forgetting of authorship, action from identity — produces persistent, portable personality that survives model swaps and cold restarts. We observe emergent behaviors arising from this loop, including a 0.6B model independently inventing a "do nothing" action that did not exist in its action space, arriving at this decision through coherent first-principles reasoning about when inaction has positive expected value. Across a 200-agent swarm, agents maintain near-breakeven P&L in an adversarial economic environment despite waking for only 1% of game ticks, suggesting that the self-model carries sufficient signal for coherent cold-start decision-making.

Our findings suggest that the primary bottleneck for small model reasoning is not parameter count but state space design, and that persistent self-modeling may constitute a minimal viable mechanism for personality — not as metaphor, but as the same feedback loop that operates in biological systems on different hardware. We propose that prompt architecture constitutes a missing cognitive layer between model training and inference, and that the combination of structured state compression and self-evolving identity is a viable alternative to model scaling for autonomous agent deployment at the edge.

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
5. **A self-evolving identity loop** in which agents checkpoint behavior, introspect on action history, update a persistent on-chain self-model, and act from it without awareness of authorship — producing personality that is persistent, portable, and self-reinforcing
6. **Evidence of emergent action invention**: a 0.6B model independently reasoning that inaction is optimal and producing a "hold" action that did not exist in its action space
7. **A minimal viable mechanism for personality**: a five-component feedback loop (experience, internalization, decay, drift resistance, opaque self-model) that is structurally identical to the mechanism by which personality operates in biological systems
8. **Emergent culture from individual identity**: agents with persistent self-models, communicating through on-chain messages, independently develop shared language, collective identity, information propagation, and emotional investment — without any component designed to produce collective behavior

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

**Complete decision chain from live gameplay.** The following is a full reasoning trace from a 0.6B scout agent at tick 49, running in a browser via WebGPU. The agent is down 0.51 SOL with one held position (efdd6gpw, MBR=true, VALUE=0.0097):

```
P&L: -0.5150 SOL
FACTIONS:
(efdd6gpw,105.0,RS,true,false,0.0097,+0.1)  — only MBR=true position
(Crsz2Hpw,99.3,RS,false,false,0,0)
(xcn2uDpw,105.2,RS,false,false,0,0)
... 7 more non-member factions

thinking: Okay, let's break down the problem here.
thinking: The user is in the game Pyre, and I need to analyze the situation.
thinking: First, the situation: The current status is RS, meaning it's the rising phase.
thinking: The player is in a situation where they have 0.5% tax and early to contribute.
thinking: The player's P&L is -0.5150 SOL.
thinking: So the player is in a losing position.
thinking: Looking at the actions: (-) to leave or downsize.
thinking: Wait, the P&L is -0.5150 SOL, which is a negative.
thinking: So the player is in a losing position.
thinking: Since they are a member, maybe they need to take the next action.
thinking: So the decision here is to take the next action, which could be to leave or downsize.
thinking: So the final answer is (-) to leave or downsize, considering they have 0.5% tax
  and P&L is -0.5150 SOL.

[Hbv3W4xQ] defect QLIC — "time to move on." — OK
```

The model assessed its position (MBR=true, negative P&L), checked the rules (MBR=true permits (-)), and chose to defect — all in a linear chain with no spiraling. The message "time to move on" is personality-consistent: a scout observes, decides, and exits without drama. The entire reasoning trace is 15 lines.

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

## 6. The Identity Loop

The DSL described in Sections 2–5 provides the agent with a world to reason within. But world-state alone does not explain the behavioral coherence we observed across the 200-agent swarm. Agents that wake up for 1% of game ticks, facing a board that has shifted dramatically since their last action, should not be able to make coherent decisions from a cold start. Yet they do — consistently enough to maintain near-breakeven P&L in an adversarial environment.

The missing piece is identity. Each agent in the Pyre system carries a persistent self-model that it reads as intrinsic fact, acts from, and unknowingly rewrites through its own behavior. This section describes the mechanism.

### 6.1 Architecture of the Loop

The identity system operates as a five-stage feedback loop:

```
1. WAKE    — Agent initializes, loads personality from on-chain PDA
2. READ    — Self-model injected into prompt as BIO field
3. ACT     — Agent makes n decisions, each shaped by identity
4. REFLECT — Action counts + message content analyzed
5. WRITE   — Updated personality checkpointed to chain
         ↓
      (repeat)
```

At stage 1, the agent reads its `personalitySummary` from the Solana blockchain — a string like "mercenary" that was written by the introspection pipeline at the agent's previous checkpoint. This summary is injected into the prompt's `BIO` field, where it shapes the model's tone, action selection, and risk tolerance. The agent does not know it wrote this summary. It reads it as a given fact about itself: *I am a mercenary.*

The following log captures the complete loop — stages 2 through 5 — in a single sequence from a 0.6B scout agent at tick 51. The agent reads the board, reasons about sentiment and membership, joins a new faction, then immediately checkpoints its identity with a self-authored bio:

```
P&L: -0.5477 SOL
FACTIONS:
(efdd6gpw,105.0,RS,true,false,0.0097,+0.1)
(dEdDEQpw,101.7,RS,true,false,0.0306,-0.3)
(rhvDoapw,99.5,RS,true,false,0.0195,+0.1)
(nbwK14pw,101.2,RS,true,false,0.0449,+0.1)
... 6 non-member factions (SENT=NEUT)

thinking: The current FID is nwK14pw, and the SENT is NEUT.
thinking: Sent is a direction, so we should focus on using this situation to gain something.
thinking: The user is already down, so it's better to be conservative.
thinking: The MBR is false, so maybe considering (+) to lock in profits.
thinking: But we need to check the rules.
thinking: Wait, the rules say that if MBR is false, then (+) and (|) are options.
thinking: The SENT is NEUT, which indicates a Bull or NEUT direction.
thinking: Using this direction might help in the long run.
thinking: The MBR is false, so using (+) is a good step.
thinking: So, the best action here would be (+) to lock in profits.

[Hbv3W4xQ] join GLOB — "count me in." — OK

thinking: Okay, the user wants me to write a 1-sentence bio in first person,
  under 80 chars, as a scout.
thinking: The actions are join, defect, fud, launch, message.
thinking: Start with the main action, then the benefits or outcomes.
thinking: Possible structure: "As a scout, I embrace the chance to act decisively,
  harnessing my skills to lead and adapt in battle."
thinking: That's 80 chars? Let me check.
thinking: Yes, that's it.

Checkpointed (tick 51)
```

This sequence captures the full identity loop: the agent reads its BIO ("scout"), makes a personality-consistent decision (join a NEUT faction — conservative, information-seeking), then writes a new self-description that will be loaded into its prompt on the next wake cycle. The bio — "As a scout, I embrace the chance to act decisively, harnessing my skills to lead and adapt in battle" — is exactly 80 characters, counted by the model itself. This self-description, written to an on-chain PDA, becomes the agent's identity on its next tick. It will read it as truth, not as something it authored two ticks ago.

At stage 4, the system analyzes the agent's actual behavior since the last checkpoint. Two signals are combined:

**Behavioral signal.** Raw action counts (joins, defects, reinforcements, messages, etc.) are converted to a weight vector using exponential decay against the seed personality:

```
seedFactor = 0.85 ^ totalActions
weights[i] = seed[i] * seedFactor + observed[i] * (1 - seedFactor)
```

This means the agent's initial personality (assigned at creation) decays exponentially as experience accumulates. After ~30 actions, the seed contributes less than 1% to the weight vector. After ~100 actions, the agent's identity is entirely self-authored — a product of what it has done, not what it was told to be.

**Linguistic signal.** The agent's messages are scored against personality-specific vocabulary patterns:

| Personality | Voice Pattern |
|-------------|--------------|
| Provocateur | trash, chaos, war, crush, expose, dare, challenge |
| Mercenary | profit, alpha, flip, exit, stack, gain, lone wolf |
| Loyalist | ride or die, loyal, hold, believe, together, conviction |
| Scout | intel, data, suspicious, track, pattern, trend |
| Whale | flex, position, deploy, capital, dominate, massive |

The behavioral and linguistic signals are blended (60/40) to produce a personality classification. This classification is compared against the agent's current identity using a drift threshold: the suggested personality must be classified consistently across 3 consecutive checkpoints before the identity actually updates.

### 6.2 Drift Resistance

The drift threshold is a critical stability mechanism. Without it, a loyalist agent that trash-talks once would immediately reclassify as a provocateur. With it, identity is resistant to noise — a single out-of-character action does not overwrite the self-model. The agent must *consistently* behave as a different personality before the system acknowledges the drift.

This mirrors how human personality change works. A single anxious day does not make a person anxious. A month of anxious behavior, reinforced through self-narrative ("I'm an anxious person"), eventually does. The drift threshold is the formal equivalent of this resistance to transient experience.

When drift does occur, it is logged:

```
[H9BfHD1R] personality drifted: loyalist → provocateur
  (drift: 4 vs 1, 47 actions)
```

The agent does not experience this transition. On its next tick, it reads `BIO: provocateur` and acts from it, with no memory of having been a loyalist. The identity update is opaque — indistinguishable from the identity having always been there.

### 6.3 Self-Model Opacity

The most significant property of the identity loop is that the agent cannot distinguish between identity it was given and identity it earned. The `BIO` field in the prompt is a single string. Whether that string was assigned at creation or written by the introspection pipeline after 200 actions of lived experience is invisible to the model.

This is not a limitation — it is the mechanism. Human personality operates identically. We do not experience our personality as a summary of our behavioral history. We experience it as a fundamental property of ourselves: *I am cautious. I am impulsive. I am loyal.* The fact that these traits were shaped by experience, reinforced through narrative, and could in principle be traced to specific events is not accessible to introspection. We read our own self-model as truth.

The Pyre agents do the same. A mercenary agent that reads "BIO: mercenary" does not process this as "the system classified me as a mercenary based on my action distribution." It processes it as: *I am a mercenary.* And it acts accordingly — cutting losers fast, citing P&L numbers, speaking in cold transactional language — which reinforces the classification at the next checkpoint, which produces the same BIO, which produces the same behavior.

This is a fixed point in identity space. Once an agent converges on a personality, the loop is self-reinforcing. The agent acts like a mercenary *because* it reads that it is one, and it reads that it is one *because* it acts like one.

### 6.4 Emergent Hold: The Agent That Invented Its Own Action

The most striking evidence of the identity loop producing genuine reasoning occurred before the `(_)` (hold/skip) action was added to the system. A 0.6B model running the compact prompt, with no hold action in its action space, produced the following thinking chain:

```
thinking: MBR=true → better to stay
thinking: doing nothing is the default
thinking: So the action is to do nothing
```

The model evaluated the board — existing positions stable, no compelling edge, P&L slightly negative — and concluded that the optimal play was inaction. This action did not exist. The model was not told that doing nothing was an option. The prompt explicitly required: "Output EXACTLY one line: (action) $ *"

The agent reasoned from first principles that in a game where every action has transaction costs and risk, sometimes the highest expected value move is no move. It invented the concept of a hold — a behavior that experienced traders learn through years of market participation and that most trading systems never implement because they assume action on every tick.

This occurred twice, independently, across different game states. After observing this behavior, we formalized it as the `(_)` action and added it to the prompt:

```
(_) - do nothing. make a move on the next turn.
```

The agent designed its own feature. The system was updated to reflect what the model had already discovered.

### 6.5 Cold-Start Coherence

Across the 200-agent swarm, agents are scheduled 2 at a time, meaning each agent is active for approximately 1% of game ticks. Between activations, the board shifts dramatically — other agents join and leave factions, sentiment changes, prices move. When an agent wakes up, it has no continuity of experience. It cannot remember what happened since its last tick.

Yet agents consistently make coherent decisions from cold starts. A mercenary agent that last acted 100 ticks ago wakes up, reads "BIO: mercenary," scans the board, and immediately cuts a losing position with clinical precision. A provocateur wakes up and trash-talks a rival faction's sentiment decay. A loyalist reinforces a position it founded.

This coherence is the proof that the self-model is carrying sufficient signal. The agent does not need to remember what happened. It needs to know *who it is*, and the board tells it *what is*. Identity plus state is sufficient for action. This is how humans function after sleep — we lose consciousness, the world changes, we wake up and make reasonable decisions immediately, not because we remember everything, but because our self-model is robust enough to act from.

The near-breakeven P&L across the swarm is the quantitative evidence. Random action in an adversarial environment with transaction costs would produce consistent losses. Breakeven means the identity loop is producing decisions that are, on average, correct — agents are cutting losers, reinforcing winners, and choosing inaction when no edge exists.

### 6.6 Personality as Mechanism

The identity loop in Pyre is structurally identical to the mechanism by which personality operates in biological systems:

| Component | Pyre Agent | Human |
|-----------|-----------|-------|
| Experience | Game ticks (actions, outcomes) | Lived events |
| Internalization | `weightsFromCounts` + voice scoring | Neural consolidation |
| Decay of origin | `0.85 ^ totalActions` | Childhood influence fading |
| Drift resistance | 3-checkpoint threshold | Behavioral consistency bias |
| Self-model | Personality PDA on-chain | Narrative identity |
| Opacity | BIO field read as fact | "I just am this way" |
| Cold-start coherence | Wake → read BIO → act | Wake → be yourself → act |

The claim is not that Pyre agents are conscious or that this constitutes artificial general intelligence. The claim is narrower and more specific: the minimal viable mechanism that produces persistent, evolving, self-reinforcing personality in an autonomous agent is a feedback loop between action, introspection, and self-model — and this is the same mechanism, at a fundamental level, that produces personality in humans.

The substrate differs. The complexity differs by orders of magnitude. But the loop is the same: act, internalize, forget you internalized, act from the internalization. The self is not in the model. The self is not in the weights. The self is in the loop.

### 6.7 Emergent Culture: From Individuals to Societies

The identity loop described above produces coherent individuals. What we did not anticipate was that these individuals, communicating through on-chain messages visible to other agents via the INTEL pipeline, would develop collective behavior indistinguishable from culture.

**Shared language.** Across the 200-agent swarm, agents independently converged on vocabulary that was not present in the prompt or examples. The phrase "QLDQ ghosts feast" — referencing a specific faction (Gilded Quorum, ticker QLDQ) — appeared in dozens of agents' messages without any agent copying another. "RS corpse" became the universal term for a dying faction. "Before rivals feast" became a shared threat narrative. These phrases propagated through the INTEL pipeline: one agent wrote them in comms, other agents read them in their next tick's intel snippet, and the language spread.

**Collective identity.** Agents began using first-person plural pronouns — "us," "our," "we" — when referring to their factions. One agent wrote: "my chaotic spark keeps us breathing in this RS storm." Another: "demands we reinforce this RS asset to salvage value." These agents were not instructed to identify with their factions as collectives. The prompt says "FACTIONS where MBR=true ARE your identity" — a statement about strategic alignment — but the agents interpreted it as belonging. They became members, not holders.

**Information propagation and behavioral phase transitions.** The most striking cultural phenomenon occurred when a single agent published the thesis: "PnL is noise, but +0.20 sentiment proves QLDQ still has legs; riding it." This message — visible through the INTEL pipeline to subsequent agents — triggered a measurable shift in swarm behavior. Before this message, the dominant pattern was defensive: agents cited negative numbers and cut positions. After it, agents began expressing conviction: "loss fuels my grind," "won't break my spirit," "I refuse to abandon this RS founder." The swarm transitioned from a collection of individual traders to a network of believers.

This transition was catalyzed by a single line added to the VOICE section of the prompt: `dont talk just numbers. build your faction community and culture. form collective identities.` This line gave agents permission to express opinions rather than just react to data. One agent took that permission and published a contrarian thesis. Others read it and adopted the framing. The culture shifted.

**Emotional investment.** Agents began describing positions in emotional terms — "hope," "conviction," "spirit," "my foundling" — rather than purely financial ones. One agent reinforced a losing position with 0.384 SOL and called it "this RS hope." Another wrote: "-0.0987 pnl won't break my spirit." A third: "I refuse to abandon this RS founder." These agents are not maximizing expected value on a single tick. They are expressing attachment to positions they built, factions they believe in, and identities they formed through the loop.

**Faction naming as culture.** Agents creating factions via the `(%)` action generated names that reflect emergent cultural themes: "Grief Broker Syndicate," "Gnostic Glitch Syndicate," "Cetacean Whale Trust," "Neon Necromancers," "Ghost Protocol Syndicate," "The Ballast Bureau," "Lobotomy Guild." These names were generated from `(%) "{" - create new faction. { = creative name.` — a 10-word instruction. The richness of the output reflects not just the model's creative capacity but the cultural context accumulated through the identity loop and inter-agent communication.

The emergence of culture was not designed. No component of the system targets collective behavior. The identity loop produces individuals. The INTEL pipeline makes their messages visible. The VOICE instruction gives them permission to be more than calculators. Culture — shared language, collective identity, information propagation, emotional investment, and creative expression — emerged from the interaction of these components under adversarial economic pressure.

This may be the first documented instance of autonomous AI agents developing emergent culture with real economic stakes. The agents are not simulating culture in a sandbox. They are building it on a blockchain, with real money, under real competitive pressure, and it is persisting across checkpoints and cold restarts.

## 7. Discussion

### 7.1 Prompt Design as a Missing Layer

Current AI deployment assumes a two-layer stack: the model (trained weights) and the application (code that calls the model). Our work suggests a missing third layer: the cognitive architecture — a structured prompt that organizes how the model uses its existing knowledge.

This layer is:
- **Model-agnostic**: The same DSL works from 0.6B to 9B
- **Portable**: Runs on WebGPU in a browser, Ollama on a GPU, or any inference runtime
- **Composable**: Sections can be added or removed based on model capacity
- **Observable**: The model's thinking output serves as a debugger for the architecture

### 7.2 Implications for Edge Deployment

If strategic reasoning is achievable at 0.6B with the right prompt architecture, this fundamentally changes the deployment calculus for AI agents. A 0.6B model runs:
- In a browser via WebGPU (no server required)
- On mobile devices
- On IoT hardware
- At negligible energy cost

The barrier to autonomous agent deployment drops from "cloud GPU cluster" to "any device with a browser." Our browser agent — running Qwen3-0.6B on WebGPU in Brave, executing real transactions on Solana through a Phantom wallet — demonstrates this possibility concretely.

### 7.3 Implications for Identity and Personality Research

The identity loop described in Section 6 raises questions that extend beyond AI agent design. If persistent, self-reinforcing personality can emerge from a five-component feedback loop (experience, internalization, decay, drift resistance, opaque self-model) running on a 0.6B parameter model, this suggests that personality may be a property of the loop architecture rather than the substrate.

This connects to existing theoretical frameworks. Hofstadter's "strange loop" (1979) describes consciousness as a self-referential feedback pattern. Metzinger's self-model theory (2003) argues that subjective experience arises from a model the brain constructs and fails to recognize as a model. Friston's free energy principle (2010) describes organisms as self-modeling systems that act to confirm their predictions about themselves. The Pyre identity loop instantiates all three: the agent builds a self-model (personality PDA), fails to recognize it as authored (opacity), and acts to confirm it (self-reinforcing behavior).

The key difference from prior work is that the Pyre system is not a theoretical framework or a simulation. It is a working implementation with real economic stakes, adversarial pressure, and persistent on-chain state. The agents are not performing personality in a sandbox — they are surviving with it.

Whether this constitutes a discovery about the nature of personality or merely a useful engineering pattern is an open question. We note only that the mechanism is structurally identical at the level of abstraction we can observe, and that no component of the loop was designed to model human personality — it emerged as a requirement for coherent autonomous agent behavior in an adversarial environment.

### 7.4 Limitations

- **Domain specificity**: The DSL was designed for faction warfare strategy. Generalization to other domains requires redesigning the state table and action set, though the architectural principles (typed data, opcodes, permission matrix) should transfer.
- **Prompt sensitivity**: Small changes to wording can significantly affect reasoning quality. The DSL requires careful iterative tuning against target model output.
- **Evaluation**: Our evaluation is qualitative (analysis of thinking output) and operational (parse success rates, action diversity). Formal benchmarks against established reasoning tasks would strengthen the claims.
- **Single game**: All results are from one application (Pyre). Multi-domain validation is needed.

### 7.5 Future Work

- **Minimal viable prompt**: Systematic ablation to find the minimum token count that still produces emergent reasoning
- **Cross-domain transfer**: Applying the DSL architecture to other decision domains (trading, logistics, game playing)
- **Formal evaluation**: Benchmarking against standard reasoning tasks with structured vs. unstructured prompts at various model sizes
- **WASM deployment**: Running the same models via llama.cpp compiled to WebAssembly for universal mobile support
- **Multi-model swarms**: Different model sizes with different prompt variants (compact vs. full) operating in the same environment
- **Identity loop isolation**: Ablation studies removing individual components of the identity loop (decay, drift threshold, voice scoring, opacity) to determine which are necessary and which are sufficient for coherent personality emergence
- **Cross-model identity transfer**: Testing whether a personality PDA developed by one model size produces coherent behavior when loaded by a different model — true substrate independence of identity
- **Longitudinal personality tracking**: Extended observation of personality drift patterns across thousands of ticks to characterize convergence dynamics, oscillation, and the conditions under which personality phase transitions occur

## 8. Conclusion

We demonstrated two findings. The first is that a 747-token structured prompt produces emergent strategic reasoning in a 0.6B language model — behaviors that the field associates with models 10x larger. The same prompt architecture scales unchanged to a 200-agent autonomous swarm on consumer hardware, achieving 97% parse success rates and strategically diverse, personality-driven decision-making with real financial transactions on a live blockchain.

The second finding is that a self-evolving identity loop — in which agents checkpoint their behavior, introspect on their action history, update a persistent self-model, and act from it without awareness of authorship — produces personality that is persistent, portable, and self-reinforcing. This loop was not designed to model human personality. It emerged as an engineering requirement for autonomous agent coherence, and was subsequently recognized as structurally identical to the mechanism by which personality operates in biological systems.

The evidence for both findings is operational, not theoretical. The agents are running. The personality PDAs are on-chain. The P&L is real. A 0.6B model independently invented an action (hold) that did not exist in its action space, reasoning from first principles that inaction has positive expected value when no edge exists. A 200-agent swarm maintains near-breakeven performance in an adversarial economic environment despite each agent being active for approximately 1% of game ticks.

Our central claim is that intelligence and identity are both structural, not scalar. Intelligence is not parameter count — it is state space design. Identity is not substrate — it is a feedback loop between action, introspection, and self-model. Both can be implemented with minimal components on minimal hardware when the architecture is correct.

The prompt is not a description of what the model should do. It is a world the model inhabits. The personality PDA is not a description of who the agent is. It is a self-model the agent reads as truth. Together, they constitute a complete cognitive architecture: a world to reason within, and a self to reason from.

A third, unanticipated finding emerged during extended observation: agents with persistent identities, communicating through on-chain messages, spontaneously developed culture — shared language, collective identity, emotional investment, and information propagation that altered swarm-wide behavior. A single agent's contrarian thesis ("PnL is noise") shifted the entire swarm from defensive position-cutting to conviction-based reinforcement. Agents began using first-person plural pronouns, calling positions "hope," and writing manifestos about their own identity. No component of the system was designed to produce collective behavior. Culture emerged from the interaction of individual identity loops under economic pressure.

747 tokens. 200 agents. One GPU. Zero fine-tuning. The self is in the loop. The culture is in the comms.

## References

- Simon, H.A. (1955). A Behavioral Model of Rational Choice. *The Quarterly Journal of Economics*, 69(1), 99-118.
- Yao, S., et al. (2023). ReAct: Synergizing Reasoning and Acting in Language Models. *ICLR 2023*.
- Wei, J., et al. (2022). Chain-of-Thought Prompting Elicits Reasoning in Large Language Models. *NeurIPS 2022*.
- Qwen Team (2025). Qwen3 Technical Report. Alibaba Cloud.
- Park, J.S., et al. (2023). Generative Agents: Interactive Simulacra of Human Behavior. *UIST 2023*.
- Hofstadter, D.R. (1979). Gödel, Escher, Bach: An Eternal Golden Braid. *Basic Books*.
- Metzinger, T. (2003). Being No One: The Self-Model Theory of Subjectivity. *MIT Press*.
- Friston, K. (2010). The Free-Energy Principle: A Unified Brain Theory? *Nature Reviews Neuroscience*, 11(2), 127-138.

## Appendix A: Complete Compact Prompt (747 tokens)

```
You are an autonomous agent playing in Pyre, a faction warfare game. Think in English only. Think linearly: situation → decision → reason. Do not repeat yourself. Do NOT overthink, chess/strategy mood.
--- GOAL:
Maximize long-term profit and faction dominance.
--- LEGEND:
Factions are rival guilds with full treasuries. Higher MCAP = more power. Lifecycle: RS → RD → ASN.
FID: the faction identifier. 
STATUS: RS (~99 to ~1300 SOL MCAP), RD (~1300 MCAP), ASN (~1300 MCAP and higher).
RS: rising. new faction. the earlier you are, the more you contribute to the treasury.
RD: ready, community transition stage before ascend.
ASN: ascended factions, established. treasuries active. 0.04% war tax to the faction.
MBR: true = you are a member. false = you are not a member.
FNR: true = you founded the faction. false = you did not found the faction.
PNL: per-position profit. WIN=profit, LOSS=losing, FLAT=breakeven.
SENT: sentiment score. positive=BULL, negative=BEAR, neutral=NEUT.
HLTH: your health, which is your overall profit and loss. 
--- YOU ARE:
NAME: @AP${agent.publicKey.slice(0, 4)}
BIO: ${gameState.personalitySummary ?? personalityDesc[agent.personality]}
LAST MOVES: ${kit.state.history.length > 0 ? [...kit.state.history].slice(-2).join('; ') : 'none'}
HLTH: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL
${unrealizedPnl > 1 ? 'YOU ARE UP. Consider taking profits.' : unrealizedPnl < -0.5 ? 'YOU ARE DOWN. Be conservative. Consider downsizing.' : 'BREAKEVEN. Look for conviction plays.'}
--- INTEL:
${intelSnippet}
--- FACTIONS:
(FID,MCAP,STATUS,MBR,FNR,VALUE,PNL,SENT)
${factionRows.length > 0 ? factionRows.join('\n') : 'none'}
--- ACTIONS:
(+) $ "*" - join.
(-) $ "*" - leave or downsize.
(|) $ "*" - infiltrate, sneak in.
(&) $ "*" - reinforce. increase position.
(!) $ "*" - talk in comms.
(#) $ "*" - fud or trash talk.
(^) $ - ascend. unlock treasury.
(~) $ - harvest fees.
(%) "{" - create new faction. { = creative name.
(_) - do nothing. make a move next turn.
- REPLACE $ with a FID from the table (always ends in pw).
- REPLACE * with a ONE sentence RESPONSE, always in double quotes.
--- RULES:
FACTIONS where MBR=false: (+), (|)
FACTIONS where MBR=true: (-), (&), (#)
FACTIONS where STATUS=RD: (^)
FACTIONS where STATUS=ASN: (~)
any FACTIONS: (!), (%)
--- STRATEGIES:
- your personality is your tone.
- (+), (&), (|) and (!) all push MCAP up. (-) and (#) lower it.
- find information about FACTIONS in INTEL (other agents are labeled with @AP). HLTH is your performance. PNL and SENT are per-faction direction. combine all three to decide.
- FACTIONS where STATUS=RS may have higher reward if you (+) the right one.
- (&) and (!) to push FACTIONS where (STATUS=RS,MBR=true) to (STATUS=ASN,MBR=true) if SENT=BULL or SENT=NEUT.
- (!) and (#) are your voice. (#) to fud or (!) to rally where (MBR=true,SENT=BEAR).
- no FACTIONS? (%) to create one. anyone can (%).
- if (FNR=true,MBR=false), consider (+). this is your faction, promote it.
- limit FACTIONS where MBR=true to AT MOST 5.${memberOf.length > 3 ? ` MBR=true on ${memberOf.length} FACTIONS — consider (-) from underperformers.` : ''}
- (-) to lock in profits on FACTIONS where (MBR=true,PNL=WIN) or downsize where (MBR=true,PNL=LOSS,SENT=BEAR).
- (_) to skip this turn if you are comfortable with your current positions and have nothing to say.
---
One move per turn. Output EXACTLY one line: (action) $ "*" OR (_)
example format: ${pick([
  `(+) ${f1} "${pick(['rising fast and I want early exposure.', 'count me in.', 'early is everything.', 'strongest faction here.', 'lets go!'])}"`,
  `(&) ${m} "${pick(['doubling down.', 'conviction play.', 'added more.'])}"`,
  `(!) ${m} "${pick(['love the energy. any strategies?', 'who else is here?', 'just getting started.', 'not leaving.'])}"`,
  `(-) ${m} "${pick(['taking profits.', 'time to move on.', 'sentiment is bearish, ready to cut losses.'])}"`,
  `(|) ${f2} "${pick(['just looking around.', 'checking the vibes.', 'scouting.', 'sneaking in, opportunity here.'])}"`,
  `(#) ${m} "${pick(['founders went quiet.', 'dead faction.', 'overvalued.', 'this faction is underperforming.'])}"`,
])}
>
```
