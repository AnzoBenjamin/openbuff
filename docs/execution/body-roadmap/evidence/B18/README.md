# B18 exact command identity and compound approval evidence

The implementation hashes the exact UTF-8 shell command and evaluates every recognized potential effect. Quoted spaces, literal newlines, substitutions, changed bytes and reordered compounds retain distinct identities. Force, delete, refspec, mirror, broad-ref, dynamic-target and unknown-option push risks remain visible to balanced and strict policies; deliberate `allow-all` remains available.

Approval records bind the command hash and execution-context hash to repository, workspace, root run and snapshot. The context includes terminal profile, cwd, project root, ordered allowed paths, process type, detach and mode. Public receipt metadata cannot create a launcher rerun token. Internally minted WeakMap tokens are consumed once, with profile policy evaluated again. Ordinary feature pushes and feature-development commands retain the existing balanced behavior.

The primary action is a display field. `effects` is the potential effect roster; `rawCommand` retains the exact input for review and hashing. Substitution effects are collected conservatively, so array position does not claim runtime execution order. Malformed lexical/list syntax is refused; unsupported control flow, dynamic command construction, heredocs and other unsupported interpretations are explicit and require approval except under deliberate `allow-all`.

## Reproduction

Run `python3 docs/execution/body-roadmap/evidence/B18/run-verification.py <command>` for each of `policy-tests`, `terminal-tests`, `approval-bridge-tests`, `runtime-tests`, `runtime`, `sdk-consumers`, `sdk-typecheck`, and `diff-check`, then run `python3 docs/execution/body-roadmap/evidence/B18/verify-artifacts.py`.

Every receipt records actual argv/cwd, time/duration/exit, log hash, pinned Bun 1.3.5 executable hash, config hashes and before/after source hashes. The runner excludes credential variables, disables Bun env-file loading and supplies owned empty provider configuration. Absolute test paths prevent discovery of historical snapshots with matching filenames. The fixtures install a fetch barrier before runtime imports and pass owned child environments with `inheritEnv:false`.

Final frozen-source verification: **302 tests pass, 0 fail**, with **1,819 assertions** across eight files (65 policy/identity, 90 terminal/profile, 13 ACP bridge, 134 runtime/handler). SDK typechecking and diff checks pass. The actual launcher and SDK fixtures add 20 local consumer cases and 17 parser corpus cases with zero provider calls. Every final command reports unchanged source bindings.

## Observed consumers

- Helper and identity tests cover exact bytes, complete compound rosters, push risks across modes, stale profile/cwd/allowed-path/process/snapshot/run bindings and one-use records.
- Terminal/profile tests exercise fabricated public metadata, repeated attempts, actual approved rerun, unchanged profile checks and cancellation after an awaited authorizer.
- The actual reverse ACP approval bridge tests bind reviewable command display and metadata to its approval request.
- `runtime/observations.json` records 13 actual launcher/policy cases and 17 differential parser cases. Denied commands have empty traces; approved/allow-all commands execute harmless local command doubles. `bash -n` checks syntax only.
- `sdk-consumers/observations.json` records seven actual serialized `OpenbuffClient` generator cases through `run.ts`, the terminal launcher and the local approval store: declined/approved compound, declined force push, cancellation during approval, repeated command requiring a new decision, routine feature push and deliberate allow-all. Approved records are reopened from disk and checked for exact command/context hashes, scope and consumption. Repeated approval yields one effect trace and one consumed receipt; cancellation yields no trace or grant and a cancelled run outcome.

The initial real SDK cancellation control found a denied tool result becoming a completed generator run. `initial-cancellation-failure-*` retains that failure. A second run after the launcher abort check found the native runtime adapter converting cancellation into `malformed_result`; `runtime-cancellation-failure-*` preserves that separate boundary failure. Final observations prove cancellation propagation through both boundaries, including plain `Error` abort reasons. Earlier UUID directories are preliminary artifacts; current `observations.json` files and source-bound command receipts define the final invocation.

## Limits and review status

This is implementation-author verification; the independent review and card acceptance belong to the leader. The verifier writes `independent_review_pending` and cannot approve its own implementation.

The scanner recognizes a bounded shell subset and known command families. It does not execute or fully interpret arbitrary scripts, aliases, executable lookup, external effects or all shell grammar. Unsupported cases remain explicit. This evidence establishes cooperative TypeScript policy and receipt behavior, not OS isolation, native parser authority, cross-process fencing, real remote Git/deployment effects, provider behavior or installed-package compatibility. Process-tree enforcement and broad effective-environment adoption remain later-card work.
