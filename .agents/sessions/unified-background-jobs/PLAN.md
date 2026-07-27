# Unified Background Job Architecture — PLAN

<!-- current-task: M1.1 unified core registry -->

Status legend: `[ ]` pending, `[~]` in_progress, `[x]` done, `[!]` blocked.

## Milestones

### M0 — Discovery & blast-radius (DONE)
- [x] M0.1 Discovery shards machine-confirmed the exact blast radius (see DESIGN §Consumers).

### M1 — Unified core in `common` (single source of truth) — DONE
- [x] M1.1 New module `common/src/util/job-registry.ts` + wait/snapshot/stream primitives + 63 unit tests (63/63 pass, common typecheck clean).

### M2 — Shell (process) adapter in `sdk` — DONE (49/49 sdk tests)
- [x] M2.1 ProcessJobAdapter: spawn/kill/log capture/quota.
- [x] M2.2 Cross-session recovery as write-only disk projection; removed pendingJobs gate for shell.
- [x] M2.3 Re-pointed run-terminal-command BACKGROUND branch.

### M3 — Agent adapter in `agent-runtime` — DONE (24/24 agent tests)
- [x] M3.1 AgentJobAdapter: coroutine, AbortController cancel, chunk streaming, capacity limits (shares singleton, per-kind agent bounds).
- [x] M3.2 Re-pointed spawn-agents background path + background-agent-jobs.

### M4 — Tool migration (thin wrappers) — DONE (31/31 agent-runtime; all typechecks clean)
- [x] M4.1 check_job unified event result; M4.2 check_background_agent; M4.3 kill/list/read_logs + end_turn on unified core; M4.4 schemas (full JobState/JobEventPayload/kind); M4.5 DELETED authorize-background-job.ts + common/util/pending-background-jobs.ts. Single-key bg-agent ids.

### M5 — Live UI — IN PROGRESS
- [~] M5.1 Run loop consumes job event stream; M5.2 CLI renders live job status/output.

### M6 — Prompts, docs, evals, generated bundles
- [ ] M6.1 agent prompts; M6.2 docs/deterministic-edit-system.md; M6.3 evals + regenerate cli/release bundles.

### M7 — Validation & review
- [ ] M7.1 typecheck all; M7.2 test all touched suites; M7.3 live dev-server smoke; M7.4 coverage gate.

## DESIGN (authoritative implementation spec)

### Core types (`common/src/util/job-registry.ts`)
```ts
export type JobKind = 'process' | 'agent'
export type JobState =
  | 'queued' | 'running' | 'stopping'
  | 'completed' | 'error' | 'stopped' | 'lost' | 'cancelled'
export const TERMINAL_STATES: ReadonlySet<JobState> // completed|error|stopped|lost|cancelled

export interface JobOwner { clientSessionId: string; rootRunId: string; parentRunId: string; parentAgentId: string }

export type JobEventPayload =
  | { type: 'output'; data: string }                       // shell stdout/stderr bytes (agent 'text' chunk)
  | { type: 'agent_chunk'; chunkType: string; data: unknown } // agent structured chunk (tool_call/tool_result/subagent_*)
  | { type: 'lifecycle'; state: JobState; exitCode?: number|null; error?: string }
  | { type: 'status'; message?: string }

export interface JobEvent { sequence: number; jobId: string; timestamp: number; payload: JobEventPayload }

export interface Job {
  jobId: string; kind: JobKind; state: JobState; owner: JobOwner
  label: string            // shell: command; agent: agentType
  createdAt: number; startedAt?: number; completedAt?: number
  exitCode?: number|null; error?: string; result?: unknown  // agent result
}
```

### State machine (enforced, un-bypassable)
- `queued -> running -> stopping -> {completed|error|stopped|lost|cancelled}`
- `queued -> running`; `running -> stopping`; `stopping -> <terminal>`; `running -> <terminal>`.
- No transitions out of a terminal state. Adapters NEVER mutate state; they call `registry.emit()` and the registry folds lifecycle events into state.

