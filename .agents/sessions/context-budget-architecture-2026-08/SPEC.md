# Context Budget Architecture — SPEC

Status: draft
Session: context-budget-architecture-2026-08
Owner: orchestrator (Buffy)
Related audits: docs/audits/read-write-indexing-2026-07-14 (workspace revision now exists in common/src/types/workspace-state.ts)

## Problem statement

The model context window fills quickly because cost lives in two pools and only one is managed:

1. Fixed per-turn baseline (NEVER pruned). Re-sent on every request:
   - Orchestrator system prompt (core mandates, edit mandates, harness recovery, spawning guidelines, gate semantics, git discipline, security patterns, specialist routing) plus inlined AGENTS.md, patterns index, language profile.
   - Project file tree via getProjectFileTreePrompt (packages/agent-runtime/src/system-prompt/prompts.ts:121), token-budgeted but large.
   - Knowledge files via knowledgeFilesPrompt (prompts.ts:14) and docs/architecture.md.
2. Conversation history (the ONLY pruned pool). Pruning is reactive: maybePruneContext (packages/agent-runtime/src/util/context-pruning.ts:262) does nothing until total tokens exceed DEFAULT_MAX_CONTEXT_TOKENS = 190_000, then trimMessagesToFitTokenLimitWithReport (packages/agent-runtime/src/util/messages.ts:385) drops oldest messages and simplifies old tool results (keep N most recent full via numToolResultsToKeep).

Automatic injections compound the problem:
- Proactive query_index: classifyProactiveRetrieval (agents/base2/base2.ts:7893) fires on a very broad keyword set (code, file, repo, project, module, package, function, class, component, hook, api, schema, config, test, implement, fix, debug, refactor, audit, review, investigate, architecture, flow, index, context). Result is a verbose programmatic_tool_result block (often ~10k tokens) with NO cross-turn dedup. A second site exists in agents/general-agent/general-agent.ts (shouldProactivelyQueryIndex).
- git_status: yielded at 9 sites in agents/base2/base2.ts handleSteps (lines 787, 1097, 2480, 3133, 3354, 3474, 4064, 4301, 4449). Cheap individually but redundant; re-fires even when the worktree is unchanged, and each injection rides along in history.

Root structural gap: there is no per-component token accounting and no per-turn budget enforcement. The biggest, most repetitive costs are in the unmanaged fixed baseline.

## Goals

- G1. Measure: produce a per-turn, per-component token ledger (system sections, file tree, knowledge, proactive retrieval, git observations, conversation) with telemetry.
- G2. Retrieval dedup: make proactive query_index cached and deduped by (normalized query, workspace revision); inject a compact pointer on repeats instead of the full result.
- G3. Git deltas: collapse the 9 git_status yield sites behind one guarded helper that injects a compact delta only when the worktree changed since the last observation.
- G4. Progressive prompt disclosure: move large static rule blocks into retrievable skills/knowledge and keep only a compact index inline; fetch full text on demand.
- G5. Earlier, gentler compaction: wire the existing model-aware semantic budget into the main loop so compaction starts before the 190k emergency brake.

## Non-goals

- Not changing the provider/model routing or BYOK architecture.
- Not rewriting the LLM-based context-pruner agent's summarization heuristics (agents/context-pruner.ts) beyond wiring it to the budget; its knowledge-memory and pinned-active-work logic stays intact.
- Not altering the deterministic edit / read-capability system.
- Not changing the reviewer/validation gate contract.
- No new third-party dependencies.

## Requirements

- R1 (Ledger). Introduce a ContextBudgetLedger type and a collector that measures each injected block with countTokens/countTokensJson (packages/agent-runtime/src/util/token-counter.ts) and records category, tokens, and cacheability. Must be O(blocks) and reuse the existing TOKEN_COUNT_CACHE.
- R2 (Telemetry surface). Expose the ledger to the CLI via a new /context command (or extend /usage) showing per-component token cost and % of window. Follow agents/patterns/ship-a-cli-command.md and register in cli/src/commands/command-registry.ts + cli/src/data/slash-commands.ts.
- R3 (Retrieval cache). Add a retrieval cache keyed by stableHash(normalizedQuery) + workspace revision (common/src/types/workspace-state.ts stableHash/advanceWorkspaceState). On hit with unchanged revision, emit a one-line pointer message instead of the full query_index result. Tighten classifyProactiveRetrieval so generic words (context, index, flow) alone do not trigger; require stronger intent.
- R4 (Git delta helper). Add a single guarded helper (e.g. maybeYieldGitObservation) that compares current worktree fingerprint against the last-observed fingerprint stored in agentState; yields a compact delta ("+N modified since last check" or full status on first observation / after change) and nothing when unchanged. Replace all 9 inline git_status yields in base2.ts with calls to it.
- R5 (Progressive disclosure). Split the orchestrator system prompt into a compact always-on index plus on-demand detail blocks served through the existing skill/knowledge mechanism. Keep behavior-equivalent guidance reachable; do not drop any mandate, only relocate verbose detail.
- R6 (Early compaction). Call getSemanticCompactionBudget (context-pruning.ts:109) in the main loop (packages/agent-runtime/src/run-agent-step.ts) and trigger semantic compaction at triggerBudgetTokens rather than waiting for DEFAULT_MAX_CONTEXT_TOKENS. Preserve pinned control-plane memory and the fixed baseline (they sit outside the history budget).
- R7 (Tool-result lifecycle). Tag verbose tool results (query_index, read_files, spawn_agents) with a TTL/importance so they compress to receipts after a configurable number of turns, replacing the blunt numToolResultsToKeep cutoff. Must remain deterministic and testable.
- R8 (Backward compat). All changes behind feature flags / config with safe defaults; existing tests (agents/__tests__/base2.test.ts "base2 proactive index lookup", packages/agent-runtime/src/util/__tests__/context-pruning.test.ts, agents/e2e/context-pruning-threshold.e2e.test.ts) must keep passing.

