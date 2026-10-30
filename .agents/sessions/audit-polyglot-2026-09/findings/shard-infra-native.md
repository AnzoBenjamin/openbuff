# Audit findings: shard-infra-native

- Subsystems: native-core, internal-providers, build-tools, github-ci
- Features: native-core-scaffold, napi-prebuild-matrix, js-fallback-parity, openai-compatible-provider, openrouter-provider, tool-call-serialization, retry-error-mapping, infisical-run-executor, release-build-matrix, native-ci-prebuilds
- Files covered: 23
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [HIGH] correctness — tsconfig.json:24 — packages/native-core has zero production consumers outside its own package, tsconfig.json reference, and its own CI workflow — deletion is safe and SUPPORTS D8/X-3a
- **Risk:** Deletion scope could be underestimated if hidden consumers exist; conversely, the zero-consumer state means the scaffold currently delivers zero runtime value while its build/CI cost continues.
- **Fix:** Proceed with X-3a deletion exactly as scoped in PLAN.md: remove packages/native-core/, .github/workflows/native-core-build.yml, and the tsconfig.json:24 project reference. Nothing outside those three artifacts needs touching.
- **Evidence:** code_search 'native-core' across repo: 72 matches, all inside packages/native-core/**, .github/workflows/native-core-build.yml, tsconfig.json:24, and .agents planning docs. query_index references mode for packages/native-core/index.ts returns only its own test file plus false-positive name collisions (scripts/tmux/tmux-viewer/index.tsx and cli/src/cli-args.ts match a generic local 'version' symbol, not an import of the package). No package.json in the workspace declares @codebuff/native-core as a dependency; bun.lock:172/268 lists the workspace but no consumer edge.

## [MEDIUM] test-coverage — .github/workflows/native-core-build.yml:112 — PC-6 CONFIRMED STILL TRUE in current state: native-core-build.yml test job exercises only the JS fallback; the 7-leg build matrix produces .node artifacts that nothing ever downloads or runs
- **Risk:** Every push/PR touching packages/native-core runs 7 cross-compile legs (x86_64/aarch64-gnu, x86_64/aarch64-musl, darwin-x64/arm64, win32-msvc) producing artifacts that are never tested natively, never published, and never consumed — pure CI spend masking an untested native path.
- **Fix:** No repair needed if D8/X-3a is confirmed: the correct disposition is deletion, not closing the gap. If the scaffold is kept instead, the test job must download the matrix artifact for the host triple and assert nativeAvailable === true before bun test.
- **Evidence:** native-core-build.yml:106-110 uploads native-core-<target> artifacts with if-no-files-found: error; the separate test job (lines 112-135) never uses actions/download-artifact and its run step is 'cd packages/native-core && bun test' with the comment 'Runs the pure-JS fallback path; no native artifact is required here' (line ~127). Parity tests in __tests__/native-core.test.ts are designed to pass identically without the binary. No workflow downloads or smoke-tests the uploaded .node files.

## [MEDIUM] correctness — packages/native-core/index.ts:170 — Dual-implementation parity burden is real and ongoing: index.ts carries a byte-for-byte JS mirror of the Rust stripper plus a lead-byte mirror, pinned by a 564-line test file — the exact PC-3 cost D8 cites
- **Risk:** Every future hot-path export (W1-2 ANSI stripping was the seed) requires maintaining byte-identical Rust and JS state machines plus a growing parity test suite; drift between them silently changes CLI output depending on whether a .node binary loaded.
- **Fix:** Delete with the scaffold. The lesson (encode as a rule in the new P4/P5 workspace): no napi export ships without either (a) a single-source-of-truth implementation (Rust only, JS thin shim) or (b) a property-based cross-mode fuzz gate in CI running the actual binary — never hand-mirrored dual implementations.
- **Evidence:** index.ts:168-250 stripAnsiBytes + index.ts:285-305 utf8CodePointLength are documented 'byte for byte' mirrors of src/lib.rs:44-103 strip_ansi and lib.rs:120-131 utf8_code_point_len; tests at __tests__/native-core.test.ts:296-330 (band-for-band lead-byte mirror) and 332-360 (ESC contract both modes) exist solely to hold the two implementations together. .agents/sessions/polyglot-native-waves/STATUS.md:45-50 documents 4 repair rounds and 8 blocking findings (R1-R8) all about keeping the dual implementations identical for three trivial exports.

## [LOW] dependency-hygiene — packages/native-core/.cargo/config.toml:6 — MSRV friction is already paid tax: .cargo/config.toml exists solely to pin cargo resolution against napi crate MSRV newer than the local toolchain — recurring toolchain fragility evidence for D8
- **Risk:** Local dev and CI select different napi crate versions (3.4 locally, newest on CI per STATUS.md:20), so 'it builds locally' does not imply 'it builds in the 7-leg matrix' — a recurring failure class for any future native work.
- **Fix:** Moot after deletion. For the fresh P4/P5 workspace: commit a rust-toolchain.toml with an explicit channel and re-declare the resolver fallback at workspace level so the MSRV contract is versioned, not discovered.
- **Evidence:** .cargo/config.toml:6-9 sets [resolver] incompatible-rust-versions = "fallback" with comment explaining local rustc 1.87 vs napi MSRV 1.88+; .agents/sessions/polyglot-native-waves/STATUS.md:20 records the incident and the lockfile re-resolution to napi 3.4. package.json declares no rust-toolchain pin (no rust-toolchain.toml exists in the package).

## [LOW] performance — packages/native-core/index.ts:245 — Native value for the only Wave-1 candidate export (stripAnsi) is unproven and likely marginal: the JS fallback is already a zero-copy byte-loop over Buffer, and the export has zero call sites
- **Risk:** Native speedup for a byte-scan over CLI-scale outputs (KB-MB) is nanoseconds-per-byte and invisible next to network LLM latency; carrying a 7-target FFI distribution for it is negative ROI.
- **Fix:** Delete now (D8/X-3a). Re-admit ANSI stripping to the future Rust workspace only if the X-2 profiling gate shows a measured win; otherwise the well-tested JS byte stripper in git history can be lifted into a utility package verbatim without any Rust.
- **Evidence:** index.ts:245-305 implements the full stripper in pure JS over Buffer with zero allocations per byte beyond one output buffer; README.md:8-10 states Wave 0 exists to 'prove the napi-rs toolchain' and Wave 1+ would move hot paths in. No consumer currently calls stripAnsi at all (finding 1), so there is no measured hot path to justify native code.

## [MEDIUM] api-contract — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:148 — packages/internal provider wrappers: TS is clearly the right language — the code is a thin AI-SDK-v5 integration layer, not a compute kernel; a native provider layer would be pure overhead
- **Risk:** A Rust provider layer would need to reimplement SSE parsing, zod-equivalent schema validation, LanguageModelV2 stream-part emission, and FFI-marshalling per chunk to interop with the AI SDK the whole product is built on — high cost, no latency win on I/O-bound streams.
- **Fix:** Keep TS. Do not create a native provider layer in the P4/P5 Rust workspace; if the sandbox shim work later wants shared Rust logic, scope it to compute-bound crates (parsing/indexing/sandbox), never the SSE provider adapters.
- **Evidence:** packages/internal/package.json:33-37 declares @ai-sdk/provider ^2.0.1, @ai-sdk/provider-utils ^3.0.17, ai ^5.0.52; openai-compatible-chat-language-model.ts:148-174 implements LanguageModelV2 with zod/v4 chunk schemas and createJsonErrorResponseHandler/createEventSourceResponseHandler from provider-utils; doStream (412-560) is a TransformStream over the SDK's event-source response. No retry loop exists in the package: the only retry surface is the isRetryable?: hook passed through at openai-compatible-error.ts:37-39, i.e. retry policy is delegated to the AI SDK layer.

## [LOW] api-contract — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:505 — Tool-call serialization is small, vendor-quirk-heavy TS glue: prepareTools is 94 lines; stream tool-call accumulation/phantom-filtering lives inside the AI SDK stream contract — no language opportunity
- **Risk:** This is protocol-glue logic where the value is exact conformance to per-vendor JSON quirks; rewriting in Rust would be a full re-derivation of accumulated edge-case fixes (e.g. phantom tool calls) with regression risk and no gain.
- **Fix:** No migration. Keep as TS. If dedup between openai-compatible and openrouter-ai-sdk is desired, that is a refactor within TS (shared chunk-merge helper), not a language change.
- **Evidence:** openai-compatible-prepare-tools.ts:8-93 maps LanguageModelV2 tools/toolChoice to OpenAI function format with warning collection in ~90 lines; the stream-side accumulation in openai-compatible-chat-language-model.ts:445-525 merges delta fragments and filters phantom empty-name tool calls at finish ('Tool \"\" not found' guard, lines 505-525). openrouter-ai-sdk/chat/index.ts:396-871 mirrors the same shape for OpenRouter chunks incl. reasoning-details schemas.

## [LOW] error-handling — packages/internal/src/openai-compatible/openai-compatible-error.ts:12 — Error mapping encodes hard-won vendor quirks (array-wrapped error payloads, Google RPC reason extraction) that a port would have to rediscover
- **Risk:** Migrating error mapping to a native layer would strand this vendor-quirk knowledge and its behavioral tests; error strings surface directly to CLI users, so regressions are user-visible.
- **Fix:** Keep in TS with the provider layer. When auditing future Rust crates, add a rule: no error-mapping for HTTP/JSON APIs crosses into Rust; only CPU-bound transformation logic does.
- **Evidence:** openai-compatible-error.ts:12-20 z.preprocess picks the first object containing 'error' out of an array payload; lines 57-80 getGoogleRpcReason walks details[].reason and details[].metadata.reason; createOpenAICompatibleStreamError (chat-language-model.ts:121-146) JSON-encodes and truncates metadata to 2000 chars into the message. These behaviors are pinned by openai-compatible-error.test.ts and the per-provider msw test suites.

## [LOW] performance — packages/build-tools/executors/infisical-run/executor.ts:1 — packages/build-tools is a single Nx executor (infisical-run) that shells out to the infisical CLI — 62 lines of TS build glue with no language opportunity
- **Risk:** None meaningful; ~60 lines with input validation and cwd-escape guards, already adequate for its purpose.
- **Fix:** No action. Explicitly out of scope for the polyglot waves; document as 'stays TS' in the P4/P5 workspace charter so nobody migrates glue code.
- **Evidence:** packages/build-tools/executors/infisical-run/executor.ts:1-62 (entire executor), executors.json:1-10 registers it; project.json:1-24 shows the package's only real targets are tsc build/clean. It is consumed as Nx project machinery, not runtime code.

## [MEDIUM] performance — .github/workflows/native-core-build.yml:33 — CI cost picture: native-core-build.yml adds a 7-leg Rust cross-compile matrix per native-core change with zero consumers, while the main CI test matrix does not include native-core at all; the existing release path already pays Rust/Zig toolchain costs (ripgrep, opentui)
- **Risk:** A polyglot expansion that keeps the current scaffold multiplies CI legs without consumer value; conversely, deleting it removes the only Rust CI experience the repo has, which the P4/P5 workspace will need to re-derive.
- **Fix:** Confirm D8: delete native-core-build.yml with X-3a. For the new P4/P5 cargo workspace, reuse the cli-release-build.yml cross-compile patterns (explicit rustup target add + static musl linking, per the workflow's own comments) but gate matrix legs behind the first real crate's existence and add a native-path smoke test from day one so PC-6 does not recur.
- **Evidence:** native-core-build.yml:33-59 matrix of 7 targets, each installing Rust toolchain + Swatinem/rust-cache + Bun 1.3.5 + bun install (line 84) before building; ci.yml test matrix (lines ~96-108) lists .agents, agents, cli, common, evals, packages/agent-runtime, packages/indexer, packages/internal, sdk, scripts — packages/native-core is absent, so main CI never runs its tests. Meanwhile cli-release-build.yml:100-260 already compiles ripgrep with cargo for legacy-macOS and darwin-x64 legs and builds OpenTUI with Zig — Rust/Zig toolchains are already part of the release path, so the P4/P5 workspace legs reuse familiar machinery rather than introducing a new one.

## [LOW] correctness — packages/native-core/index.ts:126 — Deletion blast radius is confined: the scaffold's only behavioral guarantees (graceful fallback, telemetry channel) are entirely self-contained and tested, so removal cannot break runtime behavior of any other package
- **Risk:** If deleted without a note, this carefully-built fallback/telemetry pattern (which survived 4 repair rounds) is lost and will likely be re-derived imperfectly for the first real Rust crate.
- **Fix:** Carry the *contract* forward, not the code: when the P4/P5 workspace ships its first loadable artifact, reuse this degraded-mode + telemetry design (it is the one high-quality part of the scaffold worth referencing in the X-3b design doc), then delete the package.
- **Evidence:** index.ts:13-45 getNativeLoadFailure channel; index.ts:126-152 isNativeBinding shape+behavioral probe; index.ts:156-206 loadNativeBindingWith two-stage candidate resolution; test file covers all of it (native-core.test.ts:365-564). This engineering exists only to make a missing binary invisible.

## Coverage receipt

### Subsystems
- native-core
- internal-providers
- build-tools
- github-ci

### Features
- native-core-scaffold
- napi-prebuild-matrix
- js-fallback-parity
- openai-compatible-provider
- openrouter-provider
- tool-call-serialization
- retry-error-mapping
- infisical-run-executor
- release-build-matrix
- native-ci-prebuilds

### Files
- packages/native-core/README.md
- packages/native-core/Cargo.toml
- packages/native-core/build.rs
- packages/native-core/index.ts
- packages/native-core/src/lib.rs
- packages/native-core/.cargo/config.toml
- packages/native-core/package.json
- packages/native-core/tsconfig.json
- packages/native-core/__tests__/native-core.test.ts
- packages/internal/package.json
- packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts
- packages/internal/src/openai-compatible/chat/openai-compatible-prepare-tools.ts
- packages/internal/src/openai-compatible/openai-compatible-error.ts
- packages/internal/src/openrouter-ai-sdk/chat/index.ts
- packages/build-tools/executors/infisical-run/executor.ts
- packages/build-tools/executors.json
- packages/build-tools/project.json
- .github/workflows/native-core-build.yml
- .github/workflows/ci.yml
- .github/workflows/cli-release-build.yml
- .github/workflows/sdk-release.yml
- .github/workflows/evals.yml
- tsconfig.json

### Domains
- correctness
- test-coverage
- performance
- dependency-hygiene
- api-contract
- error-handling
