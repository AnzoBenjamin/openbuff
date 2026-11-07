# Shard 3 — sdk/src/tools/run-terminal-command.ts (+ tests)

Files audited (git diff AND working tree; working tree is source of truth):
- `sdk/src/tools/run-terminal-command.ts` (modified, +791/-27)
- `sdk/src/__tests__/run-terminal-command.test.ts` (modified, +457)

Verification performed: full working-tree read; full diff read; targeted runtime probes
against the real `runTerminalCommand` (windowed-scan overlap at slice boundaries, 2MB
byte-budget kill, quoted-header handling under pristine git config); full test suite run
(38/38 pass, 3.2s); importer sweep across sdk/packages/cli/common.

Known-risk items from the author's log, verified CLEAN in the working tree:
- `publishedStatsHolder` and `publishged`: zero occurrences (grep over both files).
- `publishStats` slot lookup: uses `indexOf(retainedStats)` where `retainedStats` is
  reassigned to the fresh copy only AFTER the slot is found (`sdk/src/tools/run-terminal-command.ts:353-358`)
  — the "lastIndexOf after reassignment can never find the old slot" bug is gone. Identity
  lookup is safe (each snapshot is a fresh object); after eviction by 16 newer scanners it
  returns -1 and early-returns without re-pushing.
- Ring truncation on `__resetStagedDiffScanStatsForTest` (`:236-238`): sets `.length = 0`;
  a still-live pre-reset scanner publishing afterwards finds -1 and drops (understates the
  seam, never corrupts it). Correct.
- Detachment: `snapshotStats` (`:180-188`) copies 5 primitive counters into a fresh plain
  object; the ring never holds the scanner-closure `scanStats`, so no reference to
  `queued`/`parkedText`/`StringDecoder` (and the up-to-2MB parked patch) outlives the
  preflight. Pinned by the retained-keys test.

---

## F1 — Sensitive-name check silently bypassed for git C-quoted staged paths

- Severity: HIGH
- Domain: 1 (Security) / 2 (Correctness)
- File: `sdk/src/tools/run-terminal-command.ts:284-299` (`parseStagedDiffHeader`, `unquoteGitPath`)
- Risk (empirically verified): with git's DEFAULT `core.quotePath=true` (any machine/user
  that has not set it to false — this author's `~/.gitconfig` HAS `core.quotePath=false`,
  which masks the bug locally), `git diff --cached -U0` emits headers like
  `diff --git "a/r\303\251sum\303\251.pem" "b/r\303\251sum\303\251.pem"` for any path
  containing non-ASCII bytes, `"`, `\`, or control chars. `parseStagedDiffHeader` requires
  `body.startsWith('a/')` (`:288`), which fails on the leading quote — the header is
  entirely unparsed, the path never enters the names table, `namesTruncated` stays false,
  and the commit is CLEARED. Probe result under `GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_SYSTEM=/dev/null`: staged `résumé.pem` → commit executed (`exitCode 0`),
  `maxRetainedNames: 0`. Real-world shape: `café/.env`, `schlüssel.pem` — i.e. plain
  sensitive files under non-ASCII directories slip the name check. The content check still
  catches actual `-----BEGIN…PRIVATE KEY-----`/AKIA material, but an `.env` or
  `credentials.yaml` under a non-ASCII path passes uninspected. The function's own doc
  comment claims "git's C-style quoting of unusual paths is stripped from each side" —
  only the surrounding quotes are stripped (`unquoteGitPath`), never the `\nnn` octal
  escapes, and the `"a/` prefix defeats the parse before that. Note: the OLD `--name-only`
  code had an equivalent blind spot (quoted line ends with `"` so the suffix regex missed),
  so this is a carried-over, not newly introduced, bypass — but the new parser was written
  specifically to handle quoting and doesn't.
- Suggested fix: accept `"a/`-prefixed bodies (split on `lastIndexOf('" b/')` when quoted),
  and unescape C-style escapes (octal `\nnn`, `\\`, `\"`) before testing
  `SENSITIVE_STAGED_PATH`. Fallback hardening: if a header line starts with
  `diff --git` but fails to parse, treat it as an inspection failure rather than no name.

## F2 — New multi-byte test passes only via the author's git config; fails on default config

- Severity: MEDIUM
- Domain: 7 (Test coverage) / 2 (Correctness)
- File: `sdk/src/__tests__/run-terminal-command.test.ts:726-753`
  ("reassembles a multi-byte code point split across chunk boundaries")
