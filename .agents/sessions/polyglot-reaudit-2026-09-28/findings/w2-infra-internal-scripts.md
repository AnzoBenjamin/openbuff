# Audit findings: w2-infra-internal-scripts

- Subsystems: .github, packages, scripts, .agents, ., openbuff.d.example
- Features: ci-workflows, provider-wrappers, repo-guards, example-config, local-agent-templates, dependabot, root-build-config
- Files covered: 24
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — .github/workflows/buffbench.yml:35 — [BEST] buffbench.yml serializes the entire secrets context and has no permissions block
- **Risk:** SECRETS_CONTEXT: toJSON(secrets) puts every repo secret into one step env, so any compromised dependency or script in that step can read all of them. With no top-level permissions the job gets the default GITHUB_TOKEN scope. Actions are pinned by mutable tag (checkout@v6, setup-bun@v2, cache@v5). Line 44 also interpolates secrets.OPENBUFF_GITHUB_TOKEN straight into the run script.
- **Fix:** Use the explicit per-secret env list that ci.yml already uses. Add `permissions: contents: read`, pin all actions by SHA, and pass the token through env instead of `${{ }}` interpolation.
- **Evidence:** buffbench.yml:33-44: `SECRETS_CONTEXT: ${{ toJSON(secrets) }}` ... `echo "CODEBUFF_GITHUB_TOKEN=${{ secrets.OPENBUFF_GITHUB_TOKEN }}"`; the file has no permissions: key; lines 12/15/20 use tag pins.

## [HIGH] test-coverage — .github/workflows/ci.yml:117 — [POLY] No CI job runs the harness against non-TS repos or toolchains
- **Risk:** The test matrix covers only TS workspaces. No job installs Python/Go/Rust/Java toolchains or language servers, and none runs indexing, validation or edit flows against polyglot fixture repos. Polyglot behaviour (P2/P3 language intel, validation hooks) is therefore never exercised in CI, and regressions for non-TS repos cannot be detected.
- **Fix:** Add a polyglot-fixtures job whose toolchains are pinned with mise (.mise.toml: python/uv, go, rust, java) or a devcontainer. Check in small fixture repos (python+pytest, go module, cargo crate, maven/gradle) and run indexer, get_build_targets, run_targeted_validation and the language-server adapter against each. Make it a required check.
- **Evidence:** ci.yml:117-129 matrix lists only .agents, agents, cli, common, evals, packages/agent-runtime, packages/indexer, packages/internal, sdk, scripts. The only setup steps are setup-bun/cache. rust-workspace.yml builds rust/ only and never runs the harness against a repo.

