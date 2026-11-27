# Repository intelligence and durable records

The host prepares source discovery, remembered knowledge, applicable procedures,
and validation evidence for each registered actor before execution. Prompt agents
receive the packet in their first model request and after request reconstruction;
programmatic agents receive it in `agentState.repositoryContext`. Authenticated
supervised children use the same host compiler, with their own role and task ID.
Transcript inheritance is independent of this delivery. Context preparation has a
three-second deadline; local discovery can use up to 2.5 seconds, reserving the
remaining budget for knowledge and validation evidence.

## Boundaries

- `common/src/types/contracts/repository-intelligence.ts` defines the versioned
  context request and packet. The SDK compiler is
  `sdk/src/services/repository-intelligence.ts`.
- `packages/indexer/src/storage-port.ts` defines normalized storage operations,
  pagination and atomic compare-and-swap. The embedded implementation supports
  Bun SQLite and a portable Node directory store. Native CLI builds bundle
  `rust/crates/openbuff-intelligence`, a persistent SQLite service behind the
  same port.
- Parsing, graph maintenance and ranking remain in TypeScript using the existing
  Tree-sitter/SCIP producers. Rust currently owns normalized source-index storage
  and transactions. Durable knowledge and transcript storage use the existing
  CLI SQLite repository. A native parser or knowledge-store rewrite requires
  separate parity and workload measurements.
- Knowledge, procedures and execution authority retain separate contracts.
  Discovery hints and old facts do not grant permission or satisfy read-before-
  edit capabilities. Current execution and mutation gates still apply.

## Source lifecycle

Repository and worktree identities are persisted independently. Git worktrees
share immutable objects through the common Git directory while mutable
generations and journals are worktree-scoped. Native stores use a stable key
derived from that storage location; upgrading executable bytes preserves store
identity. Non-Git projects use their own durable identity.

Generations reference immutable content-addressed file/parse/graph/posting records
and publish atomically. Updates maintain changed file relationships and lexical
postings instead of rewriting a monolithic parse/index JSON. A durable mutation
journal tracks changed paths and gaps. Retention preserves current heads,
referenced objects and pinned generations under publication/CAS ownership.

The last valid discovery generation can be queried during reconciliation. It is
marked unverified until offline changes and watcher gaps are reconciled. Known
dirty paths are rehashed even when size and timestamps match. `waitUntilReady`
allows cached discovery; callers requiring reconciled sources use
`waitUntilReconciled` (or the explicit reconciliation option).

Producer layers are independent. Structural refresh preserves unchanged precise
SCIP edges; source, producer configuration and declared dependency changes
invalidate affected precise data. Parse fingerprints include actual grammar and
query asset bytes, and changed assets reload parser/query objects.

## Knowledge and archive lifecycle

Canonical events remain the reconstruction and audit source. Schema 7 retains
schema 6's maintained knowledge projections and adds immutable original tool-text
references with transactional archive retention. Indexed text candidates and dependency
validity remain separate from archive fullness. Event-tail admission no longer controls whether an old pinned fact is
retrievable. Optional semantic retrieval progresses through the eligible corpus
instead of considering only a recent prefix.

The current producer is `current-knowledge-2`, with a checked sequence cursor and
cursor event identity. Backfill uses pages of 250 events. Recognized producer-1
projections rebuild derived knowledge to repair old selector-occurrence
collisions; unknown producers fail closed.

The context compiler attests bounded source selectors and distinguishes changed,
missing and unavailable evidence. Unrelated workspace revision changes do not
invalidate a source fact whose dependencies still match. Current worktree-state
assertions and broad validation receipts retain stricter validity requirements.

Exact consolidation merges compatible discoveries across tasks while preserving
source evidence, verification, use counters, pins and conflicting dependencies.
Semantic consolidation produces source-linked unverified candidate observations,
keeps source observations active, and does not activate executable policy.
Disagreement cannot silently replace a claim. Staged failures remain inspectable
and retryable.

Explicit successful native `record_decision` results are captured at the actual
local-handler completion boundary, before UI delivery, using registered
actor/action/task identity. Supervised children report through the authenticated
host bridge. Recorded facts, decisions and constraints remain **unverified**
until their supporting evidence is checked; they can be retrieved as applicable
unverified context without promoting a handler timestamp or model assertion.
A failed or unacknowledged primary capture cannot retract another claim or
publish dependent citations. Host-selected memory authority is captured per run
and resolved independently for each actor before execution, so missing or failed
V2 retrieval does not silently inject a V1 shadow. Mutable programmatic state
cannot override that captured source selection.

