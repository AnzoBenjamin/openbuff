# Audit findings: w1-agents-prompts

- Subsystems: agents, packages
- Features: base2-orchestrator, base2-gate-handleSteps, agent-prompts, prompt-assembly, dependency-manager, test-writer, code-reviewer, editor, specialists, plan-P9-T1, plan-P9-T4, plan-P2-T8
- Files covered: 17
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — agents/base2/base2.ts — [POLY] Gate reviewable-file predicate silently excludes Ruby/PHP/Swift/C/C++/Elixir/Scala/Dart/Lua sources, so the final code-reviewer is skipped for those repos
- **Risk:** isReviewableGateFile (generated gate-paths region) only admits /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb)$/. An edit to app/models/user.rb, src/Foo.php, Sources/App.swift, src/main.c, lib/app.ex, *.scala or *.dart yields reviewableGateScopeFiles=[] and hits the 'reviewer skip: no reviewable source files' branch that sets reviewerFinalizationVerdict='LOOKS_GOOD'. The gate reports PASSED with no review. isNonTestSourceFile / isPublicApiSourceFile use the same list, so test-writer/doc-writer aux gates never fire either. The list is also inconsistent with reliabilityCodeExtension in the same handleSteps (which does include rb|php|swift|c|cc|cpp|h|hpp) and with the dependency-manager manager enum (bundler, composer, swift, mix, dart).
- **Fix:** Replace the hardcoded extension regexes with one canonical source-extension table owned by common/util/language-profiles (the same data that drives LANGUAGE_PROFILE), generated into the gate-helpers region. Use it in isReviewableGateFile, isNonTestSourceFile, isPublicApiSourceFile, repairEditorReadablePaths, and reliabilityCodeExtension. Add parity tests with one fixture per supported language asserting that the reviewer runs.
- **Evidence:** base2.ts, generated region: `return /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb)$/.test(filePath)` in isReviewableGateFile. Skip branch: `reviewableGateScopeFiles.length === 0 ? 'reviewer skip: no reviewable source files'`. By contrast, `reliabilityCodeExtension = /\.(?:ts|tsx|...|rb|php|cs|swift|c|cc|cpp|h|hpp)$/` appears near the top of handleSteps.

## [HIGH] correctness — agents/base2/base2.ts — [POLY] Test-file detection is JS-only, so Python/Go/Java/Rust/Ruby tests are classed as production source and coverage routing breaks
- **Risk:** isCoverageEvidenceFile and isNonTestSourceFile recognize only __tests__/ and .test./.spec. with TS/JS extensions. The patterns test_foo.py, foo_test.py, foo_test.go, FooTest.java, src/test/java/..., spec/foo_spec.rb and tests/*.rs are all missed. (1) The test-writer aux gate targets changed test files as if they were source. (2) selectAuxRelevantFiles counts test-writer outputs as aux-relevant, which can re-trigger detectPendingGateFileSetChange. That is the infinite re-spawn loop the comment says it prevents, and it is still open for non-JS tests. (3) The hard-blocker text 'add a case to the relevant *.test.ts' and isTestCoverageReviewerFinding (which requires `.test.`) fail to route Python/Go coverage gaps to test-writer; they go to repair-editor, which returns an empty receipt and parks the gate in blocked.
- **Fix:** Take test-file conventions from the language profile. Minimum set: pytest test_*.py/*_test.py/tests/, Go *_test.go, JVM src/test/**, *Test.java/*Tests.kt, Ruby spec/**/*_spec.rb and test/**/*_test.rb, Rust tests/**, .NET *.Tests/**, PHP tests/**Test.php, Elixir test/**/*_test.exs. Generate them into the gate helpers. Make the hard-blocker string language-neutral ('add a covering test case') and key isTestCoverageReviewerFinding on the structured coverage field instead of substring matching. Keep the collectReviewerBlockers/collectReviewerHardBlockers byte parity.
- **Evidence:** isCoverageEvidenceFile: `/\.(test|spec)\.(?:tsx?|jsx?|mjs|cjs)$/`. isNonTestSourceFile: `if (/\.(test|spec)\.tsx?$/.test(filePath)) return false`. Hard blocker: `'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)'`. isTestCoverageReviewerFinding: `/\.test\.[a-z0-9]+/`.

