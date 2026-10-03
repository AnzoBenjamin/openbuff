# PLAN — Polyglot Native Adoption (Waves 0–5)

Evidence base: `.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md` (+ per-shard findings). Spec: `SPEC.md` in this directory.

## Wave 0 — Foundations (prerequisite for all waves)

- [ ] W0-1 Set up `packages/native-core/` Rust workspace with napi-rs; CI builds prebuilt `.node` packages for the same platform matrix as `cli-release-build.yml` (linux x64/arm64, macOS x64/arm64, win32 x64). Validation: package installs on all 5 targets via optionalDependencies; `bun test` in a consumer package passes with the module loaded and absent.
- [ ] W0-2 Golden performance benchmarks: capture baseline (token-count throughput, code-search latency, index refresh time, stream-parse throughput) into `scripts/measure-perf-guards-baseline.ts`-style harness. Validation: baseline rows committed; every wave must show before/after parity-or-better.
- [ ] W0-3 Freeze contract specs with golden vectors: cap.v3 token grammar (`common/src/util/content-hash.ts`), broker receipt schema, tool JSON-schema export. Validation: new fixture tests pin byte-exact encode/decode.

## Wave 1 — Pure-function addons (lowest risk)

- [ ] W1-1 Token counting: `openbuff-tokenizer` napi module (tiktoken-core); port `token-counter.ts` API surface; remove caps/fudge factors behind a flag until evals confirm parity. Validation: `packages/agent-runtime` token-counter tests + context-budget tests pass; benchmark shows ≥10x throughput.
- [ ] W1-2 ANSI/string utils: byte-level stripAnsi/stripColors/suffixPrefixOverlap in `common/src/util/string.ts`. Validation: `common` string tests pass unchanged (exact-output oracle).
- [ ] W1-3 Range reads: memmap2+memchr `readNodeTextRange` behind `node-filesystem.ts`. Validation: `sdk` node-filesystem + read-files tests pass; readdirView pairing guard untouched.

## Wave 2 — Search/index core

- [ ] W2-1 In-process ripgrep: replace per-call `rg` spawn in `sdk/src/tools/code-search.ts`; keep `CODEBUFF_RG_PATH` override ("use external binary") and error-message contract. Validation: `sdk` code-search tests + `find-files-matching-content` tests pass; latency benchmark.
- [ ] W2-2 BM25 lexical tier: tantivy (or FTS5) behind unchanged `queryIndex` API in `packages/indexer/src/query.ts`. Validation: query-quality/retrieval-quality/call-navigation MRR suites must be >= baseline (these are the golden harness).
- [ ] W2-3 Transactional store: sled/redb (or SQLite) behind `index-store.ts`; port lock/CAS tests verbatim. Validation: `index-store.test.ts`, `index-manager.test.ts`, p8/m7 suites pass.

## Wave 3 — Parse tier

- [ ] W3-1 Extract `buildTokenCallers` conformance fixture (shared between code-map and agent-runtime suites) before touching parse. Validation: fixture runs green from both packages.
- [ ] W3-2 Native tree-sitter + rayon parallel parse behind `parse.ts` facade; `.scm` queries verbatim; WASM fallback retained. Validation: all code-map suites (parse/integration/languages/all-language-wasm/incremental/structure) pass on BOTH paths; parity diff over golden repo corpus = zero.
- [ ] W3-3 Retire `grammar-wasm-repair.ts` runtime network fetch once native grammars are default (keep for fallback). Validation: cold-start benchmark shows no cdn.jsdelivr.net dependency in native path.

## Wave 4 — CLI feature addons (styled-span protocol first)

- [ ] W4-1 Styled-span/line data protocol at the markdown/highlight/layout boundary (TS-owned types; native layers emit spans). Validation: markdown-renderer renders identically from both TS and span sources on fixture corpus.
- [ ] W4-2 Syntax highlighting: tree-sitter+syntect addon replaces stub in `cli/src/utils/syntax-highlighter.tsx`. Validation: visual smoke on fixtures; streaming benchmark shows per-chunk highlight affordable.
- [ ] W4-3 Image protocols: `image` crate decode/resize; sixel/kitty/iTerm2 in `terminal-images.ts`. Validation: tmux-cli visual verification across kitty + non-graphics terminal (graceful null).
- [ ] W4-4 Word-level diffs (imara-diff) in diff-viewer. Validation: diff-viewer component tests.
- [ ] W4-5 Fuzzy matching (nucleo) in suggestion engine. Validation: `use-suggestion-engine` tests; keystroke-latency benchmark.
- [ ] W4-6 Memory-v2 native kernel: rusqlite+FTS5+sqlite-vec; ship `search()` + `compact()`; namespaced embeddings cacheKey. Validation: all memory-v2 suites pass incl. two-session cold-start; semantic recall e2e.

## Wave 5 — Process model & distribution

- [ ] W5-1 Index daemon (`openbuff serve`): resident native process owns index; IPC IndexManager client. Validation: lock machinery tests replaced by daemon lifecycle tests; crash-recovery drill.
- [ ] W5-2 Workspace watching: notify-based external-change events in `sdk/src/run.ts`; incremental reindex. Validation: new integration test simulating external edit mid-run.
- [ ] W5-3 LSP + MCP servers on native core. Validation: LSP conformance smoke; MCP tool roundtrip.
- [ ] W5-4 cargo-dist single-binary release; retire vendored ripgrep + WASM sibling shipping; smoke-binary simplification. Validation: release workflow produces one artifact per target; `sdk/test/ripgrep-bundling` suite retired or repurposed; checksum verification at build time.

## Dependencies

- W0 before everything. W1 independent items can parallelize. W2-2/2-3 depend on W0-2 baselines; W3-2 depends on W3-1. W4-* depend on W4-1 protocol. W5-1 depends on W2-3; W5-4 depends on W2-1+W3-2 (native search/parse must be default).

## Risks

- Platform-matrix build failures (musl, Windows MSVC) — fall back to TS path; module absence must never break the CLI.
- Parity drift in search ranking — MRR harness is the gate; never ship a tier below baseline.
- Boundary chatter overhead — batch APIs only.
- Bun/NAPI compat regressions on Bun version bumps — add a compatibility lane to CI mirroring the existing Bun 1.0 legacy lane pattern.

## Validation gates (per wave)

1. `bun run typecheck` + affected `bun test` suites (behavioral oracle).
2. Golden benchmark suite: before/after rows with parity-or-better assertions.
3. Contract fixture tests (W0-3) green.
4. For CLI-facing waves (4/5): tmux-cli visual smoke of the affected surfaces.
