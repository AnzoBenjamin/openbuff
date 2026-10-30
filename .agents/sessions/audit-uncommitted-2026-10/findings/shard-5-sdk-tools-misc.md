# Shard 5 — sdk tools: file-change-hooks, concurrency, affected-tests/build-targets/inspect-environment, run.ts dispatch

Branch `feat/polyglot-reaudit-roadmap`, uncommitted working tree (source of truth).
Files audited: `sdk/src/tools/file-change-hooks.ts`, `sdk/src/tools/concurrency.ts`, `sdk/src/tools/get-affected-tests.ts`, `sdk/src/tools/get-build-targets.ts`, `sdk/src/tools/inspect-environment.ts`, `sdk/src/run.ts` (tool-dispatch region + cloneDeep comment hunk).
Verification performed: full read of all six files, git diffs vs HEAD, repo-wide call-site grep (`sdk/ packages/ cli/ agents/ evals/ scripts/ common/`, `web/` does not exist), harness-intelligence delegate inspection, `bun run typecheck` in `sdk/` (exit 0). Tests for the two big files were verified passing by another shard; test names were reviewed here for coverage.

## Findings

### 1. Originator abort poisons joiners of the shared in-flight hook-inference snapshot

- Severity: MEDIUM
- Domain: 2 (Correctness — race condition)
- File: `sdk/src/tools/file-change-hooks.ts:328-340` (`inferFileChangeHooksCached`), `:356-368` (`collectAndCacheHookInference`)
- Risk: The pending cache entry dedupes concurrent callers onto ONE promise, but the snapshot's filesystem work is bound to the FIRST caller's (`originator`'s) signal (`collectAndCacheHookInference(key, root, snapshot, fileSystem, signal)`). If the originator's run is cancelled mid-snapshot, `collectManifestSnapshotAsync` rejects, the cache slot is deleted, and every joiner that had `raceAbort(cached.pending, itsOwnSignal)` awaiting the same entry receives an AbortError it did not cause — its `run_file_change_hooks` tool call fails despite not being cancelled. This directly contradicts the documented intent at `concurrency.ts:26-31` ("the shared work must keep running for whoever else is still interested, so `work` is never aborted") and at `file-change-hooks.ts:311-313` (which only protects *waiters*, not the owner). Requires two concurrent runs on the same cwd within one TTL window plus one cancellation; self-heals on the next call (slot deleted, fresh snapshot). No test covers originator-abort-with-joiner.
- Fix: Do not thread the originator's signal into the shared snapshot; run the shared work un-signalled and have ALL callers (originator included) observe cancellation via `raceAbort(sharedPending, ownSignal)`. The aborted originator's snapshot then finishes under the existing entry/width bounds and its result is cached for the joiners. Alternatively, on abort-rejection of a joined call, fall back to re-invoking inference (cache slot is already gone).

### 2. Dotnet-walk `.catch(() => undefined)` swallows cancellation and caches a truncated snapshot

- Severity: LOW
- Domain: 4 (Error handling — swallowed errors)
- File: `sdk/src/tools/file-change-hooks.ts:1041-1044` (`collectManifestSnapshotAsync`), `:850-853` (`collectManifestSnapshotFromFileSystem`), cached at `:374-379`
- Risk: The walk's failure catch swallows aborts too. The comment claims "cancellation is re-thrown below", but that re-throw only happens via the manifest-probes phase (`mapWithConcurrency`'s per-item `throwIfAborted`) — i.e. only while probes are still running. If the signal aborts after the probes settled but while the (slower) walk is mid-flight, the walk's abort is swallowed, `collectManifestSnapshotAsync` resolves normally with `dotnetTarget: undefined` (or a partially-walked target), and `collectAndCacheHookInference` publishes that truncated result into the TTL cache for up to 5 s. Subsequent non-cancelled callers get hooks missing the dotnet format/build/test entries. Narrow window (walk slower than 36 probes), self-corrects after TTL; hence LOW.
- Fix: Distinguish cancellation from walk failure, e.g. `.catch((error) => { if (signal?.aborted) throw error; return undefined })`, or check `signal?.aborted` before `storeHookInferenceEntry` in `collectAndCacheHookInference`.

### 3. Dead `signal` parameter on the sync snapshot/walk

