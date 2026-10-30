# Audit findings: p2-c-turn-snapshots

- Subsystems: cli-tui-utils, cli-tui-commands, cli-tui-hooks
- Features: turn-snapshots-v1, undo-turn, restore-turn, bisect-turn, per-shell-command-snapshot
- Files covered: 7
- Snapshot: legacy

## [MEDIUM] correctness — cli/src/commands/router.ts:103 — Pre-dispatch shell snapshot races the command: no barrier means fast commands can mutate the tree before the snapshot captures it
- **Risk:** The gate claim ('shell snapshot fires BEFORE dispatch so basher side effects are captured') holds only for call ordering, not capture ordering: the snapshot is a fire-and-forget promise racing the command. A fast mutating command (e.g. `rm tracked-file`) can complete before the snapshot's `git add -u`/`write-tree` runs, so the 'shell' snapshot records the POST-mutation tree and /undo-turn then restores the mutated state instead of the pre-command state — the gate's protection is best-effort, not guaranteed.
- **Fix:** Either await a snapshot barrier before dispatching the command (with a bounded timeout so the TUI never hangs), or take the snapshot synchronously before the git subprocess chain via a single `git stash create`-equivalent plumbing step; at minimum document the race in the router comment (currently the comment claims 'captures the tracked tree immediately before arbitrary user shell mutation' without the race qualifier).
- **Evidence:** router.ts:98-103 'void turnSnapshots.createTurnSnapshot({ label: "shell" }).catch(() => undefined)' precedes runTerminalCommand at :105-112; turn-snapshots.ts:226-310 runs 5+ sequential git subprocesses (rev-parse HEAD, read-tree, add -u, write-tree, commit-tree, update-ref) with no synchronization against the concurrently dispatched command.

