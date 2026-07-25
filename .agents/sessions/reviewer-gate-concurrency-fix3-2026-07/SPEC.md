# Fix 3 (deferred): Concurrent-instance isolation for the base2 validation/reviewer gate

Status: DESIGN — awaiting user review before implementation.

## Problem

When multiple Openbuff instances (or the user + an instance) share one worktree,
instance B's base2 gate can absorb instance A's in-flight edits into its own
`pendingGateFiles` and try to validate/review files it never touched. Symptoms:
spurious `awaiting_validation`, reviewer spawns over unrelated files, and
attestation churn.

### What already works (do NOT re-fix)

- **Pre-existing dirty files (Issue 3a) are already isolated.** The turn-start
  snapshot `initialGitStatusFiles` (`agents/base2/base2.ts` ~705-712) is
  subtracted from the mid-turn git-status sweep (~938:
  `!initialGitStatusFiles.includes(file)`), and the fresh-turn pending
  population (~606-617) only seeds from `changedFiles` (empty at turn start).
  A file already dirty when the turn begins never enters this turn's pending set.
- **The commit guard is already scoped** to `taskRelatedFiles`
  (`touchedFiles`/`changedFiles`/`pendingGateFiles`/`gatePassedFiles`) via
  `uncommittedUnvalidatedFiles` (~804-813), so unrelated dirty files do not
  block commits.

### The remaining gap (Issue 3b)

The mid-turn git-status sweep (~930-947, `recordChangedFiles([file], {
fromStatusObservation: true })`) pulls in ANY newly-dirty path that appeared
*after* turn start, regardless of whether THIS agent authored it. If instance A
writes `foo.ts` during instance B's turn, B's post-step `git_status` reports
`foo.ts` as newly dirty (not in B's `initialGitStatusFiles`), so B absorbs it.

The sweep is load-bearing, not a backstop: in the test harness and for
`{ file }`-shaped step results, files enter `pendingGateFiles` ONLY via this
sweep (~15 tests in `agents/__tests__/base2.test.ts` depend on it). So it cannot
simply be scoped to `taskRelatedFiles` without dropping legitimately
self-authored changes that only `git_status` (not `extractChangedFiles` /
`extractChangedFilesFromMessages`) observed — e.g. a formatter/codegen write
triggered by a `basher`/`run_terminal_command` step.

## Why the naive fixes fail

- **Scope sweep to `taskRelatedFiles`:** drops self-authored files that only
  git saw (terminal/codegen writes) and breaks the ~15 harness tests that seed
  pending exclusively through the sweep.
- **Thinker's `stepResult.toolName` gate:** wrong for this architecture. A STEP
  is a full multi-tool model step; there is no single `toolName` on the step
  result. Tool calls are scanned from the message-history delta
  (`extractChangedFilesFromMessages`, ~5257), not a scalar tool id.

## Proposed design: per-process ownership token from the mutation broker

The SDK already journals every mutation per originating process through the
worktree-scoped cooperative mutation broker
(`sdk/src/services/workspace-mutation-broker.ts`). That journal is the correct
authority for "did THIS process write this file," rather than inferring
authorship from repo-global `git status`.

### Sketch

1. **Expose an owned-path set from the broker to the runtime.** The broker
   already records exact-byte conditional commits/creates/deletes per process.
   Add a read-only accessor that returns the set of project-relative paths this
   process's broker has mutated during the session (or since a passed cursor).
   Surface it on the agent runtime state the base2 generator can read, e.g.
   `mutableAgentState.selfMutatedPaths` (a `Set<string>` / string[]).

2. **Gate the sweep absorption on self-authorship OR self-mutation evidence.**
   In the mid-turn git-status sweep, keep the existing
   `!initialGitStatusFiles.includes(file) && !gatePassedFiles.has(file)`
   predicate and add: absorb the file only if it is already task-related
   (`taskRelatedFiles.has(file)`) OR present in `selfMutatedPaths`. A file
   dirtied during the turn that is neither task-related nor self-mutated is
   attributed to a concurrent instance and excluded from `pendingGateFiles`
   (but STILL recorded into `gitStatusObservedFiles` / `gitStatusObservedDirty`
   so the existing committed-file pruning telemetry keeps working — narrow only
   the absorption branch, not the observation bookkeeping).

3. **Test-harness compatibility.** The ~15 base2 tests feed `{ file: 'src/a.ts' }`
   step results — those already route through `extractChangedFiles` →
   `recordChangedFiles`, making the file task-related BEFORE the sweep, so they
   remain unaffected. Add a test double for `selfMutatedPaths` so the
   terminal/codegen self-authored case is covered explicitly.

### Residual, bounded ambiguity (state honestly)

If instance B runs a mutating terminal command in the SAME step that instance A
writes a file, and B's broker did not record A's file (it wouldn't — different
process), B correctly EXCLUDES A's file. The only unavoidable ambiguity is a
tool/codegen path the broker does not observe (a raw child process writing
outside the broker); those remain attributed via the `taskRelatedFiles` fallback
only, i.e. excluded unless independently self-authored. This errs toward NOT
absorbing another instance's file — the correct safety bias for isolation, and a
strict improvement over today.

## Scope / risk

- Cross-package: `sdk/src/services/workspace-mutation-broker.ts` (accessor) +
  runtime state plumbing + `agents/base2/base2.ts` (sweep predicate). Medium
  size; touches the fragile serialized `handleSteps` generator, so it needs its
  own e2e coverage (a two-instance simulation feeding disjoint
  `selfMutatedPaths` + overlapping `git_status`).
- Must preserve every existing gate e2e invariant
  (`agents/e2e/gate-*.e2e.test.ts`, `agents/__tests__/base2.test.ts`).

## Open questions for the user

1. Is per-session self-mutation tracking sufficient, or do we want per-turn
   cursoring (reset the owned-path set at turn boundaries)?
2. Should a file dirtied by an unobserved raw child process (outside the broker)
   fail open (absorb + validate — safer for correctness, worse for isolation)
   or fail closed (exclude — better isolation, risk of an unvalidated self-edit)?
   The commit guard already fails closed independently, which argues for
   fail-closed here too.