## [HIGH] correctness — agents/base2/base2.ts — [POLY] Validation/test command inference is hardcoded to this repo's bun monorepo and one guessed tool per language; it ignores the detected language profile
- **Risk:** inferPackageTestCommand returns `cd packages/X && bun run typecheck && bun test` for any user repo that has a packages/*/src layout (pnpm/npm/yarn/turbo/nx monorepos included), `bun test` for every JS/TS file (jest/vitest/mocha repos), `./gradlew test` for Maven projects and projects without a wrapper, bare `pytest` for uv/poetry/tox repos (should be `uv run pytest`/`poetry run pytest`), and `go test ./...` from the wrong cwd for nested modules. The test-writer gate runs this command through basher and treats its failure as reduced assurance. The editor's inferValidationCommands duplicates the same table verbatim into requestedValidation. LANGUAGE_PROFILE is injected only as prompt prose (strings.ts), so no handleSteps can consume it; selectProjectAwareTestWriterTargets uses get_build_targets only when that tool returns a test-looking command.
- **Fix:** Delete both inline tables. Resolve commands from get_build_targets/inspect_environment, which already exist and are yielded in the aux path. Also expose a structured languageProfile (commands per ecosystem: test/typecheck/lint/build, runner prefix such as uv run/poetry run/bundle exec/./mvnw) on params/agentState so gate code and editor receipts read data, not regexes. Keep the repo-specific `cd packages/X && bun ...` rules only behind an explicit openbuff-repo profile, never as a default.
- **Evidence:** base2.ts inferPackageTestCommand: `const pkgMatch = filePath.match(/^packages\/([^/]+)\/(?:src|__tests__)\//) ... return `cd packages/${pkgMatch[1]} && bun run typecheck && bun test``; `if (/\.(java|kt|kts)$/.test(filePath)) return './gradlew test'`; `if (/\.(tsx?|jsx?|mjs|cjs)$/.test(filePath)) return 'bun test'`. editor.ts inferValidationCommands repeats the same mapping. strings.ts LANGUAGE_PROFILE is formatLanguageProfilePromptForFileTree(...) text only.

## [MEDIUM] correctness — agents/test-writer/test-writer.ts:74 — [POLY] test-writer write scope and prompt example cannot express Go/Rust/Python-at-root/Ruby test conventions
- **Risk:** The filesystemScope.write globs and testWriterScopePatterns (base2) allow only *.test.*, *.spec.*, __tests__/, test/ and tests/. Several conventions fall outside them: Go `foo_test.go` next to source, Python `test_foo.py`/`foo_test.py` outside a tests/ dir, Ruby `spec/**/*_spec.rb` (spec/ is not listed), Rust inline `#[cfg(test)] mod tests` (requires editing the source file), and JVM tests under src/test are only covered accidentally by **/test/**. test-writer then fails or writes into a nonstandard location. The single worked example is `import { describe, expect, test } from 'bun:test'`, which biases weaker models toward bun even in other ecosystems.
- **Fix:** Derive write globs from the language profile's test conventions (include **/*_test.go, **/test_*.py, **/*_test.py, spec/**, **/*_spec.rb, src/test/**). For Rust, allow scoped edits of the `mod tests` block or document that inline tests route to repair-editor. Replace the bun example with a neutral one, or inject an example selected by profile.
- **Evidence:** test-writer.ts filesystemScope.write: ['**/*.test.*','**/*.spec.*','**/__tests__/**','**/test/**','**/tests/**']; instructionsPrompt example content: "import { describe, expect, test } from 'bun:test'". inputSchema prompt description examples: "bun test", "npm test", "pytest".