## [MEDIUM] error-handling — cli/src/hooks/helpers/send-message.ts:521 — Fire-and-forget snapshot outcomes are silently dropped: structured 'error'/'skipped' statuses are never surfaced to the user
- **Risk:** createTurnSnapshot is total (never rejects) and returns structured outcomes precisely so failures are inspectable, but both production callers discard the resolved value. A persistent git failure (e.g. write-tree error, ref permission problem) is completely silent: the user believes snapshots are being taken, then /undo-turn reports 'nothing-to-undo' with no indication that snapshotting broke turns ago. The same applies to 'skipped' bisect-pause outcomes at turn-snapshots.ts:239-245.
- **Fix:** Log the resolved outcome via the logger (logger.ts is already imported in both files' siblings) and surface a one-line status-bar chip or system message on the first 'error' outcome per session, so users know undo coverage silently lapsed.
- **Evidence:** send-message.ts:516-521 `void createTurnSnapshot({ label: 'turn' }).catch(() => undefined)`; router.ts:103 `void turnSnapshots.createTurnSnapshot({ label: 'shell' }).catch(() => undefined)`; TurnSnapshotOutcome 'error' variant exists at turn-snapshots.ts:44-48 but has no consumer at either call site.

## [LOW] correctness — cli/src/hooks/helpers/send-message.ts:516 — PLAN wording 'before and after each turn and each shell command' only partially honored: after-turn and after-shell snapshots do not exist
- **Risk:** The P2-T4 PLAN text says snapshots are 'taken before and after each turn and each shell command'. Actual wiring: one post-turn snapshot (label 'turn') and one pre-shell snapshot (label 'shell'); no after-turn or after-shell snapshot exists. The router comment documents the missing after-shell seam, but the missing after-turn snapshot is not disclosed anywhere in the module docblock; the unchanged-tree dedup (turn-snapshots.ts:271-279) mostly masks it since before==after when nothing changed, but a turn whose abort path mutated the tree leaves the post-state uncaptured until the next successful turn.
- **Fix:** Acceptable for v1 if the PLAN DONE note is treated as the authoritative scope; a later slice can add an after-shell snapshot in the runTerminalCommand .then handler (router.ts:113) which IS an async completion point.
- **Evidence:** send-message.ts:516-521 (single post-turn snapshot; comment says 'fires exactly once per successful turn'); router.ts:98-102: 'runBashCommand has no async completion seam, so the after-state is covered by the next turn's snapshot'; PLAN.md:90 DONE note acknowledges the after-shell deviation.

## [LOW] state-mutation — cli/src/utils/turn-snapshots.ts:83 — Untracked and ignored-path side effects are a documented honest limitation, but the tracked-tree gate still excludes most real-world basher side effects (installed deps, build artifacts)
- **Risk:** The module docblock explicitly states untracked files are never captured nor restored (add -u, not -A), and both command messages disclose 'untracked files are unchanged', so this is an honest, disclosed limitation — not a silent gap. However it means the gate 'undo covers basher side effects in the tracked tree' is literal: basher side effects that land in ignored/untracked paths (cargo target/, node_modules installs, .venv, __pycache__) are outside undo entirely, consistent with the prior reaudit finding (polyglot-reaudit-2026-09-28 w2-plan-p1-p2) and with the plan's own 'SB-3 partial' marker; EV-8's full turn-undo intent is only partially met by design.
- **Fix:** None required for v1 (plan marks SB-3 partial); a follow-up could offer an opt-in `git add -A`-with-exclusions mode or document that non-git repos get nothing (isSnapshotCapableRepo, turn-snapshots.ts:162-174 already fails closed there).
- **Evidence:** turn-snapshots.ts:83-85 'Untracked files are never captured nor restored (tracked-tree gate)' and :266 add -u rationale; :100-102 checkout-index 'leaves untracked files ... alone'; command-registry.ts:710 and :787 user messages disclose 'the real index, HEAD, and untracked files are unchanged'.

## [MEDIUM] state-mutation — cli/src/utils/turn-snapshots.ts:529 — Bisection/snapshot concurrency guard is process-local: a second CLI instance on the same repo bypasses it entirely
- **Risk:** The in-flight guard is race-free within a single process as documented (checked and set in the same synchronous slice at :717-744, no awaits between), and createTurnSnapshot fail-closes during a bisection (:239-245). But two concurrently running openbuff CLI instances sharing one repo each hold their own module-level boolean: both can run bisections simultaneously, interleaving checkoutSnapshotTree rewrites across processes and breaking the always-restores-newest contract, and one process's turn snapshots can chain onto the other's rolled-back probe tree (the exact corruption the guard documents).
- **Fix:** Take a cross-process advisory lock (e.g. a lockfile under the repo's .git/openbuff/ or an atomic O_EXCL create) held for the bisection duration, checked by both runTurnBisection and createTurnSnapshot.
- **Evidence:** turn-snapshots.ts:521 `let bisectCancelled = false`; :529 `let bisectRunning = false`; :717-744 check-then-set in one synchronous slice; createTurnSnapshot bisect guard at :239-245 is also only the same process's flag. No lockfile/flock or git-ref-based mutex exists anywhere in the module.

## [LOW] state-mutation — cli/src/utils/turn-snapshots.ts:363 — Retention pruning uses `git replace --graft`, mutating the repo-global refs/replace namespace — a side effect outside the 'private ref only' safety model
- **Risk:** The module's safety model claims writes go only to the private ref and a temp index; pruneTurnSnapshots additionally calls `git replace --graft` on the oldest kept snapshot, creating refs/replace/<sha>. Replace refs are repo-global: they are honored by the user's own `git log`/`diff` invocations that touch those objects and are pushed by `git push --mirror` (the same vector the SECURITY WARNING at :87-99 worries about). Snapshot commits are outside HEAD history so normal browsing is unaffected, but the repo metadata mutation is an undisclosed global side effect and the replace refs accumulate one per prune cycle.
- **Fix:** Disclose the replace-ref side effect in the module docblock and the /undo-turn user message, or switch retention to `update-ref -d` chain truncation semantics (e.g. expire via reflog-free rewrite of the ref to a fresh orphan chain) so the user's replace namespace stays untouched.
- **Evidence:** turn-snapshots.ts:363 `await runGitCommand(deps, ['replace', '--graft', graftTarget], root, env)`; the safety model at :78-105 enumerates only temp-index/plumbing/checkout-index operations and never mentions refs/replace.

## [LOW] correctness — cli/src/commands/command-registry.ts:755 — /restore usage hint points to a non-existent '/restore list' subcommand; typing 'list' resolves to a not-found sha
- **Risk:** The missing-argument message tells users to find indices 'from /restore list', but the /restore handler only special-cases bare numbers (1-based index resolution at :761-777); any other token, including 'list', is passed to restoreToTurn as a sha and fails the hex-sha regex (turn-snapshots.ts:479), yielding '/restore: no turn snapshot found for list.' The snapshot listing actually lives at /bisect-turn list, so the UX hint dead-ends.
- **Fix:** Either accept `list` in /restore (render the same numbered list) or reword the prompt to '/restore <sha|index> (see /bisect-turn list)'.
- **Evidence:** command-registry.ts:752-758: guard `if (!target)` only; no `target === 'list'` branch exists in the restore handler (the list rendering lives in the bisect-turn handler at :834-855); restoreToTurn's sha regex at turn-snapshots.ts:479 rejects 'list' as not-found.

## Coverage receipt

### Subsystems
- cli-tui-utils
- cli-tui-commands
- cli-tui-hooks

### Features
- turn-snapshots-v1
- undo-turn
- restore-turn
- bisect-turn
- per-shell-command-snapshot

### Files
- cli/src/utils/turn-snapshots.ts
- cli/src/commands/router.ts
- cli/src/commands/command-registry.ts
- cli/src/data/slash-commands.ts
- cli/src/hooks/helpers/send-message.ts
- cli/src/utils/__tests__/turn-snapshots.test.ts
- cli/src/commands/__tests__/bash-command.test.ts

### Domains
- correctness
- error-handling
- state-mutation
