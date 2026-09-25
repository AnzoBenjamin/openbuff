# Audit findings: shard-docs-root

- Subsystems: ., docs, test
- Features: getting-started-docs, project-knowledge-file, architecture-docs, agents-tools-docs, config-docs-and-examples, request-flow-docs, testing-docs, local-mode-docs, root-package-scripts, test-bootstrap-scm-loader
- Files covered: 18
- Snapshot: a0de6357ff5254c1bb8cf2e92d821fd948811744293fe3361209c5d557e95392

## [MEDIUM] test-coverage — package.json:30 — Root test script omits @codebuff/code-map and @codebuff/internal although both ship test scripts
- **Risk:** The `test` filter runs 8 workspaces but excludes `@codebuff/code-map` and `@codebuff/internal`, both of which define runnable test scripts (packages/code-map/package.json:22 `bun test`; packages/internal/package.json:36 `bun test`). A contributor or CI job that trusts `bun run test` as the full suite silently skips all code-map (tree-sitter grammar/symbol extraction) and internal (provider wrapper) tests — critical parsing paths go unexercised on every root-level run.
- **Fix:** Add `@codebuff/code-map` and `@codebuff/internal` to the filter list at package.json:30 (or switch to `bun --filter='*' run test` like the typecheck script and let workspaces without tests no-op), and document the authoritative suite scope in docs/testing.md.
- **Evidence:** package.json:30 test filter = {@codebuff/common,@codebuff/agents,@codebuff/agent-runtime,@codebuff/indexer,@openbuff/sdk,@codebuff/cli,@codebuff/evals,@codebuff/scripts}; packages/code-map/package.json:22 has `"test": "bun test"`; packages/internal/package.json:36 has `"test": "bun test"`; neither package appears in the filter.

## [MEDIUM] test-coverage — test/setup-scm-loader.ts:4 — .scm text loader is not preloaded in the workspace that actually consumes .scm files (packages/code-map)
- **Risk:** test/setup-scm-loader.ts is the Bun plugin that turns `.scm` query imports into text (the contract packages/code-map/src/languages.ts relies on). It is preloaded only via the 3 bunfig.toml files found: root bunfig.toml:10, sdk/bunfig.toml:9, packages/agent-runtime/bunfig.toml:2. `packages/code-map` has NO bunfig.toml, so `cd packages/code-map && bun test` (packages/code-map/package.json:22) runs without the loader; code-map tests paper over Bun .scm quirks by re-reading files from disk (packages/code-map/__tests__/languages.test.ts workaround comment 'In Bun, .scm imports may resolve to a file path rather than content'), masking loader regressions for every other importer.
- **Fix:** Add packages/code-map/bunfig.toml with `preload = ["../../test/setup-scm-loader.ts", ...]` (same pattern as packages/agent-runtime/bunfig.toml:2), and add one direct loader-contract test asserting a `.scm` import yields file text, not a path.
- **Evidence:** glob **/bunfig.toml -> exactly {bunfig.toml, sdk/bunfig.toml, packages/agent-runtime/bunfig.toml}; bunfig.toml:10 `preload = ["./test/setup-scm-loader.ts", "./sdk/test/setup-env.ts"]`; packages/code-map/package.json:22 `"test": "bun test"` with no package-local bunfig; prior-shard evidence packages/code-map/__tests__/languages.test.ts:342-356 re-reads .scm from disk with a Bun-quirk workaround comment.

