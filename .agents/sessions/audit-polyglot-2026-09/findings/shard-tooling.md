# Audit findings: shard-tooling

- Subsystems: scripts, build-distribution
- Features: binary-distribution, cold-start, build-pipeline-fragility, distribution-feature-unlocks, native-core-rewrite-contracts, new-feature-candidates
- Files covered: 9
- Snapshot: 3ce1fa2b4613303fb428bab8463887ba85bd13958dfd9df8c276dee8231f053a

## [HIGH] correctness — cli/scripts/build-binary.ts:243 — Bun --compile cannot reliably embed tree-sitter WASM; distribution is a multi-file bundle instead of a single binary
- **Risk:** Distribution depends on a multi-file layout (binary + tree-sitter.wasm + ~14 grammar wasms + manifest) that can silently break when files are separated; every packaging consumer (tarball step, smoke harness, wrappers) must replicate the sibling contract.
- **Fix:** Move the search/index core to Rust (tree-sitter is already a Rust-native stack: tree-sitter + libloading, ripgrep is Rust). Native grammars compile into the core as static objects; cargo-dist or a single cdylib artifact eliminates sibling-file packaging, the manifest, and the node_modules path probes.
- **Evidence:** Comment: 'Bun --compile asset embedding is unreliable on Windows (every JS-level retrieval mechanism we tried ... got tree-shaken, minified away, or returned an undefined binding)'. Workaround: wasm shipped as sibling files read from dirname(process.execPath), plus a generated tree-sitter-manifest.json (schemaVersion 1) of sha256 hashes; CI must then copy 'cli/bin/tree-sitter*.wasm' and the manifest into every smoke dir and tarball. findWebTreeSitterWasm()/findGrammarWasmSource() hardcode 3-5 node_modules candidate paths each to survive bun hoisting differences.

## [HIGH] correctness — sdk/scripts/build.ts:380 — SDK build ships three regex post-patches working around Bun bundler bugs, including a hardcoded tool-symbol list
- **Risk:** These patches are load-bearing pattern matches over Bun's volatile bundler output: any Bun upgrade can change minified shapes and silently break the SDK npm package at consumer runtime, and the hardcoded ToolHelpers list drifts whenever tools are added.
- **Fix:** A Rust core with a stable, generated ABI (or napi-rs bindings) would make the SDK surface a thin typed layer; bundler output would no longer carry the aggregation-object re-export that Bun tree-shakes. Even short of migration, generating the ToolHelpers list from the same source of truth as compileToolDefinitions removes the hardcoded duplication.
- **Evidence:** sdk/scripts/build.ts performs three post-build regex surgeries on generated bundles: fixCjsImportVars() (reconstructs dropped 'var import_*' declarations by mapping getters to exports_* objects), fixEsmExportRenames() (replaces broken 'X2 as X' dedup renames and deletes tree-shaken exports), and fixToolHelpers() (hardcodes the full ToolHelpers member list 'runTerminalCommand, codeSearch, findFilesMatchingContent, ... writeAuditFindings, listJobs' as a string literal and splice-inserts it into both ESM and CJS bundles). fixDuplicateImports() regex-patches the .d.ts too.

## [HIGH] correctness — .github/workflows/cli-release-build.yml:117 — Release workflow rebuilds ripgrep and OpenTUI native libs from source on runner with duplicated 60-line Xcode toolchain detection
- **Risk:** The release matrix is the most fragile surface: Xcode image bumps, Zig version drift, or OpenTUI loader-shape changes break releases at 5 of 6 matrix legs, and the duplicated toolchain-detection shell doubles the maintenance surface.
- **Fix:** A Rust core built with cargo-zigbuild or cargo-dist targets aarch64/x86_64-apple-darwin with a chosen deployment target in one command; no vendored dylib, no runtime node_modules patching, no per-runner toolchain discovery. Even keeping the TS CLI, moving search into the Rust core removes the rg build and vtool gates entirely.
- **Evidence:** For legacy macOS and darwin-x64 the workflow downloads ripgrep 14.1.1 source and builds it with cargo ('MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release --locked'), runs a ~60-line DEVELOPER_DIR discovery loop (xcode-select, /Applications/Xcode_*.app scan, CommandLineTools fallback) that is duplicated verbatim twice in the same file, cross-compiles OpenTUI's Zig native library via mlugg/setup-zig, verifies minos via 'xcrun vtool -show-build | grep minos 11', and separately emulates linux-arm64 smoke via QEMU docker. patchOpenTuiCoreNativeLoaderForLegacy() in build-binary.ts regex-replaces '@opentui/core-${process.platform}-${process.arch}' inside node_modules bundles at build time.

