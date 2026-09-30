# Audit findings: w1-docs

- Subsystems: docs, .
- Features: user-docs, supported-languages-matrix, architecture-docs, hook-examples, windows-docs, rust-workspace-docs
- Files covered: 27
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — docs/configuration.md:512 — [POLY][BEST] Inferred-hook table is stale and misstates a safety property (package.json scripts ARE executed)
- **Risk:** The doc says Openbuff 'does not infer or execute package.json scripts by default' and that inferred hooks are 'fixed commands'. The code runs repo-controlled `lint`/`typecheck`/`type-check`/`check:types` scripts, and composer scripts, automatically when autoFileChangeHooks is unset. Users who clone untrusted repos rely on a guarantee that does not hold. The table also leaves out most polyglot hooks, so Go/Rust/.NET/Python/Ruby/JVM/PHP/C++/Godot users cannot predict what runs: test suites (go test, cargo test, dotnet test, pytest, rspec, swift test, maven test) run on every matching edit.
- **Fix:** Regenerate the table from inferFileChangeHooks: add go test, cargo test, dotnet build/test, pyright/mypy/pytest (ruff only when referenced), rspec and bundle exec rubocop, swift build/test (swift-format only with .swift-format), gradle check / maven test, composer validate plus composer script, C++ hooks, and godot validation. State plainly that package.json and composer scripts are executed, and point to `autoFileChangeHooks: false` for untrusted repos. Remove or reword the 'validation-only / fixed commands' paragraph at lines 520-525.
- **Evidence:** sdk/src/tools/file-change-hooks.ts:250-276: findScript(packageJson.scripts,['lint']) leads to `${packageRunner} run <script>`, and typecheck scripts are handled the same way. Lines 158, 171-178, 196-198: go test, dotnet build/test, cargo test. Lines 317-337: ruff runs only when referenced; pyright/mypy/pytest. Line 354: rspec. Lines 206-223: swift-format only with .swift-format, plus swift build/test. Lines 376-395: gradle check / maven test. Lines 404-420: composer validate plus scripts. Line 228: inferCppHooks. Line 232: godot. docs/configuration.md:512-525 claims otherwise.

