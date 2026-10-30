> **SUPERSEDED** by `.agents/sessions/polyglot-roadmap-v2/` (2026-09-27). Wave 0 scaffold (packages/native-core) is removed per locked decision D8; the fresh Rust workspace starts under X-3b. This session is retained for historical evidence only.

# STATUS — Polyglot Native Adoption

Updated: 2026-09-26.

## Current state

- **Wave 0 in progress.** W0-1 (native-core workspace + napi-rs scaffolding + CI prebuild matrix) is done.
- W0-2 (golden perf baselines) and W0-3 (contract specs + golden vectors) are pending — next up.

## Wave 0 — completed

- `packages/native-core/` created: Cargo.toml (napi 3 / napi-derive 3, cdylib), build.rs (napi_build::setup), src/lib.rs with three real napi exports (`version`, `stripAnsi` byte-level stripper incl. CSI/OSC/two-char ESC, `countBytes` Buffer crossing proof).
- TS wrapper `index.ts`: loads platform `.node` when present (process.platform/arch → triple mapping), never throws when absent, pure-JS `stripAnsi` fallback that is production-correct.
- `__tests__/native-core.test.ts`: 6 tests — fallback path always exercised; native-vs-fallback output parity on a fixture corpus when native is available.
- `.github/workflows/native-core-build.yml`: prebuild matrix (linux x64/arm64, macOS x64/arm64, windows x64-msvc), workflow_dispatch + path-filtered PR/push triggers, artifact upload of `*.node`, and a `bun test` job.
- Root `tsconfig.json` gained a project reference for `packages/native-core`. Workspace membership is automatic via the root `packages/*` glob.

## Blockers resolved this wave

- **rustc 1.87 vs napi crate MSRV (1.88):** newest napi 3.13 rejects the local toolchain. Fixed crate-scoped via `packages/native-core/.cargo/config.toml` `[resolver] incompatible-rust-versions = "fallback"` plus a fresh lockfile re-resolution → napi 3.4 selected; `cargo build`/`cargo test` pass. No global toolchain change was made. On CI (dtolnay/rust-toolchain@stable) the newest napi is fine; the fallback config is harmless there.

## Validation evidence (Wave 0 W0-1)

- `cargo build` + `cargo test`: compile clean, 0 Rust unit tests (exports verified via JS binding tests).
- `bun test` in packages/native-core: 6 pass / 0 fail.
- `bun run typecheck` (tsc --noEmit): clean.
- Automated reviewer gate: pending at time of this note.

## Next checkpoint

1. W0-2: add golden perf baseline harness (token counting, code_search latency, index refresh, stream-parse throughput) with before/after rows.
2. W0-3: pin cap.v3 grammar + broker receipt schema + tool JSON-schema export as byte-exact golden fixtures.
3. Then Wave 1: W1-1 tokenizer (tiktoken-core) is the first real migration target behind `packages/agent-runtime/src/util/token-counter.ts`.

## Resume instructions

- Build locally: `cd packages/native-core && bun run build:debug` (requires Rust; MSRV fallback config is committed).
- Run tests: `cd packages/native-core && bun test`.
- CI prebuilds: dispatch `.github/workflows/native-core-build.yml` manually or rely on path-filtered triggers under `packages/native-core/**`.
- Remaining Wave 0 tasks live in PLAN.md (W0-2, W0-3); then follow the wave ordering in PLAN.md.

<!-- update_plan_status:appended -->
## Wave 0 round 2 — 2026-09-26T06:24:59.176Z

Four findings repaired (3 by the runtime repair-editor + 2 parent fixes): (1) engines.bun in packages/native-core/package.json set to 1.3.5 to match the CI jobs that build and test the package (build matrix + test job both pin bun-version 1.3.5 with contract comments) — closes the BLOCKING engine-mismatch and the bun-engine-vs-ci finding; (2) native countBytes/export and JS fallback now return u64/bigint so >4 GiB Buffers cannot wrap (Cargo consumption requires napi8 feature — added in Cargo.toml); (3) JS utf8CodePointLength now band-for-band mirrors Rust utf8_code_point_len including invalid-lead bands (0x80..=0xbf → 1), exported and directly tested; (4) repair-editor also added CI musl x64/arm64 build legs wired to the napi.triples set. Parent fixes during validation: de-duplicated a duplicated `fn utf8_code_point_len` signature line the repair pass left in lib.rs (cargo build break), and added the napi8 feature to Cargo.toml (E0277: u64 does not implement ToNapiValue without it). Final validation: cargo build + cargo test green, tsc clean, bun test 15/15 pass.

<!-- update_plan_status:appended -->
## Wave 0 round 3 — coordinated wrapper/native contract repair — 2026-09-26T07:27:36.577Z

Round 5 findings (8 BLOCKING + 1 aggregate RF-9) closed by one coordinated two-sided contract round in packages/native-core: (R1/R2) single canonicalizeInput() at the wrapper entry — native and JS-mirror modes now scan byte-identical lossy-UTF-8 substrate (pinned by unpaired-surrogate + ESC+NUL tests); (R2) countBytes uniform Buffer|string|Uint8Array → bigint contract with UTF-8 conversion before the native call; (R3) isNativeBinding behavioral version() probe; (R4) tripleCandidatesFor() ordered libc candidates with family fall-through; (R5) getNativeLoadFailure() telemetry, cleared on success; (R6) guarded createRequire construction with recorded diagnostics; (R7) defined default-arm ESC contract (ESC+0x20..=0x7e non-CSI/OSC/intermediate byte consumes exactly 2 bytes; control bytes incl. NUL and non-ASCII leads consume ESC + one whole code point) documented identically in strip_ansi and stripAnsiBytes with byte-parity tests; (R8) new tests: uniform contract concrete outputs, countBytes argument-kind matrix, probe rejection, candidate ordering + fall-through, telemetry retrieval/clear. Parent follow-ups in this wave: fixed an earlier duplicated utf8_code_point_len fn-signature compile break, added napi8 feature for u64 BigInt, verified final file hashes match the repair-editor receipt. Validation: cargo build + cargo test green, tsc clean, bun test 25/25 (408 assertions).


<!-- update_plan_status:appended -->
## Wave 0 round 4 — malformed alternate libc triple fix — 2026-09-26T07:58:49.802Z

compatibility-reviewer found the round-3 candidate fall-through was half-broken: tripleCandidatesFor used slice(0, -4) to recover the triple base, but '-gnu' (4 chars) and '-musl' (5 chars) are different widths, so musl primaries built malformed alternates ('linux-x64--gnu' / 'linux-arm64--gnu') that match no prebuilt filename or published package — the wrong-libc fall-through was dead in exactly the direction Bun (which hides glibcVersionRuntime) exercises. Repair-editor fixed the base recovery with a regex strip (/-(?:gnu|musl)$/) and added two regression tests: both detection directions yield well-formed family pairs, and every generated triple resolves to a real prebuilt filename and platform package name for both libc families. Receipt 3LfsuMeJWf8 (mutation 73077ed9) covers malformed-alternate-libc-triple, RF-2-eb17b650, RF-3-3b9cf12c. Validation: tsc clean, bun test 27/27 (432 assertions).