## [MEDIUM] api-contract — docs/configuration.md:222 — Config docs cite this repo's openbuff.d/{providers,routes,indexing,hooks}.json, but no openbuff.d/ directory exists
- **Risk:** docs/configuration.md:222 ('This repo's `openbuff.d/providers.json` sets ... windowTokens: 500000'), :235 ('loaded from `openbuff.d/indexing.json`') and the fragment-layout block (~lines 33-40, 'This repo uses this pattern: openbuff.json ... openbuff.d/providers.json routes.json indexing.json hooks.json') all describe files that are absent: `list_directory openbuff.d` returns ENOENT and glob `openbuff.d/*.json` matches nothing — only `openbuff.d.example/` ships. Users and agents following the docs look for the claimed repo config, cannot find it, and may conclude config is missing/broken or hand-create fragments the loader never reads (root openbuff.json.example only `includes` openbuff.d paths).
- **Fix:** Reword these passages to cite `openbuff.d.example/` as the shipped example set that users copy into their own `openbuff.d/`, or commit a real `openbuff.d/` matching the doc; add a docs-vs-disk existence check so cited paths cannot drift.
- **Evidence:** docs/configuration.md:222,235 and fragment block cite openbuff.d/providers.json, openbuff.d/routes.json, openbuff.d/indexing.json, openbuff.d/hooks.json; list_directory('openbuff.d') -> ENOENT; glob {openbuff.d/*.json} -> 0 matches while openbuff.d.example/{providers,routes,indexing,hooks}.json all exist; the windowTokens:500000 claim itself checks out against openbuff.d.example/providers.json:28,75,101,121,148,168,199.

## [MEDIUM] api-contract — openbuff.json.example:2 — openbuff.json.example includes point at nonexistent openbuff.d/*.json fragments and omit the hooks fragment the docs say exists
- **Risk:** The example's `includes` (openbuff.d/providers.json, openbuff.d/routes.json, openbuff.d/indexing.json) reference files absent from the repo (only openbuff.d.example/* ships), so a user copying the example to openbuff.json gets a config whose includes resolve to nothing — providers/routes silently missing or a loader error — and the first symptom is the hard 'No model configured' error rather than a missing-fragment warning. It also omits openbuff.d/hooks.json although docs/configuration.md's 'this repo uses this pattern' block lists hooks.json as part of the layout.
- **Fix:** Make the example self-contained (inline a minimal providers/routes block) or point `includes` at copyable openbuff.d.example/* paths with a comment 'copy openbuff.d.example to openbuff.d first'; include the hooks fragment or explicitly note hooks are optional.
- **Evidence:** openbuff.json.example:2-6 `"includes": ["openbuff.d/providers.json","openbuff.d/routes.json","openbuff.d/indexing.json"]`; openbuff.d does not exist (ENOENT) while openbuff.d.example/{providers,routes,indexing,hooks}.json exist; docs/configuration.md:33-40 lists hooks.json in the same fragment set.

## [LOW] api-contract — openbuff.json.example:7 — Example comment cites resolveConfiguredAgentModelConfig at sdk/src/impl/model-provider.ts but it lives in sdk/src/provider-config.ts
- **Risk:** The comment directs users to `sdk/src/impl/model-provider.ts:resolveConfiguredAgentModelConfig`; the function is defined and exported at sdk/src/provider-config.ts:1710 and only imported by model-provider.ts:31. Anyone debugging routing failures follows the comment to a file where the function (and its hard-error branch) is not implemented, wasting time and risking edits to the wrong module.
- **Fix:** Change the citation to `sdk/src/provider-config.ts:resolveConfiguredAgentModelConfig` (imported by sdk/src/impl/model-provider.ts).
- **Evidence:** openbuff.json.example:7 cites 'sdk/src/impl/model-provider.ts:resolveConfiguredAgentModelConfig hard-errors'; code_search shows `export function resolveConfiguredAgentModelConfig` at sdk/src/provider-config.ts:1710 (hard-error throw at :1779-1782) and only an import at sdk/src/impl/model-provider.ts:31.

## [LOW] api-contract — docs/agents-and-tools.md:117 — Docs instruct registering pattern-specific agents in openbuff.d/routes.json, a file that does not exist in the repo
- **Risk:** The pattern-specific-agent convention says 'register it in `openbuff.d/routes.json` so the pattern can route it', but openbuff.d/ is absent (only openbuff.d.example/routes.json ships). An agent author following this creates a file the loader may never read (nothing `includes` it) and concludes routing is broken; the instruction is unactionable as written.
- **Fix:** Point the instruction at the real registration location (openbuff.d.example/routes.json as the template to copy, or wherever routes are actually loaded from) and state the loader wiring explicitly.
- **Evidence:** docs/agents-and-tools.md:117 'register it in `openbuff.d/routes.json` so the pattern can route it'; list_directory('openbuff.d') -> ENOENT; openbuff.d.example/routes.json exists.

## [LOW] api-contract — docs/agents-and-tools.md:1967 — Slash-command table claims to be current but omits /plans (plan-ls) and /plan-use (plan-active, use-plan)
- **Risk:** The table 'The static command set (current as of the source file)' lists Durable plans as `interview, resume-plan, update-plan, plan-status, lessons` only. `/plans` (alias `plan-ls`) and `/plan-use` (aliases `plan-active`, `use-plan`) are live commands (cli/src/commands/command-registry.ts:354-382; regression tests cli/src/commands/__tests__/command-args.test.ts:246-254) and are documented in docs/local-mode.md. A reader trusting the table thinks plan-session selection/activation is undocumented or missing, contradicting the local-mode docs.
- **Fix:** Add `plans` (plan-ls) and `plan-use` (plan-active, use-plan) to the Durable plans row, or change the claim so the table is explicitly a palette subset with a pointer to the command registry.
- **Evidence:** docs/agents-and-tools.md:1967 'The static command set (current as of the source file)'; table row 'Durable plans | interview, resume-plan (rp), update-plan (up), plan-status (ps), lessons (lesson)' lacks plans/plan-use; command-registry.ts:354-382 implements `/plan-use` error paths and stale-active-session text naming `/plans`; command-args.test.ts:246-254 asserts both commands registered with aliases.

## [LOW] api-contract — README.md:76 — README agent examples set model: as if it routes the agent, contradicting the documented 'never read at runtime' contract
- **Risk:** README's git-committer example (README.md:76 `model: 'openai/gpt-5.4-nano'`) and SDK custom-agent example (README.md:125) present `model` as the agent's model selection with no caveat, while docs/configuration.md:94 states 'The `model:` field on agent templates is documentation of intent only — it is never read at runtime' and routing comes only from openbuff.json modes/agents/defaultModel. New users copy the example expecting per-agent models to take effect and get silent routing to defaultModel instead.
- **Fix:** Add one sentence next to both examples: 'model is intent-only documentation; actual routing is resolved from openbuff.json (modes/agents/defaultModel) — see docs/configuration.md#model-routing-resolution', or drop `model` from the examples.
- **Evidence:** README.md:76 and README.md:125 set `model: 'openai/...'` in agent definitions with no caveat; docs/configuration.md:94: 'The `model:` field on agent templates is documentation of intent only — it is never read at runtime.'; sdk/src/provider-config.ts:1710-1783 resolves models exclusively from loadedConfig (modes -> agents -> defaultModel -> explicit param).

## [LOW] api-contract — README.md:198 — 'Running Tests' tells contributors `cd cli && bun test` runs 'the test suite' but that runs only the CLI workspace
- **Risk:** README.md:198-203 presents `cd cli && bun test` as running the test suite; the real multi-workspace suite is root `bun run test` (package.json:30, 8 workspaces — itself incomplete, see the code-map/internal finding). A contributor verifying a change to sdk/agents/common per this doc runs zero relevant tests and ships unverified changes believing the suite passed.
- **Fix:** Replace with `bun run test` from the repo root (all workspaces) and keep `cd <pkg> && bun test` as the fast per-package loop, matching docs/testing.md guidance.
- **Evidence:** README.md:198 '### Running Tests' / 'To run the test suite: cd cli && bun test'; package.json:30 root test filter spans 8 workspaces; cli/package.json:22 test script runs only CLI tests.

## [LOW] api-contract — package.json:26 — smoke:openbuff exports OPENBUFF_LOCAL_MODE=true although no code reads it as a toggle and local-mode docs say no toggle exists
- **Risk:** package.json:26 (and cli/package.json:18 dev) set `OPENBUFF_LOCAL_MODE=true`, implying a mode switch, while docs/local-mode.md:19 says 'Openbuff is always local/BYOK — there is no cloud-mode toggle' and common/src/constants/local-mode.ts (the file docs/codebuff-to-openbuff-migration.md:42 claims owns `isLocalModeEnabled()`) exports only LOCAL_MODE_USER_ID/EMAIL — no toggle function exists. The var is merely forwarded (common/src/env-process.ts:36, common/src/types/contracts/env.ts:77). Divergent doc claims leave users unsure whether setting it false does anything (it does not), and scripts legitimize a dead knob.
- **Fix:** Remove `OPENBUFF_LOCAL_MODE=true` from package.json:26 / cli scripts (or wire a real fail-closed toggle), and state explicitly in docs/local-mode.md that the variable is vestigial and local/BYOK is unconditional.
- **Evidence:** package.json:26 `"smoke:openbuff": "OPENBUFF_LOCAL_MODE=true bun scripts/openbuff-smoke.ts"`; docs/local-mode.md:19 'there is no cloud-mode toggle'; common/src/constants/local-mode.ts:1-2 defines only two user-identity constants (no isLocalModeEnabled); env-process.ts:36/contracts env.ts:77 only pass the value through.

## [LOW] correctness — docs/agents-and-tools.md:1246 — Truncated sentence in the create_plan / update_plan_status section ('right tool for incremental status or lesson updates.')
- **Risk:** The section heading `### create_plan and update_plan_status` is followed by the fragment 'right tool for incremental status or lesson updates.' with its subject clause missing (presumably 'update_plan_status is the ...'). Readers cannot tell which tool the guidance applies to — the exact tool-choice distinction the section exists to make.
- **Fix:** Restore the full sentence (e.g. '`update_plan_status` is the right tool for incremental status or lesson updates.') and re-read the surrounding paragraph for other dropped text.
- **Evidence:** docs/agents-and-tools.md:1246 renders as a dangling '  right tool for incremental status or lesson updates.' immediately under the '### `create_plan` and `update_plan_status`' heading, with no subject; contrast docs/local-mode.md which phrases it correctly ('prefer `update_plan_status` for incremental STATUS.md and lesson-note edits').

## [LOW] correctness — docs/request-flow.md:191 — Prose paragraph trapped inside the Tool Call Lifecycle code fence, corrupting the diagram and hiding a contract
- **Risk:** The `## Tool Call Lifecycle` code block opens at request-flow.md ~187 and immediately contains the paragraph 'Control-plane reads and validation use the same local dispatch path. A targeted validation call must include the snapshot ID ...' before the ASCII diagram at :192+. Rendered docs show that contract text as monospace garbage fused to the diagram, so the snapshot-id/stale-rejection contract (an api-contract guarantee) is invisible to readers scanning prose, and the lifecycle diagram itself is mangled.
- **Fix:** Close the fence before the paragraph (or move the paragraph above the fence) so the prose renders as prose and the code block contains only the diagram.
- **Evidence:** request-flow.md:191 is the paragraph 'Control-plane reads and validation use the same local dispatch path. A targeted validation call must include the snapshot ID observed before execution; ...' sitting between the opening ``` of the Tool Call Lifecycle block and the 'LLM Response (tool_call) ...' ASCII art at :192+.

## [LOW] correctness — README.md:221 — README test-doc link text `cli/src/**tests**/README.md` renders as broken bold markdown instead of a path
- **Risk:** README.md:221 uses `cli/src/**tests**/README.md` as link text; the `**tests**` renders as bold in GitHub, displaying 'cli/src/tests/README.md' with weird emphasis and misleading readers about the real path (cli/src/__tests__/README.md). Cosmetic but a wrong-looking path in the primary getting-started doc.
- **Fix:** Wrap the link text in backticks: [`cli/src/__tests__/README.md`](cli/src/__tests__/README.md).
- **Evidence:** README.md:221 'See [cli/src/**tests**/README.md](cli/src/__tests__/README.md) for comprehensive testing documentation.' — link target is correct, link text renders incorrectly.

## [LOW] correctness — knowledge.md:3 — Repo-root knowledge.md is an unfilled scaffold while claiming to give project context
- **Risk:** knowledge.md states 'This file gives Openbuff context about your project: goals, commands, conventions, and gotchas' but every section (Quickstart Setup/Dev/Test, Architecture, Conventions) is an empty bullet template. Openbuff loads root knowledge.md as project context, so agents receive zero project commands/conventions from it and fall back to re-deriving them each session — and a reader assumes the project has no documented setup/test commands despite package.json:26-30 and docs/testing.md carrying them.
- **Fix:** Fill the scaffold with this repo's real content (dev: `bun run dev`, test: `bun run test`, typecheck: `bun run typecheck`, key dirs, formatting = prettier) or remove the file and rely on AGENTS.md/docs.
- **Evidence:** knowledge.md:3-21: '## Quickstart - Setup: - Dev: - Test:' etc. all blank; package.json scripts at :14-30 define dev/test/typecheck/format; AGENTS.md and docs/ carry the actual conventions.

## [LOW] error-handling — test/setup-scm-loader.ts:10 — readFile failure in the .scm onLoad handler surfaces as a raw fs error with no query-file diagnostic
- **Risk:** The async onLoad calls `readFile(args.path, 'utf8')` and returns its result directly; a missing/unreadable .scm rejects the load with a bare ENOENT/EACCES stack that names no importer or query file, so a broken tree-sitter query ships appears as an opaque module-resolution failure in whichever workspace test hits it first. No timeout or typed diagnostic wraps the I/O.
- **Fix:** Wrap in try/catch and rethrow a descriptive error naming args.path and the loader (e.g. `scm-text-loader: failed to read query file <path>: <cause>`), preserving the original error as `cause`.
- **Evidence:** test/setup-scm-loader.ts:8-15: `build.onLoad({ filter: /\.scm$/ }, async (args) => { const text = await readFile(args.path, 'utf8'); return { exports: { default: text }, loader: 'object' } })` — no catch, no context enrichment.

## [LOW] state-mutation — bunfig.toml:10 — Preload order of setup-scm-loader vs sdk/test/setup-env differs across the three bunfig.toml files
- **Risk:** Root bunfig.toml:10 preloads `./test/setup-scm-loader.ts` before `./sdk/test/setup-env.ts`; sdk/bunfig.toml:9 preloads `./test/setup-env.ts` first; packages/agent-runtime/bunfig.toml:2 matches root. Plugin/env initialization therefore happens in different orders per workspace, so any future state setup-env performs (env mutation the loader or plugin registration could observe) behaves differently depending on which directory `bun test` runs in — an init-order hazard that is invisible until it produces a workspace-only failure.
- **Fix:** Standardize one preload order in all three bunfig.toml files (env setup first, then scm loader) and note the invariant in a comment.
- **Evidence:** bunfig.toml:10 `preload = ["./test/setup-scm-loader.ts", "./sdk/test/setup-env.ts"]`; sdk/bunfig.toml:9 `preload = ["./test/setup-env.ts", "../test/setup-scm-loader.ts"]`; packages/agent-runtime/bunfig.toml:2 `preload = ["../../test/setup-scm-loader.ts", "../../sdk/test/setup-env.ts"]`.

## [LOW] dependency-hygiene — package.json:38 — Dev-only native deps canvas + gif-encoder-2 sit in root production dependencies for a tmux viewer utility
- **Risk:** `canvas` (^3.2.0, native build) and `gif-encoder-2` are consumed only by scripts/tmux/tmux-viewer/gif-exporter.ts (a debug/gif-export helper), yet they are root `dependencies`, so every workspace install and every consumer of the root manifest pays native-module build cost and supply-chain surface for a dev tool. Root production deps also imply runtime need that does not exist.
- **Fix:** Move both to the `scripts` workspace's devDependencies (or root devDependencies), leaving root `dependencies` to genuinely shared runtime packages (zod).
- **Evidence:** package.json:38-39 `"canvas": "^3.2.0", "gif-encoder-2": "^1.0.5"` under root `dependencies`; only importer is scripts/tmux/tmux-viewer/gif-exporter.ts:9-15 (`import { createCanvas } from 'canvas'; import GIFEncoder from 'gif-encoder-2'`).

## [LOW] dependency-hygiene — package.json:60 — Duplicated major-mismatched TypeScript ESLint stacks and undeclared eslint itself at the root
- **Risk:** Root devDependencies carry both `@typescript-eslint/eslint-plugin@^6.17` (package.json:60) and `typescript-eslint@^7.17.0` (a different, newer meta-stack), while `eslint` — the runner eslint.config.js needs — is not declared at all and only arrives transitively. Two incompatible @typescript-eslint major lines can resolve duplicate rule engines, and a hoisting change can break `eslint` resolution with no direct dependency to pin.
- **Fix:** Keep one stack (typescript-eslint v7), delete `@typescript-eslint/eslint-plugin@^6` (and check eslint-config-prettier/eslint-plugin-* peers), and add `eslint` as an explicit devDependency pinned to the version the v7 stack supports.
- **Evidence:** package.json:60 `"@typescript-eslint/eslint-plugin": "^6.17"` vs package.json devDeps `"typescript-eslint": "^7.17.0"`; no `"eslint"` entry anywhere in package.json despite root eslint.config.js; devDeps also list eslint-config-prettier/eslint-plugin-import/eslint-plugin-unused-imports.

## [LOW] performance — package.json:28 — clean-ts scans the entire tree (including node_modules) twice before deleting node_modules
- **Risk:** The clean-ts script runs `find . -name '*.tsbuildinfo'` and `find . -name '.next'` across the whole repo — including the huge node_modules tree it is about to delete — then a third find removes node_modules and reinstalls. On large repos this is minutes of wasted I/O; pruning node_modules first (or excluding it from the finds) removes the wasted scans.
- **Fix:** Reorder: delete node_modules first, then run the tsbuildinfo/.find sweeps (or add `-not -path '*/node_modules/*'` to the first two finds).
- **Evidence:** package.json:28 `"clean-ts": "find . -name '*.tsbuildinfo' -type f -delete && find . -name '.next' -type d -exec rm -rf {} + ... && find . -name 'node_modules' -type d -exec rm -rf {} + ... && bun install"` — the two full-tree finds traverse node_modules before it is removed.

## [LOW] security — README.md — Getting-started guidance tells users to export API keys inline, persisting secrets in shell history
- **Risk:** README instructs 'export the API key env var named by your provider's apiKeyEnv (e.g. `export OPENAI_API_KEY="..."`)' (Configure-a-provider section) and `export OPENCODE_GO_API_KEY="your_key"` (Provider configuration section). For a BYOK tool whose whole security model is local key custody, inline exports leave plaintext provider keys in shell history files and scrollback, a needless secret-leak vector for shared/CI machines.
- **Fix:** Prefer secret-safe setup: `read -s OPENAI_API_KEY && export OPENAI_API_KEY`, direnv/.env (gitignored) loading, or `/provider status`-driven key entry; add a one-line warning that inline export persists to shell history.
- **Evidence:** README.md Configure-a-provider paragraph: 'Then export the API key env var named by your provider\'s `apiKeyEnv` (e.g. `export OPENAI_API_KEY="..."`)'; README.md Provider configuration block: `export OPENCODE_GO_API_KEY="your_key"` — both inline secret literals; docs/configuration.md:20-21 instead documents 0600 credentials.json, showing the safer in-product path exists.

## Coverage receipt

### Subsystems
- .
- docs
- test

### Features
- getting-started-docs
- project-knowledge-file
- architecture-docs
- agents-tools-docs
- config-docs-and-examples
- request-flow-docs
- testing-docs
- local-mode-docs
- root-package-scripts
- test-bootstrap-scm-loader

### Files
- README.md
- AGENTS.md
- knowledge.md
- docs/architecture.md
- docs/agents-and-tools.md
- docs/configuration.md
- docs/request-flow.md
- docs/testing.md
- docs/local-mode.md
- openbuff.json.example
- package.json
- test/setup-scm-loader.ts
- bunfig.toml
- sdk/src/provider-config.ts
- packages/agent-runtime/src/main-prompt.ts
- common/src/constants/local-mode.ts
- openbuff.d.example/providers.json
- cli/src/commands/command-registry.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
