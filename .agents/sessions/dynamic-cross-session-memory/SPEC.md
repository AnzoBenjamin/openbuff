# SPEC — Dynamic Cross-Session Memory V2 Repair and Completion

Status: repair scope frozen; implementation must resume from the current dirty worktree.

## Objective

Finish Memory V2 without discarding the existing implementation, close all evidence-backed security/compatibility/migration/reliability findings, restore green validation, and obtain exact-snapshot reviewer approval.

## Current baseline

- Implemented surfaces already exist across `common`, `sdk`, `packages/agent-runtime`, `cli`, and `evals`.
- Focused common contracts and SDK coordinator/migration/operator suites were green after repairs: 31 common contract tests and 64 integrated SDK Memory V2 tests.
- The current SQLite focused suite is not green: 20 pass / 4 fail. Three failures are invalid digest fixtures; one exposes a production query-path bug when low-level noncanonical events are parsed as canonical envelopes.
- Earlier package-wide typechecks/tests, SDK dist build/smoke, and compiled CLI probes passed, but that evidence predates later repairs and is stale.
- The runtime validation gate previously passed typechecks, but reviewer/specialist approval did not complete. Earlier specialist reviews returned blocking source findings; a later migration-review attempt also failed from reviewer quota/protocol attestation. Protocol failure is not approval.

## Frozen decisions

1. `sqlite-v2-opt-in` is fail-closed. Storage/query/migration failure keeps V2 authority active with no injected memory; V1 resumes only after an explicit authority change. `shadow-v2` may continue with visible V2 degradation while V1 remains authority.
2. Canonical events are append-only; projection state is rebuildable and never canonical.
3. Canonical V2 contracts must match the approved architecture before downstream repairs are finalized:
   - envelope-level project/task/session/query identity and idempotency;
   - byte-range evidence selectors;
   - snapshot/query-bound discovery coverage;
   - distinct health/error states for absent, busy, corrupt, incompatible, unreadable/I/O, validation, migration, and conflict conditions;
   - an explicit “expected empty tail” CAS representation rather than omission.
4. V1 import uses a revision-keyed reservation before body events, so competing checksums cannot both append bodies. Partial imports are resumable and source V1 data is never modified.
5. Imported verification claims are untrusted. Verification lifecycle is stripped/downgraded until a contained live read reproduces the claimed digest.
6. Operator corrections, forget, pin, and revalidation require explicit task scope and reject cross-task targets.
7. Provider repositories are leased. Reset/root/authority switches retire a provider but do not close storage under active clients/runs.
8. Path-based lstat/realpath checks are not claimed to be race-free. SQLite authority may ship only where a race-resistant no-follow/beneath open primitive is proven. Otherwise the provider reports typed unsupported/unavailable; opt-in stays fail-closed.
9. No dependency addition is authorized by this plan. If a native helper/dependency is required for secure open, pause for explicit dependency/product approval.
10. Default V2 authority, V1 removal, release, commit, and push remain out of scope.

## Requirements

### R1 — Canonical contracts

- Preserve additive compatibility where possible.
- Add the frozen envelope/selector/coverage/failure/CAS semantics to `common/src/types/memory-v2.ts` and focused contract tests.
- Update all producers and consumers atomically enough that no intermediate snapshot is treated as reviewable.
- Keep SDK declarations/runtime free of Bun database imports and types.

### R2 — SQLite kernel

- Fix the four current focused failures without weakening digest validation.
- Query must ignore unsupported low-level event families while still failing malformed recognized canonical events.
- Enforce byte limits before materializing full payloads into JS.
- Bind every eventful database to exactly one project; reject mixed/unbound foreign query/export/rebuild/write behavior.
- Make exact idempotent replay win over a stale CAS only when every event is byte-equivalent; retain conflicts for divergent or later-tail writes.
- Implement canonical reducers for task/session/observation/claim/evidence lifecycle; append and rebuild must produce normalized-equivalent projections.
- Backfill schema 1→2 projections transactionally and test rollback/idempotence.
- Fresh verified knowledge requires matching selector digest plus matching workspace revision/snapshot when supplied.
- Preflight compatibility/integrity before WAL or migration mutation.
- Enforce owner-only directory/database/sidecar modes and reject symlinked/nonregular components. Do not claim ancestor-swap resistance without a proven primitive.

