# STATUS — Polyglot Roadmap v2

Updated: 2026-09-26.

## Current state
- Roadmap v2 is written: SPEC.md and PLAN.md, with 11 phases (P0–P10), 6 cross-cutting foundations, and a traceability matrix that covers all 89 re-audit findings and the 72 prior-audit findings.
- `.agents/sessions/polyglot-native-waves/` is superseded. Its W0-1 work (the packages/native-core scaffold and the CI prebuild matrix) is kept and continues under X-3.
- No implementation has started. The next task is P0-T1.

## Verified during planning
- `sdk/src/env.ts:49` `getSystemProcessEnv()` returns the full `process.env` (P0-T1).
- `packages/agent-runtime/src/run-programmatic-step.ts:368` runs string handleSteps through `new Function`. `@jitl/quickjs-wasmfile-release-sync` is a dependency in sdk/package.json:62 but isn't used on this path (P9-T4). This resolves the QuickJS contradiction the re-audit flagged.

## Open decisions
D1–D8 are listed in SPEC.md, with a default for each and the task where each gets resolved.

## Resume instructions
- Start at P0-T1. Tasks within P0 are independent of each other.
- Run X-1, X-4 and X-5 alongside P0, before P1.
- Every task must pass the validation gates in PLAN.md. For security-boundary tasks, security-reviewer approval is required.

<!-- update_plan_status:appended -->
## Decisions D1–D9 locked — 2026-09-26T08:52:57.323Z