### Registry API
```ts
class JobRegistry {
  create(params:{ kind:JobKind; label:string; owner:JobOwner }): Job        // state=queued, emits lifecycle(queued)
  start(jobId): Job                                                          // queued->running
  emit(jobId, payload: Omit<JobEventPayload,'sequence'>): JobEvent           // appends to ring buffer; lifecycle payloads fold into state
  get(jobId): Job | undefined
  list(owner?: Pick<JobOwner,'clientSessionId'|'rootRunId'>): Job[]          // running + settled-within-TTL
  listRunning(owner?): Job[]
  assertOwned(jobId, owner): Job | { error: 'not_found'|'foreign' }          // ownership enforced INSIDE registry
  snapshot(jobId, cursor=0): { events: JobEvent[]; nextCursor: number; state: JobState; truncated: boolean; dropped: number }
  wait(jobId, opts:{ predicate?: (e:JobEvent)=>boolean; timeoutMs?: number; cursor?: number }):
       Promise<{ events: JobEvent[]; nextCursor: number; state: JobState; matched: boolean; timedOut: boolean; dropped: number }>
  stream(jobId, cursor?): AsyncIterable<JobEvent>                            // in-process push for UI/run-loop
  cancel(jobId): void  // emits lifecycle(cancelled/stopping); adapter does the real kill/abort
}
export const jobRegistry: JobRegistry  // process-wide singleton (replaces pending-background-jobs Map)
```
- Ring buffer: bounded (e.g. 500 events / 256KB per job), oldest evicted, `dropped` counter tracked. Per-consumer cursors; cursor = last-consumed sequence (0 = from start). NO job-global read offset.
- `wait` resolves on (a) predicate match over new events, (b) terminal state, or (c) timeout. Subsumes follow-mode + dev-server readiness.
- TTL sweep for settled jobs (24h shell-consistent, or kind-aware).
- Test hooks: `__clearJobRegistryForTest()`.

### Adapter pattern (dependency inversion)
```ts
interface JobAdapter {
  readonly kind: JobKind
  // adapter owns the real process/coroutine; it ONLY emits events via registry.emit().
}
// sdk registers ProcessJobAdapter; agent-runtime registers AgentJobAdapter.
// The registry never imports either. Disk metadata (shell) is a write-only recovery projection.
```

### Consumers to migrate (M2/M3/M4)
- common/src/util/pending-background-jobs.ts → REPLACED by job-registry.ts (keep as thin deprecated re-export during transition, or delete + fix all importers).
- sdk: tools/background-jobs.ts, run-terminal-command.ts, check-job.ts, kill-job.ts, list-jobs.ts, read-logs.ts, run.ts(1323).
- agent-runtime: util/background-agent-jobs.ts, tools/handlers/tool/{spawn-agents,check-background-agent,check-job,kill-job,list-jobs,read-logs,authorize-background-job,end-turn}.ts, run-agent-step.ts(32,1096), util/step-loop-guard.ts.
- common tool schemas: tools/params/tool/{check-job,check-background-agent,kill-job,list-jobs,read-logs}.ts.
- cli: components/tools/background-job-tools.tsx, run-terminal-command.tsx, terminal-command-display.tsx, utils/sdk-event-handlers.ts.
- prompts/docs/evals: agents/base2/base2.ts, agents/editor/editor.ts, agents/base2/base-deep.ts, docs/deterministic-edit-system.md, evals/buffbench/*.
- generated: cli/release/index.js, cli/release-staging/index.js (regenerate, do not hand-edit).

### Key invariants
- Single source of truth: the JobRegistry. Disk metadata (shell) is a projection, never consulted for live state.
- Ownership is a job attribute checked in `assertOwned`, inside the registry. The authorize/foreign/recover tri-state gate is DELETED.
- Per-consumer cursors only; at-least-once semantics; explicit cursor is idempotent.
- Bounded memory: ring buffer caps + log-size quota for shell jobs.

## Current state / resume
Design + SPEC + M0 discovery complete. Implementing M1 (unified core). Resume at `<!-- current-task -->` above. After M1 lands, do M2 and M3 in parallel, then M4 (coherent single-pass tool migration), then M5/M6, then M7 validation.
