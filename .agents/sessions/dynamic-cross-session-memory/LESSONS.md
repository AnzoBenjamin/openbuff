# LESSONS — Dynamic Cross-Session Memory V2 Repair

## State and review discipline

- A passing typecheck gate is not equivalent to reviewer approval.
- A reviewer quota, crash, or attestation failure is not a “no findings” verdict.
- Shared contract changes invalidate all downstream test/review evidence; freeze them first.
- Agent completion prose is not proof of mutation. Verify the actual worktree and rerun focused checks.
- Keep one stable final review fingerprint; any mutation requires a new bundle and fresh specialist receipts.

## Contract lessons

- Optional `expectedLastEventId` cannot distinguish “no CAS requested” from “assert the tail is empty.” Empty-tail CAS needs an explicit representation.
- Failure classes must survive every layer. Collapsing corrupt/incompatible/busy/I/O into `internal` or `unavailable` hides recovery semantics and creates compatibility drift.
- Canonical event identity belongs in one envelope contract. Duplicating identity between envelope, metadata, and low-level rows invites projection and migration mismatches.
- Coverage cannot safely suppress exploration without query/facet plus workspace/index snapshots and explicit negative-result/limit semantics.

## SQLite lessons

- Validate test fixtures against schemas: `sha256:observed` is not a legal digest and caused three false implementation failures.
- A low-level append API may contain noncanonical event families; public query must skip unsupported families while still failing malformed recognized canonical events.
- Applying a byte cap after `.all()` has materialized full payloads does not bound memory allocation.
- Session lifecycle identity is on the event envelope, not its payload; projector code must use the canonical source.
- Lifecycle projectors must merge state rather than overwrite attachment/task history with a status-only payload.
- Exact byte-equivalent replay should be idempotent even after a lost response, but divergent replay must remain a CAS conflict.
- WAL setup can mutate an incompatible database. Compatibility/integrity/schema-shape preflight belongs before journal/migration writes.
- Pathname lstat/realpath checks reduce risk but do not defeat ancestor replacement. Do not claim race-free containment without descriptor-relative/no-follow evidence.

## SDK/runtime lessons

- Fail-closed must be end-to-end. Keeping opt-in active in the coordinator is ineffective if the CLI provider silently converts unavailable storage to V1 or omits Memory V2 configuration.
- Returning `undefined` for both empty tail and tail-derivation failure can silently remove CAS protection.
- Parking terminal state works only if a new coordinator can hydrate and replay it; same-instance retry is insufficient for crash recovery.
- Racing a promise against timeout bounds caller latency but does not cancel underlying mutation. Use cooperative cancellation or a generation guard.
- Correlate both project ID and query ID before installing retrieval results.

## Migration/operator lessons

- A final migration marker cannot prevent conflicting bodies already appended. Reserve revision ownership before body pages with a deterministic revision key and checksum.
- Imported `verified` flags are claims from untrusted input, not proof. Strip verification lifecycle and require a live contained digest read.
- Prefix recovery requires CAS on page 1, including an explicit empty-tail expectation.
- Task ownership checks should not disappear when callers omit task scope; make scope mandatory for mutations.
- Secret redaction needs both sensitive-key normalization and bounded content-pattern detection. Exact key denylists miss camelCase variants.

## Provider/CLI lessons

- Shared repository caches require leases; reset must retire resources, not close them under active runs.
- Revalidation is a filesystem operation before it is a repository operation: resolve safely, read bounded bytes, hash, then append verification.
- CLI prechecks must not contradict operator recovery semantics; blanket nonempty-target rejection blocked resumable import.
- Cursor pagination needs guards for repeated, nonadvancing, and empty-page-with-cursor responses.
- Sanitization must be a top-level boundary covering thrown errors as well as discriminated failure results.

## Validation lessons

- Run the narrow failing suite first and repair exact diagnostics sequentially.
- After contract freeze, validate in this order: common contracts → SDK producers/services → SQLite adapter → provider/client → CLI commands → runtime coverage/context → combined/package/artifact checks.
- Keep artifact validation separate: SDK source tests do not prove generated CJS/ESM correctness; compiled CLI success does not prove the smoke command used the emitted filename.
- Final security/compatibility/migration/reliability review must follow, not run in parallel with, the final validation when review depends on its results.

<!-- update_plan_status:appended -->
## SQLite WAL reopen semantics — 2026-09-11T23:56:59.876Z

Raw SQLite database bytes are not a valid reopen-idempotence contract under WAL because checkpoint/header bookkeeping may change physical counters while logical state remains identical. Assert canonical rows/order, project binding, capabilities, projection cursor/state, `user_version`, and `quick_check` instead. Avoid redundant `PRAGMA user_version = currentVersion` writes, but do not infer that physical bytes must remain stable.


<!-- update_plan_status:appended -->
## Session lessons — 2026-09-12T10:04:07.894Z

- Provider crashes are not approval: three specialist reviewers crashed on quota/timeout during this session. The migration-reviewer and compatibility-reviewer results from the working provider run were clean, but the later provider switch caused all four specialists to fail with empty workspaces. A protocol failure is never a positive review signal.
- Background agent spawns are fragile: the background agent flow broke mid-session, requiring a switch to synchronous foreground basher calls for validation. Always have a foreground fallback.
- Discovery coverage is lifecycle bookkeeping without identity: the existing discoveryCoverageV1Schema lacked taskId, workspaceSnapshotId, and structured negative results. The vertical slice added identity fields but full adapter-declared capture and reuse safety remain future work.
- Contained file I/O proc-fd probe: the initial O_NOFOLLOW flag on the /proc/self/fd probe rejected the proc symlink itself. Fixed by using a separate PROC_DIRECTORY_FLAGS without O_NOFOLLOW for the self-probe only, keeping O_NOFOLLOW on all project path components and leaf files.
- Export retry idempotency: deterministic filename + O_EXCL makes retry after success deterministically fail. Fixed by comparing existing file content on EEXIST and treating identical content as success.
- finishTurn must be bounded: unbounded await on finishTurn can block run termination when SQLite is locked. Fixed by racing against a FINISH_TURN_TIMEOUT_MS deadline.
- Post-abort observation gate: captureToolObservation could append after abort because isCurrent(undefined) always returned true. Fixed by threading preparation generation into the observation path.


<!-- update_plan_status:appended -->
## Session lessons (final) — 2026-09-12T10:06:33.552Z

- Specialist reviewers that cannot read workspace files will produce hallucinated findings based on imagined code patterns. Always verify reviewer evidence cites actual file content before acting on findings.
- Provider quota/crash failures are not approval. The gate must produce a structured verdict with file attestation against a matching snapshot.
- Discovery coverage identity requires taskId in the shard key hash; without it, different tasks with the same question text suppress each other.
- The proc-fd support probe in contained-file-io must NOT use O_NOFOLLOW on the /proc/self/fd symlink itself — only on project path components and leaf files.
- Provider open must not yield through close() when no current/pending state exists, or concurrent openers race past the pending publication.
- Export retry idempotency requires EEXIST handling that compares existing content rather than failing deterministically on identical checksums.
- finishTurn must be bounded against the run abort signal; an unbounded await on a hung SQLite store can delay run termination indefinitely.
- Post-abort tool observations need a generation gate; isCurrent(undefined) returning true unconditionally allows commits after invalidate.
