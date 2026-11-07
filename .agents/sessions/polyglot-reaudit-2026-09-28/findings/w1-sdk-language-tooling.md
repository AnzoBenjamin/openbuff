# Audit findings: w1-sdk-language-tooling

- Subsystems: sdk
- Features: language-diagnostics, affected-tests, build-targets, environment-inspection, validation-hooks, targeted-validation, code-search, audit-intelligence, 3d-assets
- Files covered: 16
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — sdk/src/tools/run-targeted-validation.ts:103 — [POLY] Targeted validation reports assurance 'full' when changed files in some languages had no hook at all
- **Risk:** In a mixed repo (e.g. root package.json plus a Go/Elixir/Terraform subdir), changing a.ts and svc/main.go runs only the TS hooks. They pass, so status='passed' and assurance='full', even though the .go change was never validated. The agent and the parent then treat unvalidated polyglot edits as fully verified.
- **Fix:** Work out coverage per changed file. For each file, record which matching hook(s) ran (selectMatchingHooks per file). Return uncoveredFiles, and downgrade assurance to 'reduced' when any changed file has no matching hook. Add a test with a two-language change where only one language has hooks.
- **Evidence:** `skipped` is true only when results are empty or EVERY result is no_hooks_configured/hooks_skipped (:103-111). file-change-hooks.ts selectMatchingHooks keeps a hook if ANY file matches, and returns hooks_skipped only when zero hooks match. So one matching hook hides every uncovered file. assurance = skipped ? 'reduced' : 'full' (:127).