## [MEDIUM] security — sdk/scripts/fetch-ripgrep.ts:11 — fetch-ripgrep.ts vendors per-platform rg binaries with no checksum verification and shell-outs to tar/chmod
- **Risk:** A compromised or MITM'd ripgrep release tarball would be executed on end-user machines by the CLI with no integrity gate; the tar-based extraction also depends on the runner/host having GNU tar with matching flags.
- **Fix:** If the core is Rust, link the ripgrep library (rg crate) directly into the core binary — the vendored-binary pipeline, its GitHub fetch, and the tar/zip extraction all disappear. Interim: pin per-archive sha256 in fetch-ripgrep.ts mirroring PINNED_GRAMMAR_ASSETS.
- **Evidence:** downloadAndExtract() fetches 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/...' for 5 platforms, extracts with system tar ('--force-local' Windows workaround) or AdmZip, and chmods — but never verifies a sha256 of the downloaded archive (unlike grammar-wasm-repair.ts, which does pin checksums). Binaries are then vendored into sdk/vendor/ripgrep and shipped in the published SDK (copyRipgrepVendor in sdk/scripts/build.ts) and CLI builds.

## [MEDIUM] performance — packages/code-map/src/grammar-wasm-repair.ts:120 — Grammar WASM checksum-pinned repair can hit the network at runtime, adding cold-start latency and an online dependency
- **Risk:** Cold start and CI builds pay network latency and hash-verification overhead per grammar whenever the vendored wasm is absent; a CDN outage can block boot or build with only bounded retries.
- **Fix:** Rust tree-sitter grammars compile to native object code linked into the core binary — no WASM, no manifest, no jsdelivr fetch, no retry budget, and cold start loses both the manifest read and per-file hash verification. Static linking is exactly the property a native core buys here.
- **Evidence:** packages/code-map/src/languages.ts calls repairGrammarWasm (per query_index referencedBy), and repairGrammarWasm downloads grammar wasm from cdn.jsdelivr.net with up to 3 attempts x 30s timeout plus exponential backoff; a CI/first-run environment without the vendored file pays a network round trip and sha256 verification before parsing can start. build-binary.ts and sdk/scripts/build.ts both re-run resolveGrammarWasmSource per grammar at build time and emit tree-sitter-manifest.json consumed at runtime.

## [MEDIUM] api-contract — cli/scripts/release.ts:15 — Release engineering contracts that must survive a core rewrite: workflow dispatch, npm publish, artifact naming, env-var defines
- **Risk:** Any native-core migration must preserve these externally observable contracts or break automation and consumers: token env names, the dispatch input schema, npm package publication of @openbuff/sdk, artifact/tarball naming, and CODEBUFF_CLI_VERSION / CODEBUFF_CLI_TARGET defines embedded in binaries.
- **Fix:** A Rust core does not need to change these: keep release.ts as the trigger, emit the same artifact names from cargo-dist, and keep the npm SDK package as the JS-facing contract (potentially backed by a napi-rs native module) so consumers see no breaking change.
- **Evidence:** release.ts dispatches 'cli-release-prod.yml' with {ref:'main', inputs:{version_type}} using OPENBUFF_GITHUB_TOKEN || CODEBUFF_GITHUB_TOKEN and polls workflow_runs for the dispatched run; publish.ts runs 'npm pack --dry-run' then 'npm publish' with the version read from sdk/package.json; cli-release-build.yml names artifacts '{binary-name}-{target}' (e.g. win32-x64, darwin-x64-legacy) and tars binary+wasm+manifest.

## [MEDIUM] performance — cli/scripts/smoke-binary.ts:20 — Smoke binary relies on 10s boot-screen pattern matching because startup failures surface asynchronously after the TUI mounts
- **Risk:** Cold start is gated on locating/verifying sibling wasm and initializing web-tree-sitter asynchronously; failures only surface after the TUI mounts, so CI needs a long-running pattern-matching smoke to catch regressions — a structural symptom of the runtime-composition model.
- **Fix:** A native core eliminates the async-wasm-init class of failure entirely (static init) and the sibling-staging steps; the smoke harness could shrink to --version plus a single native-init probe, cutting CI minutes and false-negative churn on legacy runners.
- **Evidence:** Smoke harness exists precisely because Bun-compiled binaries fail asynchronously: comments note '--version exits via commander synchronously, before async startup failures (e.g. the unhandled rejection from Parser.init when the tree-sitter wasm load fails)' and that wasm rejections 'can fire after spawn (after React mounts)'; CI keeps the binary alive 10s and pattern-matches boot strings including a special non-TTY marker 'openbuff bootscreen ok' added for native Windows. Every smoke run must stage tree-sitter*.wasm and the manifest next to the binary.