- Severity: LOW
- Domain: 2 (Correctness — misleading contract / dead param)
- File: `sdk/src/tools/file-change-hooks.ts:806-808` (`collectManifestSnapshot(cwd, signal?)`), `:1093` (`findDotnetTarget(cwd, signal?)`)
- Risk: This change ADDED a `signal` parameter to both sync functions, but the sync `findDotnetTarget` body never reads it (a `readdirSync` loop cannot observe a signal), and the only caller (`inferFileChangeHooks`, line 196) passes no signal. Accepted-but-ignored parameter implies cancellability the code cannot deliver — the same anti-pattern the task brief flags.
- Fix: Drop the parameter from both functions (or assert-and-ignore loudly in a comment).

### 4. Sync→async break of public SDK exports `inspectEnvironment` / `getAffectedTests` / `getBuildTargets`

- Severity: LOW
- Domain: 8 (API/ABI contract)
- File: `sdk/src/tools/inspect-environment.ts:3-6`, `sdk/src/tools/get-affected-tests.ts:13-17`, `sdk/src/tools/get-build-targets.ts:5-9`, re-exported at `sdk/src/index.ts:314-316`
- Risk: All three tool functions changed from returning `CodebuffToolOutput<...>` to `Promise<CodebuffToolOutput<...>>`. Every repo-internal call site was found and verified: only `sdk/src/run.ts:2833/2838/2864` calls them, all now `await`-ed with the correct `(cwd, files, signal)` order, `signal` in scope (`handleToolCall` param, run.ts:2080); no `@codebuff/sdk` package imports exist anywhere in-repo; `web/` does not exist. The remaining risk is external SDK consumers of the published API (sdk 0.11.0, pre-1.0): a JS consumer using the result without `await` now gets a Promise. The sync twins in `harness-intelligence` (`getAffectedTestTargets`, `getBuildTargets`, `inspectHarnessEnvironment`... note `inspectHarnessEnvironment` itself is now async at `harness-intelligence.ts:1256`) are separately re-exported at `index.ts:370-374` and were checked by the harness shard.
- Fix: Intentional per the change's design; record in CHANGELOG as a breaking (pre-1.0 minor) change so SDK consumers migrate.

### 5. `__resetFilesystemPhaseStatsForTest` clears LIVE per-phase counts, contradicting its docblock

- Severity: LOW
- Domain: 3 (State mutation — module-level mutable state)
- File: `sdk/src/tools/concurrency.ts:187-198`
- Risk: The docblock says "Reset every high-water mark (never the live counts)", and indeed `filesystemSlotsInUse` (live aggregate) is untouched — but `filesystemPhaseSlotsInUse` (LIVE per-phase counts) is wiped. If a test resets while gated probes are still in flight, each phase's live count restarts at 0 while the aggregate still counts the held slots, so a phase can then exceed its `phaseLimit` by up to the number of slots it held at reset. Test-seam-only impact (no production caller), but it can produce confusing flakes or silently weaken the phase-cap assertions the seam exists to pin.
- Fix: Only delete `filesystemPhaseMaxSlots` entries and zero `filesystemMaxPhaseSlots`; leave `filesystemPhaseSlotsInUse` alone (matching the docblock).

### 6. Test coverage gaps for the two race windows above

- Severity: LOW
- Domain: 7 (Test coverage)
- File: `sdk/src/__tests__/file-change-hooks.test.ts`, `sdk/src/__tests__/concurrency.test.ts`
- Risk: Coverage of the new machinery is otherwise strong — concurrency.test.ts pins aggregate bound, slot leak on rejection, abort-while-queued, cancelled-after-shift handoff, FIFO drain order, phase caps (lines 85-397); file-change-hooks.test.ts pins cache TTL/in-flight dedup, adapter keying, fan-out bounds, entry-budget trim, walk/probe overlap, abort release of slots, bounded phase log. NOT covered: (a) originator abort while a joiner awaits the shared pending entry (finding 1); (b) abort landing after probes settled but during the walk (finding 2). Both are exactly the interleavings where the current code misbehaves.
- Fix: Add the two interleaving tests alongside the existing "shares one snapshot across overlapping callers" and "an aborted snapshot stops queueing probes" cases.

## Verified sound (no finding)

