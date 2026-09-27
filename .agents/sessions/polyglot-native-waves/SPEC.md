# SPEC — Polyglot Native Adoption (Waves 0–5)

## Goal

Introduce native (Rust) components into Openbuff — a TypeScript-on-Bun, local-first BYOK coding CLI — **incrementally via napi-rs prebuilt modules behind existing TS interfaces**, to unlock features the current language blocks (from `.agents/sessions/audit-polyglot-2026-09/AUDIT-REPORT.md`, 72 findings across 5 shards). Never a big-bang rewrite.

## Non-goals

- No rewrite of the agent loop (`packages/agent-runtime/src/run-agent-step.ts`) — I/O-bound; TS is appropriate (Claude Code precedent).
- No rewrite of the OpenTUI/React TUI (`cli/src/chat.tsx`, `app.tsx`, components).
- No change to published SDK contract shapes: `ToolResultOutput`, `FileMutationResultV1`/`CommitReceiptV1`, `ClientToolOverrides`, `CodebuffFileSystem` adapter (`readdirView` pairing, `hostProcessView` gating).
- No change to the cap.v3 token grammar or content-hash normalization (`common/src/util/content-hash.ts`) — stays frozen in TS; native components never mint/validate tokens.
- No change to mutation-broker receipt schema (`sdk/src/services/workspace-mutation-broker.ts`) — persisted cross-process state.
- No re-declaration of tool schemas outside Zod; native registries must be generated FROM `common/src/tools/compile-tool-definitions.ts` output.
- No replacement of `agents/` prompt/programmatic agent templates.

## Requirements

- R1 (Wave 1): Pure-function napi-rs addons with exact-output contracts, each behind an existing TS module and pinned by existing tests as oracle:
  - R1a: Token counting — replace JS BPE in `packages/agent-runtime/src/util/token-counter.ts` with tiktoken-core bindings; remove 100k-char cap / 20k extrapolation / 1.35×/1.1× fudge factors; exact per-provider counts.
  - R1b: ANSI stripping + `suffixPrefixOverlap` — replace quadratic/regex hazards in `common/src/util/string.ts` with byte-level Rust scanner; identical output contract.
  - R1c: Range reads — `readNodeTextRange` byte-by-byte scan in `sdk/src/tools/node-filesystem.ts` replaced by memmap2+memchr; keep `readdirView` pairing guard semantics.
- R2 (Wave 2): Search/index core behind unchanged `queryIndex`/`IndexManager` APIs:
  - R2a: In-process ripgrep (grep-searcher/ignore/globset crates) replacing per-call `rg` spawn in `sdk/src/tools/code-search.ts`; preserve `CODEBUFF_RG_PATH` override and error-message contract.
  - R2b: Persistent BM25 lexical tier (tantivy or SQLite FTS5) replacing O(files×tokens) substring scorer in `packages/indexer/src/query.ts`.
  - R2c: Transactional index store (sled/redb or SQLite) replacing whole-artifact JSON rewrites in `packages/indexer/src/index-store.ts`; port lock/CAS semantics from `index-store.test.ts` verbatim.
- R3 (Wave 3): Native tree-sitter parse tier (`packages/code-map/src/parse.ts`, `languages.ts`) with rayon parallelism; keep `.scm` queries verbatim; extract `buildTokenCallers` conformance suite to a shared fixture first; preserve WASM fallback path until parity is proven.
- R4 (Wave 4): CLI feature addons gated behind a styled-span/line data protocol introduced at the markdown/highlight/layout boundary:
  - R4a: Real syntax highlighting (Rust tree-sitter + syntect) replacing the stub in `cli/src/utils/syntax-highlighter.tsx`.
  - R4b: Image protocols — sixel/kitty/iTerm2 decode+resize via Rust `image` crate (+ ratatui-image protocol unification) in `cli/src/utils/terminal-images.ts`.
  - R4c: Word-level intra-line diffs (imara-diff/similar) for `cli/src/components/tools/diff-viewer.tsx`.
  - R4d: fzf-quality fuzzy matching (nucleo) for `cli/src/hooks/use-suggestion-engine.ts`.
  - R4e: Memory-v2 native kernel (rusqlite + FTS5 + sqlite-vec) in `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts`: ship `search()` (currently `unsupported('semantic-search')`) and `compact()`; namespace embeddings cacheKey (`local:onnx/<model>`).
- R5 (Wave 5): Process model and distribution:
  - R5a: Resident index daemon (`openbuff serve`) owning the index; IPC client keeps IndexManager API; eliminates hand-rolled cross-process lock machinery.
  - R5b: Live workspace watching (notify crate) surfaced as SDK-level external-change events; incremental reindex.
  - R5c: Embedded LSP server (stdio) and MCP server (local socket) on the native core.
  - R5d: cargo-dist single-binary distribution replacing multi-file bundle; vendored ripgrep binaries and WASM grammar sibling files become obsolete; checksum verification moves to build-time supply chain.
  - R5e: Local offline embeddings (candle/ort) behind existing `EmbedFn` (from R2/R4 embeddings work; cacheKey namespacing required).

## Acceptance criteria

- Every native module ships as a prebuilt per-platform `.node` package (napi-rs optionalDependencies pattern); no runtime compilation; `bun:ffi` not used.
- For each wave: existing behavioral test suites pass unchanged (they are the oracle); new golden benchmarks added before/with each wave (none exist today).
- Contract receipts preserved byte-for-byte: cap.v3 grammar, broker receipts, tool schemas, `CODEBUFF_RG_PATH` env override, release automation inputs.
- Distribution: single static binary artifact per platform; `smoke-binary.ts` pattern-matching shrinks to `--version` + one probe once native init is static.
- Feature gates: each R4 feature is independently toggleable and degrades gracefully to the current TS behavior when the native module is absent (e.g. CI environments without prebuilts).

## Relevant systems

- `packages/agent-runtime/src/util/token-counter.ts` (R1a)
- `common/src/util/string.ts` (R1b); `sdk/src/tools/node-filesystem.ts` (R1c)
- `sdk/src/tools/code-search.ts`, `sdk/src/native/ripgrep.ts` (R2a); `packages/indexer/src/query.ts` (R2b); `packages/indexer/src/index-store.ts` (R2c)
- `packages/code-map/src/parse.ts`, `languages.ts`, `grammar-wasm-repair.ts` (R3)
- `cli/src/utils/syntax-highlighter.tsx`, `terminal-images.ts`, `markdown-renderer.tsx` (R4); `cli/src/hooks/use-suggestion-engine.ts` (R4d); `cli/src/services/memory-v2/bun-sqlite-memory-repository.ts` (R4e)
- `sdk/src/run.ts`, `packages/indexer/src/index-manager.ts` (R5a/b); `cli/scripts/build-binary.ts`, `sdk/scripts/build.ts`, `.github/workflows/cli-release-build.yml` (R5d)
- Frozen contracts: `common/src/util/content-hash.ts` (cap.v3), `sdk/src/services/workspace-mutation-broker.ts`, `common/src/tools/compile-tool-definitions.ts`

## Risks

- Distribution matrix pain (OS × CPU × libc) — the Prisma lesson; mitigated by napi-rs prebuilt matrix + graceful TS fallbacks.
- Cross-language serialization overhead at every NAPI boundary — keep boundaries coarse (batch APIs), not per-call.
- WASM→native parse parity drift — golden parse fixtures must be identical across both paths during transition.
- Test harnesses protect behavior, not performance — add throughput/latency golden corpora before each wave to prove the win and catch regressions.
- Vector-space cache mixing if embeddings cacheKey isn't namespaced before local embedders land.