## [MEDIUM] correctness — .github/workflows/cli-release-build.yml:87 — OpenTUI node_modules symlink fix duplicated across two CI jobs; legacy Bun 1.0 lane maintained as a parallel build path
- **Risk:** Duplicated inline CI scripts drift independently; the legacy lane's reliance on Bun 1.0 behavior (ignored --outfile, missing --production flag) means upstream Bun fixes can silently change which branch of the build script executes.
- **Fix:** A Rust core removes the OpenTUI node_modules coupling from the packaged core path (the JS TUI could remain a thin client over an IPC core, or the legacy lane collapses to one zig/cargo target). At minimum, extract the symlink fixer into a committed action to de-duplicate.
- **Evidence:** Two separate jobs contain an identical ~55-line inline 'bun - <<BUN' script that re-symlinks node_modules/@opentui/{core,react} into cli/node_modules with junction/dir fallbacks and EEXIST recovery. The matrix also carries a bespoke legacy lane: bun v1.0.36 zip download, two legacy targets (darwin-x64-legacy, darwin-arm64-legacy), OPENBUFF_LEGACY_MACOS_BUILD define flow, and output-file rename normalization in build-binary.ts because Bun 1.0 ignores absolute --outfile.

## [LOW] api-contract — scripts/generate-tool-definitions.ts:22 — Tool-definition codegen chains three output mirrors plus prettier and a second generator in one command
- **Risk:** If the core moves to Rust and re-declares tool schemas natively, drift between Zod schemas (TS) and the Rust registry becomes a correctness hazard; the three-mirror contract must not be forked.
- **Fix:** No language change recommended — this is correctly TS. Migration work should treat this script's outputs as frozen generated artifacts: the native core's tool registry should be generated FROM the same Zod schemas (e.g. via a JSON schema export) rather than re-declared in Rust, so one source of truth feeds both TS and native surfaces.
- **Evidence:** generate-tool-definitions.ts writes the same generated tools.ts to three mirrors (common/src/templates/initial-agents-dir/types/tools.ts, agents/types/tools.ts, .agents/types/tools.ts), handles EROFS/EACCES mirrors, formats via 'npx prettier --write', and then invokes cli/scripts/generate-init-type-sources.ts so 'schema changes cannot leave CI-only drift'. This is a deliberate multi-artifact codegen contract that a language migration must keep intact.

## [LOW] correctness — sdk/scripts/build.ts:33 — Dual ESM/CJS SDK build hand-maintains the 'external' builtin list and silences import.meta in CJS
- **Risk:** A missed builtin or ws optional peer ('bufferutil'/'utf-8-validate') breaks the published bundle at consumer runtime, and the CJS import.meta=undefined define can mask bugs only in one of the two published formats.
- **Fix:** With a Rust core, the SDK package shrinks to a thin IPC/napi client whose bundle is trivially correct; alternatively generate the external list from package.json types (dependencies vs devDependencies) to remove the hand-maintained union.
- **Evidence:** sdk/scripts/build.ts hand-maintains an external list mixing package deps and Node builtins ('fs','path','ws','bufferutil','utf-8-validate',...) for two Bun.build passes with divergent settings (ESM uses env:false + .scm text loader; CJS additionally defines import.meta.url = 'undefined' — a semantic hack that breaks any code relying on real import.meta in the CJS build).

## [LOW] correctness — cli/scripts/build-binary.ts:1 — New features unlocked by a native core: embedded index daemon, embedded LSP/MCP servers, WASM plugin host, delta auto-updates
- **Risk:** Each unlock changes the process model: daemon/LSP/server processes need socket lifecycle, version pinning against the CLI, and smoke coverage; the plugin host adds a trust/sandbox boundary that the current single-user TS process does not have.
- **Fix:** Sequence: first extract search/index/tree-sitter into a Rust cdylib behind the existing contracts (CODEBUFF_RG_PATH-style env override, tree-sitter-manifest.json compatibility shim), then grow the daemon/LSP/MCP/plugin surfaces on the native side while the TS CLI remains the TUI front end.
- **Evidence:** With a static-linked Rust core (ripgrep embedded, tree-sitter grammars native, index state in-process), the shipped binary can host: (1) a long-lived embedded index daemon — no node_modules, so a persistent `openbuff serve` process becomes a plain static binary installed once; (2) an embedded LSP server exposing Openbuff code intelligence to any editor over stdio; (3) a plugin host via wasmtime (extism-style) running community plugins sandboxed inside the same single file; (4) an embedded MCP server so agents/IDEs talk to the CLI over one local socket without npm; (5) cargo-dist-style auto-update with delta/compressed artifacts since binaries are self-contained (today's multi-file tarball makes atomic in-place updates fragile).

## Coverage receipt

### Subsystems
- scripts
- build-distribution

### Features
- binary-distribution
- cold-start
- build-pipeline-fragility
- distribution-feature-unlocks
- native-core-rewrite-contracts
- new-feature-candidates

### Files
- cli/scripts/build-binary.ts
- cli/scripts/release.ts
- cli/scripts/smoke-binary.ts
- sdk/scripts/build.ts
- sdk/scripts/fetch-ripgrep.ts
- sdk/scripts/publish.ts
- scripts/generate-tool-definitions.ts
- .github/workflows/cli-release-build.yml
- packages/code-map/src/grammar-wasm-repair.ts

### Domains
- correctness
- performance
- security
- api-contract
- dependency-hygiene
