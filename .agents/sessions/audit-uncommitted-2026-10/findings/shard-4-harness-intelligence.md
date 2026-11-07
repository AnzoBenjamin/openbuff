# Shard 4 — harness-intelligence async/concurrency conversion

- Shard: shard-4-harness-intelligence
- Branch: feat/polyglot-reaudit-roadmap (uncommitted working tree)
- Files audited (diff + working tree):
  - `sdk/src/services/harness-intelligence.ts` (+1965)
  - `sdk/src/__tests__/harness-intelligence.test.ts` (+759)
  - `sdk/src/__tests__/harness-read-tools.test.ts` (+14)
- Method: full read of the 2465-line working-tree file, full diff against HEAD, read of `sdk/src/tools/concurrency.ts` (gate/raceAbort/mapWithConcurrency), `common/src/util/project-path-containment.ts` (resolver parity), `sdk/src/tools/node-filesystem.ts` (no nested slot acquisition), all four importers (`inspect-environment.ts`, `get-affected-tests.ts`, `get-build-targets.ts`, `sdk/src/index.ts`). Both assigned test files re-run: 38 pass. Findings 1 and 2 were reproduced with standalone runtime scripts (repros described inline).

---

## Finding 1 — Go workspace inference silently deleted (HIGH)

- Domain: Correctness
- File: `sdk/src/services/harness-intelligence.ts:335-383` (working tree), diff hunk removing `} else if (base === 'go.mod') {` between the `Cargo.toml` and `pom.xml` branches of `inferWorkspace`.
- Evidence: HEAD had a `go.mod` branch producing `{ ecosystem: 'go', manager: 'go', lockfile: go.sum, confidence: 'confirmed' }`. The working tree drops it with no comment; `go.mod` remains in `manifestNames` and `go.sum` in `lockfileNames`, so Go manifests are still discovered — they now fall through to the default `{ ecosystem: 'unknown', manager: 'unknown', confidence: 'inferred' }`.
- Runtime repro (verified): a temp repo with `go.mod` + `go.sum` + `svc/api/main.go` returns `workspaces: [{"root":".","ecosystem":"unknown","manager":"unknown","manifest":"go.mod","confidence":"inferred"}]`, `getBuildTargetsAsync` returns `commands: [], confidence: "unknown"`, and `analyzeTestImpactAsync`'s build-tool tier is `[]`. At HEAD the same repo produced `manager: 'go'` and `go test/vet/build` commands.
- Concrete risk:
  - `get_build_targets` no longer reports Go targets; `analyzeTestImpact`'s build-tool tier no longer emits `go test ./<dir>`.
  - Go files lose workspace ownership, so `packageRoot` falls back to `'.'`.
  - The `workspace.manager === 'go'` branches at `harness-intelligence.ts:1769` and `:2071` are now dead code — a strong signal the deletion was accidental.
  - Neither the old nor the new test suite has any Go fixture (checked HEAD test file too), which is why all 141 tests stay green. `toolVersionAsync('go', ['version'])` still probes `go`, deepening the incoherence.
- Suggested fix: restore the `go.mod` branch in `inferWorkspace` (and its test coverage), or, if the removal is intentional, remove `go.mod`/`go.sum` from the discovery lists, delete the dead `'go'` branches, and document the decision.

## Finding 2 — First caller's abort poisons the shared tools cache for 60s (HIGH)