- run.ts dispatch (2830-2870): all three calls awaited, arg order `(cwd, files, signal)` correct; surrounding branches already used `signal`; the other run.ts hunk (940) is a comment-only justification for lodash `cloneDeep` — no behavior change.
- Signal is genuinely HONORED end-to-end, not a dead param: `inspectEnvironment` → `inspectHarnessEnvironment(cwd, signal)` (throws if aborted upfront, threads signal into both phases); `getAffectedTests` → both async twins → `discoverWorkspacesAsync(cwd, signal)` + `collect*Async(..., signal)`; `getBuildTargets` → `getBuildTargetsAsync(cwd, files, signal)`; all funnel into `withFilesystemSlot(probe, signal)` / `mapWithConcurrency(..., signal)` with `throwIfAborted` at batch boundaries.
- Entry budget is REAL, not advisory: `findDotnetTargetAsync` checks `remaining <= 0` before every readdir batch (line 1275) and at each entry consumption (1297); the adapter twin additionally trims the listing batch to `remaining` (1162). Budget bounded at MAX_PROJECT_SCAN_ENTRIES=2000, depth at 5, exclusions applied.
- KNOWN_PROJECT_PATHS probes and the dotnet walk do overlap as claimed (walk started at 1041 before probes awaited at 1045, joined at 1089; both phases logged via `trackManifestSnapshotPhase`).
- TTL anchored at completion (`expiresAt = Date.now() + TTL` after the snapshot resolves, line 376); identity-checked publish/delete prevents a stale snapshot overwriting a cleared/evicted slot; LRU re-insert on hit; eviction skips pending entries.
- concurrency.ts slot gate: no leak on error paths — `withFilesystemSlot` releases in `finally`; the `settled`/`cancelled` one-shot latch correctly handles the abort-after-shift handoff; re-queue on phase limit cannot livelock (phase limits only bind while that phase holds slots, and holders always settle); no gated call awaits another gated call anywhere in `sdk/` (checked all 7 `withFilesystemSlot` call sites) so the gate cannot self-deadlock; `mapWithConcurrency` failure contract (first error wins, started calls awaited, nothing past failure started) is sound; `raceAbort` composition leaves no unhandled rejection and removes its listener.
- concurrency.ts delta vs HEAD is purely additive: `abortReason`, `raceAbort`, and the filesystem slot gate + seams; `throwIfAborted`/`mapWithConcurrency` behavior unchanged (no removed exports; new optional params only). file-change-hooks.ts removed no exports; `inferFileChangeHooksFromFileSystem` gained only an optional trailing signal.
- Security: per-file hook traversal guard intact (`path.relative` + `..`/absolute rejection, MAX_PER_FILE_HOOK_FILES=50, `shellQuote`); manifest-derived names are shell-quoted (script names, cmake preset regex-validated `^[A-Za-z0-9_.-]+$`); dotnet walk uses Dirent type checks so directory symlinks are not followed and candidates are always cwd-relative.
- `runFileChangeHooks` abort handling: per-hook `.catch` maps genuine failures; `throwIfAborted(params.signal)` after `allSettled` rethrows the run's own cancellation instead of reporting it as failing hooks (covered by tests at file-change-hooks.test.ts:342, 365).
- `sdk` package typecheck (`tsc --noEmit -p .`) passes on the working tree (exit 0) — the whole async signature chain compiles.

## Coverage receipt

- `sdk/src/tools/file-change-hooks.ts` — audited (diff + full 1644-line read): cache/in-flight dedup identity checks, slot-gated probes, level-batched walk budget, hook execution/cancellation; findings 1, 2, 3; security guards verified.
- `sdk/src/tools/concurrency.ts` — audited (diff + full read): additive change (raceAbort/abortReason/fs slot gate); waiter latch/FIFO/release logic traced through abort-shift and phase-limit requeue interleavings; no slot leak or deadlock; finding 5.
- `sdk/src/tools/get-affected-tests.ts` — audited: correct async twin usage, `Promise.all` over both halves with signal threaded; no issue.
- `sdk/src/tools/get-build-targets.ts` — audited: fail-open `resolveOwningTargets` try/catch retained, truncation honesty, signal threaded; no issue.
- `sdk/src/tools/inspect-environment.ts` — audited: thin async wrapper delegating to now-async `inspectHarnessEnvironment` with signal; no issue.
- `sdk/src/run.ts` (tool-dispatch region + 940 hunk) — audited: all three dispatches awaited with correct arg order and in-scope signal; repo-wide grep found zero other callers; cloneDeep hunk is comment-only; part of finding 4 (public re-export surface).