## Acceptance criteria

- AC1. A /context (or /usage) invocation prints a per-component token breakdown summing to within 5% of the actual request token count.
- AC2. Repeating an equivalent prompt within an unchanged workspace revision injects a pointer (<200 tokens) instead of a full query_index result; verified by a unit test asserting the second turn's injected block size.
- AC3. With an unchanged worktree, consecutive turns inject zero git_status blocks; after a real change, exactly one compact delta is injected. Verified by a base2 handleSteps test.
- AC4. The always-on orchestrator system prompt token count drops by a measurable target (measure baseline first; target >= 25% reduction) with all guidance still retrievable on demand.
- AC5. Semantic compaction triggers at the model-aware triggerBudgetTokens on a synthetic growing history, before reaching DEFAULT_MAX_CONTEXT_TOKENS; verified by an e2e/property test.
- AC6. No regression in existing context-pruning, proactive-retrieval, and gate tests.

## Relevant systems (exact files)

- packages/agent-runtime/src/util/context-pruning.ts — budgets, maybePruneContext, getSemanticCompactionBudget, getEffectiveContextLimits, DEFAULT_MAX_CONTEXT_TOKENS.
- packages/agent-runtime/src/util/messages.ts — trimMessagesToFitTokenLimitWithReport, simplifyToolResultHelper, getContextCategoryTelemetry, extractPinnedContextBlocks, numToolResultsToKeep, shortenedMessageTokenFactor.
- packages/agent-runtime/src/util/token-counter.ts — countTokens, countTokensJson, countTokensForFiles, TOKEN_COUNT_CACHE.
- packages/agent-runtime/src/system-prompt/prompts.ts — getProjectFileTreePrompt, getSystemInfoPrompt, getGitChangesPrompt, knowledgeFilesPrompt, additionalSystemPrompts.
- packages/agent-runtime/src/system-prompt/truncate-file-tree.ts — truncateFileTreeBasedOnTokenBudget.
- packages/agent-runtime/src/system-prompt/search-system-prompt.ts — getSearchSystemPrompt.
- packages/agent-runtime/src/run-agent-step.ts — loopAgentSteps, contextTokenCount computation, where maybePruneContext is called.
- agents/base2/base2.ts — classifyProactiveRetrieval (7893), proactive query_index yield (~704), 9 git_status yields.
- agents/general-agent/general-agent.ts — shouldProactivelyQueryIndex (second proactive site).
- agents/context-pruner.ts — LLM summarization, knowledge memory, pinned active work.
- common/src/types/workspace-state.ts — WorkspaceStateV1, stableHash, advanceWorkspaceState, createInitialWorkspaceState.
- sdk/src/services/workspace-journal.ts, workspace-mutation-broker.ts — revision/journal machinery.
- cli/src/commands/command-registry.ts, cli/src/data/slash-commands.ts — command registration.
- packages/indexer/src/index-manager.ts, cli/src/utils/index-workspace-watcher.ts — index staleness/refresh.

## Key interfaces (pseudo-code)

// packages/agent-runtime/src/util/context-budget.ts (NEW)
export type ContextCategory =
  | 'system-core' | 'system-rules' | 'file-tree' | 'knowledge'
  | 'proactive-retrieval' | 'git-observation' | 'conversation' | 'tool-result'

export interface BudgetLine { category: ContextCategory; label: string; tokens: number; cacheable: boolean }
export interface ContextBudgetLedger {
  lines: BudgetLine[]
  totalTokens: number
  windowTokens: number
  reservedTokens: number
  byCategory: Record<ContextCategory, number>
}
export function recordBlock(ledger, category, label, content, opts?): BudgetLine
export function finalizeLedger(ledger, windowTokens): ContextBudgetLedger
export function formatLedgerForCli(ledger): string

// retrieval cache (NEW, near base2 or a shared util)
export interface RetrievalCacheEntry { queryHash: string; workspaceRevision: number; tokens: number; at: number }
export function retrievalCacheKey(query: string, revision: number): string
export function shouldReuseRetrieval(entry, query, revision): boolean

// git delta helper (NEW helper consumed by base2 handleSteps)
export function maybeYieldGitObservation(state: { lastGitFingerprint?: string; workspaceRevision?: number }):
  | { toolName: 'git_status'; input: {}; note: 'first'|'changed' }
  | { addMessage: string }   // compact delta or nothing
  | undefined                // unchanged -> inject nothing

## Risks and mitigations

- Risk: progressive disclosure hides guidance the model needs. Mitigation: keep a compact always-on index with trigger keywords; measure task success on evals before/after; gate behind flag.
- Risk: retrieval dedup serves stale candidates after external edits. Mitigation: key on workspace revision from workspace-state.ts and index staleness; invalidate on markPathsChanged.
- Risk: git delta suppresses a needed observation. Mitigation: always emit full status on first observation and after any revision change; delta only within an unchanged revision.
- Risk: early compaction drops pinned control-plane memory. Mitigation: keep pinned blocks (extractPinnedContextBlocks) and fixed baseline outside the history budget, as today.
- Risk: token counting drift vs provider. Mitigation: reuse existing gpt-tokenizer + ANTHROPIC_TOKEN_FUDGE_FACTOR; treat ledger as advisory telemetry, not a hard request gate initially.

## Out of scope (future)

- Hard per-component request gating (refuse to inject over budget) — start advisory.
- Semantic (embedding) retrieval dedup — start with exact normalized-query + revision key.
- Cross-session budget persistence.