All open decisions are now locked in SPEC.md under "Locked decisions". The user overrode the defaults on two of them:
- **D7:** a Rust sidecar (mistral.rs / llama-cpp-2) from the start. Reason: node-llama-cpp has an open segfault under Bun (oven-sh/bun#27320).
- **D8:** remove `packages/native-core` and start a fresh Rust workspace at P4/P5. PLAN.md now has X-3a (removal, which needs explicit confirmation before any deletion) and X-3b (the new workspace).

D9 was added: adopt ACP v1 through `@agentclientprotocol/sdk`, with namespaced Openbuff extensions. Adding that dependency will need approval.

D3 is GPL-3.0-only, which is incompatible with Openbuff's Apache-2.0 license. It may therefore only be used as an external CLI that the user installs.

P1 is unblocked. The next task is still P0-T1.


<!-- update_plan_status:appended -->
## P1-T1 security follow-ups — 2026-09-26T09:26:02.994Z

Follow-ups on the P1-T1 security review are done.

**Assumptions verified (recorded in design §13):**
- MCP tool calls bypass harness approval (run.ts:1816-1843).
- The MCP SDK 1.20.2 stdio child env is the default allowlist plus the config env.
- `gatePassedFingerprint` is an unkeyed sha256 and grants no authority.
- ACP SDK 1.5.0:
  - keeps request ids per connection;
  - does not validate `optionId`;
  - rejects pending requests when the connection closes;
  - caps ndjson frames at 32 MiB by default.

**Code change:** `common/src/mcp/client.ts` now has `MCPConfigOrigin` and `resolveMCPConfigValues`.
- Configs with origin `client` are never `$VAR`-expanded.
- The origin is part of the cache key.
- The default stays `project`, so current trusted callers behave the same.
- 4 new tests; 8/8 pass; common and sdk typecheck clean.

**Design:** P1-T1-DESIGN.md is now rev 3.
- §12 covers SEC-1…9 and §12.8 covers the second review's NEW-1…7.
- Added GV-15…GV-29 and property tests.

**Blocking before P1-T2 ships:**
- NEW-1: the origin registry, loader marking, and a fail-closed default. Currently only specified in the design, not built.
- The approval commandHash contract change.
- The client-tool first-call approval hook.
- ~~Checking whether published/database templates can carry `mcpServers`.~~ Closed 2026-09-26 (see below).

<!-- update_plan_status:appended -->
## Database-template mcpServers check closed — 2026-09-26

Verified and recorded in P1-T1-DESIGN.md §13, under "Database agent templates".

**Finding.** The path is dormant, not exploitable today. The SDK injects `localFetchAgentFromDatabase`, which always returns `null` (`sdk/src/impl/agent-runtime.ts:76,137-146`), and the real registry fetch is referenced only by tests.

**Latent risk.** If the fetch is re-enabled, a database template's `mcpServers` survive validation unchanged. They would reach `getMCPClient` at `run.ts:1216` and `run.ts:1819` with the default origin `'project'`, so `$VAR` expansion would run on them.

**Action.** Folded into the NEW-1 origin-registry work. It is not a separate blocker:
- M-1: mark entries `'client'` in `agent-registry.ts` after each database fetch.
- M-2: mark the final template in `database.ts:319-323`.
- M-3: make `getMCPClient` default to `originOf(config) ?? 'client'` (fail-closed).
- Test GV-30 covers this.

**Still blocking before P1-T2 ships:**
- NEW-1 origin registry, including M-1…M-3.
- Approval commandHash contract change.
- Client-tool first-call approval hook.

<!-- update_plan_status:appended -->
## P0 progress — 2026-09-26

Committed on `feat/polyglot-reaudit-roadmap` (not pushed):
- **P0-T1** child-env credential strip — `c87263595`.
- **P0-T3** tmux teardown fix (partial; `bash -n` test + profile verification still open) — `c87263595`.
- **P0-T4** Chrome `chromeSandboxArgs` (partial; `--remote-debugging-pipe` transport still open) — `10e048a42`.
- **P0-T5** tree-sitter `hasError` preflight for the 10 previously-unvalidated languages (async, fail-open) — `ad75fa62c`.
- **P0-T6** eval statistics + significance gate — `6da95613a`.
- **P0-T7** all 8 sub-items done — `ba6522502`, `398a77a2c`, `6da95613a`, `b30dcfd2d`.
- **P0-T2** approval-rerun one-shot token (SB-6), sec-review LOOKS_GOOD — `b30dcfd2d`.
- **LI-11 remainder** dedicated tree-sitter-c grammar for `.c`/`.h` — `b30dcfd2d`.

**Still open in P0:** P0-T8 (structured JSON/SARIF diagnostics). Deferred residuals: SB2-F1 (generic OPENAI/ANTHROPIC/OPENROUTER_API_KEY not stripped from child env), SB2-F2 (blender spawn full env), EV-3 `isResultDelimiterBalanced` replacement.

**Update — P0-T3/P0-T4 completed (2026-09-26).** Committed `e66f2f0cc`:
- **P0-T3 (SB-5) done:** `agents/__tests__/tmux-cli.test.ts` runs `bash -n` over the tmux-cli agent's generated helper/setup/teardown scripts (4/4 pass) and pins the declared `tmux-test` profile. Profile-scope finding surfaced honestly: the agent-runtime handler forwards `permission_profile: 'full-access'` for all agents, so `tmux-test` is enforced at the policy-function layer, not the runtime handler layer — documented, not silently rewired.
- **P0-T4 (SB-7) done:** `sdk/src/tools/cdp-pipe-transport.ts` (new, NUL-framed fd 3/4 transport; bounded buffers fail closed; request correlation; bounded outbound backpressure) and `browser-logs.ts` migrated pipe-first with per-executable `detectPipeSupport` (timeout fails closed, demonstrable failure falls back to `--remote-debugging-port=0` ws bridge with bounded backpressure and teardown disposal), multiplexed flatten-session routing, stale-session rollback, APNG chunk assembly without payload copies, ws-URL token redaction, and ownerless-session reaping. 76/76 tests; migration/performance/security reviewer rounds all LOOKS_GOOD.

**Update — P0-T8 completed (2026-09-26).** Committed `92039a5a`:
- **P0-T8 (LI-05) done:** `sdk/src/tools/language-diagnostics.ts` now has six structured parsers tried before the regex fallbacks — cargo/rustc `--message-format=json` (native 1-based spans, `suggested_replacement` fix-its with `suggestion_applicability` mapped to an exported `LanguageDiagnosticTextEditApplicability`), ruff `--output-format=json` (fix.edits, case-insensitive severity), pyright `--outputjson` (LSP-style 0-based line/character), eslint `-f json` (offset-mapped fix-its when source is available), `go vet -json`/`golangci-lint --out-format=json`, and SARIF 2.1.0 (uriBaseId resolution against `originalUriBaseIds`, `%SRCROOT%` placeholder stripping, percent-decoded URIs, ErrorLog file ingest with a bounded cwd-honoring read). `LanguageDiagnostic` gained optional `fixes`/`relatedInformation`; both barrels export the new types. The default parse runs structured + regex dual-pass with content-aware dedupe and an interleaved MAX_DIAGNOSTICS cap so structured output can never starve plain-text stderr diagnostics, and the plain-text go-vet path skips JSON lines so mixed runs are never double-counted. 31/31 language-diagnostics tests; 29/29 file-change-hooks tests; full typecheck clean; compatibility-reviewer + code-reviewer LOOKS_GOOD.

The P0 batch (P0-T1 through P0-T8) is now fully complete.

<!-- update_plan_status:appended -->
## P1-T2 groundwork — NEW-1 MCP origin registry complete (2026-09-27)

Committed `045365e2` on `feat/polyglot-reaudit-roadmap` (not pushed):
- **NEW-1 origin registry (M-1…M-3) done.** `common/src/mcp/client.ts` records config origin out of band in a WeakMap (`markMCPConfigOrigin`/`markAllMCPConfigOrigins`/`originOf`), never from config content, with a no-upgrade guard (a `'client'` mark can never be raised to a trusted origin) and a fail-closed default (unmarked → `'client'`, no `$VAR` expansion, one-time `diagnoseFailClosedEnvRefs` warning).
  - **M-1:** trusted on-disk loaders mark their configs — `load-mcp-config.ts` marks `mcp.json` servers `'user'`/`'project'` by path; `load-agents.ts` marks agent-embedded `mcpServers` by path.
  - **M-2:** database-fetched templates mark `'client'` on fetch/cache (`agent-registry.ts`, `database.ts`); `assembleLocalAgentTemplates` re-marks `'database'`-provenance configs `'client'` so the identity-losing Zod re-parse into `fileContext.agentTemplates` cannot upgrade them, and `propagateMCPConfigOrigins` carries marks across the re-parse.
  - **M-3:** `resolveMCPConfigOrigin` fails closed to `'client'` for unknown-provenance configs; the trusted blanket mark is provenance-gated so unmarked source configs are never silently upgraded.
- **Single connect-time `$VAR` substitution.** Removed all loader-side env resolution (`resolveMcpEnv`/`resolveMcpConfigEnv`/`resolveAgentMcpEnv`); `resolveMCPConfigValues` is now the sole, origin-gated substitution site (one pass, no re-scan). Missing vars throw `MissingMcpEnvVarError` uniformly across whole-value env, inline env, and http/sse headers — but only on the trusted branch; `'client'` origins pass values through literally and never throw. Env-key case is preserved in cache identity so `API_KEY`/`api_key` stay distinct.
- Coverage: `client.test.ts` (32 tests), `load-mcp-config.test.ts`, `load-agents.test.ts` (new `mcpServers origin marking` block asserting project/user), `agent-registry.test.ts` (NEW-1 client/project/re-parse/db-provenance suite). Full typecheck clean; migration-reviewer, compatibility-reviewer, and code-reviewer all LOOKS_GOOD.

**P1-T2 is now unblocked** on the origin-registry axis. Remaining P1-T2 prerequisites from the P1-T1 design review: the approval commandHash contract change and the client-tool first-call approval hook.

<!-- update_plan_status:appended -->
## Cross-cutting foundations X-1…X-6 + P0-T5 remainder complete (2026-09-27)

All six foundation tasks and the final P0-T5 item are done (details in PLAN.md):
- **X-1 (contract freeze + golden vectors):** `compileToolJsonSchemas()` per-tool artifacts + the mapper's silent-`any` fallback now throws; golden-vector suite 32/32 (cap.v3 round-trip/scope-rejection, FileMutationResultV1/CommitReceiptV1 valid+reject vectors, deterministic per-tool schema pins — glob fixture regenerated from the real pipeline); base2 spawn-contract emission (`agents/base2/spawn-contract.ts`) with a byte-identical legacy fallback, roster-drift prose-sync test retired in favor of derived-clause coverage; spawn-contract/roster-drift/quality-prompt-snapshot 39/39, base2 242/242. The rg env override golden vector is deferred.
- **X-2 (golden baselines):** `scripts/measure-perf-guards-baseline.ts` extended with CASE 6 (token counting, raw + capped), CASE 7 (rg line-parse, honestly labeled), CASE 8 (X-2a hot paths, D13-attributed), CASE 9 (stream parse); baseline run green (8/8 parity rows) with keystroke/cold-start documented as manual-only rows (no fake numbers).
- **X-2a (D13 prerequisites):** stat-gated hashing (metadata-indexer 26/26), interval-stack `assignDepths` (structure 19/19), bounded vocabulary scan (new query-data suite) — all behavior-preserving.
- **X-3a (user-confirmed deletion):** `packages/native-core/` + `native-core-build.yml` deleted, tsconfig reference removed, zero remaining references; the degraded-mode/telemetry loading pattern preserved first in `X-3B-DESIGN-NOTE.md`.
- **X-3b (Rust workspace):** `rust/` cargo workspace with pinned `rust-toolchain.toml` (1.87.0), a real harness crate whose test passes (`cargo test` green), CI skeleton with the 5+ target matrix gated behind the first real crate, README + tracked Cargo.lock; the 5+ matrix lands with P5-T1.
- **X-4 (D16 freeze):** `language-capability-manifest.ts` + golden-vector suite 11/11 (byte-frozen serialized registry, JSON round-trip, schema rejects unknown keys/stages); protocol/doctor/status-bar advertisement rides P1-T1/P1-T2.
- **X-5 (sidecar supervisor):** `sdk/src/services/sidecar-supervisor.ts` (handshake/version negotiation, JSON-RPC with timeouts, exponential restart backoff + typed events, child env via `getChildProcessEnv`); fake-sidecar tests 6/6 (crash→restart, attempts-exhausted, requests-while-restarting, stop). Checksum-verified downloads land with the first real sidecar.
- **X-6 (citations):** memory `:2670`→`:1553` (both occurrences), sixel `:155`→`:199` and depth-audit `:183–186`→`:196–199` (verified live), SUPERSEDED banner on `polyglot-native-waves/STATUS.md`.
- **P0-T5 (EV-3 remainder):** `tryNearMatchAutoCorrect`'s delimiter gate is now the tree-sitter ERROR-node check on the full candidate content (bracket check kept only as the grammar-unavailable fail-open fallback); process-str-replace 159/159 with new EV-3 cases.

**Validation:** full monorepo typecheck clean (including the env-architecture check after the supervisor's `process.env` read was routed through `getChildProcessEnv`). All work is on `feat/polyglot-reaudit-roadmap`, pending gate + commit.