## [MEDIUM] dependency-hygiene — .github/dependabot.yml:1 — [POLY] Dependabot omits cargo for rust/ and does not batch GitHub Actions updates
- **Risk:** The rust/ workspace (X-3b) gets no automated dependency or security updates, so RustSec advisories go unnoticed. With every npm dep in one group, a single breaking change blocks the whole batch.
- **Fix:** Add `package-ecosystem: cargo, directory: /rust`, and plan pip/uv and gomod entries for when P5-T5/P8-T3 land. Split the npm groups by dependency type or major-vs-minor, and add a group for github-actions. Add cargo-deny/cargo-audit to rust-workspace.yml.
- **Evidence:** dependabot.yml:3-14 lists only github-actions and npm (a single '*' group). rust-workspace.yml triggers on rust/**.

## [MEDIUM] security — .github/workflows/rust-workspace.yml:18 — [BEST] rust-workspace.yml has no permissions, concurrency or timeout, and actions are tag-pinned
- **Risk:** The job gets the default GITHUB_TOKEN scope and relies on mutable tags (actions/checkout@v4, Swatinem/rust-cache@v2, dtolnay/rust-toolchain@1.87.0). With no timeout a hang can run for 6h, and without a concurrency group superseded pushes keep running. ci.yml pins by SHA, so this is inconsistent with the repo's own standard.
- **Fix:** Add `permissions: contents: read`, `concurrency: {group: rust-${{ github.ref }}, cancel-in-progress: true}` and `timeout-minutes: 30`. Pin actions by SHA and add `cargo clippy -- -D warnings`, `cargo fmt --check` and cargo-deny.
- **Evidence:** rust-workspace.yml:18-38 has no permissions, concurrency or timeout-minutes keys; lines 25/29/33 use tag pins.

## [MEDIUM] correctness — .github/workflows/ci.yml:29 — [BEST] CI and eval workflows install Bun 1.3.5 but the repo pins bun 1.3.11
- **Risk:** package.json declares engines.bun and packageManager as 1.3.11, while ci.yml, evals.yml and buffbench.yml install 1.3.5. CI therefore validates a different runtime than the one developers and releases use (linker/isolate behaviour differs across 1.3.x), and bun.lock may be written by a different version.
- **Fix:** Use `bun-version-file: package.json`, or derive the version from packageManager, in every workflow. Better still, pin it in a single .mise.toml or .tool-versions shared by CI and developers.
- **Evidence:** package.json:77-80 has `"bun": "1.3.11"` and `packageManager: bun@1.3.11`. ci.yml:29, 137 and 288, evals.yml:36 and buffbench.yml:17 all have `bun-version: '1.3.5'`.

## [MEDIUM] performance — .github/workflows/evals.yml:4 — [LANG P8-T0] evals.yml has no concurrency group, cost cap or artifact upload, and buffbench/nightly-evals drop traces
- **Risk:** evals.yml starts on every push to every branch, spinning up a runner just to grep the commit message. It has no concurrency group and no cost cap, and two setup actions are marked TODO for SHA pinning. Eval traces are lost because no workflow calls upload-artifact. The P8-T0 plan (a docker/podman wrapper) is weaker than it could be: untrusted CLI runners using --dangerously-skip-permissions or --full-auto should run in an ephemeral microVM/gVisor (runsc) or rootless podman with network egress allow-listing, and secrets should go to a scoped proxy rather than into the container env.
- **Fix:** Trigger on workflow_dispatch plus a label, or an `if:` on the commit message at job level. Add a concurrency group with cancel-in-progress and pin the TODO actions. Add upload-artifact with `if: always()` to buffbench.yml, nightly-evals.yml and evals.yml. Build P8-T0 on a reusable workflow that runs evals in a gVisor/Firecracker sandbox with an egress policy, and enforce a hard cost budget in the runner.
- **Evidence:** evals.yml:3-5 `push: branches: ['**']`; lines 34/40 `# TODO: pin to SHA`; a grep for upload-artifact matches only ci.yml and the cli-release workflows. PLAN.md:164 P8-T0 is [ ].

## [MEDIUM] api-contract — .github/workflows/rust-workspace.yml:43 — [LANG X-3b/X-5] Planned hand-rolled rustup target matrix plus checksums is weaker than cargo-dist/zigbuild with Sigstore attestations
- **Risk:** The commented plan uses `rustup target add` per leg and has sidecar downloads only 'checksum-verified'. That misses cross-OS linking (glibc floors, macOS universal binaries), and bare checksums prove integrity but not provenance: a compromised release can simply publish matching checksums. cli-release already uses actions/attest-build-provenance, but X-5 does not verify it.
- **Fix:** Generate release workflows with cargo-dist, which handles the target matrix, installers and npm optionalDependencies packaging. Use cargo-zigbuild for glibc-pinned Linux and cross for exotic targets. Attest each binary with actions/attest-build-provenance (SLSA L3 via a reusable workflow). In X-5, verify the Sigstore bundle (sigstore-js or `gh attestation verify`) as well as the sha256 before spawning a downloaded sidecar.
- **Evidence:** rust-workspace.yml:43-61 comment sketch; PLAN.md:27 X-3b [~] 'publishes checksummed artifacts'; PLAN.md:29 X-5 [~] 'Artifacts are checksum-verified downloads'; cli-release-staging.yml:213 already uses attest-build-provenance@v2.

## [MEDIUM] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:128 — [LANG P5-T5/P8-T3] A Go sidecar for gitleaks and a Go eval fleet add a toolchain with no CI, dependabot or supervisor story
- **Risk:** P5-T5 (a Go sidecar) and P8-T3 (a Go runner) would add a fourth language. Nothing in CI, dependabot (no gomod entry) or the example configs supports Go, and the Rust X-5 supervisor charter already covers sidecars. Commit gating does not need a runtime sidecar: the gitleaks-action or pre-commit binary is enough, and the TS codegen of TOKEN_SHAPES from the TOML covers stream-time redaction.
- **Fix:** P5-T5: run gitleaks (pinned by SHA and checksum) as a CI job and a pre-push step, and codegen the TS redaction from gitleaks.toml with golden vectors. Do not ship a runtime Go sidecar. P8-T3: build the fleet on existing orchestrators (GitHub Actions matrix, or Rust/TS with Firecracker/gVisor) rather than a new Go codebase. If Go is chosen anyway, add a gomod dependabot entry and a setup-go job first.
- **Evidence:** PLAN.md:128 'lang Go sidecar + TS codegen'; PLAN.md:167 'lang Go runner + TS runTask entry'; dependabot.yml has no gomod; no workflow uses setup-go.

## [MEDIUM] correctness — openbuff.d.example/hooks.json:2 — [POLY] Example hooks and indexing configs are TS-only
- **Risk:** Every fileChangeHook is `bun run typecheck/test` over *.ts globs, and indexing.json shows no language-specific excludes or LSP settings. Users with Python/Go/Rust repos get no template for pytest/ruff/mypy, go vet, cargo check or javac hooks, so the validation loop is invisible to them for non-TS files.
- **Fix:** Add commented or alternate example hooks, e.g. `{filePattern:'**/*.py', command:'uv run ruff check && uv run pytest -x'}`, `{filePattern:'**/*.go', command:'go vet ./...'}`, `{filePattern:'rust/**/*.rs', command:'cargo check --manifest-path rust/Cargo.toml'}`. Add a rust/ cargo hook for this repo itself. Include indexing excludes for target/, .venv/ and vendor/.
- **Evidence:** hooks.json:1-52: all 8 hooks use `bun run` with .ts/.tsx patterns; none covers rust/**. indexing.json:1-30 has `exclude: []`.

## [LOW] correctness — scripts/harness-language-server.ts:14 — [POLY] harness-language-server.ts is a bare argv passthrough, not a language server adapter
- **Risk:** The script only spawns a user-supplied command with file paths. It does not speak LSP, map languages to servers (pyright, gopls, rust-analyzer, jdtls), or normalise diagnostics. Non-TS diagnostics therefore depend on the user's own tooling, arrive in unstructured output, and have no timeout.
- **Fix:** Rename it, or implement a real adapter: a language-to-server table, an LSP client (vscode-jsonrpc) using textDocument/publishDiagnostics or pull diagnostics, output normalised to a SARIF-like JSON shape, and a timeout with kill. Alternatively route through the planned Rust lanes sidecar.
- **Evidence:** harness-language-server.ts:3-19: `spawn(command, files, {stdio:'inherit', shell:false})` with no timeout and no language handling.

## [MEDIUM] dependency-hygiene — packages/internal/package.json:43 — [BEST] Vendored @ai-sdk openai-compatible/openrouter forks have no upstream-sync provenance
- **Risk:** packages/internal/src/openai-compatible and openrouter-ai-sdk are vendored forks, but no recorded upstream version or commit, patch list or drift check is visible. @ai-sdk/provider and provider-utils are caret ranges (^2.0.1, ^3.0.17), so a minor upstream bump can change the V2 stream-part contracts the fork relies on without any visible diff. Streaming usage also assigns undefined when a later chunk omits a field (lines 630-632: `usage.promptTokens = prompt_tokens ?? undefined`), which can wipe counts reported earlier by providers that send usage across multiple chunks.
- **Fix:** Record the upstream package@version and commit in each fork directory (UPSTREAM.md plus a patches/ list). Add a scheduled CI job that diffs against upstream and opens an issue on drift. Pin @ai-sdk/* exactly. Merge usage fields only when they are non-null, as is already done for the details fields.
- **Evidence:** package.json:43-44 carets; openai-compatible-chat-language-model.ts:630-632 overwrites unconditionally, while lines 633-652 guard the details fields with != null; version.ts only derives __PACKAGE_VERSION__.

## [LOW] correctness — eslint.config.js:132 — [BEST] ESLint config references unregistered plugin rules, and the typescript-eslint versions are mixed
- **Risk:** 'react-hooks/exhaustive-deps' and '@next/next/no-img-element' are set in a flat config that never registers those plugins, which ESLint flat config rejects ('Could not find plugin'; inferred, not run). The devDeps mix @typescript-eslint/eslint-plugin ^6 with typescript-eslint ^7, and `globals` is imported but not declared at root. The core no-unused-vars rule runs on TS instead of @typescript-eslint/no-unused-vars. tsconfig.base lacks noUncheckedIndexedAccess and exactOptionalPropertyTypes.
- **Fix:** Remove the two orphan rule entries or register their plugins. Drop @typescript-eslint/eslint-plugin ^6, pin typescript-eslint to a version compatible with TS 5.5.4, and declare globals. Switch to @typescript-eslint/no-unused-vars and consider tseslint.configs.strictTypeChecked. Enable noUncheckedIndexedAccess incrementally per package.
- **Evidence:** eslint.config.js:132-133 orphan rules; lines 124-131 use core no-unused-vars; package.json:60,79 have `@typescript-eslint/eslint-plugin: ^6.17` and `typescript-eslint: ^7.17.0`; tsconfig.base.json:10-11 has only strict and noImplicitReturns.

## [LOW] security — openbuff.d.example/providers.json:285 — [BEST] Example providers config contains a real-looking GCP project ID and duplicate provider entries
- **Risk:** The agent-platform baseURL embeds a concrete project ID (project-7a6f8b41-...), which leaks account metadata and will fail for anyone who copies it. 'agentrouter' and 'AGENT_ROUTER' duplicate the same endpoint and key, and many third-party relays appear with 500k defaultCapabilities that most listed models do not support. Copied examples will then overstate context windows.
- **Fix:** Replace the project ID with `${GCP_PROJECT}` or a placeholder, remove the duplicate AGENT_ROUTER entry, and trim the example to a few canonical providers with accurate per-model windows.
- **Evidence:** providers.json:285 baseURL includes 'projects/project-7a6f8b41-2520-4c35-a45'; lines 126 and 153 define agentrouter and AGENT_ROUTER with the same baseURL and apiKeyEnv.

## [LOW] state-mutation — .github/workflows/mirror-dot-agents.yml:14 — [BEST] mirror-dot-agents.yml is dead but still triggers on push and lacks a permissions block
- **Risk:** The header marks the workflow DISABLED because the target repo does not exist, but the file still defines a push trigger and injects a PAT into a URL. If it is re-enabled by accident it fails, or pushes to whoever registers that repo name.
- **Fix:** Delete the file as its own comment suggests, or switch the trigger to workflow_dispatch only and add `permissions: contents: read`.
- **Evidence:** mirror-dot-agents.yml:2-13 DISABLED banner; lines 14-18 push trigger; line 43 `https://x-access-token:${TOKEN}@github.com/AnzoBenjamin/openbuff-dot-agents.git`.

## Coverage receipt

### Subsystems
- .github
- packages
- scripts
- .agents
- .
- openbuff.d.example

### Features
- ci-workflows
- provider-wrappers
- repo-guards
- example-config
- local-agent-templates
- dependabot
- root-build-config

### Files
- package.json
- tsconfig.base.json
- bunfig.toml
- openbuff.json.example
- eslint.config.js
- .github/dependabot.yml
- .github/workflows/ci.yml
- .github/workflows/rust-workspace.yml
- .github/workflows/evals.yml
- .github/workflows/buffbench.yml
- .github/workflows/mirror-dot-agents.yml
- openbuff.d.example/hooks.json
- openbuff.d.example/indexing.json
- openbuff.d.example/providers.json
- openbuff.d.example/routes.json
- scripts/harness-language-server.ts
- packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts
- packages/internal/src/openai-compatible/version.ts
- packages/internal/package.json
- .agents/claude-code-cli.ts
- .agents/codex-cli.ts
- .agents/gemini-cli.ts
- .agents/lib/create-cli-agent.ts
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
