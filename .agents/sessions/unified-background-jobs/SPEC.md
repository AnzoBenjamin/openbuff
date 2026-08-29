# Unified Background Job Architecture — SPEC

## Goal

Replace the fragmented background-job system (two job models, three state stores, two read/cursor semantics, an authorize/re-stamp gate, manual sleep-polling) with a single, unified architecture that is excellent for dev servers and long-running agents, and renders live activity in the CLI. Breaking changes to tool contracts are allowed (user approved).

## Current-state problems (verified by reading source)

- Two job models: shell `ChildProcess` jobs (sdk/tools/background-jobs.ts, log file + metadata file) and in-process agent coroutines (agent-runtime/util/background-agent-jobs.ts, in-memory ring buffer). Different lifecycles, TTLs (24h vs 30min), recovery models, cancellation.
- Three state stores for shell jobs: SDK in-memory `jobs` Map, shared `pendingJobs` Map (common/util/pending-background-jobs.ts), and disk metadata files. They drift; "recover" exists only to reconcile them.
- Ownership via authorize-background-job.ts: owned/foreign/recover tri-state; "recover" re-stamps ownership from disk. This produced the user's "unavailable to this run" failure.
- Two read semantics: shell uses a single job-global `readOffset` mutated on read (read starvation across consumers); agents use readOffset + consumerCursors + cursor/nextCursor + droppedChunks.
- Polling UX is archaic: follow mode is a manual `await sleep(200)` loop in check-job.ts; no join/wait primitive; a separate step-loop-guard must special-case polling tools.

## Non-goals

- Do not change foreground (SYNC) run_terminal_command behavior.
- Do not change the foreground spawn_agents aggregation path.
- Do not add a real agent-facing push/subscribe channel (the model can only act via request/response tool calls; live UI consumes the stream in-process instead).
- No production/deploy/git-commit actions.

## Requirements (acceptance criteria)

1. ONE `JobRegistry` (common package) is the single source of truth for all background jobs, with `kind: 'process' | 'agent'`. No dependency on child_process/fs/agent-runtime in the registry core.
2. ONE lifecycle state machine: `queued -> running -> stopping -> {completed|error|stopped|lost|cancelled}`. Adapters emit events; the registry folds them into state (state machine is un-bypassable).
3. ONE event model: a bounded, sequenced ring buffer of `JobEvent` envelopes `{ sequence, timestamp, jobId, type: 'output'|'status'|'lifecycle', payload: { kind, ... } }`. Per-consumer sequence cursors; no job-global read offset.
4. A `wait(jobId, { predicate?, timeoutMs? })` join primitive that resolves on lifecycle settle or when output matches a predicate (regex/substring) — subsumes follow-mode and dev-server readiness. Plus a non-blocking `snapshot(jobId, cursor?)` read.
5. Ownership is a job attribute enforced inside the registry; remove the authorize/foreign/recover gate and the metadata re-stamp path.
6. Shell jobs: spawn (bash, windows bash resolution), process-group kill (SIGTERM w/ SIGKILL escalation), log capture to a per-job temp file (O_EXCL+O_NOFOLLOW, 0o600), log-size quota termination, and dev-server readiness via `wait`. Cross-session recovery persists as a write-only disk projection of the same event stream; a dead live job reconciles to `lost`.
7. Agent jobs: coroutine-backed, AbortController cancel, chunk streaming into the same EventLog, capacity limits, no disk recovery (process-scoped).
8. Tools become thin wrappers over the registry: `check_job`, `check_background_agent` (new `{events, nextCursor, state, truncated}` + settled result/error), `kill_job`, `list_jobs`, `read_logs`. `wait_for` becomes a predicate over the event stream. end_turn leak detection reads the unified registry.
9. Live UI: the run loop consumes the job event stream in-process and emits job activity to the CLI chat so users see live status/output without the agent polling. CLI renders live job status in the terminal-command and job tool components.
10. Prompts, docs (docs/deterministic-edit-system.md), and evals updated for the new contracts. Generated release bundles (cli/release, cli/release-staging) regenerated, not hand-edited.
11. step-loop-guard polling-loop detection reads the unified model (or is simplified if join replaces most polling).

## Architecture (decided with thinker)

- Registry in `common` (dependency inversion): `sdk` and `agent-runtime` each register a kind-adapter; the registry never imports them. Preserves `sdk→common`, `agent-runtime→common` DAG.
- Adapters: `ProcessJobAdapter` (sdk) and `AgentJobAdapter` (agent-runtime). Adapters emit events; registry folds to state.
- Internal push stream (async iterator) for UI/run-loop; agent-facing surface is `wait`/`snapshot` over per-consumer cursors.
- Event envelope single type; payload variant distinguishes shell output bytes vs agent structured chunk.
- Disk metadata = optional recovery projection, not a parallel truth.

## Relevant systems / files

- common: util/pending-background-jobs.ts (to be superseded by new registry module)
- sdk: tools/background-jobs.ts, tools/run-terminal-command.ts, tools/check-job.ts, tools/kill-job.ts, tools/list-jobs.ts, tools/read-logs.ts
- agent-runtime: util/background-agent-jobs.ts, tools/handlers/tool/{check-background-agent,check-job,kill-job,list-jobs,read-logs,authorize-background-job,end-turn,spawn-agents}.ts, util/step-loop-guard.ts, tools/stream-parser.ts (fileProcessingState / job wiring)
- common tool schemas: common/src/tools/params/tool/{check-job,check-background-agent,kill-job,list-jobs,read-logs}.ts
- cli: components/tools/background-job-tools.tsx, components/tools/run-terminal-command.tsx, components/terminal-command-display.tsx, utils/sdk-event-handlers.ts
- prompts/docs/evals: agents/base2/base2.ts, agents/editor/editor.ts, agents/base2/base-deep.ts, docs/deterministic-edit-system.md, evals/buffbench/\*
- generated: cli/release/index.js, cli/release-staging/index.js, cli/src/data/initial-agent-type-sources.generated.ts

## Validation gates

- bun typecheck across sdk, agent-runtime, common, cli.
- bun test for all touched packages' background-job and tool tests.
- Regenerate release bundles via their scripts; run cli release-wrapper tests.
- Live dev-server smoke: start a dev server as a background job, `wait` for readiness, read_logs, kill_job — verify no manual polling needed.
