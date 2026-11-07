# Audit findings: p2-g-index-watcher

- Subsystems: cli-index-watching, indexer-index-manager, cli-run-config-wiring
- Features: P2-T9-interim-index-watcher-linux-bun, index-dirty-marking-gate, worker-thread-fd-capped-watch-pool, auto-watch-new-directories, root-eviction-bound
- Files covered: 6

## [MEDIUM] correctness — cli/src/utils/index-dir-watch-worker.ts:37 — fd-cap overflows and watch failures are dropped silently, never surfaced to the user or telemetry
- **Risk:** Subtrees beyond MAX_DIR_WATCHERS=128 or whose watch() fails are silently unwatched: the user gets no signal that live watching is partial for their repo shape, and index freshness there degrades to the age sweep without notice. The re-audit recommendation to report 'index.watch: sweep-only' in X-4 is not implemented.
- **Fix:** Emit one bounded warning (or a status/telemetry counter) the first time a cap drop or watch-failure occurs, or set a `watch: sweep-only` capability flag per the re-audit suggestion (polyglot-reaudit-2026-09-28/findings/w2-plan-p1-p2.md:50) so operators know watching is partial.
- **Evidence:** index-dir-watch-worker.ts:37-38 'if (watchers.size >= maxWatchers) return' (comment: silently drop); index-dir-watch.ts:134-138 parent deliberately ignores 'watch-error'/'watch-failed' messages with no log; index-dir-watch.ts:32-36, 57-58 and index-workspace-watcher.ts:165-167 document the cap in code comments only; no markStale fallback is triggered for dropped subtrees.

## [MEDIUM] test-coverage — cli/src/utils/__tests__/index-workspace-watcher.test.ts:73 — No Linux+Bun end-to-end test that the pool path drives manager.markPathsChanged/markStale via ensureIndexWorkspaceWatcher; harness mirrors the wiring instead
- **Risk:** The literal production wiring (relativePath derivation, classify call, feedClassification, ambiguous->addDir, deleted->removePrefix, degrade->markStale) inside ensureIndexWorkspaceWatcher:172-211 is never asserted against a real manager, so a future edit to that wiring could break the gate while tests stay green. Worker-crash degrade and cap-exhaustion auto-add drop are entirely untested.
- **Fix:** Add a test that drives ensureIndexWorkspaceWatcher on the Linux+Bun branch with a recording manager and asserts markPathsChanged/markStale fire within the 75ms flush after a real fs event, plus a forced-degrade test (terminate the worker) asserting markStale, and a cap-exhaustion auto-add-drop test.
- **Evidence:** index-workspace-watcher.test.ts:73-113 startHarness mirrors the onRawEvent wiring ('mirrors the classification + auto-add/remove wiring inside ensureIndexWorkspaceWatcher'); the two live tests (:117-193) assert only classified event kinds plus 'degraded' absence; the root-bound test (:196-284) uses makeManager() with empty markStale/markPathsChanged stubs; no test injects a recording IndexManager through ensureIndexWorkspaceWatcher on the !supportsRecursive branch, and no test forces worker.on('error')/exit!=0.

## [LOW] correctness — cli/src/utils/index-dir-watch-worker.ts:62 — remove-prefix matching mixes path separators, latent Windows bug (currently unreachable)
- **Risk:** If the pool branch were ever enabled on Windows, deleting a directory would leave stale watchers on its children, leaking fds until eviction.
- **Fix:** Normalize separators (replace \\ with /) on both sides of the prefix comparison, or skip: the branch is unreachable on Windows today.
- **Evidence:** index-dir-watch-worker.ts:60-64 compares dir.startsWith(`${message.prefix}/`) while all watcher keys on Windows are backslash-joined absolute paths (index-dir-watch.ts path.join); unreachable because the pool only starts when supportsRecursiveIndexWorkspaceWatcher is false, i.e. linux+bun (index-workspace-watcher.ts:154).

## [LOW] error-handling — cli/src/utils/index-dir-watch.ts:148 — Degraded latch is permanent: a single worker error/exit!=0 disables the pool for the root's lifetime with no recovery
- **Risk:** One transient worker crash (e.g. a Bun watcher bug) permanently downgrades the root to the age-based sweep for the whole CLI session even though a fresh worker would likely succeed; directories whose individual watch() failed are also unwatched with no retry or surfacing.
- **Fix:** Optionally restart the worker once with backoff on nonzero exit (reusing collectWatchableDirectories), or at least surface degradation in the index status command; otherwise leave as accepted behavior and note it in the plan.
- **Evidence:** index-dir-watch.ts:148-152 degradeOnce latches; index-workspace-watcher.ts:194-199 onDegrade sets ambiguous=true and scheduleFlush; no restart path exists (post() is gated on !degraded at :168-172); watch-error/watch-failed are dropped at :134-138 without even marking degraded.

## [LOW] correctness — cli/src/utils/index-dir-watch.ts:192 — Startup re-sweep is single-shot: dirs created after the 250ms scan but before their parent watcher boots rely on the age sweep; depth-9+ dirs never watched
- **Risk:** Bootstrap-window directories deeper than depth 8 remain unwatched beyond the single resweep; impact bounded by the age sweep and identical to the steady-state cap policy.
- **Fix:** None required; note the depth-9 blind spot in the cap documentation if depth 8 ever grows shallower.
- **Evidence:** index-dir-watch.ts:192-222 resweep runs collectWatchableDirectories again and posts raw 'add' for unposted dirs; a dir created at depth 9 is never collected (depth >= maxDepth continue at :81) so it stays unwatched until the age sweep; a dir that appeared and was deleted between scans posts a 'add' the worker drops via watch() catch (worker :51-54) harmlessly.

## Coverage receipt

### Subsystems
- cli-index-watching
- indexer-index-manager
- cli-run-config-wiring

### Features
- P2-T9-interim-index-watcher-linux-bun
- index-dirty-marking-gate
- worker-thread-fd-capped-watch-pool
- auto-watch-new-directories
- root-eviction-bound

### Files
- cli/src/utils/index-dir-watch.ts
- cli/src/utils/index-dir-watch-worker.ts
- cli/src/utils/index-workspace-watcher.ts
- cli/src/utils/create-run-config.ts
- cli/src/utils/__tests__/index-workspace-watcher.test.ts
- packages/indexer/src/index-manager.ts

### Domains
- correctness
- error-handling
- state-mutation
- test-coverage