- Domain: Correctness / State mutation
- File: `sdk/src/services/harness-intelligence.ts:714-748` (`probeToolsAsync` passes `signal` into `refreshToolProbes(signal)` at line 730), `:590-597` (`toolVersionAsync`'s `onAbort` settles `{ available: false }`), `:730-736` (unconditional publish of the settled record).
- Trace: on a cache miss the starting caller's `signal` is baked into the shared 14-probe group. If that caller's signal aborts mid-flight, every `toolVersionAsync` `onAbort` kills its child and settles `{ available: false }` — the group **resolves** (never rejects), and the `.then` handler publishes the all-unavailable record into the 60s TTL slot (identity check passes; nothing cleared it). Every subsequent caller — including fresh, non-cancelled inspections and callers that joined via `raceAbort(cached.pending, ...)` — is served "all 14 tools unavailable" for up to 60 seconds.
- Runtime repro (verified): fake spawn reports `9.9.9` after 300ms; caller A starts a miss and aborts at 50ms; caller A resolves with all-false tools (discovery had already settled, so `Promise.all` resolves), and a fresh caller B afterwards gets `{"git":{"available":false},...}` for every tool.
- Additional inconsistencies:
  - The docblock at `:721-723` claims "The shared group is never cancellable on one caller's behalf" — the code does exactly the opposite for the group starter.
  - The starting caller gets `pending` unwrapped (`return pending`, line 747) while later callers get `raceAbort(cached.pending, signal)` — the starter's cancellation semantics differ from every other caller's (and, when discovery is still in flight, the same aborted inspection can reject via the discovery race while the probe half silently fabricates unavailability).
  - The discovery cache solved this same problem with the waiter-count + per-traversal-controller design (`registerDiscoveryWaiter`); the tools cache has no equivalent.
- Suggested fix: do not thread the starting caller's signal into `refreshToolProbes` (bound probes by `toolVersionTimeoutMs` alone), or give the group its own controller cancelled only when zero callers await it (mirror the discovery pattern); and/or have an abort-settled probe group skip the cache publish / delete the pending entry instead of caching fabricated unavailability. Add a mid-flight-abort regression test (none exists today).

## Finding 3 — Probe contract drift: timeout 3s→5s, output cap semantics changed, docblock claims "identical contract" (MEDIUM)

- Domain: Correctness / Error handling (documentation-claim mismatch)
- File: `sdk/src/services/harness-intelligence.ts:522` (`toolVersionTimeoutMs = 5_000`), `:525` (`toolVersionMaxBytes = 64 * 1_024`), `:563-567` (docblock: "identical contract — same timeout, same output concatenation"), vs HEAD's `spawnSync(..., { timeout: 3_000 })`.
- Concrete risk:
  - A hung tool now holds its child and the pending cache entry for 5s instead of 3s. The change is undocumented and contradicts the docblock (and the task intent, which states "same 3s timeout and 8KB output cap" — the code says 5s / 64KB).
  - Old behavior: output beyond `maxBuffer` (1MB default) made `spawnSync` set `result.error` → tool reported unavailable. New behavior: output is truncated at 64KB and the tool still reports `available` with the first line. Different verdict for chatty tools.
  - `sdk/src/__tests__/harness-intelligence.test.ts:47` declares `TOOL_PROBE_TIMEOUT_MS = 3_000` that is never used — a stale constant documenting the wrong value.
  - Minor: `output.slice(0, toolVersionMaxBytes)` slices UTF-16 code units while the cap counts bytes (cosmetic for version strings).
- Suggested fix: either restore 3s or update the docblock + task claims to 5s deliberately; delete or correct the unused test constant; note the truncation-vs-unavailable semantics change in the docblock.

## Finding 4 — Public SDK export `inspectHarnessEnvironment` flipped sync→async (LOW)

- Domain: API/ABI contract
- File: `sdk/src/services/harness-intelligence.ts:1256-1259`, re-exported at `sdk/src/index.ts:380` (`@codebuff/sdk` 0.11.0).
- Concrete risk: every in-repo caller (`inspect-environment.ts` tool, both test files) was updated and awaits correctly (verified by grep across sdk/, packages/, cli/, common/, agents/, evals/ — no other importers). But the function is re-exported from the package root, so external SDK consumers calling it synchronously (property access on the result) break at runtime with `undefined`. Pre-1.0, so likely acceptable; flagged so the flip is a decision, not an accident. The sync `getAffectedTestTargets`/`getBuildTargets`/`analyzeTestImpact` are retained, so only this one export changed shape. New async twins are not re-exported from the index (tool-internal only) — fine.
- Suggested fix: note the breaking change in the sdk changelog, or keep a sync-named alias if external consumers are known.

## Finding 5 — Sync (DFS) and async (BFS) walks can disagree above the 2000-dir visit cap (LOW)

- Domain: Correctness
- File: `sdk/src/services/harness-intelligence.ts:103-130` (sync stack walk, pop-time cap) vs `:175-218` (level-batched walk, per-level trim).
- Concrete risk: below `MAX_VISITED_DIRS` both walks visit the identical set (output is sorted). On trees with more than 2000 visited directories, the sync walk's DFS order and the async walk's level batching truncate *different* subsets of the tree, so `getBuildTargets` (sync) and `getBuildTargetsAsync` (async tool) can report different manifests for the same repo. Both are "a bounded subset", so severity is low; the twin-path parity the module otherwise works hard to guarantee silently degrades exactly at the cap.
- Suggested fix: document the divergence at the cap, or align the trim strategy (e.g., give the sync walk the same level ordering).

---

## Checked and clean (negative results, for the record)

- Pending-promise cleanup paths (specific concern): both caches register before first await and clean up inside the promise's own handlers, identity-gated (`ownsToolProbeSlot` / `ownsDiscoverySnapshot`), so late settles cannot overwrite fresher/cleared entries; no early return or throw exists between `toolsCache = {pending,...}`/`storeDiscoveryEntry` and the await that would leak a registered entry; `awaitDiscovery`'s waiters are released in `finally` on all paths; a just-rejected pending entry served to a same-tick caller propagates the rejection through that caller's own await (handled — no unhandled-rejection window; `Promise.race` attaches handlers to both participants).
- Timer/child cleanup in `toolVersionAsync`: single `settle` gate clears the timer and removes the abort listener on every path (timeout, error, close, abort, sync spawn throw); early-aborted entry returns before the timer is created; both pipes are drained; SIGKILL on timeout/abort; the `refreshToolProbes` rejection path is effectively dead (each probe's promise only resolves) but is correctly identity-gated anyway.
- Discovery waiter latch: `cancelled` entries are dropped synchronously with being flagged, so a dead promise is never served; LRU eviction of a pending entry does not strand its waiters (they hold the entry object); last-leaver abort of an already-settled walk is a no-op.
- Security: probe argv is a hardcoded constant list (no injection); `cargo -p` interpolation still gated by `/^[A-Za-z0-9._-]+$/`; command strings are display-only and unchanged from HEAD; walk starts from the trusted tool cwd, skips symlinks; `resolveProjectPathForFileSystem` mirrors `resolveProjectPath` containment (lexical + realpath + owned-temp scope rejection) — traversal tests pass; captured probe output is capped and only first-line retained (no secret-leak surface beyond what HEAD had).
- Performance: level batching genuinely bounds in-flight readdirs at 8 per phase, aggregated by the process-wide 8-slot gate with 1 reserved interactive slot; manifest pre-reads skip lockfile-decided scopes; collector probes flattened into one bounded list; manifest reads deduped per manifest; no gated probe awaits another gated probe (no saturation deadlock; `node-filesystem` is plain `fs.promises`).
- Dependency hygiene: only stdlib additions (`node:fs/promises`, `spawn`); no new packages.
- `harness-read-tools.test.ts` (+14): purely mechanical `await` additions for the now-async tool wrappers; assertions unchanged.

## Test coverage gaps (domain 7)

- No test for a mid-flight abort of a probe group or a discovery walk (only the already-aborted signal case is covered) — this is exactly the hole Finding 2 lives in.
- No test drives the probe timeout kill path (`toolVersionTimeoutMs`); nothing pins the 3s→5s value (Finding 3).
- No test pins TTL anchoring (a slow miss still getting a full 60s/5s window after settle) for either cache.
- No explicit two-concurrent-callers-one-walk dedup test for the discovery cache (the tools cache has one: "shares one in-flight probe group across concurrent inspections").
- No Go-ecosystem fixture anywhere (pre-existing gap that let Finding 1 through).
- No rejection-path cleanup test for either cache (entries deleted on rejection, next caller gets a fresh group/walk) — currently only exercisable via the dead-by-construction rejection path.

## Coverage receipt

- `sdk/src/services/harness-intelligence.ts` — AUDITED (full working tree + full diff; both assigned test files re-run green; findings 1-5 above; findings 1-2 runtime-reproduced).
- `sdk/src/__tests__/harness-intelligence.test.ts` — AUDITED (full read + HEAD comparison; strong observability seams, but gaps listed above; stale unused `TOOL_PROBE_TIMEOUT_MS` noted in finding 3).
- `sdk/src/__tests__/harness-read-tools.test.ts` — AUDITED (diff-only mechanical async update; assertions intact; no issues).