- Risk: the test stages `résumé.pem` and asserts the commit is blocked with the literal
  name. Under default `core.quotePath=true` (CI runners, other machines) the header is
  octal-quoted, the name is not extracted (F1), the commit runs, and both assertions fail.
  Verified: same scenario with pristine git config → `blocked: false, committed: 0`.
  `initTempGitRepo` sets only `user.email`/`user.name` locally, so every test inherits the
  author-machine global gitconfig — the suite is green here and red on default-config CI.
- Suggested fix: fix F1 (parser handles quoting) and keep/strengthen the test with an
  explicitly quoted path; until then the test cannot be made config-independent because
  the scanner's git args are fixed. Also consider `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
  isolation for the suite — noting `getChildProcessEnv()` does not forward those vars, so
  repo-local `git config core.quotePath …` in `initTempGitRepo` is the reliable lever.

## F3 — Preflight git spawns have no timeout and ignore the abort signal

- Severity: MEDIUM
- Domain: 4 (Error handling)
- File: `sdk/src/tools/run-terminal-command.ts:603-706` (`runGitForSafety`),
  `:725-745` (`validateStagedCommit`), `:1227` (call site)
- Risk: `timeout_seconds` bounds only the bash child spawned AFTER the preflight; the two
  `git diff --cached` spawns have no deadline, and `runTerminalCommand`'s `signal` is not
  passed into `validateStagedCommit`. A stalled git (hung FUSE/NFS mount, wedged process)
  hangs the tool call forever; an aborted request keeps the preflight running to
  completion. The old `spawnSync` path also had no timeout (and blocked the event loop),
  so this is not a regression — but the async rewrite was the opportunity to wire it.
- Suggested fix: thread `signal` into `runGitForSafety` (kill on abort) and add a generous
  wall deadline that resolves `{ kind: 'inspectionFailed' }` instead of hanging.

## F4 — `safetyPreflightFailed` undeclared in the tool output schema

- Severity: LOW
- Domain: 8 (API/ABI contract)
- File: `sdk/src/tools/run-terminal-command.ts:1243-1261` vs
  `common/src/tools/params/tool/run-terminal-command.ts:56-84` (unmodified in this changeset)
- Risk: the new field (and pre-existing `approvalRequired`, `harnessAction`,
  `harnessTarget`, `approvalReceiptId`) is absent from `terminalCommandOutputSchema`, so it
  is not part of the `CodebuffToolOutput<'run_terminal_command'>` static type and would be
  stripped by any consumer parsing results through `outputSchema` — the stripping behavior
  is documented by the repo itself (`sdk/src/run.ts:3003-3006`). The
  permissionDenied-vs-safetyPreflightFailed distinction is the diff's core new contract;
  typed downstream consumers cannot see it. No in-reco consumer currently parses tool
  results through toolParams.outputSchema (only agentTemplate.outputSchema at set-output,
  a different mechanism), hence LOW.
- Suggested fix: declare `safetyPreflightFailed` (and the harness fields) in the schema's
  errorMessage branch.

## F5 — `drainAll` scans everything parked at settle in one unsliced tick

- Severity: LOW
- Domain: 5 (Performance)
- File: `sdk/src/tools/run-terminal-command.ts:513-536`, `:576-580`
- Risk: the comment claims the settle-time flush "is bounded by what the last tick left
  parked", but if git outpaces the 64KB/slice drain loop, the remainder at close can
  approach GIT_SAFETY_OUTPUT_LIMIT (2MB) — a single-tick decode+regex pass, partially
  defeating the slice bound the design exists for. Overall memory stays bounded (kill at
  2MB); this is event-loop latency only, worst case ~2MB of decode+regex in one tick.
- Suggested fix: have `drainAll` loop `scanAvailable(GIT_SAFETY_SCAN_SLICE_CHARS)` with
  `setImmediate` yields (it is already async-adjacent via `scanWhilePending`).

## F6 — stderr decoded per-chunk without a StringDecoder

- Severity: LOW
- Domain: 2 (Correctness) / 4 (Error handling)
- File: `sdk/src/tools/run-terminal-command.ts:695-699`
- Risk: `chunk.toString('utf8')` per stderr chunk splits a multi-byte code point across a
  chunk boundary into U+FFFD — inconsistent with the StringDecoder care taken for stdout
  (`:622`, `:685`). Cosmetic: affects only retained error-message text.
- Suggested fix: decode stderr through a second `StringDecoder`, flush in `settle`.

## F7 — Coverage gaps in the new suite (paths verified working by manual probes)

