# Wave 1 integration verification (N01–N10)

Date: 2026-11-13. Tree: branch `feat/polyglot-reaudit-roadmap` at `f5aba489d` plus uncommitted B19–B21 work and wave 1.
Baseline for "already failing" was a disposable `git worktree add --detach /tmp/ob-head HEAD` with `bun install --frozen-lockfile`. It was removed afterwards (`git worktree remove`, `git worktree list` shows only the main tree). HEAD has none of the uncommitted B19–B21 work, so "passes at HEAD, fails now" means the cause is either wave 1 or the roadmap work in progress. Each such failure was attributed by its error and by the receipts' changed-file lists.

Logs: `/tmp/integ/tc-*.log`, `/tmp/integ/test-*.log`.

## Typecheck (`bun run typecheck` in each package)

| Package | Result |
|---|---|
| common, packages/agent-runtime, packages/code-map, packages/indexer, packages/internal, scripts, evals, sdk, agents, cli | pass (0 errors). sdk and cli re-checked after the fixes and the bundle regeneration: pass. |
| .agents | **fail, 35 errors**, all from untracked audit probe scripts in `.agents/sessions/product-audit-2026-11-12/verification/probes/` (see below) |

`sdk/src/__tests__/fixtures/fake-llm-server.ts:135` (a known report): no error any more. sdk typecheck is clean.

## Tests

| Package | Command | Pass | Fail | Skip |
|---|---|---|---|---|
| sdk | `bun run test` (`bun test`) | 5721 | 54, now 49 after fixes | 0 |
| common | `bun test` | 2006 | 0 | 0 |
| packages/agent-runtime | `bun test` | 3056 | 0 | 0 |
| cli | `bun run scripts/run-cli-tests.ts` (run twice, the second after the bundle regeneration) | 4676 | 0 | 187 |
| agents | `bun test __tests__` | 1284 | 0 | 0 |
| evals | `bun test` | 430 | 1 | 0 |
| packages/code-map | `bun test` | 175 | 2 | 0 |
| packages/internal | `bun test` | 130 | 0 | 0 |

Known reports that now pass: `packages/agent-runtime/.../__tests__/run-terminal-command.test.ts` and the `sdk/src/__tests__/model-provider.test.ts` ancestor-trust tests. In code-map, PHP/Swift/Kotlin `structure.test.ts` passes (it fails at HEAD) and the packaged-WASM coverage test passes.

## Failures, cause and resolution

### (a) Wave 1: fixed

1. `sdk/src/__tests__/initial-session-state.test.ts` "derives knowledgeFiles from projectFiles when not provided" (1 test).
   - Cause: N08 replaced the one-file-per-directory priority (knowledge.md > AGENTS.md > CLAUDE.md) with "every instruction file per directory" (`sdk/src/run-state.ts` `deriveKnowledgeFiles` → `loadInstructionFiles`, addendum N08 Accept). The test still asserted that `claude.md` is dropped when `knowledge.md` is present.
   - Fix: the assertion now expects `claude.md` to be loaded (line ~237), with an N08 comment.
2. `sdk/src/__tests__/run-startup-context.test.ts` "deferred fs/spawn initialization retains captured skills and metadata" (4 tests).
   - Cause: N02 keeps project skills out of `fileContext.skills` unless the project is trusted (`sdk/src/run.ts:1072` `includeProjectSkills`). The test reads project skills from `.agents/skills` without trusting the project.
   - Fix: the test client passes `trustProjectConfig: true` (line ~283). This is the same approach N02 used in `run-state-home-policy.test.ts`. The SDK does not persist explicit trust, so no file is written.
   - Verify: `bun test src/__tests__/initial-session-state.test.ts src/__tests__/run-startup-context.test.ts` gives 29 pass, 0 fail.
3. Generated bundle `cli/src/agents/bundled-agents.generated.ts` (gitignored) was stale.
   - Cause: it was built before the N08 `agents/base2/base2.ts` placeholder removal and the N04 `agents/context-pruner.ts` change. It differed in 7 agents: base-deep, base2-evals, base2-execute-plan, base2-fast-no-validation, base2-fast, base2-plan and context-pruner.
   - Fix: regenerated with `cd cli && bun scripts/prebuild-agents.ts` (45 agents). cli typecheck and tests pass afterwards.

### (b) B19–B21 roadmap work in progress: not fixed

