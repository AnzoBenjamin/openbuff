# OpenBuff Rust workspace

A separate cargo workspace (decision D8 / X-3b) — deliberately NOT registered in
the root `tsconfig.json` or any JS package.json. Charter:
`.agents/sessions/polyglot-roadmap-v2/X-3B-DESIGN-NOTE.md` (normative).

## Purpose

Home for the Rust sidecar crates, in planned order: `shim` (P5-T1 sandbox),
`jobd` (P5-T2 supervisor), `index` (P6-T7 parse tier), `lanes` (P6), `pty`
(P5-T4 PTY host), `infer` (P9-T6). Sidecars ship as standalone binaries, not
napi bindings; napi kernels exist only where X-2 evidence justifies them.

## Build & test

```sh
cargo build
cargo test
```

Both must be green from day one (PC-6: never a build-only path).

## Charter rules

- **No dual JS mirror** (charter rule 1): napi exports are single-source Rust
  with a thin TS shim, or guarded by a cross-mode fuzz gate in CI.
- **CI runs the native path from day one** (charter rule 2): every matrix leg
  that builds a binary must also download and smoke-test it. Matrix legs stay
  gated behind the first real crate.
- **CI toolchain cost stays O(1)** (charter rule 3): one reusable job with
  caching, not per-package setup steps.
- **Publish prebuilts when the first consumer lands** (charter rule 4): a
  built-but-unpublished artifact is pure CI spend.