### R3 — SDK lifecycle and concurrency

- Runtime authority validation and opt-in fail-closed behavior remain intact.
- Migration/no-op outcomes refresh the coordinator cursor before lifecycle append.
- CAS rebase must distinguish a genuinely empty tail from tail-derivation failure; failure must degrade, never retry without protection.
- Persisted `finishing + pendingTerminal` state replays after a new coordinator/process before a new turn starts.
- Query result project and query IDs must both match.
- Memory preparation is bounded by run timeout/cancellation and cannot mutate state after the run has abandoned it. Add cooperative cancellation or a generation guard.

### R4 — Migration and operator atomicity

- Reserve `(project, revision)` with checksum before V1 body pages; conflicting checksum loses before body append.
- Newer revisions explicitly supersede older imported observations.
- Report source counts and truncation deterministically.
- Import validates aggregate byte/depth limits before expensive work, strips all verification lifecycle variants, and guards every page including an empty initial tail.
- Export redaction covers sensitive key variants (`apiKey`, `clientSecret`, `privateKey`, tokens/passwords/PEM material), bounded text, and omission warnings.
- Manifest import resumes an admitted prefix, rebuilds only after complete import, and rejects divergence.

### R5 — Provider/client ownership and authority

- Unavailable opt-in providers still construct SDK Memory V2 config with requested authority and no repository, preserving fail-closed behavior.
- Provider lease/refcount semantics defer close until active clients/runs release.
- Reset, root switch, authority switch, pending open, failed construction, repeated release, and reopen are deterministic and exactly-once.

### R6 — CLI operator safety

- Revalidation performs a bounded contained regular-file read and hashes live bytes before apply; preview states that live verification is pending.
- Export/import use one reusable secure contained-I/O abstraction. Reject traversal, absolute paths, symlinks, nonregular files, oversized files, and deterministic ancestor/leaf replacement races.
- CLI import does not blanket-reject nonempty stores; it delegates admitted-prefix recovery to the operator.
- Correction lookup is cursor-paginated with repeated/empty/nonadvancing cursor guards.
- One top-level sanitized error boundary covers returned and thrown V1/V2/provider/operator failures without leaking absolute paths, SQL, tokens, or secrets.

### R7 — Coverage and prompt safety

- `coverage.recorded` carries task/query/facet/scope/exclusions/limits/candidates/negative results/unresolved gaps/workspace revision/index snapshot.
- Capture only declared bounded tool result adapters.
- Reuse/suppression requires matching task/query facet and fresh workspace/index support.
- Persisted text remains untrusted evidence and never instruction authority.

## Acceptance criteria

- All focused Memory V2 suites pass together, including new race/concurrency/migration/replay cases.
- Common, SDK, agent-runtime, CLI, and evals typechecks/tests pass after the final contract snapshot.
- SDK ESM/CJS/declarations build and Node dist smoke pass; no Bun database import/type leaks.
- Compiled CLI binary tree-sitter/OpenTUI probes pass and a real packaged SQLite open/write/close/reopen/read smoke passes where SQLite authority is supported.
- Security, compatibility, migration, and reliability reviewers return structured non-blocking verdicts on the same stable review fingerprint.
- Runtime reviewer gate returns a valid structured attestation for the exact final snapshot.
- Durable STATUS records receipts, deferred items, and any platform where SQLite authority remains disabled.

## Non-goals

- Making V2 the default.
- Removing V1 APIs or `/memory prune`.
- Adding embeddings, hosted memory, cloud sync, or remote services.
- Adding dependencies without explicit authorization.
- Releasing, committing, or pushing.
