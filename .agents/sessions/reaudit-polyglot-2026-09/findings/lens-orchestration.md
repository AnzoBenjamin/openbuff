# Audit findings: lens-orchestration

- Subsystems: agent-runtime-orchestration, sdk-run-lifecycle, common-session-state, base2-gates
- Features: durable-execution, handleSteps-sandbox, agent-supervision, multi-machine-swarm, provider-scheduler, deterministic-replay, workflow-engine, sdk-bounded-concurrency
- Files covered: 16
- Snapshot: 1100aecfb57d2576e054f1182e75c6f694d6f6908577ed90429482adbdb02be8

## [HIGH] state-mutation — packages/agent-runtime/src/run-programmatic-step.ts — ORCH-1 Durable execution: runs cannot survive crash/reboot mid-tool-call (generators live only in memory)
- **Risk:** Current state: AgentRunContextRegistry comment states 'Generator state can't be serialized, so we store it in memory'. loopAgentSteps (run-agent-step.ts) checkpoints only the MAIN agent, throttled to CHECKPOINT_INTERVAL_MS=30_000, and subagent loops pass no onCheckpoint. On resume, reconcileInterruptedLedgerSpawns / reconcileInterruptedPathLeases / reconcileInterruptedBackgroundAgentIntents can only mark in-flight work 'interrupted' - they cannot continue it. background-agent-jobs.ts header: 'There is no disk recovery: background agents are process-scoped and never outlive the CLI process.' A base2 handleSteps generator mid-gate is simply restarted from the top. Feature unlocked: resume exactly at the step/tool call that was in flight, including subagents and background agents; turns survive laptop sleep/reboot/OOM. User value: very high for long autonomous runs. Candidate: Restate/Temporal-style event-sourced journal (Restate has a TS SDK; Temporal has TS/Go SDKs) or an Elixir/Go kernel with persisted process state. Honest verdict: the blocker is NOT the language - it is JS generators + in-place mutation of AgentState. A BEAM rewrite does not make handleSteps serializable either. TS can do it via journaled replay: persist every yielded value + tool result per runId, and on resume re-run the generator feeding recorded results (Temporal's determinism model).
- **Fix:** Introduce a per-run append-only step journal (SQLite, bun:sqlite already bundled) recording generator yields, tool-call inputs/outputs, LLM responses, and spawn receipts; rebuild generators by deterministic replay; checkpoint at every step boundary for all agents (not 30s main-only). Keep TS; optionally adopt Restate TS SDK. Requires injecting clock/rng into handleSteps (see ORCH-6).
- **Evidence:** run-programmatic-step.ts AgentRunContextRegistry ('Generator state can't be serialized'); run-agent-step.ts CHECKPOINT_INTERVAL_MS = 30_000 and onCheckpoint 'Only fired for the main agent loop'; background-agent-jobs.ts header 'There is no disk recovery'; workspace-path-leases.ts in-memory `activeLeases` Map + reconcileInterruptedPathLeases marks 'interrupted'; orchestration-ledger.ts reconcileInterruptedLedgerSpawns reason 'Run resumed without a durable terminal spawn receipt.'

## [HIGH] security — packages/agent-runtime/src/run-programmatic-step.ts — ORCH-2 handleSteps runs in the host realm via new Function; the 'QuickJS sandbox' test does not exercise any sandbox
- **Risk:** Current state: string handleSteps are materialized with `new Function(`return (${template.handleSteps})`)()` in the main Bun realm, gated only by an executionSource allowlist ('bundled'|'local'|undefined); 'database' is denied outright. sandbox-generator.test.ts is titled 'QuickJS Sandbox Generator' but just calls runProgrammaticStep with a string generator - no QuickJS/isolate exists. Consequences: (a) a trusted-local agent has full process authority (globalThis, fetch, require via globals), (b) untrusted community agents can only be published prompt-only, (c) CPU-bound or infinite loops inside a generator's sync code block the whole event loop (MAX_PROGRAMMATIC_TOOL_CALLS only bounds yields, not work between yields). Feature unlocked: installable untrusted programmatic agents (marketplace), per-agent CPU/memory limits and interrupt, and - uniquely - SERIALIZABLE generator state via QuickJS heap snapshots, which directly unblocks ORCH-1. Candidate: QuickJS compiled to WASM (quickjs-emscripten, TS-hostable) or wasmtime + Javy/extism. TS can do this: quickjs-emscripten is a JS package; no host rewrite needed.
- **Fix:** Run string handleSteps in a quickjs-emscripten context with interrupt handler (step/CPU budget), memory limit, and a narrow bridge exposing only yield/next; inject the orchestrationControlPlane functions as host callbacks. Rename or rewrite sandbox-generator.test.ts to assert isolation (no globalThis/fetch access, interrupt on busy loop). Evaluate QuickJS snapshotting for durable generators.
- **Evidence:** run-programmatic-step.ts: TRUSTED_STRING_HANDLE_STEPS_EXECUTION_SOURCES = new Set(['bundled','local']); `new Function(`return (${template.handleSteps})`)()`; sandbox-generator.test.ts:21 describe('QuickJS Sandbox Generator') and :100 test body only calls runProgrammaticStep.

## [HIGH] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — ORCH-3 No supervision/fault isolation: every agent is a coroutine on one event loop sharing mutable parent state
- **Risk:** Current state: foreground subagents run via Promise.allSettled and background agents as 'fire-and-forget same-process' promises (spawn-agents.ts comment). Settle handlers mutate parentAgentState in place (discoveryCoverage, backgroundAgentJobs intents, leases), and loopAgentSteps documents it 'mutates params.agentState in place throughout the run'. Caps are counters (32 process-wide, 8 per root, MAX_SPAWN_BATCH_SIZE, maxSpawnDepth at spawn-agent-utils.ts:2305). Cancellation is cooperative AbortSignal only - a non-cooperative handler or sync loop cannot be killed. No restart strategy exists: a crashed child yields a 'failed' receipt and the parent model must decide. Feature unlocked (Elixir/OTP or Go): per-agent processes with preemptive kill, supervision trees (one_for_one restart of a flaky reviewer with backoff), memory isolation, crash containment, live introspection (observer-style agent tree). User value: high for large swarms; moderate for today's typical 1-8 child runs. Cost/risk: Elixir kernel = new runtime to distribute, contributor skillset, and agents/handleSteps/tools are still JS so you'd need JS workers anyway (Prisma-style retreat risk). TS partial path: Bun Worker per agent with message-passing - but blocked by the in-place shared-mutation design, which is the real refactor.
- **Fix:** First refactor to message-passing: children return receipts/events; only the parent's own loop applies them to parent state (already half-true via reconcileAgentReceiptIntoParent). Then run each subagent in a Bun Worker (or subprocess) under a small TS supervisor with restart policies and hard kill. Consider an Elixir/Go supervisor only if multi-machine (ORCH-4) becomes a goal.
- **Evidence:** spawn-agents.ts: 'the coroutine runs as a fire-and-forget same-process job'; settle `.then` writes parentAgentState.discoveryCoverage / intent.status; background-agent-jobs.ts MAX_RUNNING_BACKGROUND_AGENT_JOBS=32, _PER_ROOT=8; run-agent-step.ts loopAgentSteps doc 'mutates params.agentState in place'; spawn-agent-utils.ts:2269 executeSubagent, :2305 depth check.

## [MEDIUM] correctness — packages/agent-runtime/src/util/workspace-path-leases.ts — ORCH-4 Multi-machine swarms impossible: leases, job registry, and ownership are process-local singletons
- **Risk:** Current state: `activeLeases` is a module Map; overlap is a lexical stable-prefix check; two CLI processes on the same repo cannot see each other's leases. jobRegistry is a process-wide singleton; getTrustedSessionClientId is a per-process random UUID (sdk/run.ts). No remote worker, SSH, or container dispatch path exists; tools execute via requestToolCall in-process. Feature unlocked: agent swarms fanning out to remote workers/containers (git worktree per worker), cross-process write-conflict prevention, a shared job view across terminals. Candidate: BEAM distribution (nodes, :global/:pg registries) or Go daemon with gRPC; alternatively a local lease/job service in any language. TS could do it (daemon over unix socket + SQLite leases), but BEAM gives distribution/registries for free - this is the strongest genuine case for Elixir.
- **Fix:** Promote leases + job registry to a resident local daemon (same daemon proposed for the index) with SQLite-backed leases and fencing tokens; define a worker protocol (spawn receipt in, events out) so remote workers (SSH/container) can join. Choose Go/Rust for a single static daemon, or Elixir if multi-node clustering is a first-class goal.
- **Evidence:** workspace-path-leases.ts: `const activeLeases = new Map<string, ActiveLease>()`, overlaps() via stablePrefix; extendWorkspacePathLease throws 'no longer held in runtime memory'; sdk/src/run.ts getTrustedSessionClientId per-process randomUUID; background-agent-jobs.ts 'shares the process-wide jobRegistry singleton'.

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — ORCH-5 No cost/rate-limit scheduler across agents, sessions, or providers
- **Risk:** Current state: selectAgentAttempt is called with a single candidate (explicitRoute: true) and a running count; admission is a count cap, not a token/cost/RPM budget. Budget enforcement (checkBudgetExceeded) is per agent run after the fact; background agent costs are not aggregated into the parent ('surfaced on poll'). Concurrent CLI sessions each hit providers independently. Feature unlocked: global BYOK spend and rate-limit scheduler (token buckets per provider/key, priority queues: reviewer before speculative file-picker, automatic model fallback when a provider is throttled), cross-session budgets. Candidate: Go (goroutines + x/time/rate) or Elixir GenStage in a daemon. TS is adequate within one process; cross-process requires a daemon regardless of language.
- **Fix:** Add a scheduler interface in front of promptAiSdk (acquire(provider, estTokens, priority)) with token buckets fed by provider 429/usage headers; include background agents in parent cost; later move it into the shared daemon for cross-session enforcement.
- **Evidence:** spawn-agents.ts selectAgentAttempt({ candidates: [ { template, contextWindowTokens, explicitRoute: true } ], runningForRoot, maxRunningForRoot: 8 }); comment 'background agent costs are accumulated into their own AgentState and surfaced on poll'; run-agent-step.ts checkBudgetExceeded per step.

## [MEDIUM] correctness — packages/agent-runtime/src/util/orchestration-ledger.ts — ORCH-6 No deterministic replay: nondeterminism is ambient and the ledger is lossy
- **Risk:** Current state: crypto.randomUUID and Date.now are called directly throughout (agentStepId, toolCallId, ledger eventId/timestamp, lease ids). The orchestration ledger is capped at MAX_LEDGER_EVENTS=256 with compaction, and LLM responses/tool outputs are not journaled (only debug logs). Feature unlocked: time-travel debugging ('replay run X step-by-step'), fork-from-step with a different model/prompt, regression fixtures from real runs, eval reproducibility. Candidate: any durable-execution runtime; language-independent. TS fully adequate - requires injecting Clock/Rng/IdGen deps and journaling I/O (same journal as ORCH-1).
- **Fix:** Thread clock/idGen through AgentRuntimeDeps; record LLM stream results and tool results into the run journal; build `openbuff replay <runId> [--from-step N --model M]`.
- **Evidence:** orchestration-ledger.ts MAX_LEDGER_EVENTS = 256, compactEvents, randomUUID/Date.now; run-agent-step.ts `const agentStepId = crypto.randomUUID()`; tool-executor.ts generateCompactId for toolCallId.

## [LOW] api-contract — packages/agent-runtime/src/orchestration/workflow-engine.ts — ORCH-7 Workflow engine is advisory; the real gate is imperative generator code
- **Risk:** Current state: file header says 'ADVISORY / TELEMETRY-ONLY ... NOT the authoritative orchestration gate'; base2GateWorkflowV1 transitions are recorded but base2 handleSteps decides. Because control flow lives in an opaque generator, it cannot be persisted, visualized, or resumed. Feature unlocked: declarative, persisted statecharts (resume a gate in 'awaiting_review'), visual run graphs. TS adequate (XState or promote this engine); no language move needed.
- **Fix:** Promote gate decisions into the WorkflowStateV1 machine with persisted revisions; have base2 read/drive it; this also shrinks what ORCH-1 must replay.
- **Evidence:** workflow-engine.ts header comment; transitionBase2Gate injected into base2 via orchestrationControlPlane (run-programmatic-step.ts).

## [LOW] performance — sdk/src/tools/concurrency.ts — ORCH-8 SDK bounded fan-out and gate-concurrency are TS-adequate
- **Risk:** mapWithConcurrency is a correct bounded worker pool with first-error-wins and full drain; gate-concurrency.ts is a small pure absorption predicate. Filesystem fan-out is I/O-bound; goroutines/BEAM add nothing here. Recorded to be honest where TS is adequate.
- **Fix:** No language change. Keep as is.
- **Evidence:** sdk/src/tools/concurrency.ts mapWithConcurrency; agents/base2/gate-concurrency.ts shouldAbsorbGitStatusFile (lines 12-31).

## Coverage receipt

### Subsystems
- agent-runtime-orchestration
- sdk-run-lifecycle
- common-session-state
- base2-gates

### Features
- durable-execution
- handleSteps-sandbox
- agent-supervision
- multi-machine-swarm
- provider-scheduler
- deterministic-replay
- workflow-engine
- sdk-bounded-concurrency

### Files
- .agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md
- packages/agent-runtime/src/run-agent-step.ts
- packages/agent-runtime/src/run-programmatic-step.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/util/background-agent-jobs.ts
- packages/agent-runtime/src/orchestration/workflow-engine.ts
- packages/agent-runtime/src/util/orchestration-ledger.ts
- packages/agent-runtime/src/util/workspace-path-leases.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/__tests__/sandbox-generator.test.ts
- sdk/src/run.ts
- sdk/src/run-state.ts
- sdk/src/tools/concurrency.ts
- common/src/types/session-state.ts
- agents/base2/gate-concurrency.ts

### Domains
- correctness
- state-mutation
- security
- error-handling
- performance
- api-contract