- Severity: LOW
- Domain: 7 (Test coverage)
- File: `sdk/src/__tests__/run-terminal-command.test.ts`
- Not covered, with manual verification status:
  - Byte-budget overflow kill + fail-closed: NOT tested. Probe verified working (3MB
    staged diff → child SIGKILLed, settled in ~22ms, `safetyPreflightFailed: true`,
    `permissionDenied` unset, commit not run).
  - Long-line window/overlap path (single line > slice cap, marker straddling the
    boundary): NOT tested — the trickiest off-by-one surface in the scanner. Probe
    verified working: `AKIA…` marker straddling the first 64KB boundary and
    `-----BEGIN OPENSSH PRIVATE KEY-----` straddling the second boundary are both
    detected (overlap 256 ≥ longest pattern ~34 chars — the invariant that makes it
    correct; worth pinning in a test since raising the patterns or lowering the overlap
    silently breaks it).
  - Ring eviction after 16 scanners, and reset-while-scanner-alive: NOT tested.
  - Concurrent `validateStagedCommit` calls (the exact race the per-scanner stats fix
    addresses): NOT tested.
  - Quoted-header path: NOT tested — and currently broken (F1/F2).
  - Minor: `expect(value.exitCode).not.toBe(0)` at `test.ts:710` is vacuous — the
    structured inspection-failure result carries no `exitCode` (the commit never ran), so
    the assertion can never fail on `0` meaningfully.
- Covered well: ring detachment (retained-keys), name extraction from -U0 headers
  (plain/rename/multi-byte/name-cap), whitespace-vs-fatal distinction, bounded slices +
  enqueueDecodedBytes==0 invariant, inspection-failure vs denial semantics, abort windows.

---

## Verified-correct claims from the change intent

- Windowed scan: 16KB incomplete-line threshold / 256-char overlap / 64KB slice
  (`:95-109`); raw chunks parked as Buffers and decoded only in the drain loop via a
  stateful `StringDecoder` (`:373-379`, `:385-388`), so split multi-byte code points are
  reassembled (verified live) and `decoder.end()` flushes a patch ending mid-code-point
  (`:522`).
- Staged names from `-U0` headers instead of a separate `--name-only` diff: confirmed —
  no `--name-only` spawn remains (only comments reference it), renames contribute both
  sides, table capped at 4096 with a truncation flag that fails CLOSED as
  inspectionFailed (`:796-801`, test-pinned).
- Async spawn with byte budget: `observeStdout` path retains nothing (early return before
  any stdout accumulation, `:678-681`); over-budget stream SIGKILLs the child and
  resolves `exitCode: -1` → fail-closed (`:655-661`, `:653`); budget is cumulative BYTES
  per stream; verified live.
- Two remaining diffs run concurrently under `GIT_OPTIONAL_LOCKS=0` (`:737-745` Promise.all
  + `:638` env override after `getChildProcessEnv()`), verdicts still evaluated in the
  original precedence order.
- `runGitForSafety` settle paths: `settled` guard prevents double-settle across
  `error`+`close`; killed children settle via `close`; `--check` head retention bounded at
  4KB cut on a line boundary; whitespace-diagnostic-vs-fatal distinction (`:746-764`)
  tested both ways.
- State mutation: module-level ring is the only shared mutable state; per-scanner slots,
  identity-based republish, detached snapshots; `drainAll` drops parked bytes at settle;
  scanner `wake`/`waitForWork` handshake has no lost-wake window (waitForWork re-checks
  queued/parkedText before parking); `scanWhilePending` observes both promise outlets so
  no unhandled rejection.
- API/ABI: `export function` → `export async function` is signature-compatible (always
  returned a Promise). All importers verified compatible: `sdk/src/index.ts:304`
  (re-export), `sdk/src/run.ts:2474` (awaited), `sdk/src/tools/index.ts:12`,
  `sdk/src/tools/check-job.ts:13` (named helpers `dirtyDelta`/`listDirtyPaths`/
  `withTouchedPaths` unchanged), `sdk/src/tools/file-change-hooks.ts:1377,1489`
  (`typeof runTerminalCommand` + awaited inside `Promise.allSettled`). Test seams are not
  publicly re-exported from the SDK index.
- Dependency hygiene: only `string_decoder` (node builtin) and existing `throwIfAborted`
  from `./concurrency` added; no new external deps.

## Coverage receipt

- `sdk/src/tools/run-terminal-command.ts` — AUDITED (full read + diff + 6 runtime probes + live test run). Ring/publishStats/reset/detachment clean of the known bad edits; window/overlap/slice logic correct including boundary straddles; byte-budget kill correct; HIGH finding on quoted-header name bypass (F1), plus F3/F4/F5/F6.
- `sdk/src/__tests__/run-terminal-command.test.ts` — AUDITED (full read + executed, 38/38 pass). Good coverage of ring detachment, -U0 name extraction, slice bounds, fail-closed semantics; gaps: byte-budget kill, long-line overlap, ring eviction, quoted headers (F2 — test is config-dependent and fails on default git config), one vacuous assertion.