## [MEDIUM] dependency-hygiene — agents/dependency-manager/dependency-manager.ts — [POLY] dependency-manager: broad manager enum, but manifest cross-check and several operations are incomplete for non-JS ecosystems
- **Risk:** Coverage is good: 18 managers including cargo/uv/poetry/go/gradle/maven/composer/bundler/dotnet/swift/mix. The gaps are these. (1) manifestManager detects only Cargo.toml/go.mod/pom.xml/build.gradle/Package.swift. pyproject.toml/uv.lock/poetry.lock, Gemfile, composer.json, mix.exs, pubspec.yaml and *.csproj are never checked, so a wrong uv-vs-poetry-vs-pip choice passes the conflict guard. (2) maven/gradle support only sync/restore, and `./gradlew dependencies` is a report, not a sync; mix and swift have no add; go has no remove (`go get pkg@none`); pip add/remove bypasses the lockfile and requirements.txt. (3) The timeout default is -1 (unbounded), while basher defaults to 300s. (4) The gradle wrapper is assumed without checking for gradlew.
- **Fix:** Extend manifestManager to the full manager→manifest/lockfile map (uv.lock→uv, poetry.lock→poetry, Gemfile→bundler, composer.json→composer, mix.exs→mix, pubspec.yaml→dart/flutter, *.csproj/*.sln→dotnet). Add `go get pkg@none` for remove, `mix deps.get` after an edited mix.exs, and gradle `--refresh-dependencies`/`build --dry-run` for sync with a wrapper check. Default timeout_seconds to a finite bound such as 600.
- **Evidence:** `const manifestManager = manifests.includes('Cargo.toml') ? 'cargo' : manifests.includes('go.mod') ? 'go' : manifests.includes('pom.xml') ? 'maven' : ... 'Package.swift' ? 'swift' : undefined`; `maven: ['sync','restore'], gradle: ['sync','restore'], mix: ['sync','restore','update'], go: ['add','sync','restore','update']`; `commands.push('./gradlew dependencies')`; timeoutSeconds `: -1`.

## [MEDIUM] correctness — agents/base2/base2.ts — [POLY] Specialist router dependency-manifest regex misses common non-JS manifests
- **Risk:** selectSpecialistReviewersInline routes dependency-reviewer only for the listed manifests. requirements*.txt, Pipfile(.lock), setup.cfg/setup.py, *.csproj/Directory.Packages.props/packages.lock.json, mix.exs/mix.lock, pubspec.yaml/lock, Package.resolved, gradle.lockfile/libs.versions.toml, go.work and build.sbt are all missed. Supply-chain changes in those ecosystems skip dependency review.
- **Fix:** Source the manifest/lockfile list from the same canonical ecosystem table used by inspect_environment and dependency-manager, keeping the common/src/agents/specialist-risk-router.ts parity test.
- **Evidence:** base2.ts selectSpecialistReviewersInline: `/(?:^|\/)(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|uv\.lock|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|package\.swift)$/`.

## [LOW] test-coverage — agents/reviewer/code-reviewer.ts — [POLY] Reviewer rubric is language-neutral but lacks ecosystem-specific pitfall checklists and keeps JS-isms
- **Risk:** The rubric defers to 'the active language profile' but names no language-specific hazards (Go unchecked err/goroutine leaks, Rust unwrap/unsafe, Python mutable defaults/asyncio blocking, Java resource try-with-resources, C/C++ UB/buffer bounds, SQL injection per driver). The security checklist cites console.log/error, and examples use *.test.ts. With weaker models, the result is TS-flavored reviews of other languages.
- **Fix:** Have LANGUAGE_PROFILE inject a compact per-language review pitfall list (≤10 lines per profile, max 3 profiles already enforced), and swap console.log for 'logging calls'.
- **Evidence:** code-reviewer.ts guidelines: "Flag any console.log/error string that could receive a secret."; "add a case to X.test.ts"; generic "Apply the active language profile when checking ownership/resource lifetime...".

## [LOW] correctness — agents/librarian/librarian.ts:90 — [POLY] librarian prompt examples hardcode '*.ts' find/grep patterns
- **Risk:** The examples steer exploration of non-TS repos toward TypeScript-only globs.
- **Fix:** Use a placeholder extension from LANGUAGE_PROFILE, or neutral examples ('*.<ext>').
- **Evidence:** librarian.ts:90-91: `find <dir> -name '*.ts' -type f`, `grep -rn 'pattern' <dir> --include='*.ts'`.

## [HIGH] state-mutation — .agents/sessions/polyglot-roadmap-v2/PLAN.md:189 — [LANG] P9-T4 plan to checkpoint generator state via QuickJS JS_WriteObject is not feasible; base2 handleSteps also needs host fs/crypto that an isolate lacks
- **Risk:** QuickJS JS_WriteObject/JS_ReadObject serializes values and function bytecode but not live generator frames, closures over the stack, or host objects. A suspended generator (base2's `while(true){ yield 'STEP' }` holding ~40 locals such as pendingGateFiles/gateMarkerCache/seen*Fingerprints) cannot be written to the P2-T2 journal and resumed. The planned replacement for AgentRunContextRegistry would therefore fail at the core requirement. Separately, base2's handleSteps calls process.getBuiltinModule('node:fs'/'node:crypto'/'node:path') directly (readGateFileContentMarker, hashGateSnapshotDetails). Inside a QuickJS VM these return 'unreadable:no-module-loader'/'unreadable:no-crypto', and every fingerprint becomes non-attestable, so the whole gate fails closed. The plan does not specify a host-capability bridge.
- **Fix:** Split the concerns. (a) Run first-party agents (base2, editor) as trusted host TS modules: import them, drop the .toString()/new Function path, and delete the gate-helper codegen. That delivers D11 with no isolate at all. (b) For untrusted/user string handleSteps, use QuickJS with an explicit capability API (hashFile, readMarker, gitStatus as yieldable host tools), CPU interrupt and memory limit. (c) Make durability come from an explicit state-machine/reducer over the persisted base2ActiveWork plus event-sourced replay of yielded tool results, not from heap snapshots. Alternatives evaluated: SES/Compartments have no CPU/memory limits; ShadowRealm is not shipping in Bun; isolated-vm is not Bun-compatible; wasmtime+StarlingMonkey gives stronger limits and component-model capabilities but likewise cannot snapshot a mid-generator frame portably. QuickJS stays the right isolate for (b); the checkpoint design is what needs changing.
- **Evidence:** PLAN.md:189: "generator state is checkpointed via JS bytecode/heap serialization (JS_WriteObject) into the P2-T2 run journal". base2.ts readGateFileContentMarkerUncached: `fs = getBuiltinModule('node:fs') ... else return 'unreadable:no-module-loader'`; hashGateSnapshotDetails returns 'unreadable:no-crypto' without node:crypto.

## [MEDIUM] error-handling — .agents/sessions/polyglot-roadmap-v2/PLAN.md:94 — [LANG] P2-T8 Bun Workers for subagent supervision give weak fault isolation; prefer process supervision for terminal/tool-bearing children
- **Risk:** Bun Workers share the process heap limits, native addon state, file descriptors and cwd. An OOM, native crash, or process.chdir/env mutation in one worker takes down or corrupts the orchestrator and every sibling. Worker.terminate() cannot interrupt blocking native calls. That is weaker than the 'hard kill and restart policies' the plan promises, and the subagents here run long terminal commands and filesystem mutation.
- **Fix:** Use Bun.spawn child processes with IPC (structured-clone or NDJSON receipts), per-child rlimits/timeouts, and kill-tree on cancel for untrusted or terminal-bearing agents. Reserve Workers for cheap pure-compute children (reviewer prompt assembly). The receipt-only message-passing contract works unchanged over either transport, so define it transport-agnostic first.
- **Evidence:** PLAN.md:94: "Supervision uses Bun Workers with hard kill and restart policies." basher/dependency-manager/debugger all use run_terminal_command.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:185 — [LANG] P9-T1 declarative agent.yaml is appropriate for config-shaped agents (confirmation) but should be JSON-Schema-first
- **Risk:** This finding confirms the approach. create-specialist.ts is already pure config (SpecialistConfig → definition), so P9-T1a is well-targeted. The one risk: YAML's implicit typing (on/off/yes, octal-like strings) inside prompt prose and enums.
- **Fix:** Generate a JSON Schema from the existing zod dynamic-agent-template schema, accept YAML only as a surface syntax validated against it (YAML 1.2 core schema), and keep programmatic agents (base2/editor) in TS.
- **Evidence:** create-specialist.ts builds the entire definition from {id, displayName, purpose, focus, terminal, advisory, intelligence}; PLAN.md:186 P9-T1a.

## [HIGH] performance — agents/base2/base2.ts — [BEST] base2.ts is a 12.7k-line single definition whose handleSteps is an untestable monolith duplicated by codegen
- **Risk:** The whole gate (aux gates, security/specialist/code-reviewer loops, repair, receipts, plan receipts) lives in one generator, because the serialization constraint forbids imports. The same repair-editor handoff object is copy-pasted at least four times (security, specialist, validation, reviewer), as are the security/specialist credit blocks. Tests reach helpers only via source slicing (extract-inline-function-source). Every change carries high regression risk, and review cost is proportional to the file.
- **Fix:** Once handleSteps runs as trusted host code (see the P9-T4 finding), extract it into modules: gate/state.ts (pure reducer), gate/aux/*.ts, gate/reviewer-loop.ts, gate/handoffs.ts (single buildRepairHandoff(family, findings)), with unit tests on pure functions. Until then, move duplicated handoff builders into the generated-helpers region.
- **Evidence:** editAnchor endLine 12729; repeated `agent_type: 'repair-editor', handoff: { schemaVersion: 1, ... permissions: { readablePaths: repairEditorReadablePaths(...` blocks in the security, specialist, validation and reviewer branches; the `<gate-helpers-generated>` region inlined from gate-*.ts.

## [MEDIUM] state-mutation — agents/base2/base2.ts — [BEST] handleSteps uses Date.now()/Math.random() for task IDs and bypass challenge IDs, breaking deterministic replay
- **Risk:** taskId `test-writer-${Date.now()}-${Math.random()...}`, repairSessionId, and reviewerBypassChallenge.id are nondeterministic, which conflicts with P2-T1/P2-T2 replay and journaling goals. Replaying a turn yields different IDs, and the bypass challenge text the user must type changes on re-execution.
- **Fix:** Derive IDs from a runtime-injected clock/idGenerator in params (like Clock in P2-T1), or hash (runId, stepIndex, family). Keep the bypass challenge random only from a seeded, persisted source.
- **Evidence:** `taskId: `test-writer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}``; `activeWorkState.repairSessionId = `repair-${Date.now()}-...``; ensureReviewerBypassChallenge `id: `${Date.now().toString(36)}-${Math.random()...}``.

## [MEDIUM] performance — agents/base2/base2.ts — [BEST] base2 system prompt restates tool-choice/read-policy and editing mandates several times, inflating every step's context
- **Risk:** The tiered read-policy/edit_transaction guidance appears in full in '# Core Mandates' ('Prefer dedicated harness tools...'), again in '# Spawning agents guidelines' ('Tool choice:'), again in buildImplementationStepPrompt and in EXPLORE_PROMPT. The '# Code Editing Mandates' block deliberately duplicates qualitySection even with progressive disclosure on. Validation-selection bullets also hardcode this repo's paths (agents/base2/*, packages/sdk/*, cli/src/components/*) into the prompt shipped to every user repo, which wastes tokens and misleads models on other codebases.
- **Fix:** Deduplicate into one read/edit policy block. Move the repo-specific 'Validation selection' path→suite map into a project knowledge file or ROUTER.md entry, loaded only for this repo, and replace it with profile-driven generic guidance. Add a token-budget test on the resolved system prompt.
- **Evidence:** systemPrompt: "Tiered read policy: small files (≤~400 lines) use read_files paths..." and later "- **Tool choice:** ... tiered policy: small files (≤~400 lines)..."; "Map changed paths to suites deterministically when possible: agents/base2/* -> agents typecheck ... cli/src/components/* or cli/src/hooks/* -> CLI typecheck plus CLI visual smoke".

## [MEDIUM] api-contract — agents/editor/editor.ts:30 — [BEST] Editor and code-reviewer hardcode provider model IDs, contradicting the BYOK no-hardcoded-model routing contract
- **Risk:** base2 documents that all agents are BYOK-routed via openbuff.json 'with no hardcoded fallback', yet editor sets `model: EDITOR_MODELS[model]` (anthropic/claude-opus-4.7). code-reviewer's createReviewer(model) accepts a model argument and silently ignores it, while its definition passes 'anthropic/claude-opus-4.7'. Users on local/other providers either get an unexpected provider call or have to override per agent. The ignored parameter is a dead contract.
- **Fix:** Omit `model` from shipped definitions, as base2 does when modelOverride is undefined, and let resolveConfiguredAgentModelConfig route them. Either use or remove createReviewer's model parameter.
- **Evidence:** editor.ts:30-37 EDITOR_MODELS map and `model: EDITOR_MODELS[model]`; code-reviewer.ts `export const createReviewer = (model: Model)` body never references `model`; base2.ts comment "All agents including the orchestrator (base2) are BYOK-routed via openbuff.json ... with no hardcoded fallback".

## [LOW] correctness — agents/file-explorer/file-picker.ts — [BEST] file-picker emits the basename as 'summary' and duplicates extractErrorMessage
- **Risk:** The spawner contract promises 'short summaries for each file', but set_output writes `summary: path.split('/').pop()`, so parents receive no relevance rationale. extractErrorMessage is defined twice (module scope and inside handleSteps), an existing drift hazard.
- **Fix:** Either carry through the lister's per-line rationale when present, or rename the field/contract to reflect path-only output. Keep a single inline extractErrorMessage and test it through handleSteps.
- **Evidence:** file-picker.ts: `summary: path.split('/').pop() || path`; `function extractErrorMessage(agentOutput: any)` at module scope and `const extractErrorMessage = (agentOutput: any)` inside handleSteps.

## [LOW] performance — packages/agent-runtime/src/templates/strings.ts — [BEST] LANGUAGE_PROFILE is prose-only and not injected into basher/debugger/dependency-manager/test-writer command selection
- **Risk:** formatLanguageProfilePromptForFileTree output reaches only prompts that embed the placeholder (base2, editor, code-reviewer, test-writer). Programmatic agents that choose commands (basher, debugger, dependency-manager, base2 gate) cannot read it, which is the root cause of the hardcoded tables above.
- **Fix:** Compute the profile once per run in the runtime and pass a structured object (ecosystems, commands, test conventions) on agentState/params, with the placeholder rendering the same object.
- **Evidence:** strings.ts: `[PLACEHOLDER.LANGUAGE_PROFILE]: () => formatLanguageProfilePromptForFileTree(fileContext.fileTree, {...}) + formatEngineProfilePromptForFileTree(...)` returns string only.

## Coverage receipt

### Subsystems
- agents
- packages

### Features
- base2-orchestrator
- base2-gate-handleSteps
- agent-prompts
- prompt-assembly
- dependency-manager
- test-writer
- code-reviewer
- editor
- specialists
- plan-P9-T1
- plan-P9-T4
- plan-P2-T8

### Files
- agents/base2/base2.ts
- agents/base2/quality-prompt-section.ts
- agents/base2/tool-tiers.ts
- agents/editor/editor.ts
- agents/reviewer/code-reviewer.ts
- agents/file-explorer/file-picker.ts
- agents/test-writer/test-writer.ts
- agents/debugger/debugger.ts
- agents/basher.ts
- agents/guides/code-craftsmanship.md
- agents/guides/pre-review-self-check.md
- agents/specialists/create-specialist.ts
- packages/agent-runtime/src/templates/strings.ts
- packages/agent-runtime/src/system-prompt/prompts.ts
- agents/dependency-manager/dependency-manager.ts
- agents/librarian/librarian.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
