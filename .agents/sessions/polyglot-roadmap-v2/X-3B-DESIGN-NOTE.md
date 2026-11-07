# X-3b Design Note — Fresh Rust Workspace Charter

Carried forward from `packages/native-core` (Wave-0 scaffold, removed by X-3a) and the DEPTH-2026-09-27 audit (shard-infra-native + shard-tooling). This note exists so the removal does not erase the one high-quality artifact of the scaffold: its loading pattern.

## 1. Workspace layout (locked decision D8)

- Root: `<repo>/rust/` (NOT a packages/* workspace member — it is a separate cargo workspace; the old scaffold lived under `packages/` only because napi optionalDependencies needed a package.json, which the new workspace does not).
- `rust/Cargo.toml` — workspace root, `members = ["crates/*"]`, `[workspace.dependencies]` for shared versions.
- `rust/rust-toolchain.toml` — **commit with an explicit channel** (the native-core MSRV incident: napi 3.13 MSRV 1.88 vs local rustc 1.87 forced a `.cargo/config.toml` `incompatible-rust-versions = "fallback"` workaround and a lockfile re-resolution. Pinning the channel is the already-paid tax; do not pay it again).
- `rust/crates/<name>/` — one crate per component. Planned: `shim` (P5-T1 sandbox), `jobd` (P5-T2 supervisor), `index` (P6-T7 parse tier), `lanes` (P6 lanes), `pty` (P5-T4 PTY host), `infer` (P9-T6).
- Sidecars (shim, jobd, pty, index) ship as **standalone binaries** distributed via checksum-verified downloads or optionalDependencies — NOT napi bindings. napi kernels exist only where X-2 evidence justifies them; first candidate is the batched SIMD semantic dot-product.

## 2. Charter rules (PC-3 / PC-6 lessons)

1. **No dual JS mirror.** Any napi export is single-source Rust with a thin TS shim, OR guarded by a property-based cross-mode fuzz gate in CI running the actual binary. The native-core scaffold cost 4 repair rounds (8 blocking findings R1–R8) keeping a byte-for-byte JS mirror in sync for three trivial exports. Never again.
2. **CI runs the native path from day one.** Every matrix leg that builds a binary must also download and smoke-test it (PC-6: native-core-build.yml built 7 targets and tested only the JS fallback; prebuilds were never published or downloaded). Gate matrix legs behind the first real crate's existence; reuse `cli-release-build.yml` cross-compile patterns (explicit `rustup target add` + static musl linking).
3. **CI toolchain cost stays O(1):** one reusable `workflow_call` job + `Swatinem/rust-cache`, not per-package setup steps (shard-evals-infra). Rust/Go/Python toolchains enter CI only at the first real consumer.
4. **Publish prebuilts when the first consumer lands** — a built-but-unpublished artifact is pure CI spend.

## 3. Loading pattern to carry forward (from `packages/native-core/index.ts`)

The degraded-mode/telemetry loading pattern is the canonical reference for every future native/sidecar binding surface in TS:

- **Graceful degradation is the core invariant.** The wrapper module must never throw when the native binary is absent; every export falls back to a pure-JS/TS implementation. A module that loads but drifts from the declared surface (stale binary, future platform package, partial shim) degrades the same way.
- **Two-stage probe:** a shape check (`typeof member === 'function'` for every declared member) followed by a **behavioral probe** — call the cheapest exported function under try/catch and require a plausible non-empty result, so a truthy-but-misbehaving object cannot suppress the fallback.
- **Recorded degradation telemetry:** every candidate-load failure (missing factory, shape-fail, probe-fail, dlopen error) is recorded through a `get<Area>LoadFailure(): string | null` channel — cleared on success, never silently swallowed — so consumers can distinguish "no binary" from "a candidate loaded but does not implement the surface".
- **Guarded `createRequire`:** construct the require factory inside try/catch (early Bun releases surface ERR_REQUIRE_ESM-style diagnostics from ESM graphs); a failed factory degrades with a recorded cause.
- **Ordered candidate list with family fall-through:** local prebuilt files first (all candidates), then published platform packages. On Linux carry the detected libc family FIRST plus the alternate family SECOND (hardened/minimal containers hide `process.report`, defaulting musl detection to glibc; a failed dlopen on the wrong-libc primary falls through before the pure-JS degrade). Recover the triple base by stripping the exact `-gnu`/`-musl` suffix (fixed-width slicing corrupted musl primaries into `linux-x64--gnu`).
- **Byte-identical canonical input across modes:** when both a native and a JS path scan the same input, encode/normalize once at the wrapper entry (lossy UTF-8 for strings) so both paths see identical bytes; no escape arm may split a multi-byte code point.
- **Template specifiers for optional deps:** never statically import/require a platform-specific optional package (it fails resolution at typecheck/load time); resolve it through the guarded require factory at runtime.
- **Export the types referenced by exported declarations** so declaration emit cannot break with TS4023 (`export interface <Area>Binding { ... }`).
- **Inject the resolver for tests:** `load<Area>BindingWith(resolver, candidates)` so libc fall-through and telemetry are exercisable with a stub resolver without mocking module internals.

For sidecar (stdio) components, translate this to: spawn → health/version handshake (`version` probe) → capability negotiation; a sidecar that exits, hangs, or answers an unexpected version is restarted with backoff by X-5 and reported through the same recorded-failure channel, never silently degraded.

## 4. What X-3a deletes

`packages/native-core/` (Rust crate, TS wrapper + JS mirrors, tests, `.cargo/config.toml` MSRV fallback), `.github/workflows/native-core-build.yml` (7-leg prebuild matrix with no consumer), and the `packages/native-core` project reference in the root `tsconfig.json`. Verified zero importers outside its own package (DEPTH shard-infra-native: HIGH finding, deletion safe). The `.gitignore`d `target/` build artifacts go with the directory.