## [HIGH] api-contract — docs/architecture.md:105 — [POLY] No user-facing supported-languages matrix with honest capability tiers
- **Risk:** A user of a Python/Go/Rust/Java/C#/C++/Swift/Kotlin/Ruby/PHP repo gets no per-language statement of what works (parsing, symbols, imports, diagnostics parsers, inferred tests, LSP) or what is degraded. architecture.md:105 lists only tree-sitter parser languages. agents-and-tools.md:157 names the internal registry but does not surface its contents. LSP server argv/detect/rootMarkers (e.g. pyright-langserver --stdio) exist only in code, so users cannot tell which server to install or how to override it.
- **Fix:** Add docs/languages.md (linked from README and getting-started) with a table generated from common/src/util/language-capabilities.ts, one row per language and one column per tier: parse/symbols, import resolution, diagnostics parser, inferred hooks, LSP server plus install command, and idioms. Mark GDScript and other partial tiers explicitly. Add a CI golden test so the table cannot drift (see the test-coverage finding).
- **Evidence:** common/src/util/language-capabilities.ts:155-178 (python: languageServer pyright/pylsp, argv ['pyright-langserver','--stdio']), :288-297 (java), :322-327 (C#), :361 (clang-tidy), :398, :437, :474, :513-529. Searching docs/ for 'pyright|gopls|rust-analyzer|supported languages' returns no user-facing matrix, only docs/agents-and-tools.md:157.

## [MEDIUM] api-contract — openbuff.d.example/hooks.json:1 — [POLY] All hook/config examples are TS/bun-only; no polyglot fileChangeHooks recipes
- **Risk:** The only copyable hook example and every hook snippet in configuration.md (lines 55-75, 470-500, 574-640) use `cd <pkg> && bun run typecheck` for this monorepo. Users of other languages get no template for scoping go/cargo/pytest/gradle hooks per module, overriding inferred hooks, or setting timeouts for slow JVM/C++ builds.
- **Fix:** Keep the repo-specific recipe, but add a 'Recipes by language' section to configuration.md with Python (ruff/pyright/pytest), Go, Rust (cargo per-crate with -p), JVM (gradle :module:check), .NET, C++ (cmake --build + ctest), Ruby, and PHP. Ship an openbuff.d.example/hooks.polyglot.json alongside, or rename the current file to make clear it is monorepo-specific.
- **Evidence:** openbuff.d.example/hooks.json:1-53: eight hooks, all `cd <pkg> && bun run typecheck|test` on *.ts. docs/configuration.md:55-75 and :574-640 show the same TS-only examples.

## [MEDIUM] api-contract — AGENTS.md:11 — [LANG] Core docs omit the planned polyglot architecture (Rust workspace, sidecars, ACP, Python optional deps, capability manifest)
- **Risk:** AGENTS.md, architecture.md, and CONTRIBUTING.md describe a pure TypeScript monorepo. The repo map and package graph omit `rust/`. CONTRIBUTING.md:83 says 'TypeScript everywhere', which contradicts SPEC D1/D7/D8 (Rust sidecars and workspace), D2/D28 (optional uv-managed Python), D9 (ACP v1 protocol), and D16 (language-capabilities.ts as sidecar manifest). Contributors and agents loading these docs through ROUTER.md will plan TS-only changes and may add dual JS mirrors, which rust/README charter rule 1 forbids.
- **Fix:** Add `rust/` to the AGENTS.md repo map and the architecture.md package graph, marked as a separate cargo workspace (D8/X-3b). Add a short 'Planned polyglot architecture' section to architecture.md that summarises D1, D2, D7, D9, and D16, links to SPEC.md, and marks what is shipped vs planned. Reword CONTRIBUTING.md:83 to 'TypeScript for the JS workspaces; Rust for sidecars under rust/ (see rust/README.md)'.
- **Evidence:** AGENTS.md:11 'TypeScript monorepo (Bun workspaces)'. AGENTS.md:17-26 repo map has no rust/. docs/architecture.md:10-30 graph has no rust/. CONTRIBUTING.md:83. rust/Cargo.toml:1-3 workspace members crates/*. SPEC.md:167-175 (D1, D2, D7, D8, D9) and :189 (D16).

## [MEDIUM] api-contract — WINDOWS.md:139 — [BEST] Documents legacy CODEBUFF_GIT_BASH_PATH as 'the implemented' override; primary is OPENBUFF_GIT_BASH_PATH, and the PowerShell syntax is wrong
- **Risk:** Users follow a legacy alias that README.md:5 says was removed along with the other CODEBUFF_* vars. The runtime error message tells them to use OPENBUFF_GIT_BASH_PATH, so the two sources disagree. The snippet sits in a ```powershell block but uses cmd `set`, which does not set an env var in PowerShell.
- **Fix:** Change the snippet to `$env:OPENBUFF_GIT_BASH_PATH = "C:\path\to\bash.exe"` in PowerShell and `set OPENBUFF_GIT_BASH_PATH=...` in cmd. Mention CODEBUFF_GIT_BASH_PATH only as a legacy fallback, and list it in docs/environment-variables.md and the README compatibility note.
- **Evidence:** sdk/src/tools/run-terminal-command.ts:81-82 (1. OPENBUFF_GIT_BASH_PATH, 2. CODEBUFF_GIT_BASH_PATH legacy), :94 `env.OPENBUFF_GIT_BASH_PATH ?? env.CODEBUFF_GIT_BASH_PATH`, :165-166 error text recommends OPENBUFF_GIT_BASH_PATH. README.md:5 says other legacy CODEBUFF_* vars 'were removed'.

## [MEDIUM] correctness — docs/testing.md:9 — [BEST] Contradictory `bun --cwd` guidance: docs forbid the form while repo scripts and docs use it
- **Risk:** testing.md:9 and knowledge.md:7 say `bun --cwd <pkg> run <script>` silently runs nothing. Yet the root `start-cli` script, which CONTRIBUTING/development tell users to run, is `bun --cwd cli dev`. testing.md:23-31 prescribes `bun run --cwd scripts harness:*`, and evals/README.md uses `bun --cwd=evals test ...`. Either the warning is overstated or several documented commands silently no-op and report success.
- **Fix:** Verify empirically which forms work on the pinned Bun 1.3.11 (`bun --cwd X run s`, `bun run --cwd X s`, `bun --cwd=X test`). Narrow the warning to the exact broken form, and rewrite every doc command and package.json script to the `cd <pkg> && bun run <script>` form where needed.
- **Evidence:** package.json:20 "start-cli": "bun --cwd cli dev". scripts/package.json:17 harness:lsp exists. docs/testing.md:9-17 vs :23-31. knowledge.md:7. evals/README.md 'bun --cwd=evals test compaction-retention'.

## [LOW] api-contract — WINDOWS.md:5 — [LANG][BEST] WINDOWS.md presents removed hosted/cloud flows and a shared internal machine as current
- **Risk:** Sections cover a shadow.tech shared dev machine (lines 5-20), 'legacy cloud-mode login' browser failures (lines 169-205), and binary auto-download on first run (lines 44-60, 207-222). These describe hosted and upstream-Codebuff flows that the BYOK purge removed (README.md:7, architecture.md:7), which confuses Windows users about what Openbuff needs.
- **Fix:** Delete the shadow.tech and cloud-login sections. Keep only the bash/Git-for-Windows, proxy, and WSL guidance. Re-verify whether the npm wrapper still checks GitHub releases before keeping the 'Failed to determine latest version' section.
- **Evidence:** WINDOWS.md:171 '> This applies to legacy cloud-mode login'. README.md:7 'no backend fallback'. docs/architecture.md:7 says hosted surfaces were removed.

## [LOW] api-contract — rust/README.md:9 — [LANG] Rust README lists only planned crates; the existing crate is undocumented
- **Risk:** The README lists shim/jobd/index/lanes/pty/infer as the planned order, but the only crate on disk is openbuff-workspace-harness, which is not mentioned. Readers cannot tell what the workspace ships today, or whether the harness crate breaks charter rule 2 ('matrix legs gated behind the first real crate').
- **Fix:** Add a 'Current crates' section describing openbuff-workspace-harness (purpose, whether it is a real crate or test scaffold, whether CI builds it) and keep the planned list under 'Planned'.
- **Evidence:** glob rust/**/Cargo.toml finds rust/Cargo.toml and rust/crates/openbuff-workspace-harness/Cargo.toml only. rust/README.md:9-11 does not mention it.

## [LOW] api-contract — docs/local-mode.md:21 — [BEST] Docs say there is no local-mode toggle, but the documented smoke script sets OPENBUFF_LOCAL_MODE
- **Risk:** README, local-mode.md, and getting-started all tell users to run `bun run smoke:openbuff`. That script injects OPENBUFF_LOCAL_MODE=true, while the docs say Openbuff is always local with no toggle and architecture.md says CODEBUFF_LOCAL_MODE is not read. If the env var is dead, it is misleading. If it is live, it is undocumented.
- **Fix:** Remove the variable from the smoke script if nothing reads it. Otherwise document it in environment-variables.md.
- **Evidence:** package.json:26 "smoke:openbuff": "OPENBUFF_LOCAL_MODE=true bun scripts/openbuff-smoke.ts". docs/local-mode.md:21 'there is no cloud-mode toggle'. Whether any code reads OPENBUFF_LOCAL_MODE was not verified in this shard.

## [LOW] test-coverage — docs/configuration.md:508 — [BEST] No drift guard ties docs to the code-owned language/hook registries
- **Risk:** The inferred-hook table and language lists (architecture.md:105, agents-and-tools.md:157, :804) are hand-maintained copies of file-change-hooks.ts and language-capabilities.ts. The memory-drift guard only checks that ROUTER.md paths exist, so the drift in the HIGH finding above went undetected.
- **Fix:** Add a docs golden test (in common or sdk tests, run by check:ci-local) that renders the inferred-hook table and language matrix from code and compares it with the fenced/marked sections in the docs. Alternatively, generate those doc sections from code.
- **Evidence:** ROUTER.md:16-18 describes the drift suite as checking only for missing files. common/src/util/__tests__/language-capability-manifest.test.ts pins the manifest but not the docs.

## [LOW] api-contract — docs/architecture.md:1 — [LANG] Confirmation: no doc presents packages/native-core or a hosted backend as current
- **Risk:** None. Confirms D8 compliance: removed components are not described as current in the core docs.
- **Fix:** No action. Keep it this way when adding the polyglot architecture section.
- **Evidence:** Searching docs/, README.md, AGENTS.md, knowledge.md, CONTRIBUTING.md, and package.json for 'native-core|packages/native' returns 0 matches. architecture.md:7 says hosted surfaces were removed. Package graph at architecture.md:10-30.

## [LOW] api-contract — docs/agents-and-tools.md:157 — [POLY] Confirmation: language registry and import-extraction coverage are documented for developers
- **Risk:** None for developers. Users still lack a matrix (see the HIGH finding).
- **Fix:** Reuse this content as the basis of the user-facing matrix.
- **Evidence:** docs/agents-and-tools.md:157 lists the canonical registry languages, :804 lists per-language import extraction, :813 lists native manifest command concepts. This matches common/src/util/language-capabilities.ts.

## Coverage receipt

### Subsystems
- docs
- .

### Features
- user-docs
- supported-languages-matrix
- architecture-docs
- hook-examples
- windows-docs
- rust-workspace-docs

### Files
- README.md
- AGENTS.md
- knowledge.md
- CONTRIBUTING.md
- WINDOWS.md
- ROUTER.md
- cli/README.md
- sdk/README.md
- rust/README.md
- evals/README.md
- packages/agent-runtime/docs/deterministic-edit-system.md
- docs/architecture.md
- docs/local-mode.md
- docs/configuration.md
- docs/getting-started.md
- docs/testing.md
- docs/development.md
- docs/agents-and-tools.md
- openbuff.d.example/hooks.json
- rust/Cargo.toml
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/run-terminal-command.ts
- common/src/util/language-capabilities.ts
- package.json
- scripts/package.json
- .agents/sessions/polyglot-roadmap-v2/SPEC.md
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