## [MEDIUM] correctness — sdk/src/tools/file-change-hooks.ts:72 — [POLY] Hook inference only probes root-level manifests, so monorepos and many ecosystems get no validation
- **Risk:** KNOWN_PROJECT_PATHS is a fixed list of root-relative files. packages/*/Cargo.toml, services/api/go.mod, apps/web/package.json, and nested pyproject.toml are never seen. No hooks exist for Elixir/mix, Dart/Flutter (pubspec.yaml), Zig (build.zig), Haskell (cabal/stack), Scala/sbt, Terraform, Bash (shellcheck), Lua, Dockerfile (hadolint), or go.work/Cargo workspaces. Validation for those repos is skipped, or misreported per the HIGH finding.
- **Fix:** Reuse discoverWorkspaces() from harness-intelligence, which already walks the tree. Emit hooks per workspace root, with cwd=workspace.root and filePattern scoped to `${root}/**`. Derive the per-ecosystem hook table from LANGUAGE_CAPABILITY_REGISTRY toolSpecs (validation stages), and add the missing ecosystems: mix compile --warnings-as-errors/mix test, dart analyze, zig build test, cabal build, sbt compile, terraform validate/tflint, shellcheck, hadolint.
- **Evidence:** KNOWN_PROJECT_PATHS (:72-110) contains only root paths. collectManifestSnapshot (:521) stats path.join(cwd, relativePath) for each entry. Only findDotnetTarget recurses.

## [MEDIUM] correctness — sdk/src/tools/file-change-hooks.ts:320 — [POLY] Python hooks ignore uv/poetry/pipenv environments and call bare ruff/pyright/mypy
- **Risk:** In uv or poetry projects the tools live in .venv or the poetry env, not on PATH. `ruff check .` or `pyright` then exits 127, and the result is reported as a validation failure. The inferred hooks also never request machine formats, so ruff/pyright structured parsers never run for inferred hooks.
- **Fix:** Choose the runner from the lockfile, the same way inferWorkspace does: `uv run --frozen ruff check --output-format=json .`, `poetry run pyright --outputjson`, `pipenv run ...`. Keep the bare command only when no manager lockfile is present.
- **Evidence:** inferPythonHooks: 'ruff check .' (:320), 'pyright' (:328), 'mypy .' (:330), 'python -m pytest'. harness-intelligence already detects uv.lock/poetry.lock/Pipfile.lock, but hooks don't use it.

## [MEDIUM] correctness — sdk/src/tools/file-change-hooks.ts:791 — [BEST] Structured diagnostics are parsed from already middle-truncated output, so large JSON/SARIF payloads silently fall back to regex parsing
- **Risk:** runTerminalCommand caps stdout at STREAM_ACCUMULATION_CAP (head+tail) and COMMAND_OUTPUT_LIMIT with remove:'MIDDLE' before returning. Large eslint -f json, pyright --outputjson, or SARIF documents become invalid JSON, parseJsonOutput returns undefined, and every structured diagnostic and fix-it is lost. That happens exactly for runs with many diagnostics. The plain-text pass can then produce garbage from JSON fragments, because the isJsonDocument guard fails on the truncated body.
- **Fix:** Parse diagnostics from the stream inside the runner, or have the runner write the full output to a bounded temp file/artifact (D20 out-of-band store) before truncating. Alternatively use NDJSON-capable output modes and parse incrementally. Emit a diagnosticsTruncated flag when output was cut.
- **Evidence:** file-change-hooks.ts:791 calls parseLanguageDiagnostics on value.stdout from runTerminalCommand. run-terminal-command.ts:640-688 applies appendCapped head+tail and truncateStringWithMessage({remove:'MIDDLE'}) before resolving.

## [MEDIUM] correctness — sdk/src/tools/file-change-hooks.ts:761 — [BEST] All matching hooks run concurrently, so same-project build tools collide (dotnet build||test, cargo clippy||test, swift build||test)
- **Risk:** `dotnet build X` and `dotnet test X` run in parallel on the same obj/bin. This commonly fails with file-in-use/MSB3027 errors, producing false failures. cargo and SwiftPM serialize on the build-dir lock, which roughly doubles wall time within a 300s budget per hook. Gradle and Maven wrappers also contend for daemon and cache locks.
- **Fix:** Group hooks by ecosystem or toolchain and run each group sequentially: format, then lint, then build, then test, stopping after a failure. Run different groups in parallel. Or have `dotnet test` imply the build and drop the separate build hook.
- **Evidence:** Promise.allSettled(matching.map(...)) at :761 with no grouping. The dotnet build and dotnet test hooks (:167-178) target the same file; cargo clippy and cargo test (:191-199) do the same.

## [MEDIUM] performance — sdk/src/tools/file-change-hooks.ts:158 — [LANG] 'Targeted' hooks always run whole-repo commands (go test ./..., cargo test --workspace, gradle check)
- **Risk:** Every edit re-runs the full test suite for Go, Rust, and JVM projects, regardless of which package owns the changed file. In large repos this exceeds the 300s bound and turns into timeout failures. It also contradicts P3-T7/P3-T8, whose outputs (owning package or target) are never consumed here.
- **Fix:** Take the owning package from getBuildTargets/P3-T8: `go test ./<pkgdir>/...`, `cargo test -p <crate>` (from cargo metadata), `gradle :<project>:check`, `dotnet test <owning csproj>`, `pytest <affected test files>`. Fall back to whole-repo runs only for project-stage validation.
- **Evidence:** go test ./... (:158); cargo test --workspace --all-targets (:196); gradle check (:380); get_affected_tests/get_build_targets results are not referenced in runFileChangeHooks.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:366 — [POLY] get_affected_tests only knows JS-style *.test.ext / __tests__ conventions and has no confidence label
- **Risk:** The tool finds nothing for Go (foo_test.go), Python (test_foo.py, tests/test_foo.py), Rust (tests/*.rs, inline #[cfg(test)]), Java/Kotlin (src/test/java/.../FooTest.java), C# (*.Tests projects), Ruby (spec/foo_spec.rb), PHP (tests/FooTest.php), Elixir (test/foo_test.exs), Swift (Tests/<Target>Tests), or Dart (test/foo_test.dart). The agent reads an empty candidate list as 'no affected tests'. P3-T7 requires a confidence label on each result; the output has none.
- **Fix:** Add per-language convention tables keyed by the registry language id (mirror paths: src/main→src/test, lib/→test/, app/→spec/). Label each candidate confidence:'heuristic', and label an empty result 'unknown' instead of implying there is nothing to test. Tier 0 should call runner-native related-test queries (see the LANG TIA finding).
- **Evidence:** candidates are `${stem}.test${ext}`, `${stem}.spec${ext}`, `${dir}/__tests__/...` only (:366-371). The AffectedTestTarget type has no confidence field.

## [MEDIUM] correctness — sdk/src/services/harness-intelligence.ts:28 — [POLY] Workspace discovery misses manifests for registered languages (Ruby, PHP, C++, GDScript), so build targets come back empty
- **Risk:** Gemfile, composer.json, CMakeLists.txt/meson.build, and project.godot are not in manifestNames, even though ruby, php, cpp, and gdscript are SUPPORTED_LANGUAGE_IDS. Unregistered ecosystems (mix.exs, pubspec.yaml, build.zig, *.cabal/stack.yaml, build.sbt, go.work, Cargo workspace members, *.tf, settings.gradle, nx.json/turbo.json/pnpm-workspace.yaml) are also missing. inspect_environment reports no workspace for them, and get_build_targets returns [] or falls back to the root JS workspace, which gives wrong commands. Cargo.lock is looked up only in the member dir (`at()`), not the closest ancestor, so workspace members show no lockfile.
- **Fix:** Derive manifestNames and manifestExtensions from LANGUAGE_CAPABILITY_REGISTRY, add the unregistered ecosystems as 'inferred', and give each a build/test command mapping. Use closest() for Cargo.lock and go.sum. Detect JS monorepo tools (pnpm-workspace, nx, turbo) so affected commands can use `nx affected` / `turbo run --filter`.
- **Evidence:** manifestNames (:28-40) lists package.json, pyproject, Cargo, go.mod, pom, gradle, Package.swift, requirements, and setup.* only. getBuildTargets (:395-469) has no branch for ruby/php/cpp/godot. Cargo lockfile = allFiles.has(at('Cargo.lock')).

## [MEDIUM] performance — sdk/src/services/harness-intelligence.ts:315 — [BEST] inspect_environment runs 14 uncached, sequential spawnSync probes (up to 42s blocked) with a TS/JS-skewed tool list
- **Risk:** toolVersion uses spawnSync with a 3s timeout for each tool. That blocks the event loop and is not covered by the 5s discovery cache, which the code comment says is hit every aux-gate iteration. The probe list includes k6 and blender but not java/javac, kotlinc, ruby/bundle, php/composer, swift, clang/gcc/cmake, elixir/mix, dart/flutter, zig, ghc/cabal/stack, sbt, terraform, or shellcheck. It probes 'python3' only, which is absent on Windows (py/python).
- **Fix:** Probe asynchronously in parallel with Promise.all, and cache per PATH hash with a long TTL. Derive the probe list from registry toolSpecs[].detect, filtered to ecosystems actually discovered in the repo, plus a small core set.
- **Evidence:** tools: {...14 toolVersion calls} at :315-330. toolVersion uses spawnSync with timeout 3_000 (:224-240). discoveryCache only wraps discoverWorkspaces.

## [MEDIUM] performance — sdk/src/services/harness-intelligence.ts:73 — [BEST] discoverNamedFiles walks the whole tree synchronously with no depth or entry budget and a JS/Python-only ignore list
- **Risk:** In large polyglot monorepos the walk blocks the event loop on each cache miss (every 5s). It descends into vendor/, Pods/, .gradle/, .dart_tool/, _build/ and deps/ (Elixir), .stack-work/, dist-newstyle/, zig-cache/, .terraform/, and obj/. That wastes work and reports vendored manifests as workspaces. file-change-hooks already has a bounded scanner (MAX_PROJECT_SCAN_ENTRIES/DEPTH); this one does not.
- **Fix:** Use `git ls-files` (or ripgrep --files, which honors .gitignore) filtered by manifest names, with an entry/depth budget and an async API. Extend the ignore set, or better, rely on .gitignore.
- **Evidence:** visit() recurses on every non-ignored directory with no counter (:73-103). ignoredDiscoveryDirectories (:56-71) lacks vendor, Pods, .gradle, _build, .dart_tool, and similar.

## [MEDIUM] correctness — sdk/src/services/audit-intelligence.ts:135 — [BEST] Audit snapshotId hashes only the first 256KB of each file, so edits past that point leave the snapshot 'fresh'
- **Risk:** Coverage receipts are bound to snapshotId. A change beyond byte 256,000 of a large file (generated parsers, big fixtures, lockfiles, SQL dumps) does not change the ID, so stale audit receipts are still accepted as covering current code.
- **Fix:** Hash the full file with streaming reads, or mix in size and mtimeNs (or the git blob OID from `git ls-files -s`) for files above the cap. The git index gives cheap full-content identity for tracked files.
- **Evidence:** readCapped allocates min(size, maxFileBytes=256_000) (:124-133). hashInventory updates with readCapped(absolute) and never includes stat.size (:135-149).

## [MEDIUM] api-contract — sdk/src/services/audit-intelligence.ts:50 — [POLY] Audit inventory keeps parallel, incomplete language/manifest/test tables instead of deriving them from the capability registry
- **Risk:** sourceExtensions/extensionLanguages omit .mjs/.cjs/.mts, .kts, .h/.hpp/.cc/.cxx, .scala, .ex/.exs, .dart, .zig, .hs, .lua, .sh, .tf, .sql, .vue, and .svelte. For those repos, subsystems report sourceFiles=0 and capabilityPacket.languages is empty. The manifest regex omits Gemfile, composer.json, *.csproj/*.sln, and CMakeLists.txt. testPattern misses same-directory foo_test.go, test_foo.py, foo_spec.rb, and FooTest.java/FooTests.cs, so Go/Python/Ruby tests are counted as implementation. This contradicts the registry's own contract ('Consumers should derive lookup maps from this registry').
- **Fix:** Build the extension→language and manifest sets from LANGUAGE_CAPABILITY_REGISTRY, plus a secondary 'unregistered-but-recognized' table (for example linguist's languages.yml subset). Add per-language test-name conventions to the registry and derive testPattern from them.
- **Evidence:** sourceExtensions (:50-67), testPattern (:68-69), manifests regex (:169-173), extensionLanguages (:191-208). common/src/util/language-capabilities.ts:99-103 says to derive lookup maps from the registry.

## [MEDIUM] correctness — sdk/src/tools/language-diagnostics.ts:213 — [POLY] Plain-text parsers miss common compiler formats: column-less file:line (mypy, gcc -fno-show-column, pytest), go build, GHC multi-line, Elixir, Dart, Terraform, jest stack frames
- **Risk:** colonCompilerParser requires :line:col:, so mypy's default `f.py:12: error: msg [code]` is dropped. The go regex is gated to go test/vet, so `go build` errors are dropped. For GHC `X.hs:3:5: error: [GHC-88464]`, the message is captured as the bracket code and the real message on the following lines is lost. Elixir (`warning: ...` then `  lib/x.ex:12`), dart analyze (`error • msg • lib/a.dart:3:5 • code`), terraform validate (`Error: ...` + `on main.tf line 3`), and kotlinc/javac warnings (`w:` lines are ignored) all yield no diagnostics.
- **Fix:** Make column optional in colonCompilerParser. Add parsers or structured modes: mypy --output json, dart analyze --format=machine, credo --format json, rubocop --format json, phpstan --error-format=json, shellcheck -f json1, hadolint/tflint -f sarif, terraform validate -json, and go build -json (Go 1.24+). Add a two-line state machine for GHC and Elixir, and handle kotlinc `w:` as warning. Better: see the LANG problem-matcher finding.
- **Evidence:** colonCompilerParser regex /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note|info):/ (:213-240). commandSpecificParser go branch is gated on /go\s+(?:test|vet)|php\s+-l/. jvmParser handles only `e:`, [ERROR], and javac error lines (:346-383).

## [LOW] correctness — sdk/src/tools/language-diagnostics.ts:425 — [BEST] go test regex keeps leading indentation in file paths and treats every `x:N:` line as an error
- **Risk:** go test failure output is indented (`    foo_test.go:12: got 1 want 2`). The regex /^(.+?):(\d+)/ captures '    foo_test.go' including the spaces, so the path does not match workspace files. Any log line of the form 'key:123: ...' under go test also becomes an 'error'.
- **Fix:** Trim or strip leading whitespace, require a path-like token ending in .go, and prefer `go test -json` (the Action/Output events) for structured failures.
- **Evidence:** commandSpecificParser go branch: line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/) with severity 'error' (:425-490); no trim on match[1].

## [MEDIUM] correctness — sdk/src/tools/language-diagnostics.ts:1050 — [BEST] SARIF regions given as charOffset/byteOffset are turned into fake 1:1 ranges, including fix deletedRegions
- **Risk:** sarifRegionToRange defaults startLine and startColumn to 1 when the region uses charOffset/charLength, which SARIF permits and some Roslyn/semgrep/CodeQL outputs emit. A fix replacement then targets line 1 col 1 of the file. P4-T3 apply_compiler_fix would splice the text at the start of the file. The eslint parser deliberately avoids exactly this fabrication.
- **Fix:** When a region lacks startLine, either map charOffset against artifact contents if the SARIF embeds them, or drop the fix (and mark range null for the diagnostic). Never default a fix range to 1:1. Add a test.
- **Evidence:** sarifRegionToRange: `numberAt(region,'startLine') ?? 1`, `startColumn ?? 1`. It is used for fixes' deletedRegion in sarifParser (:1050+). The eslint parser comment explains why fabricated ranges are unsafe.

## [LOW] api-contract — sdk/src/tools/language-diagnostics.ts:709 — [LANG] ruff fix edits drop ruff's own applicability ('safe'/'unsafe'/'display-only'), which blocks P4-T3 auto-apply
- **Risk:** ruff JSON carries fix.applicability, but the parser omits applicability, so consumers must treat every ruff fix as 'unspecified'. apply_compiler_fix (P4-T3) then cannot auto-apply ruff's safe fixes, and cannot distinguish unsafe ones if a later consumer loosens the rule.
- **Fix:** Map fix.applicability safe→machineApplicable, unsafe→maybeIncorrect, display-only→unspecified. Do the same for clang SARIF, where no applicability exists (keep it unspecified), and for eslint (fix = safe, suggestions = maybeIncorrect).
- **Evidence:** ruffJsonParser reads fix.edits only (:709-731) and pushes edits without an applicability field. The contract comment on LanguageDiagnosticTextEdit.applicability says a missing value is treated as unspecified.

## [MEDIUM] api-contract — sdk/src/tools/language-diagnostics.ts:86 — [LANG] Hand-coded regex parsers do not scale to 'any language'; a data-driven problem-matcher registry is a better mechanism
- **Risk:** Each new ecosystem currently needs new TS code, and parsers are selected by command-string regexes that break under wrappers (`make check`, `just lint`, `npm run lint`, `./gradlew`). Unknown tool tokens default to severity 'error' (SARIF 'none'/'refactor'/'convention' become errors).
- **Fix:** Adopt VS Code's problemMatcher schema (a single- or multi-line 'loop' pattern with named groups file/line/column/severity/code/message) as data in LANGUAGE_CAPABILITY_REGISTRY toolSpecs. Reuse the existing ecosystem matchers ($tsc, $gcc, $msCompile, $go, $eslint-stylish, and the rust/python extension matchers). Keep JSON/SARIF structured parsers as tier 1, and make hooks request machine formats explicitly. Longer term, P3-T1 LSP pull diagnostics (textDocument/diagnostic) supersedes CLI scraping for languages with servers. Map unknown severities to 'warning' and SARIF 'none' to 'info'.
- **Evidence:** diagnosticParsers is a fixed TS array (:1195-1210). commandSpecificParser and godotParser gate on command regexes. severity() default branch returns 'error' (:86-95).

## [MEDIUM] api-contract — sdk/src/services/harness-intelligence.ts:395 — [LANG] P3-T7/P3-T8 plan: prefer runner-native TIA and BSP/init-script build queries over a persistent Gradle Tooling API helper
- **Risk:** The planned P3-T7 tiers skip the cheapest high-precision tier: runner-native related-test queries. P3-T8's 'Kotlin/Java Gradle Tooling API helper' adds a JVM sidecar where lighter options exist. getBuildTargets today returns fixed per-manager commands with no owning-target resolution.
- **Fix:** P3-T7 tier 0: `jest --findRelatedTests`, `vitest related`, `pytest --testmon` / pytest-picked, `go list -deps -test -json` reverse deps, `cargo metadata` + `cargo nextest list`, `bazel query rdeps()`, `nx affected -t test`, `turbo run test --filter=...[HEAD]`, `dotnet test --filter` from project references. P3-T8: a Gradle init script that prints project/sourceSet JSON (no daemon helper), BSP (Build Server Protocol: sbt, bloop, Gradle, Mill) as the JVM/Scala unifier, `swift package describe --type json`, `dotnet msbuild -getItem/-getProperty` (SDK 8+), CMake File API, `mix xref graph --format json`, `cabal-plan`/plan.json, `dart pub deps --json`. Keep TS orchestration.
- **Evidence:** PLAN.md P3-T7 (:105) and P3-T8 (:106, 'Kotlin/Java Gradle tooling helper'). getBuildTargets (:395-469) emits hard-coded commands, e.g. 'gradle test'/'mvn test', for every file in the workspace.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:99 — [LANG] P3-T1/P3-T3/P3-T11 mechanism check: TS multiplexer confirmed; use LSP 3.17 pull diagnostics; consider opengrep over semgrep
- **Risk:** P3-T1 in TS with vscode-jsonrpc is appropriate: the servers are external processes, and Rust would add no value for I/O multiplexing. P3-T3 depends on reliable baselines, and push diagnostics (publishDiagnostics) are racy for delta checks. Since the semgrep 2024-12 license changes, semgrep's rules are no longer OSS-licensed for all uses.
- **Fix:** P3-T1: keep TS, and prefer textDocument/diagnostic plus workspace/diagnostic (pull), falling back to push with a settle window. For P3-T3, key deltas on (file, code, message) with line-shift remapping from the edit's diff rather than raw ranges. P3-T11: evaluate opengrep (LGPL fork, compatible CLI, --baseline-commit, --sarif) with community rules. Keep SARIF ingestion through the existing parser, and add `--sarif` to the hook command so the sarif gate matches.
- **Evidence:** PLAN.md:99 (P3-T1 lang TS vscode-jsonrpc), :101 (P3-T3), :109 (P3-T11 semgrep OCaml sidecar). The sarifParser gate matches /semgrep/, but semgrep's default output is not SARIF.

## [LOW] performance — sdk/src/tools/code-search.ts:25 — [POLY] Default exclude of **/build/** hides tracked source directories named build in many ecosystems
- **Risk:** ripgrep already honors .gitignore, so the extra '!**/build/**' glob only removes files that are tracked: Bazel/Please `build/` packages, Go `internal/build`, Python `tools/build`, CMake modules in `cmake/build`. Searches silently miss them. Otherwise code_search is bounded, streaming, abort-aware, and language-agnostic (confirmation).
- **Fix:** Drop build/ and dist/ from DEFAULT_EXCLUDED_GLOBS and rely on .gitignore, or apply them only when the directory is not tracked (git check-ignore).
- **Evidence:** DEFAULT_EXCLUDED_GLOBS includes '!**/dist/**' and '!**/build/**' (:25-34). rg is invoked without --no-ignore, so gitignored paths are already skipped.

## [LOW] correctness — sdk/src/tools/3d-assets.ts:125 — [BEST] Blender DAE import branch is a no-op fallback (both arms call wm.collada_import); Collada was removed in Blender 5.0
- **Risk:** With Blender 5.x, .dae inspect/render fails with an AttributeError traceback instead of a clear 'importer unavailable' error. Otherwise the module is bounded (8MB output cap, timeouts, abort, --disable-autoexec, allowlisted child env via getChildProcessEnv, which resolves P0-T1 residual SB2-F2) and uses guarded conditionalCommit (confirmation).
- **Fix:** Check hasattr(bpy.ops.wm,'collada_import') and raise ValueError('Blender importer unavailable for .dae') otherwise. Optionally validate glTF with the Khronos gltf-validator before trusting the parsed structure.
- **Evidence:** BLENDER_IMPORT_SCRIPT: `elif source_format == 'dae': if hasattr(bpy.ops.wm,'collada_import'): bpy.ops.wm.collada_import(...) else: bpy.ops.wm.collada_import(...)`. runBlender env uses getChildProcessEnv().

## [LOW] test-coverage — sdk/src/__tests__/harness-intelligence.test.ts:87 — [POLY] Tests pin JS-centric behavior only; no fixtures for non-JS affected tests, nested monorepo hooks, or mixed-language assurance
- **Risk:** Nothing catches the polyglot gaps above: there are no Go/Python/JVM affected-test fixtures, no nested-manifest hook inference, and no mypy/go build/GHC/dart diagnostic fixtures. The language-diagnostics test suite covers only the six structured parsers and a few regex parsers. run-targeted-validation has no test with a changed file that matches no hook.
- **Fix:** Add a per-language fixture matrix, driven by SUPPORTED_LANGUAGE_IDS plus the common unregistered ecosystems, asserting the affected-test candidates, build targets, inferred hooks, and one real captured diagnostic sample per tool.
- **Evidence:** harness-intelligence.test.ts test names cover leases, context packets, and JS/workspace targets. file-change-hooks.test.ts 'infers ... from language manifests' uses root manifests only. The language-diagnostics.test.ts list (:16-1172) has no mypy, go build, dart, elixir, GHC, or terraform cases.

## Coverage receipt

### Subsystems
- sdk

### Features
- language-diagnostics
- affected-tests
- build-targets
- environment-inspection
- validation-hooks
- targeted-validation
- code-search
- audit-intelligence
- 3d-assets

### Files
- sdk/src/tools/language-diagnostics.ts
- sdk/src/tools/get-affected-tests.ts
- sdk/src/tools/get-build-targets.ts
- sdk/src/tools/inspect-environment.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/run-targeted-validation.ts
- sdk/src/tools/code-search.ts
- sdk/src/services/harness-intelligence.ts
- sdk/src/services/audit-intelligence.ts
- sdk/src/tools/3d-assets.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/__tests__/language-diagnostics.test.ts
- sdk/src/__tests__/harness-intelligence.test.ts
- sdk/src/__tests__/file-change-hooks.test.ts
- common/src/util/language-capabilities.ts
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