- **Native backend early return** in `sdk/src/host-execution.ts:119`: `if (profile.preferredBackend === 'native-exec' && !options.nativeExecution && !profile.allowBackendFallback) return unavailable('The requested native backend has no verified host installation')`. This sits in the B21 native-host hunks (`createNativeHostRegistry`, `nativeExecution` option), and no wave-1 receipt lists this file. The error wording no longer matches `/execution (profile|backend) unavailable/`, or the refusal now happens before target dispatch. Affected tests (all pass at HEAD):
  - `sdk/src/__tests__/run-host-contract-controls.test.ts`: "strategy.sdk: a second run with required unavailable execution starts no command target" (1)
  - `sdk/src/__tests__/toolchain-execution-branch-controls.test.ts`: "a required native profile remains unavailable at the actual SDK build consumer" (1)
  - `sdk/src/__tests__/workspace-bootstrap.test.ts`: "an unavailable required backend stays a typed refusal across identity, broker and journal" (1)
  - `evals/buffbench/execution.test.ts`: "native.unavailable preserves explicit profile refusal before any target dispatch" (1). `createDirectHostExecution` now returns `ok:false` with the message above.
- **Bootstrap forced to the default profile** in `sdk/src/host-execution.ts:367`: `contextFor(hostOwner.value.owner, bootstrapBudget.value, undefined, defaultExecutionProfile)`. Bootstrap launches now record `policy: 'workspace-write'` where the run requested `full-access`. Reverting only this line in a guarded temporary edit made all 67 affected tests pass, and the file was restored byte-identical. The change keeps bootstrap off the native profile and belongs with the B21 hunks; no wave-1 receipt claims it. Affected tests:
  - `sdk/src/__tests__/terminal-execution-branch-controls.test.ts`: `sdk.journal-bootstrap` / `sdk.broker-bootstrap` `identity.legacy.{root,common-dir}` `happy` and `replacement-env` (8)
  - `sdk/src/__tests__/blender-sdk-execution-branch-controls.test.ts` (untracked B19-era file, not at HEAD): every `sdk.blender blender.{edit,inspect-blend,inspect-import,preview,validate}` × 6 branches (30)
- **Native observer methods**:
  - `sdk/src/__tests__/external-execution-branch-controls.test.ts`: `sdk.supervision supervised.source.initial happy` and `supervised.source.retry` × 7 (8). `observerMethods` gains `commitNativeTargetEntry`, `nativePrepared`, `nativeTargetEntered` and `nativeTransportObserved` from the B21 native observer work. This matches the N06 receipt.

The decision for B21: either update these tests to the new refusal wording, bootstrap profile and observer list, or relax the code.

### (c) Already failing before wave 1: not fixed

- `packages/code-map/src/__tests__/structure.test.ts`: "extracts GDScript functions, classes, and variables (Godot 4.x)" and "extracts GDScript enums and inner class definitions" (2). They fail identically at HEAD: `parseFileStructure` returns no GDScript symbols.
- `.agents` typecheck (35 errors). The cause is the untracked audit probe scripts under `.agents/sessions/product-audit-2026-11-12/verification/probes/`, which predate wave 1:
  - `trust/p1.ts`, `p3.ts`, `p4.ts`: script files without import/export, so they redeclare globals and use top-level await.
  - `runtime/p4-trim.ts`: `editAnchor`.
  - `runtime/p7-cache.ts`: overload mismatch.
  - The probes also import `cli/src/**`. The `.agents` tsconfig has no `@openbuff/sdk` path, so those cli files resolve to the stale `sdk/dist` and report `clearDegradedProviderRoutes` / `instructionFiles` / `InputCursor` errors.
  - `.agents` typecheck passes at HEAD, where the probes do not exist. This failure makes root `bun run typecheck` fail.
  - Options: exclude `sessions/**` in `.agents/tsconfig.json`, or move the probes out of the `.agents` package. Not done, because it is not a wave-1 change.

## Generated files

- `bun run generate-tool-definitions` (root script, `scripts/generate-tool-definitions.ts`) rewrites only these files and prettier-formats them: `common/src/templates/initial-agents-dir/types/tools.ts`, `agents/types/tools.ts` and `.agents/types/tools.ts`. It then runs `cli/scripts/generate-init-type-sources.ts`, which rewrites only `cli/src/data/initial-agent-type-sources.generated.ts`. I backed up all four files and ran it. Nothing changed: the three `tools.ts` copies are byte-identical (md5 `dcaf0e68…`), and the generated init sources match their sources.
- `cli/src/agents/bundled-agents.generated.ts`: stale, regenerated (see (a) item 3).

## Files changed by this integration pass

- `sdk/src/__tests__/initial-session-state.test.ts`: one assertion updated for N08.
- `sdk/src/__tests__/run-startup-context.test.ts`: `trustProjectConfig: true` on the deferred-initialization client, for N02.
- `cli/src/agents/bundled-agents.generated.ts` (gitignored): regenerated.

No other files were changed. No state-changing git command was run in this tree apart from the disposable worktree add/remove/prune.

## Not run

- Tests for `scripts`, `packages/indexer` and `.agents` (not requested). Their typechecks were run.
- The Rust workspace.
