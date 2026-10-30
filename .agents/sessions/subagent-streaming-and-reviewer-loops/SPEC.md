# SPEC — Subagent Streaming, Specialist Routing, and Reviewer Verdict Robustness

## Goal

Fix three defects reported against the polyglot working tree (branch `feat/polyglot-reaudit-roadmap`):

1. **Subagent streaming is not equivalent to the orchestrator's.** The user wants to "see everything a subagent does, the same way the orchestrator is shown."
2. **Specialist reviewers do not spawn when they should, model-dependently.**
3. **Reviewers loop: "constantly giving results and restarting."** The user wants verdict handling made robust regardless of model or change size, and specifically wants long-running tasks (days, thousands of changes) to not be overwhelmed.

## Confirmed root causes (evidence-backed)

### Issue 1a — direct-child reasoning renders at root
- `cli/src/utils/stream-chunk-processor.ts:29-40` — `destinationFromChunkEvent` routes a `reasoning_chunk` to `{ type: 'root' }` when `event.ancestorRunIds.length === 0`, else to the agent block.
- `sdk/src/run.ts:648-660` — subagent reasoning is emitted with `ancestorRunIds: ancestorRunIds ?? []`.
- Consequence: a direct child of the orchestrator (the common case: editor, basher, reviewers) has empty ancestry, so its thinking renders at ROOT while its text renders in its own agent block.

### Issue 1b — child tool blocks can land at root
- `cli/src/utils/sdk-event-handlers.ts` `handleRegularToolCall` nests a tool block under the agent only when BOTH `event.parentAgentId` and `event.agentId` are set; otherwise it appends at root.
- `handleToolCall` returns early for `spawn_agents` and hidden tools, with no `parentAgentId`-independent fallback.
- Consequence: a child tool call whose event omits `parentAgentId` appends at ROOT instead of nesting under the child.

### Issue 1c — supervised child drops all non-text/reasoning events
- `packages/agent-runtime/src/supervision/child-entry.ts:492-531` — `buildChildOnResponseChunk` forwards ONLY: string chunks, `text`-type PrintModeEvents, and `reasoning_delta` events.
- Every `tool_call`, `tool_result`, `subagent_start`, `subagent_finish`, `phase`, and `error` event is silently dropped. The docblock at `:456-467` documents this as "a documented follow-up".
- The bridge transport is NOT the defect: `sendSubagentChunk` IS bridged (`child-entry.ts:122`, wired `:689`), and `sendAction` is likewise bridged.
- Consequence: under `processSupervision`, a child's prose/thinking stream live but its TOOL ACTIVITY is invisible — no `read_files`, no `edit_transaction`, no nested `subagent_start`.

## Non-goals

- Do NOT change the `SendSubagentChunkFn` contract shape (`common/src/types/contracts/client.ts:50-69`). User chose routing child events over the EXISTING bridged `sendAction` channel instead.
- Do NOT change reviewer/repair budget DEFAULTS. Unlimited-by-default stays; any finite value remains an explicit opt-in.
- Do NOT alter the root orchestrator's own streaming behavior.

## Requirements

- R1: A direct-child subagent's reasoning renders in that child's agent block, not at root.
- R2: A subagent's tool calls/results nest under the child's agent block regardless of whether `parentAgentId` is present on the event.
- R3: Under supervision, a child's tool/lifecycle events reach the parent and render the same way the in-process path's do.
- R4: A change touching only manifests/lockfiles/CI files still spawns its routed specialist (e.g. `dependency-reviewer` for `package.json`), while those files stay out of the code-reviewer attestation set.
- R5: When nothing routes, an explicit skip reason is recorded and surfaced (no silent no-op).
- R6: A reviewer that RAN but failed to emit a schema-valid verdict can have its verdict recovered deterministically from its output, without loosening what counts as passing.
- R7: The retry prompt feeds back the specific protocol error from the prior attempt.
- R8: On long runs, review proceeds in bounded per-wave units with per-file credit that survives receipt eviction, so a wave can always complete within one context window.

## Acceptance criteria

- A1: `destinationFromChunkEvent` routes a subagent reasoning_chunk (empty ancestry, non-empty agentId) to the agent block; a root reasoning_chunk (no agentId) still routes to root.
- A2: A tool_call event for a child nests under the child's block with no `parentAgentId`.
- A3: A supervised child's tool_call/tool_result events reach the parent event stream and render.
- A4: `dependency-reviewer` spawns for a manifest-only change; the manifest does not enter the code-reviewer attestation set.
- A5: A no-routing outcome records a non-empty `lastReviewerGateSkipReason`.
- A6: A verdict embedded in prose/fenced JSON is recovered; the recovered object is still subject to every existing hard rule.
- A7: The retry prompt names the prior attempt's specific schema violation.
- A8: Review of a >40-file change proceeds wave-by-wave with per-file credit; no single attestation requires enumerating thousands of files.

## Relevant systems

- CLI streaming: `cli/src/utils/stream-chunk-processor.ts`, `cli/src/utils/sdk-event-handlers.ts`
- SDK event mapping: `sdk/src/run.ts` (`onSubagentResponseChunk`, `onResponseChunk`)
- Supervision: `packages/agent-runtime/src/supervision/child-entry.ts`, `child-bridge-client.ts`, `parent-bridge-server.ts`, `bridge-protocol.ts`
- Contracts: `common/src/types/contracts/client.ts`
- Gate/reviewer: `agents/base2/base2.ts` (serialized `handleSteps`), `agents/base2/gate-reviewer.ts`, `agents/base2/gate-paths.ts`, `common/src/agents/specialist-risk-router.ts`
- Budgets: `common/src/util/gate-repair-budgets.ts`
