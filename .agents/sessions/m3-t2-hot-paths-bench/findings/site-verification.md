# Audit findings: site-verification

- Subsystems: scripts
- Features: m3-t2-hot-paths-benchmark
- Files covered: 2

## [LOW] performance — common/src/tools/params/utils.ts:193 — tryRecoverTruncatedToolArguments legacy O(n²) mirror must replay the real pre-M3-T2 shape
- **Risk:** A strawman legacy mirror inflating the measured speedup would fail review.
- **Fix:** Mirror both shapes in benchmark CASE 1 and keep the legacy loop verbatim in the before row (shard-common-contracts.md line 11 documents it exactly).
- **Evidence:** common/src/tools/params/utils.ts:193-246 — shipped scanTruncationState + one forward pass building candidates[] snapshots vs the audit finding's legacy shape: `for (let pos = rawInput.length - 1; pos >= 0; pos--) { const closingChar = rawInput[pos]; if (closingChar !== '}' && closingChar !== ']') continue; const prefix = rawInput.slice(0, pos + 1); for (let i = 0; i < prefix.length; i++) { ...openStack push/pop... } ... }` (shard-common-contracts.md), bounded only by MAX_TRUNCATION_SCAN_LENGTH = MAX_REPAIRABLE_JSON_LENGTH = 256_000.

## [LOW] performance — packages/agent-runtime/src/util/token-counter.ts:14 — token-counter MAX_CACHEABLE_INPUT_CHARS threshold is 8192, not 8000
- **Risk:** The >8KB row's cache-stays-cold contract depends on the exact threshold.
- **Fix:** CASE 3 uses a 48KB message (over the 8KB bound, cache stays cold); CASE 2 drives the shipped IncrementalTokenCounter directly.
- **Evidence:** packages/agent-runtime/src/util/token-counter.ts:14 `const MAX_CACHEABLE_INPUT_CHARS = 8 * 1024`; cache guard at :150-157 `serialized.length > 100 && serialized.length <= MAX_CACHEABLE_INPUT_CHARS`; class IncrementalTokenCounter WeakMap memoization at :166-238 (per audit shard-runtime-loop run-agent-step.ts:1947).

## [MEDIUM] performance — packages/agent-runtime/src/tools/tool-executor.ts:882 — toolInputJsonSchema and TOOL_JSON_SCHEMA_CACHE are NOT exported
- **Risk:** A row that merely times z.toJSONSchema directly would not exercise the shipped memo.
- **Fix:** CASE 4 times `coerceInputScalarsBySchema('read_files', deepClonedObject)` (shipped path through the cache) vs a local `z.toJSONSchema(toolParams['read_files'].inputSchema, { io: 'input' })` legacy mirror.
- **Evidence:** packages/agent-runtime/src/tools/tool-executor.ts:882-903 — `toolInputJsonSchema(toolName)` with `TOOL_JSON_SCHEMA_CACHE.has/get/set` around `z.toJSONSchema(toolParams[toolName].inputSchema, { io: 'input' })`; both symbols are module-private, so no import path reaches the shipped memo directly.

## [HIGH] performance — scripts/memory-drift-guard.ts:1096 — runMemoryDriftGuard shares one snapshot; checkers accept optional snapshot
- **Risk:** The before row would not reproduce the pre-optimization per-checker walk.
- **Fix:** CASE 6 before = shipped checkers called WITHOUT a snapshot (each re-walks/re-reads); after = shipped `runMemoryDriftGuard(root)` (one walk).
- **Evidence:** scripts/memory-drift-guard.ts:1079-1110 — `runMemoryDriftGuard` builds the snapshot once and hands it to every checker; `snapshotFiles`/`snapshotFileLines` (:135-153) fall back to `markdownFiles(root)` walk + `readLines(filePath)` when snapshot is undefined, which IS the pre-M3-T2 per-checker shape.

## [MEDIUM] performance — agents/base2/base2.ts:11759 — readGateFileContentMarker is closure-scoped inside handleSteps — must be extracted via the e2e recipe
- **Risk:** Importing base2 would run module-closure side effects; extraction must reproduce the exact bindings the e2e test already passes with.
- **Fix:** Copy the recipe verbatim; wrapper via new Function (fresh gateMarkerCache), uncached via the e2e recipe.
- **Evidence:** agents/base2/base2.ts:11759-11795 (cached wrapper, `gateMarkerCache` :1100-1103, GATE_MARKER_CACHE_MAX :1099) and :11833-12009 (uncached body); agents/e2e/reviewer-spawn-conditions.e2e.test.ts:236-335 documents the extraction recipe (Bun.Transpiler + extractInlineFunctionSource + new Function with GATE_FILE_MISSING_CONTENT_MARKER + GATE_MARKER_CACHE_MAX bindings and a fresh Map).

## [LOW] test-coverage — scripts/.coverage-allow:12 — .coverage-allow entry position verified: after fireworks-deployment-stats.ts, before get-changelog.ts
- **Risk:** Wrong position fails the alphabetical-sort check.
- **Fix:** Insert the basename between those two lines.
- **Evidence:** scripts/.coverage-allow read (lines 1-34); live list confirmed `fireworks-deployment-stats.ts` then `get-changelog.ts` adjacent, so `measure-m3-t2-hot-paths.ts` sorts between them (f < m < g).

## [LOW] correctness — packages/agent-runtime/src/util/tool-result-eviction.ts:78 — tool-result-eviction bound is MAX_PROTECTED_CONTENT_SCAN_CHARS = 5MB
- **Risk:** Using the default minSavingsTokens would no-op the row.
- **Fix:** 40KB tool results over 22 steps with keepRecentSteps: 0 and minSavingsTokens: 1 (per the test at tool-result-eviction.test.ts:51-56 which uses keepRecentSteps: 0 semantics via 2 extra steps).
- **Evidence:** packages/agent-runtime/src/util/tool-result-eviction.ts:78 `MAX_PROTECTED_CONTENT_SCAN_CHARS = 5_000_000` with bounded scanRegion in contentReferencesProtectedPath (:117-155); evictStaleToolResults returns `{ messages, tokensSaved: 0, evictedCount: 0 }` no-op below EVICTION_MIN_SAVINGS_TOKENS = 4_000 (:220-226).

## Coverage receipt

### Subsystems
- scripts

### Features
- m3-t2-hot-paths-benchmark

### Files
- scripts/measure-m3-t2-hot-paths.ts
- scripts/.coverage-allow

### Domains
- correctness
- security
- performance
- error-handling
- test-coverage