Terminal memory metadata has an independent bounded cleanup wait: cancellation
selects the cancelled status but does not abandon persisting it. Unconfirmed
terminal batches retain a replayable `finishing` decision; fresh-process
reconciliation preserves its event identities and idempotency. Optional
consolidation follows the committed terminal-state assignment. These are
metadata/recovery guarantees, not a new productive-work timeout or automatic
re-execution of uncertain effects. Prompt packing keeps complete ranked claims
and rationale ahead of bulky supporting excerpts within the bounded memory
band. See [read-only knowledge and memory agents](agents-and-tools.md#read-only-knowledge-and-memory-agents)
for operator-approved maintenance proposals; agent reviews are not authenticated
verification receipts.

Transcript snapshots contain immutable ordered references to shared message
identities and bodies. FTS uses external content. Appending a snapshot stores new
bodies and references rather than copying the whole transcript into multiple
tables. Snapshot identity includes the checked manifest; timestamps alone are
insufficient. Search preserves source ownership and occurrence identity. Failed
or partial archive loads return degradation instead of a successful empty result.

## Procedures and validation

Prompt rendering and deterministic gates share applicability filtering for
repository, acting role, known paths, status and expiry. Terminal triggers
use the existing execution-effect classifier. A rule targeting a committer spawn
belongs to the spawning actor; a commit rule is checked on the commit action.
Successful verification does not disable an otherwise active rule. Selected
instructions retain their prerequisites and conditions together; a small budget
may include a complete reference instead of an incomplete imperative. Scope
paths support bounded segment wildcards, recursive `**`, character classes and
comma braces (for example `src/**/*.{ts,tsx}`). Unsupported scope syntax is
excluded with a degraded `procedure-scope-unsupported` host-context reason,
not silently treated as a global procedure. Unknown task focus remains explicit;
this does not infer arbitrary shell-command paths or prove action-specific focus.

Memory feedback is source-specific efficiency telemetry, not a factual-quality
judgment. Only complete observation records actually packed into a model request
are eligible. A completed authenticated native read records its exact source,
digest/range and whether it was unchanged, a necessary refresh, or unknown.
Reading another file, encountering changed bytes, satisfying a reread requirement,
or clipping a record cannot penalize unrelated memories. Legacy aggregate
`full` counts alone carry no ignored credit. Inject-only procedure rendering
never invents gate firing counters.

The two built-in warn-mode rules require validation before spawning
`git-committer` and before a direct `git push`. They accept `ci-local` or
`package-checks` receipts within 30 minutes. The spawn prerequisite belongs to
the caller; there is no additional built-in direct-commit trigger. The host's
captured gate mode follows supervised children through the runtime contract.

`sdk/src/services/validation-receipts.ts` issues receipts around trusted native
terminal/hook executions. Recipes must resolve to recognized checks; echo/no-op
scripts, suppressed failures and opaque wrappers do not attest success. Receipts
bind the producing actor/root task, commands, source/configuration roster,
lockfiles, captured environment and used executable/package dependency closure.
Consumers re-attest that closure before reuse. Tool-package files are fully hashed
with a high-resolution digest cache, without recursively watching unrelated
installations. Preparation has an abortable three-second maximum and file/byte/
work bounds; uncertainty yields no usable receipt.

Both captured native PATH and package-runner `.bin` resolution are bound for
the tool names actually used. Receipts remain in the host registry for the run
and are cleared during cleanup.

Separate required checks combine only at matching dependencies and keep the
oldest completion timestamp. Successful native hook outcomes can supply these
checks to a child gate. Custom/MCP/override output cannot impersonate a native
validation receipt. Receipt reuse does not grant execution approval.

The current recipe resolver covers recognized JavaScript package/compiler/test
commands. Unsupported or opaque recipes require their ordinary validation path;
they do not silently produce broad CI evidence. Conservative dependency scans
exclude normal `.openbuff` state and generated output, but may include custom
runtime output placed among source inputs.

## Configuration and packaging

The CLI selects the verified sibling service using
`repository-intelligence-manifest.json`; project content cannot select a native
executable. Native build manifests include its SHA-256 and target. Cross-target
builds use the embedded port unless an explicit target sidecar is supplied.
`OPENBUFF_INTELLIGENCE_BINARY` is a build-time sidecar override. Native service
directories are private, and an uncertain write is not replayed against another
backend. The service may remain alive for later CLI conversations.

SDK users can pass `repositoryIntelligence: false` to disable automatic packets,
a source adapter with `query` for their local/virtual source, or supplied
`projectFiles` for immutable virtual discovery. `indexing.enabled: false` disables
the default local source index. Memory injection continues to respect the
existing Memory V2 authority configuration; enabling source context does not
enable canonical knowledge injection by itself.

## Migration and recovery

Legacy source JSON is a migration input and is preserved. New generations use
the normalized store. Knowledge producer upgrades rebuild derived projections
from canonical events with resumable checkpoints. Archive v4/v5 upgrades verify
normalized manifests, message membership and body references before removing
legacy duplicates; a corrupt staged migration stays degraded and retains its
recoverable data.

Archive retention defaults to rolling 30-day, 500-snapshot and 32 MiB aggregate
logical archive/original payload limits; a host can select another policy at store
open or explicit unbounded `keep-until-delete`. The roadmap's 4 MiB envelope is a
fixture input, not the product default. Explicit pins protect their complete body
closure; protected overflow refuses atomically. Source-run/call cutoffs prevent old
envelopes from resurrecting expired or evicted originals, and current-run records
are not exempt. Required cutoff metadata is charged too; exhausted metadata capacity
can require operator resolution rather than silently discarding those cutoffs.

`recall_context` accepts an exact `toolCallId`, optional `sourceRunId` and
`expectedSha256`, and UTF-8 `offsetBytes`/`maxBytes` pages (16 KiB default, 64 KiB
maximum). Returned offsets never split a code point. A body hash covers complete
recalled UTF-8 text, not serialized message JSON. New references distinguish
original, excerpt and pointer; legacy fullness stays unknown. Ambiguous, expired,
missing and corrupt results are explicit. Host lookup is actor/task-bound and
withheld from strict project-only readers until a guarded archive contract exists.
Sanitized originals are committed before reference-only chat publication, with
bounded inline fallback for unconfirmed storage and explicit cutoff disclosure.
The CLI keeps canonical transcript messages while rendering pageable/virtualized
windows; missing/corrupt selected sessions block sending and expose Retry/Cancel.

SQLite allocated pages, WAL/FTS overhead and logical payload are reported
separately. Migration frees reusable SQLite pages without automatically running
`VACUUM` or immediately shrinking allocated file size.

For canonical memory rollback, stop writers and retain a consistent SQLite
backup, including WAL state, before using an older binary. Derived source caches
can be rebuilt; canonical events, transcripts and operator policy cannot be
treated as disposable caches. Migration and recovery tests use disposable stores
and never run against the operator's live memory database.

Older binaries reject newer SQLite schemas. Use a pre-upgrade backup or a
compatible newer binary's canonical export for rollback; never decrement
`user_version` to bypass compatibility checks.

## Validation and measurements

Run from the repository root with explicit `./` paths so Bun does not also select
historical source copies in evidence directories:

```sh
bun test ./sdk/src/__tests__/run-host-execution.test.ts
bun test ./sdk/src/__tests__/repository-intelligence-knowledge.test.ts
bun test ./sdk/src/__tests__/validation-receipts.test.ts
bun test ./cli/src/services/memory-v2/__tests__/records-redesign.test.ts
bun test ./packages/indexer/src/durable-index-store.test.ts
bun test ./packages/indexer/src/repository-service-client.test.ts
cargo test --manifest-path rust/Cargo.toml --locked -p openbuff-intelligence
```

The installed CLI supports `--smoke-intelligence`, which creates a
disposable project, exercises packaged parsing/query/publication and checks that
the declared native backend is actually adopted. Run `--help` first.

`OPENBUFF_KNOWLEDGE_EVIDENCE_PATH=/absolute/report.json` captures the real reopened
SQLite/fresh SDK actor fixture: useful knowledge before first execution, actor
isolation, source attestation reads, elapsed time, network attempts and terminal
tool launches. Index work-count measurements live alongside the implementation
status in `.agents/sessions/index-records-architecture-20261114/`.

These fixtures establish delivery and reuse contracts. They do not establish a
Rust speedup, reduced architectural reasoning by a live model, or latency across
every project size. Keep those claims separate from deterministic work counts and
report paired model evaluations with fixed provider/task settings.
