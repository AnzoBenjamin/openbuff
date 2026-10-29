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

<!-- update_plan_status:appended -->
## P1-T1 ACP skeleton complete (2026-09-27)

Committed `d63c3a053` on `feat/polyglot-reaudit-roadmap` (pushed to PR #93):
- **Dependency:** `@agentclientprotocol/sdk@1.5.0` added to sdk (user-approved per D9). Note: the dependency-manager failed 4× with `bun --filter` "No packages matched the filter" — root cause investigated 2026-09-27: bun 1.3.14 has no `bun add --filter` (shipped in 1.4.0, PR #38333) and its space-form `--filter <name> run` matcher rejects valid workspaces; verified working invocation is `bun add --cwd <dir> <pkg>` (see LESSONS.md).
- **Skeleton:** `sdk/src/services/acp/acp-agent.ts` — `createAcpAgent` (initialize with the SDK's PROTOCOL_VERSION + honest `loadSession: false`; newSession unique ids; prompt forwards text blocks to an injected `AcpPromptHandler` with per-chunk `sessionUpdate` streaming + AbortSignal; cancel; authenticate-refusal) over a private session map; `serveAcpOverStdio` (ndJsonStream + AgentSideConnection) ready for the P1-T2 bridge.
- **Conformance:** 6/6 tests including a real `ClientSideConnection` paired over in-memory ndjson streams (true wire framing); sdk typecheck clean; code-reviewer LOOKS_GOOD.
- **Remaining P1-T1:** (none for the protocol surface — see the followup below)

<!-- update_plan_status:appended -->
## P1-T1 continuation complete (2026-09-27)

The three remaining P1-T1 pieces landed in the followup pass:
- **session/load:** `Agent.loadSession` implemented (session id registered in the same private map so prompt/cancel work; injected optional `loadHandler`, protocol error when absent); initialize now advertises `loadSession: true` honestly.
- **Reverse requests:** an optional injected `reverseRequests` seam (requestPermission/readTextFile/writeTextFile/createTerminal, types taken verbatim from the SDK declarations) is threaded into the `AcpPromptHandler` input so a prompt turn can drive permission/fs/terminal round-trips; P1-T2 binds it to the real connection.
- **Extension schemas (X-1 pipeline):** `sdk/src/services/acp/extensions.ts` — `openbuff/getReceipts`, `openbuff/askUser`, `openbuff/gateState` as Zod v4 contracts with `compileAcpExtensionJsonSchemas()` mirroring `compileToolJsonSchemas` (deterministic `z.toJSONSchema(io:'input')` per method, params+result); `extMethod` on the Agent validates params via safeParse (RequestError.invalidParams with the joined Zod issues on failure) and dispatches to an injected `extensionHandler` (method-not-found when absent/unknown).
- **Validation:** ACP suites 16/16 (incl. the real ClientSideConnection wire test), full sdk suite 1713/1713, sdk typecheck clean.
- **Still open under P1:** binding the extension handlers to real receipt/gate-state sources (P1-T2) and custom-tool schemas (P1-T4).

<!-- update_plan_status:appended -->
## ACP extension live-data wiring complete (2026-09-27)

`openbuff/getReceipts` and `openbuff/gateState` now return live data without an injected handler:
- **`sdk/src/services/acp/session-data.ts` (new):** bounded per-session store (256 newest receipts, one gate snapshot) with `recordReceipt` fed from the real `FileMutationResultV1` (`@codebuff/common/tools/results/filesystem`), `updateGateStateFromBlock` parsing the published `<gate-state>` JSON block contract (base2's `formatGateStateBlock`), and `toWireReceipt` building the design-§6.2 redacted envelope — drops `afterContent`/`patch`/`editAnchor` at every action, forces `freshCapabilities: []`, keeps `authorityReceipt` verbatim (cap.v3 tokens never leave the core).
- **Default handlers in `extMethod`:** with `sessionData` injected and no explicit `extensionHandler`, `openbuff/getReceipts` flattens the live envelopes ({operationId, receiptId, paths, actionIds}, deduped, limit default 50/cap 256) and `openbuff/gateState` projects the parsed block (passed→`final_response_allowed`, failed/skipped→`blocked`, validation→`validating`, reviewer→`reviewing`); injected handlers still win. Run-loop feeding (`recordReceipt`/`updateGateStateFromBlock` from the real core) lands with P1-T2.
- **Validation:** new `acp-session-data.test.ts` (real schema-built fixtures incl. redaction invariants + malformed-block persistence) + existing ACP suites all green, sdk typecheck clean.

<!-- update_plan_status:appended -->
## P1-T2 client-tool first-call approval hook complete (2026-09-27) — 2026-09-27T20:37:52.569Z

The second remaining P1-T2 security prerequisite (the first, the approval commandHash contract, already exists for terminal commands and is reused) now landed:
- **`sdk/src/run.ts` `handleToolCall`:** the MCP-dispatch branch gates the FIRST call of each tool from a `client`-origin MCP config (origin via `resolveMCPConfigOrigin`, which fails closed to `client` for unmarked configs) behind the existing `requestApproval` host callback. Approved `(getMCPClientCacheKey({origin:'client'}) \u0000 toolName)` keys are remembered in a per-run `Set<string>` (`approvedClientMcpTools`, declared in `runOnce` and threaded through) so subsequent same-tool calls run freely (per-tool-once). Trusted (`user`/`project`) origins are never gated. Denied → the existing MCP error-output shape, `callMCPTool` never invoked. Missing approver (headless/CI) → fail-open auto-approve so non-interactive runs are not broken (user-confirmed default).
- **`sdk/src/services/harness-enforcement.ts`:** `'mcp-tool'` added to the `ClassifiedHarnessAction` action union so the approval request typechecks; `classifyTerminalHarnessAction` never returns it and `evaluateHarnessActionPolicy` is not on this path (approval goes through `requestApproval` directly).
- **Validation:** `sdk/src/__tests__/run-mutation-dispatch.test.ts` gained 5 cases (first-call prompt+run+record, no re-prompt on second same-tool call, denied→error+no-call, no-approver fail-open, trusted-origin never prompts); full sdk suite 1735/1735, sdk typecheck clean.
- **Security review:** security-reviewer verdict NON_BLOCKING — two low observations (fail-open is a documented host-integration tradeoff bounded by the SEC-3 SSRF guard + literal client-origin values; `'mcp-tool'` omitted from `evaluateHarnessActionPolicy`'s high-impact set is unreachable defense-in-depth), no code change required.

Both P1-T2 security prerequisites are now satisfied. The remaining P1-T2 work is the `openbuff serve --stdio|--socket` bridge itself (client-origin marking at the ingest boundary, `sanitizeOutbound`, socket peer-cred auth, CLI entry) plus the `@agentclientprotocol/sdk` dependency (already added).

<!-- update_plan_status:appended -->
## P1-T2 serve bridge landed (2026-09-28) — 2026-09-28T05:52:01.984Z

The `openbuff serve` ACP bridge is now built end-to-end (both security prerequisites already landed earlier):
- **Wave 1 — sdk core:** `sdk/src/serve/bridge.ts` `createServeBridge` binds the ACP `AcpPromptHandler` to `OpenbuffClient.run()`: it forwards ONLY model-visible assistant text (`PrintModeEvent` type `'text'`) through `sanitizeOutbound`, structurally DROPS `tool_call`/`tool_result`, records confirmed mutations via `AcpSessionData.recordReceiptFromMutationEvent` (new adapter over `FilesystemMutationEvent`, redaction-preserving by construction), scans forwarded text for `<gate-state>` blocks, and maps an aborted run to `stopReason:'cancelled'`. `sdk/src/serve/outbound-filter.ts` `sanitizeOutbound` redacts cap.v3 tokens + provider-secret value shapes (SEC-1 last-line filter). `recordReceipt` refactored to share a `pushEnvelope` tail.
- **Wave 2 — transport + CLI:** `sdk/src/serve/socket-listener.ts` `serveAcpOverSocket` (SEC-4: owner-only/non-symlink/no-group-write parent-dir check, exclusive `.lock`, stale-socket unlink, 0o600 socket, constant-time token auth with an auth-timeout, no TCP, idempotent close, geteuid-guarded so socket mode fails loud on Windows); `sdk/src/serve/serve.ts` `runServe` selects stdio vs socket over the Wave-1 bridge; `cli/src/cli-args.ts` gained a `serve` subcommand (`--stdio` default / `--socket [path]` / `--socket-token`) parsed WITHOUT registering a commander subcommand on the prompt parser (so positional prompts are never treated as commands). `--socket` with no path now errors instead of silently degrading to stdio (compatibility-reviewer finding cleared).
- **Validation:** sdk full suite 1756/1756, serve suites 17/17, cli-args 15/15, sdk+cli typecheck clean. code-reviewer LOOKS_GOOD; compatibility-reviewer's one NON_BLOCKING finding (socket-optional-path-silent-stdio) repaired and re-validated.
- **Still deferred:** wiring `runServe` into `cli/src/index.tsx` (the `serve` subcommand is parsed but not yet dispatched — noted in a code comment); client-origin marking of client-supplied `mcpServers` at the bridge ingest boundary (the `markClientMcpServers` seam exists on ServeBridgeOptions but is not yet exercised); the run-loop is bound to `agent:'base'` as a starting default.

## Protocol reliability amendments added to the plan (2026-09-28)

Per the user's request after the JSON/XML + subagent-output discussion, six amendments (D19–D24) were added to SPEC.md under a new "Protocol reliability amendments (2026-09-28)" section, and a matching PR task set (PR-T1..PR-T6) was inserted into PLAN.md ahead of P1 with dependency + traceability updates:
- D19/PR-T1 typed subagent handoff envelope (outcome ok/missing_output/schema_invalid/truncated/crashed; no silent false completions) — precedes P2-T8.
- D20/PR-T2 out-of-band output store + bounded parent summary + last_message fragment merge (removes spawn-agent-utils inline truncation).
- D21/PR-T3 tool-argument normalization at dispatch (unserialize stringified JSON, log+count; flatten double-encoding-prone schemas: edits/agents/followups).
- D22/PR-T4 plain-text edit payloads (SEARCH/REPLACE or diff blocks; JSON keeps only metadata) behind an eval-confirmed flag; XML never parsed from model text.
- D23/PR-T5 content-hash attestation + gate arming policy (docs-only edits don't re-arm review; memory-drift guard accepts a recorded receipt).
- D24/PR-T6 fail-loud structured outputs + the context-pruner crash fix.

Live evidence for every amendment exists in this session: the first STATUS.md append was rejected twice because the `edits` array itself was serialized as a string — the exact D21 failure class — and had to be re-issued as a real array.

## Session design docs incorporated into the plan (2026-09-28)

Per the user's request, the standalone files under this session dir were folded into PLAN.md so the plan is self-contained:
- A "Design documents" index was added to the PLAN header pointing at P1-T1-DESIGN.md (normative ACP contract, GV-01…GV-30, §12 security), P1-T2-DESIGN.md (bridge design; its §6 prerequisites are all landed), X-3B-DESIGN-NOTE.md (Rust workspace charter), D24-OUTPUT-LOSS-TRACE.md (confirmed status fail-open behind D24/PR-T6) and LESSONS.md (bun 1.3.x `--filter` dependency rule).
- The P1-T1 PLAN entry now cites the protocol contract and records that the design doc's §13 prerequisite list (origin registry, commandHash, first-call approval hook) is fully landed.
- The P1-T2 PLAN entry was expanded from `[ ]` to `[~]`: DONE = the bridge core landed 2026-09-28 (serve files, SEC-4 socket auth, sanitizeOutbound, approval commandHash + first-call MCP approval gate, client-origin ingest marking + identity-preserving attach, journal restore, getReceipts/gateState); REMAINING = the P1-T1-DESIGN-derived surface (ext v1 methods + GV fixtures, full event-bridge mapping, session/load replay, NEW-2 trust default, NEW-3 holdback, NEW-6 sensitive rawInput, SEC-7 containment, limits, NEW-7 rebinding pinning).
- A dependency-rule bullet was added to PLAN's Dependencies section: dependency mutations go through `bun add --cwd <ws>` (LESSONS.md bun 1.3.x finding).
- X-3b already cited its design note; no change needed. EVENTS.jsonl is a runtime event log, not plan content — deliberately not incorporated.

## Compaction quality & archive recall amendments added to the plan (2026-09-28)

Per the user's follow-up (compaction too lightweight; recall_context returns nothing; would language unlocks help), four amendments (D25–D28) were added to SPEC.md under "Compaction quality & archive recall amendments (2026-09-28)" and a CQ task set (CQ-T1..T4) to PLAN.md:
- D25/CQ-T1 eval-gated hosted-model retention floor (open blockers + eviction pointers + next-action preserved verbatim; the existing retention evals become a blocking gate).
- D26/CQ-T2 evictions become archived first-class records (rides D20/P2-T2).
- D27/CQ-T3 recall_context indexed over archives (TS FTS5 first via P8-T8 pull-forward; Rust tantivy tier rides P6-T6).
- D28 language roles: Python sidecar (D2) extended to compaction selection — LLMLingua-2/summarizer/reranker run natively, absorbing P9-T7's quality core; Rust (X-3b) covers retrieval speed only.
- PLAN cross-refs updated: P9-T7 scoped down, P8-T8 annotated as pulled forward for archives; dependency lines + traceability tail extended.

## PR-T1 typed handoff envelope landed (2026-09-28)

PR-T1 (D19) is implemented and reviewed:
- `common/src/types/agent-handoff.ts`: additive optional `outcome` enum on `agentReceiptSchema` (`ok`/`missing_output`/`schema_invalid`/`truncated`/`crashed`); legacy receipts without it stay valid.
- `spawn-agent-utils.ts` `buildRuntimeAgentReceiptOrThrow`: outcome derived from runtime evidence (precedence crashed > missing_output > schema_invalid > truncated > ok). A runtime-derived non-ok outcome downgrades a would-be `completed` receipt to `partial` with an explicit retryable error unless runtime-attested mutations are the completion authority (RF-2 preserved).
- Closes both holes from D24-OUTPUT-LOSS-TRACE.md: the status fail-open (researcher-web/librarian/thinker runs without set_output resolved to `completed` with zero errors) and the child self-declared-status rescue (`findReceiptStatus` crediting a nested `status:'completed'`).
- Validation: fault-injection suite 23/23 (9 new tests incl. the D24 regression), full handlers dir 228/228, common+agent-runtime typecheck clean, code-reviewer LOOKS_GOOD.
- Meta-evidence: the STATUS.md append for this note was itself rejected once with `edits: expected array, received string` — the exact D21 failure class this envelope is designed to eliminate.

## PR-T2 out-of-band output store landed (2026-09-28)

PR-T2 (D20) is implemented on top of the PR-T1 envelope:
- `spawn-agent-utils.ts` `normalizeSpawnedAgentOutput` now merges multi-fragment `lastMessage` outputs into one assistant message before bounding (the token-sized-fragment `omittedItems: 100+` failure class), conservatively — any non-all-assistant-text shape returns unchanged.
- `boundAgentOutputForParent` oversize paths (verdict-shaped fast path + general fallback) persist the FULL serialized output to `os.tmpdir()/openbuff-spawn-output/<sha256>.json` and the parent-visible shape gains `artifactPath`/`artifactBytes`/`artifact` pointer fields; `artifactPath` is in `HIGH_FIDELITY_STRING_FIELDS` so the pointer is never clipped. Write is best-effort fail-open (tmp unwritable → fields omitted, receipt unchanged).
- Validation: suite 35/35 (12 new), handlers dir 240/240, agent-runtime typecheck exit 0 (after repairing a TS2305 tmpdir mis-import); code-reviewer LOOKS_GOOD.

## PR-T3 tool-argument normalization landed (2026-09-28)

PR-T3 (D21) slice 1 — generic schema-driven unserialize at the dispatch boundary:
- `tool-executor.ts` `coerceInputScalarsBySchema` walker: string values whose DECLARED schema type is 'array' or 'object' are JSON-parsed and accepted only on shape match; failures pass through unchanged (fail-closed, never thrown); parsed containers continue through the existing items/properties traversal, so nested coercion and nested object-strings normalize too.
- Every success increments a module-level `toolArgNormalizationStats` (total + per-tool) with an accessor + test reset — the "logged + counted, never silently" requirement.
- Schema flattening half DEFERRED with rationale recorded in PLAN.md: `edits`/`agents` already have dedicated repair paths and flattening the published provider schemas would change the wire contract mid-flight and invalidate the D17/X-1 golden vectors; the walker is the schema-keyed net for every other tool and for per-entry strings (followups).
- Validation: tool-validation-error 122/122 (new D21 describe block incl. an object-aliasing test fix — the stats getter returns the live object, so tests snapshot primitives eagerly), X-1 golden vectors 20/20, coerce-to-array 85/85, common+agent-runtime typecheck exit 0.

Live D21 evidence in this same session: the PR-T2 repair-editor `spawn_agents` call was rejected with `agents[0]: expected object, received string` — the exact double-encoding failure class this walker now repairs at the dispatch boundary.

## PR-T4 plain-text edit payloads implemented (2026-09-28, flag OFF; security-review pending)

PR-T4 (D22) implemented behind `OPENBUFF_EDIT_BLOCKS` (default off; flag-off path is byte-identical — X-1 golden vectors 20/20):
- `common/src/tools/params/edit-blocks.ts`: pure fail-closed `parseEditBlocks` (exact SEARCH/divider/REPLACE markers only, marker-collision detection with blockIndex for content-injection attempts, CRLF handled, 100%-block-content rule, never guesses) + `areEditBlocksEnabled` (find-files truthy-set pattern) + test override.
- `normalizeTransactionEditList` runs the parser first under the flag when the payload contains a SEARCH marker, feeding the existing per-entry pipeline (type inference, bounds, refinements unchanged); parse errors fall through to the existing JSON diagnostics.
- Flag-gated provider surface in `edit-transaction.ts`: description section + providerInputSchema string arm only when the flag is on at module load; the runtime inputSchema has NO string arm (the preprocess translates before schema evaluation), keeping `CodebuffToolCall` edits typed as the edit array and the handler untouched (this restructure fixed the TS7006/TS2322 inference fallout from the first union attempt).
- Deterministic eval scaffold `evals/edit-blocks/scenario.test.ts` (EB1 equivalence through the real schema, EB2 escaping-overhead with block≤json assertions for code fixtures, EB3 adversarial injection fails closed end-to-end, EB4 flag-off identity) + README noting the live completion-rate A/B (the actual flip gate) requires agent runs and stays manual.
- Validation: edit-blocks 26/26, common params 202/202, eval 10/10, handlers 240/240, common+agent-runtime typecheck exit 0.

## PR-T5 content-hash attestation + gate arming landed (2026-09-28)

PR-T5 (D23) — three slices:
- `Base2ReviewReceipt.reviewedFileHashes?: Array<{path, hash}>` (agents/base2/gate-state.ts, additive) populated at receipt build in base2.ts via `readGateFileContentMarker` for creditable markers only — reviewer receipts now carry per-file content hashes instead of session-timestamp identity.
- Docs-only edits after a reviewer pass skip the reviewer (`reviewer skip: docs-only edits after last review`, telemetry `reviewer-skip-docs-only-after-review`); base2.ts splits `editsHappened` into reviewable vs docs-only edit flags — the per-file content-marker eviction still catches real drift in reviewed files.
- `scripts/memory-drift-guard.ts` `checkStaleness` consults `<root>/.openbuff/memory/review-receipt.json` (loaded once per call, fail-open: missing/malformed = absent); a LOOKS_GOOD receipt whose `fileHashes` match the CURRENT sha256 of every file in the pair's last src commit (batched `git log -1 --name-only`) suppresses the stale finding — drift, missing entries, or wrong verdict keep it standing.
- Tests: memory-drift-guard 57/57 (7 new receipt tests; one fixture fix — receipt hash keys are individual committed file paths, not directory pathspecs), base2 receipt-hash + docs-only-skip tests green, agents + scripts typecheck exit 0.

## PR-T6 context-pruner crash fix landed (2026-09-28) — PR set complete

PR-T6 (D24) — the fail-loud half already landed in PR-T1 (typed `missing_output` outcome + status downgrade + retryable error; D24 regression test pins that a set_output-less researcher-web run no longer resolves `completed`). This task's remaining half:
- `agents/context-pruner.ts`: the tool-message JSON-part loop now guards `part.value` with object-type + null checks, so the `'exitCode' in value` and `'answers' in value` checks can no longer throw `TypeError: Cannot use 'in' operator` on truthy primitives (the crash reproduced 3x live this session). Arrays still flow through; falsy/0/null are still skipped; no downstream behavior change for well-formed objects.
- New describe block in `agents/__tests__/context-pruner.test.ts` reproduces the crash shapes (string value, `42`, `true`, and a string-valued `run_terminal_command` part), each asserting the pruner completes without throwing.
- Validation: pruner suite 127/127, agents typecheck exit 0, full monorepo typecheck green.

With PR-T1 through PR-T6 all landed, the protocol-reliability task set is complete; only PR-T3's schema-flattening half and PR-T4's live A/B eval remain deferred (both documented in PLAN.md).

## PR-T3 slice 2 closed as superseded + CQ-T1 retention floor landed (2026-09-28)

**PR-T3 slice 2 (D21 schema flattening): CLOSED, option A — no-op with recorded rationale.** The original premise (schema depth empirically triggers double-encoding) is superseded by slice 1's dispatch repair. Per-tool disposition verified from source: `followups` is already flat; `agents` needs per-agent `params` namespaces; `edits` escaping is solved by D22's block format. The walker's recursion coverage (stringified whole-`agents` array + nested stringified `params`) is now pinned by a regression test (tool-validation-error.test.ts D21 block, 12/12). Zero golden-vector churn — no providerInputSchema artifact changed. Re-open trigger recorded in PLAN.md: sustained per-tool repair rates in toolArgNormalizationStats.

**CQ-T1 (D25) hosted-model retention floor: TS slice LANDED.** `enforceKnowledgeMemoryBudgets` in `agents/context-pruner.ts` excludes `blockers` and `reviewReceipts` from the whole-block ceiling `EVICTION_ORDER` (D25 — open reviewer blockers and reviewer attestation fingerprints survive any compaction pass verbatim; per-field count/text caps still bound them). The performance-specialist round then hardened the guarantee: a superseded-review collapse (`collapseToNewestPerReviewer`) reclaims resolved-review history — the newest receipt + blocker per reviewer agent type — under ceiling pressure, so the hard ceiling remains an enforceable upper bound (the original naive exclusion could render the block ~1.4–1.6x over ceiling on small windows; the collapse closes that, and the ceiling loop still terminates with strict progress on every branch). The compaction-retention eval is now the blocking regression floor with nine scenarios: S1–S5 unchanged, S2 strengthened (seeded blocker survives the 8k-class window), S6 (blocker + receipt fingerprint both survive the small window, recall 1.0), S7 (worst-case pinned payload lands under the hard ceiling), S8 (a passing review supersedes older receipts from the same reviewer, and the LOOKS_GOOD receipt replaces the superseded BLOCKING history), S9 (ceiling pressure drains ordinary lists before touching receipts, blockers, or the task contract). Validation: compaction-retention 9/9, context-pruner 127/127, agents typecheck exit 0. Remaining for CQ-T1 proper: eviction pointers ride CQ-T2/D26; the selection-quality core stays with the D2 Python sidecar (D28).

## Review receipt seeded — drift-guard suppression exercised end-to-end (2026-09-28)

`.openbuff/memory/review-receipt.json` was seeded from the PR-T4 edit-blocks LOOKS_GOOD review (gate receipt 52yJXHzIQkQ): fileHashes carry raw-byte sha256 of the four files in the last commit touching `common/src` (the PR-T4 commit). Verified live: the memory-drift guard's only stale finding (`common/knowledge.md` vs `common/src`) is now suppressed with the log line `staleness suppressed by review receipt: common/knowledge.md`, and `guard:memory-drift` exits 0 with zero findings — the first end-to-end exercise of the PR-T5 receipt path against real repo state, replacing the timestamp-only knowledge.md touch pattern.

## CQ-T2 evictions archived + CQ-T4 multi-pass drift sweep landed (2026-09-28)

**CQ-T2 (D26) — evicted tool-result segments become retrievable archive records.** The "eviction is deliberately NOT archived" decision in `context-archive.ts` is superseded: `ContextArchiveSnapshot` gains an additive optional `tool_result_eviction` action plus `steps?: number[]` (original-transcript step provenance) and `reason?: string`; `evictStaleToolResults` returns an additive `evicted?: Array<{toolCallId, toolName, content, stepIndex}>` carrying the FULL pre-tombstone content (omitted on no-op paths); new `archiveEvictedToolResults` persists them identity-keyed, bounded by the existing archive cap (oldest dropped first), wired live in `run-agent-step.ts` before the history swap. `recallFromArchive` scans eviction snapshots as first-class recall sources. Gate test: round-trip — an archived fact is recallable after eviction. Validation: context-archive + tool-result-eviction suites 31/31, agent-runtime 1958/1958, common 1450/1450, common+agent-runtime typecheck exit 0. Journal persistence rides P2-T2.

**CQ-T4 (D25) — multi-pass drift sweep.** The compaction-retention eval gains S10 (three consecutive small-window passes, each pass's real set_messages output fed back as the next pass's input; blocker + receipt fingerprint survive every pass, final recall 1.0) and S11 (two cycles alternating baseline → small-window budget, proving the floor holds across window-size oscillation); a runSinglePass refactor exposes the compacted transcript for re-feeding; the README's single-pass-only known-gap note is closed. Validation: compaction-retention 11/11.

**PR-T4 live A/B: environment blocker recorded.** This session's environment has no OPENBUFF_API_KEY and no .openbuff/providers.json (verified via env + filesystem check), so the live completion-rate A/B cannot run here — it needs a provider-configured environment or the eval-runner CI path once P8-T0 lands. The deterministic half (10/10, block/json 0.795–0.984) is recorded in PLAN.md.

Meta-evidence: the STATUS.md append for this note was rejected once with `edits: expected array, received string` — the D21 failure class — before being re-issued as a real array.

## CQ-T3 indexed recall_context landed (2026-09-28)

**CQ-T3 (D27, TS slice) — `recall_context` queries an FTS5 index instead of brute-force substring scans, and empty is distinguishable from failed.** New `packages/agent-runtime/src/util/archive-recall-index.ts`: `recallFromArchiveIndexed` builds an IN-MEMORY bun:sqlite FTS5 index per call over flattened archive rows (dynamic `await import('bun:sqlite')`, no new npm deps; per-call build is the right shape while the archive is in-memory 8×200×4k — bounded, deterministic, cache-invalidation-free). Rows reuse the exported `stepProvenance` from context-archive.ts, so eviction snapshots' original-transcript steps flow through. User queries are sanitized (FTS5 operator/syntax chars stripped, terms double-quote-wrapped) so hostile input can never cause a syntax-error fallback. The `recall_context` handler emits additive `indexState: 'indexed' | 'fallback'` plus a bounded `indexError` — the D27 empty-vs-failed distinction — and fail-opens to the byte-identical `recallFromArchive` on any index failure (bun:sqlite unavailable, FTS5 unsupported, build/query error, >16MB text cap) with scanner-identical results. Gate test: recall-over-archive integration with seeded facts — indexed round-trip incl. eviction-snapshot step provenance, healthy-empty vs failed-index distinguishable, hostile-query sanitization, newest-first ordering, fail-open parity, shape compat. One debugger round fixed the fixture-vs-scanner provenance parity (rows now pin scanner-parity step semantics). Validation: archive-recall-index + context-archive suites 37/37, common full 1450/1450, agent-runtime + common typecheck exit 0. Remaining for CQ-T3 proper: BM25 ranking is available but recency-first ordering is kept for scanner-contract compatibility (documented in the module); Rust tantivy tier stays P6-T6.

## Sanitizer over-redaction fix + P2-T1 IdGen slice + P2-T2 design (2026-09-28)

**CLI payload sanitizer false-positive fix (committed cb89f427e).** `cli/src/utils/payload-sanitizer.ts` `isSensitiveKey` moved from a substring regex to a word-boundary rule: keys tokenize across camelCase/PascalCase/snake_case/kebab-case/SCREAMING_CASE, and a credential word (`token`/`secret`/`password`/`credential(s)`/`authorization`/`bearer`/`apikey`/`jwt`/`oauth`/`privatekey`) redacts only when it is terminal or followed by a carrier suffix (`url`/`uri`/`value`/`string`/`header(s)`/`key`/`hash`/`jwt`/`digest`/`token`/`secret`). Metadata keys that merely contain a credential substring — refreshTokenCount, tokenCount, maxTokens, tokenizer(Name), secretSantaName/Assignment — are now KEPT; every real credential key (accessToken, tokenUrl, tokenValue, clientSecret, x-api-key, oldPassword, …) still redacts. New `word-boundary key redaction` describe block pins the full REDACT + KEEP matrix across both sanitizeForDebugLog and sanitizeForChatPersistence. Validation: payload-sanitizer 15/15, full monorepo typecheck exit 0; code-reviewer LOOKS_GOOD (receipt 6ARr_jgz5o8). This closes the P2-T2-slice REPORTED sanitizer observation.

**P2-T1 IdGen slice 1 landed (uncommitted, pending gate).** See the PLAN P2-T1 entry: optional additive `IdGen` on AgentRuntimeDeps + `realIdGen` default, the three run-path identity mint sites routed through `idGen.uuid()`, three spy tests converted to inject a mock idGen. Clock/Date.now conversion and the remaining randomUUID sites are deferred to later P2-T1 sub-slices (thinker decision record). Validation: common + agent-runtime typecheck exit 0, the three suites 85/85.

**P2-T2 journal design doc written.** `.agents/sessions/polyglot-roadmap-v2/P2-T2-DESIGN.md` — the source-backed design for the append-only bun:sqlite run journal (event schema, four write points, replay-by-re-driving-the-generator resume model with tool-result idempotency short-circuit, kill-9 resume test, JournalWriter/Reader interfaces additive on AgentRuntimeDeps, staged slice plan). Explicitly depends on the P2-T1 Clock sub-slice for deterministic replay; the compaction-archive persistence slice remains its non-goal.

<!-- update_plan_status:appended -->
## P0→P1 sweep completion — 2026-10-01T21:14:00.386Z

2026-10-01 — All tasks from the start through P1 are implemented and validated.

- **P1-T2 final slices landed**: ext v1 methods + capabilities/receipts/gate-state/events ext surface; full §4.2 event-bridge mapping (receipts on tool_call_update _meta); session/load journal replay; NEW-2 trusted-roots serve default; NEW-3 outbound holdback; NEW-6 rawInput redaction; SEC-7 containment (CLI fallback documented); frame/prompt/session limits + outbound backpressure; NEW-7 DNS pinning (public-over-loopback pin target; allowlist threaded through the getMCPClient cache key so fail-closed semantics hold); §5 approval → session/request_permission + §4.2 ask_user elicitation bridge bound from the real ACP connection (reverseRequests derived from AgentSideConnection and threaded through prompt()); GV-15…GV-30 golden fixtures.
- **Wave-1 completions**: X-4 capability tiers in /doctor + status bar (derived from defaultCapabilityMapV1 — no hand-duplicated values); P1-T4 memory_search MCP tool (lexical, honest disabled payload); P1-T6 real TreeSitterClient fixture tests (no stubs; module-level destroyTreeSitterClient teardown); P1-T9 deferred OSC theme probe (renderer-path only — preserves protocol-wire exclusivity on serve/mcp/run/replay), deferred agent/skill registries with whenRegistriesReady gates on all consumers, WASM byte channel published at import time, login intercept removed; P1-T10 viewport-windowed message list; CQ-T1 eviction pointers (runtime-injected archivePointers, pruner-verbatim retention, backward-parseable section).
- **Reviewer rounds cleared**: compat-reviewer blockers repaired across seven rounds (advertisement honesty, prompt image forwarding, capability-map derivation, MCP client cache key, DNS pin ordering, registry consumer migration, OSC wire exclusivity); final receipt LOOKS_GOOD at rev 6238.
- **Validation**: typecheck clean in common/agents/agent-runtime/sdk/cli; suites green (golden 58/58, sdk serve/acp 78/78, common mcp+protocol 103/103, cli capability/status-bar/highlight 87/87, context-pruner 130/130, compaction-retention 12/12); tmux boot smoke passed (TUI renders, no crash).
- **PLAN.md**: X-4, P1-T1, P1-T2, P1-T4, P1-T6, P1-T9, P1-T10 marked done. Still open (later phases by design): X-3b, X-5, P2+.

<!-- update_plan_status:appended -->
## P3 semantic code intelligence — all 11 tasks implemented and validated — 2026-10-03T16:49:10.450Z

All P3 tasks (P3-T1…P3-T11) are implemented and validated; the per-task PLAN.md flips ride the gate-issued receipts minted when this turn's gate closes.

- P3-T1 LSP multiplexer: `sdk/src/services/lsp-multiplexer.ts` — ToolSpec-driven warm server per (language,root), LSP Content-Length framing, lazy cold start + init timeout, LRU eviction, bounded pending/frame buffers, restart-on-crash, `syncFile` doc-sync seam. 12/12 hermetic tests.
- P3-T2 agent tools: `go_to_definition`/`find_references`/`hover_type`/`workspace_symbol` end-to-end (params+output schemas, publishedTools, list.ts + clientToolCallSchema, sdk `language-intelligence` service with 1-based→0-based conversion + structured unavailable/error degradation, agent-runtime handlers, CLI renderers). Regenerated `agents/types/tools.ts`.
- P3-T3 diagnostic-delta preflight: `sdk/src/services/diagnostic-delta.ts` (P0-T8 parsers behind an injected runner; delta matcher with line-shift tolerance; reject-only-new-errors + fix-it aggregation); opt-in `OPENBUFF_DIAGNOSTIC_PREFLIGHT` hook in file-change-hooks.ts (flag-off byte-identical).
- P3-T4 SCIP ingestion: `packages/indexer/src/scip-ingest.ts` — validating SCIP-JSON parser, definition-bit → `confidence:'precise'` edges, heuristic fallback untouched, dedupe/supersede, caps, traversal guard (now fail-closed/observable per sec-review F2).
- P3-T5 real import resolution: canonical line-based extraction moved to `packages/code-map/src/import-sites.ts`; `packages/indexer/src/import-resolution.ts` resolves per ecosystem (TS relative/index/tsconfig paths, Python, Rust, Go go.mod-gated, JVM/PHP declaration-gated, conservative-unresolved); chunks.ts delegates; metadata-indexer shrank ~345 lines.
- P3-T6 enrichment: `sdk/src/services/symbol-enrichment.ts` — documentSymbol + hover + optional inlayHint merged into EnrichedSymbol[], sha256-content-keyed LRU, caps, unavailable-safe.
- P3-T7 test impact: `analyzeTestImpact` in harness-intelligence.ts — tiers convention/graph(injected)/build-tool/coverage(placeholder) with confidence labels; get_affected_tests gains additive optional `impact`.
- P3-T8 build graph: `sdk/src/services/build-graph.ts` — owning targets via cargo metadata / go list / package.json workspaces / pom-gradle / csproj / CMake / pyproject behind a runner seam; longest-prefix ownership, TTL cache, bounded walk.
- P3-T9 PageRank: `packages/indexer/src/pagerank.ts` personalized PageRank (deterministic, capped, WeakMap adjacency cache); opt-in additive `pageRankWeight` in queryIndex (default 0 = byte-identical ranking); `rankedRepoMap`.
- P3-T10 exact tokenizers: token-counter.ts ExactTokenCounter seam + `OPENBUFF_EXACT_TOKENS` truthy gate (off = estimator unchanged) + `getTokenizerForModel` family cache; HF/tiktoken providers land behind this seam (dependency-gated).
- P3-T11 semgrep baseline: `sdk/src/services/semgrep-baseline.ts` — `semgrep scan --baseline-commit --sarif` behind a runner seam, ref whitelist (argv-only), 200-file/60s/8MiB caps, SARIF via the P0-T8 parser; get_change_review_bundle gains additive optional `securityScan`, fail-open statuses.

Validation: typecheck clean across common/code-map/indexer/agent-runtime/sdk/cli/agents; new suites green (sdk 70/70 incl. language-intelligence/symbol-enrichment/build-graph/diagnostic-delta/semgrep-baseline/harness + get-change-review-bundle; indexer scip-ingest 11/11 + pagerank; agent-runtime token-counter + language-intelligence handlers). The indexer retrieval-quality repo test times out at its hardcoded 30s on this machine — verified environmental (tree-sitter indexing ~46s for 2190 files, pre-existing; my extraction change measures ~0.4ms/file and metadata-indexer lost ~345 lines).

Security review (P3 process/exec/ingestion surfaces): NON_BLOCKING with 4 low findings, all repaired this turn — F1 LSP malformed header now fails closed; F2 SCIP unsafe paths now fail closed/observable; F3 build-graph walk now depth+cap bounded iterative; F4 command-token whitelist (incl. gradle `:` project paths) with an argv-only execution note.


<!-- update_plan_status:appended -->
## P3 audit remediation wave landed — 2026-10-03 — 2026-10-03T18:23:45.803Z

The P3 coherence audit (6 shards, findings in findings/p3-*.md) surfaced 5 HIGH + several MEDIUM/LOW gaps. All landed this turn with mutation receipts:

- **HIGH-1 base2 reachability:** the four LSP tools added to MODE_NEUTRAL lists but absent from `packages/agent-runtime/src/util/base2-tool-tiers.ts` tier lists — fixed (tools now in the read/analysis tier; base2.ts confirmed to derive toolNames solely via resolveModelToolNames).
- **HIGH-2 diagnostic-delta dead in production:** NEW `sdk/src/services/diagnostic-delta-runner.ts` builds a fail-open injector over the run's child-process spawn seam; threaded into `run_file_change_hooks` and `run_targeted_validation` via `sdk/src/run.ts` (flag check stays inside runFileChangeHooks, flag-off byte-identical).
- **HIGH-3 syncFile unwired:** `syncMutatedFiles` added to the language-intelligence service (bounded 32 paths, per-path monotonic version, fail-open per path) and called at the committed-mutation site in run.ts (delete paths skipped, move syncs destination).
- **HIGH-4 per-directory root keying:** `defaultRootResolver` now walks upward (bounded 32) for the spec's rootMarkers (first wins); no-marker fallback unchanged; test pins one warm server across a subtree.
- **HIGH-5 renderer `{' '}` blank-app risk:** eliminated; renderer now reuses shortenPath, displays 1-based line AND column, has a settled '–' unavailable glyph (additive statusGlyph mapping), explicit 'no results' empty state, and a NEW render test suite + registry pin (REG-LI01).
- **MEDIUM/LOW:** param bounds (.max on line/character/query), PATH_INPUTS entries for the three position tools, semgrep ref whitelist tightened (no '..'/trailing '/', option-injection safe) + additive `truncated` cap flag surfaced through the securityScan schema, symbol-enrichment cache key now path-aware, owningTargets (resolveOwningTargets) wired additively into get_build_targets output, graphNote honesty note on get_affected_tests, conservative Python/Rust import resolution (no more bare-name false matches), repo-map localeCompare → code-point ordering, PageRank iteration/epsilon clamps, NEW opt-in `packages/indexer/src/scip-runner.ts` (argv-only table for 8 scip-* indexers, detection+index runners bounded, per-indexer fail-open, capped; IndexManager.ingestScipDump opt-in merge; automatic refresh-time running deliberately deferred), F1/F3 missing regression pins still tracked as remaining test work, module-header deferred notes on diagnostic-delta + build-graph, CASE 6c bounded ~5MB estimator row in the perf-guards baseline (D12 prerequisite), PLAN.md P3-T1..T11 entries flipped with honest DONE/DEFERRED notes, tool-definition mirrors regenerated (no diff — additive fields don't change generated output).

Validation: workspace-wide typecheck exit 0; targeted suites 0 fail (sdk 9 suites incl. lsp-multiplexer 15/15, diagnostic-delta, semgrep, symbol-enrichment; indexer 4 suites incl. scip-runner 10/10; agent-runtime token-counter 21/21 + handlers; common tools; cli components/tools incl. the new renderer suite). Known flake: token-counter LRU test failed once under parallel load, passes in isolation (5.6s timing-sensitive).


<!-- update_plan_status:appended -->
## P2 audit remediation wave landed — 2026-10-05 — 2026-10-05T12:39:34.421Z

The P2 coherence audit (8 shards, findings in findings/p2-synthesis.md + p2-a…p2-h) surfaced ~14 MEDIUM gaps. All landed this turn with mutation receipts:

- **P2-T2 crash-resume is now production-reachable:** sdk/src/services/run-resume-driver.ts wires executeRunResumeReport through the journal seam (fail-open best-effort re-drive); previously classify-and-log only.
- **Unowned deferrals named:** P2-T8b (supervised-child RPC bridge), P2-T8c (supervised restart policy); P2-T6b (transitionBase2GateSafe base2 adoption) DONE this wave; P2-T7 parity delta accepted-as-scope.
- **Security fixes:** dash token URL moved to stderr (tokenless stdout URL); malformed Authorization → 401; intent-log recovery is now lossless-aware (committed work never reverted); supervised-child env gained the closed runtime passthrough universe.
- **Reliability fixes:** P2-T4 pre-dispatch snapshot bounded-await + failure warn latch + cross-process bisect lock; P2-T9 bounded warn latch + one-restart policy + separator-agnostic remove-prefix; P2-T1 remaining ambient timestamp/identity sites converted and the determinism baseline regenerated (0 findings).
- **New tests:** Linux-only real-grandchild group-kill reaping; end-to-end ensureIndexWorkspaceWatcher (write→markPathsChanged, auto-add, dispose); bash-mutation→snapshot→undo chain.

Incident note: the base2 editor shard accidentally truncated agents/base2/base2.ts to 79 lines; restored byte-identical from HEAD and the P2-T6b change re-applied cleanly (base2.test.ts 249/249).

Validation: supervision 30/30, watcher 15/15, turn-snapshot suites green, sdk 77/77 (journal-wiring/intent-log/dash), agent-runtime affected suites 233/233, sdk/agents/cli typechecks clean, determinism guard 0 findings.

## Truncation-fix wave landed (2026-10-18) — commits e83d32b17…62686e93c on PR #93

Three commits delivered the truncation-driven token-waste fixes:
- **e83d32b17** — base2 `maxOutputTokens: 64_000` (closes the Anthropic ~4k provider-default mid-JSON cut of large edit_transaction payloads); SYNC `run_terminal_command` full-output persistence (`fullLogPath`/`logBytes` content-addressed scratch artifact, 0o600 file, additive schema fields, 3 new tests); `.envrc` sets `OPENBUFF_EDIT_BLOCKS=1` (live exercise passed: edit via blocks in 35s).
- **6f842695c** — reviewer advisories cleared: SYNC timeout timer `unref()`d, artifact dir `mkdirSync` mode 0o700, `spawnCwd` rename (was shadowing the outer resolver-result `resolvedCwd`).
- **77892e195** — ToolBranch fallback fixture refresh (web_search now exercises the fallback path) + the live tmux exercise lessons recorded in `cli/tmux.knowledge.md`.
- `f62253a4a`/`62686e93c` — the sanctioned `common/knowledge.md` + `cli/knowledge.md` staleness-refresh entries satisfying the pre-push memory-drift guard (the earlier push attempt failed the guard; fixed via the repo's own refresh pattern, never `--no-verify`).

Live-run diagnosis: the run summary's "Errors: 5-6" was benign — repeated `git_status: fatal: not a git repository` output from a non-git scratch dir; empty session.log (stderr) is the real health signal.

Binary rebuilt and reinstalled at `~/.local/share/openbuff-test/openbuff-branch` (139.7 MB, smoke pass, --version 1.0.0).

## OPENBUFF_EDIT_BLOCKS flipped default-on + live A/B measurement (2026-10-18)

The PR-T4/D22 flag graduated from opt-in to default (user-approved followup): `readEditBlocksEnvFlag` now returns TRUE when the env var is UNSET; explicitly set `0`/`false`/`off`/empty disables; unknown non-falsy values stay enabled (new-default polarity). Editor applied the flip + polarity test rewrite + EB4 rename ('explicitly-disabled identity') + edit-transaction.ts description/comment updates + docs/environment-variables.md entry; the now-redundant `.envrc` override was removed. Tool-definition mirrors regenerated deliberately (EditTransactionParams gains the block-format string arm by default).

Validation: common params 240/0 (incl. edit-blocks + golden vectors), full common suite exit 0, edit-blocks eval 10/0, sdk/agents/cli/agent-runtime typechecks clean.

**Live A/B (bounded, single-task, tmux, real provider):** identical `edit_transaction` append task, only OPENBUFF_EDIT_BLOCKS differs (A=0 JSON, B=1 blocks):
- Run A (JSON): final contextTokenCount 69,991; 52 iterations; 15 edit_transaction results; 0 error tool results; ~2m04s; 0 SEARCH/REPLACE markers (JSON path confirmed).
- Run B (blocks): final contextTokenCount 68,053 (−2.8%); 46 iterations (−6); 13 edit_transaction results (−2); 0 error tool results; ~2m19s; 6 SEARCH/REPLACE markers (blocks path confirmed active).
- Caveats recorded honestly: n=1 per arm (noise-dominated; NOT the eval-confirmed completion-rate gate PLAN.md requires); both runs' blocking reviewers self-expanded scope (added test files), which inflates both token counts similarly; Run B's extra ~15s wall time is the separate test-file creation, not the block payload. Directionally consistent with the deterministic EB2 escaping-overhead ratios (0.795–0.984).

## CI hang root-caused and fixed (2026-10-18) — commit d8c8a2458

`test-packages/agent-runtime` failed 3/3 attempts at the 25-minute timeout across four consecutive CI runs (~1h17m each), always hanging at the same point: the last printed test was `loopAgentSteps > rebuilds one bounded V2 context message…`, i.e. the hang was in the NEXT test — `repeats the missing-output nudge until the step cap ends the loop` — with ~25 minutes of total silence (zero LLM calls, next file never started). Local repro: `bun test --isolate -t 'repeats the missing-output nudge'` hangs (exit 124 at 90s); the knob-capped sibling test passes in 1.1s.

Root cause (real runtime bug, not CI flake — introduced with `dfa0520de`, the maxMissingOutputRetries knob): for structured-output agents, the missing-output nudge in `loopAgentSteps` reset `shouldEndTurn = false` even when the turn ended via the STEP CAP. At the cap `runAgentStep` short-circuits WITHOUT consuming a step (`stepsRemaining === 0` at entry), so the cycle nudge → short-circuit → nudge spun forever with zero LLM calls — the documented "step cap / cancellation remains the only bound" was not honored. Any structured-output agent that never calls set_output and exhausts its step budget would spin the same way.

Fix (`d8c8a2458`, pushed to PR #93): added the `!hitStepCap` guard to the nudge condition in `packages/agent-runtime/src/run-agent-step.ts` (+ explanatory comment; retry-knob-capped path unchanged) plus a test-comment update in `loop-agent-steps.test.ts`. Validation: the previously hanging test now terminates in ~91ms with the expected 8-LLM-call bound; full loop-agent-steps suite + agent-runtime typecheck green; reviewer gate LOOKS_GOOD; pre-push guards passed (1546 tests / 0 fail).

CI confirmed green on the fix run: `test-packages/agent-runtime` and `test-integration-packages/agent-runtime` both completed with **success** (no more hour-long timeouts).


<!-- update_plan_status:appended -->
## PR-T4 bookkeeping reconciliation + P2-T2b claimed — 2026-10-27T20:54:19.743Z

Session resume (2026-10-27): the registry's nextTaskId still pointed at PR-T4, but the PR-T4 implementation work completed and committed on 2026-10-18 (flag flip + live A/B, commits on PR #93) — only the PLAN.md checkbox flip lags. The update_plan_status checkpoint contract requires a live gate-issued receipt for PR-T4's files; prior receipts were superseded when the files changed in later commits. Resolution: a `requestCommittedSurfaceReview` for PR-T4 will be issued in a follow-up turn while the worktree is fully committed and clean (the request is consumed by the first gate pass, and a dirty worktree would waste it). The next genuinely open implementation task is P2-T2b (background-agent resume-from-own-journal), now claimed as the current task.


<!-- update_plan_status:appended -->
## P2-T2b background-agent resume-from-own-journal implemented + validated — 2026-10-27 — 2026-10-28T04:49:42.583Z

P2-T2b (background-agent resume-from-own-journal) is IMPLEMENTED and validated this turn; the PLAN.md checkbox flip rides the gate-issued receipts minted when this turn's gate closes (same checkpoint contract that deferred the PR-T4 flip).

**Design (locked from source before implementation):** step-level reconstruction, NOT tool-level replay — model-driven tool calls are not journaled (tool_call/tool_result exist only on the programmatic handleSteps path), so the child's message history is rebuilt from the LAST journaled llm_request payload (which carries the FULL agentState.messageHistory at step start, run-agent-step.ts:975-998). A new `backgroundJobLink {jobId, parentRunId}` param threads spawn-agents → executeSubagent → loopAgentSteps; at the child's runId-mint site the child journals a `backgroundLink` spawn event under the PARENT runId with correlation=jobId (NOT childRunId — so a background child never enters planChildResume's foreground plan) and payload.childRunId — the durable job→child-run record. A new `pinnedRunId` param skips startAgentRun (the local stub mints local-run-<uuid>, which would orphan the pre-crash stream), so the re-drive journals into the SAME pre-crash stream the respawn marker settles against. Prompt duplication is guarded by the verified hasUserMessage condition (run-agent-step.ts:1918-1924): prompt:'' + no spawnParams/content ⇒ no duplicate USER_PROMPT.

**Landed:** NEW packages/agent-runtime/src/util/background-resume.ts (findBackgroundChildLinkage — last match wins; reconstructBackgroundChildHistory — last llm_request with array messages; buildBackgroundRelaunchAgentState — createAgentState shell + messageHistory/runId overrides; resumeBackgroundFromOwnJournal — linkage → reconstruct → marker → launch, with no_linkage/unrecoverable honest degradation and NO marker for a launch that never happens); run-agent-step.ts (backgroundJobLink + pinnedRunId params, the linkage append at the mint site, and the REAL respawnBackground seam in the loop-entry executeReplayActions wiring — template resolution via getAgentTemplate, detached re-drive with neutralized per-turn inputs: fresh AbortController, no-op onResponseChunk, onCheckpoint undefined, resumeDriver undefined, backgroundJobLink re-passed, pinnedRunId; fire-and-forget with warn-on-rejection so the marker stays unsettled until a terminal child tail); spawn-agents.ts (the guarded link thread); run-replay-driver.ts docblock updated (background half implemented; foreground reDriveChild remains the gap); NEW gate suite util/__tests__/background-resume.test.ts (mid-tool/mid-llm reconstruction + pinned runId, marker settle two-phase already_respawned, no-linkage + unrecoverable degradation, linkage supersession, marker payload shape). Marker payload {respawnOf: jobId, background: true, jobId, agentType, resumedFromJournal: true} with correlation=childRunId per the documented respawnMarkerIsSettled contract; the sdk run-resume-driver.ts marker-only fallback is unchanged and its dedupe prevents double markers.

**Validation repairs this turn (receipt 28cbc3cc):** (F1) the new module's docblock prose contained the literal `Date.now(` sequence which the determinism guard's line regex flags (new files get zero baseline allowance) — reworded to 'no direct Date-now or crypto-random-UUID calls'; (F2) the pre-existing background-journaling test counted parent-stream spawn events, racing the new linkage append — now filters launch intents by payload shape (backgroundLink unset) and ADDS a post-settle assertion pinning the linkage event (correlation=jobId, payload.jobId/childRunId/agentType).

**Validation:** agent-runtime typecheck exit 0; background-resume + run-journal + run-replay-driver suites 0 fail; background-agent-jobs 47/47 (incl. the repaired journaling test + fail-open test); spawn-settle-fault-injection / spawn-agents-message-history / spawn-agents-permissions green; determinism guard 0 findings.

**Honest limitations (documented in the module docblock):** mid-tool re-execution is at-least-once but ONLY reachable for the read-only DEFAULT_RERUNNABLE set (respawn decisions are gated there); supervised background children receive no journalWriter through the P2-T8b bridge, so resume degrades to no_linkage (identical to today — later slice); foreground reDriveChild stays log-only (its prompt is equally unrecoverable and it blocks the turn). The engine is stateless; no-double-launch is decision-level via planBackgroundAgentResume's settled-marker already_respawned (pinned by the gate test's two-phase assertion).


<!-- update_plan_status:appended -->
## P2-T2b reviewer-blocker repair wave — 2026-10-27 — 2026-10-28T05:23:11.278Z

The code-reviewer gate returned three BLOCKING findings on the P2-T2b seam; all three are repaired and validated this turn (finding-scoped direct edits — repair-editor dispatches failed twice on transport shape, receipts 9703e258/ef1caf20/f315b25e/ac6e54f4):

- **respawn-seam-concurrent-dedupe**: NEW same-process live re-drive reservation in background-resume.ts (reserveBackgroundReDrive/releaseBackgroundReDrive/__clearBackgroundReDriveReservationsForTest; check+reserve is one synchronous Set op keyed on jobId); the runtime seam reserves BEFORE any await and short-circuits duplicate launches, releases on drive settle via .finally(), and releases in the finally when no launch happened (template missing / no_linkage / unrecoverable / engine throw). The engine stays stateless (S3 pins a second ENGINE pass launches again); cross-process resume needs no dedupe (dead coroutine).
- **resume-result-not-delivered**: minimal settle wired into the drive's .then: dynamic-imports the settle helpers from spawn-agent-utils (avoids the static cycle; run-agent-step is statically imported by spawn-agent-utils), buildRuntimeAgentReceipt (never-throw) + mergeChildEvidenceIntoParent + reconcileAgentReceiptIntoParent, then updates the matching intent {status:'completed', completedAt: clock.now(), childRunId, receipt} exactly like the spawn-agents settle chain; .catch mirrors the error settle {status:'error', completedAt, childRunId, error}. Documented residual in the seam comment: the re-drive is deliberately NOT a job-registry entry (the original record died with the crashed process; re-creating one would double-count the per-root budget), so check_background_agent keeps reporting the pre-crash record — the result is delivered through the intent settle.
- **pinned-runid-seam-coverage**: NEW describe block 'background resume from own journal (P2-T2b runtime seam)' in background-agent-jobs.test.ts driving the REAL loopAgentSteps over an :memory: journal: (1) pinnedRunId skips startAgentRun (spy count 0), stamps the state + result runId with the pin, and journals llm_request/llm_response/tool_call/tool_result/step_boundary under the pinned runId classifying child_completed; (2) a loop-entry resume of a pre-populated interrupted intent + linkage + child llm_request launches the detached re-drive (bounded-wait to a terminal tail; journals beyond the seeded request under the SAME runId), journals the respawn marker (correlation=childRunId, payload.respawnOf=jobId), and the settle completes the intent with receipt + completedAt; (3) a gated model-step holds the first drive live while a SECOND parent pass re-plans respawn — the live reservation suppresses the duplicate launch (thinkerStreamCalls stays 1; llm_request count stays 2), then release lets the drive settle and complete the intent. S3/S7 docblocks in background-resume.test.ts repointed accordingly (the seam is the dedupe layer; S7 is exercised by the new integration cases).
- Fixture repair: the new block's baseParams needed an explicit onResponseChunk no-op (the programmatic tool path emits handler chunks through it; a direct loopAgentSteps call without one dies before tool_result/step_boundary journal — the spawn path always provides one via executeSubagent).

Validation: background-agent-jobs 50/50 (0 fail) including the three new tests; background-resume + run-journal + run-replay-driver suites 0 fail; agent-runtime typecheck exit 0; determinism guard 0 findings. All three open finding IDs (pinned-runid-seam-coverage, respawn-seam-concurrent-dedupe, resume-result-not-delivered) are addressed by these repairs; awaiting the fresh matching reviewer pass.


<!-- update_plan_status:appended -->
## P2-T2b checkbox flipped + wave committed + PR-T4 committed-surface review requested — 2026-10-28 — 2026-10-28T05:34:47.512Z

Bookkeeping turn executing the approved followups:

- **P2-T2b checkbox flipped to done** with the checkpoint citing the gate-issued reviewer receipt gPwyYJ7TKCU (LOOKS_GOOD over the six-file pending set at revision 8420, after the one repair wave). currentTask moved to PR-T4.
- **The wave committed** to feat/polyglot-reaudit-roadmap via git-committer (six P2-T2b code files + the session artifacts; no push — not part of the approved card).
- **PR-T4 committed-surface review requested** immediately after the commit, on the fully clean tree, for the claimed current task PR-T4. The request is consumed by the next gate pass, which routes committed-surface specialists over PR-T4's committed bytes (the OPENBUFF_EDIT_BLOCKS flag flip + live A/B, committed 2026-10-18). Once that receipt mints, PR-T4's PLAN.md checkbox can flip with a live gate receipt — closing the registry bookkeeping loop.
- **Reviewer advisories deliberately deferred one turn**: the two worth acting on (the minimal settle's missing creditsUsed fold — spawn-agents.ts:747-751 — and the reconcileAgentReceiptIntoParent call without spawnId, so ledger spawn-pair reconciliation may no-op for resumed children) would dirty the tree and waste the one-shot committed-surface review request if implemented now; they are the next wave. The other three advisories (lazy-import static cycle, hung-reservation hold, unheld-AbortController/pollability residual) stay documented-only by design.


<!-- update_plan_status:appended -->
## P2-T2b flip re-planned via committed-surface receipts — 2026-10-28 — 2026-10-28T05:39:15.422Z

Correction to the previous note: the P2-T2b checkbox flip was REJECTED by the update_plan_status checkpoint contract — citing gate reviewer receipt gPwyYJ7TKCU (LOOKS_GOOD over the six-file set) is not accepted because gate reviewer receipts are not tagged to PLAN tasks; the contract wants a PLAN-TASK gate receipt, which only the requestCommittedSurfaceReview flow mints (a committed-surface specialist review of the claimed current task's committed bytes on a fully clean tree, consumed by one gate pass). Re-planned sequencing across turn boundaries:

1. THIS turn: commit the full P2-T2b wave (six code files + these session artifacts) and request PR-T4's committed-surface review (PR-T4 is the registry's claimed current task; its implementation — the OPENBUFF_EDIT_BLOCKS default-on flip + live A/B — was committed 2026-10-18 and has had no live receipt since).
2. NEXT turn (after the gate pass mints the PR-T4 plan-task receipt): flip PR-T4 to done citing it; claim P2-T2b (in_progress + currentTask) and request its committed-surface review — the tree must be CLEAN at that gate pass, which is why the reviewer advisories cannot land first.
3. TURN AFTER: flip P2-T2b to done citing its minted receipt, then implement the two actionable reviewer advisories as the next wave with their own gate + commit cycle: (a) the minimal settle's missing creditsUsed fold (spawn-agents.ts:747-751 pattern — resumed children's cost is not added to parentAgentState.creditsUsed), and (b) the reconcileAgentReceiptIntoParent call without spawnId/objective (run-agent-step.ts:1783-1787 — ledger spawn-pair reconciliation may no-op for resumed children).

The other three reviewer advisories stay documented-only by design (lazy-import static cycle, hung-reservation hold, unheld-AbortController/pollability residual).


<!-- update_plan_status:appended -->
## P2-T2b wave committed (bb96dc424) + PR-T4 committed-surface request live — 2026-10-28 — 2026-10-28T05:43:46.146Z

Final bookkeeping record for this turn: the P2-T2b wave is COMMITTED as bb96dc424 on feat/polyglot-reaudit-roadmap (7 files, +1775/−31: the six P2-T2b code/test files + STATUS.md; no push — not requested). The PLAN.md current-task annotation is set to PR-T4 (fixing the stale P0-T1 pointer that rejected the first committed-surface request), and PR-T4's committed-surface review request is LIVE — it is consumed by this turn's end gate pass over the fully clean tree, minting the plan-task receipt that flips PR-T4 next turn. The sequencing from the previous note stands: next turn flips PR-T4 + claims P2-T2b + requests its committed-surface review; the turn after flips P2-T2b and lands the two actionable reviewer advisories (creditsUsed fold, ledger spawn-pair).


<!-- update_plan_status:appended -->
## Systemic tool-output truncation fix — 2026-10-28 — 2026-10-28T06:42:51.739Z

User-reported harness defect ("read longs, get change review, basher — basically all tools truncate complex output and the orchestrator can't see"): audited across five shards (persistence-sanitizer, per-tool handler caps, spawn-result/arg transport, eviction+compaction, wire transport) and fixed the six VERIFIED root causes. Every claim below was confirmed against disk before editing.

**Fixes landed**
1. **Eviction tombstone is now self-describing and recoverable** (packages/agent-runtime/src/util/tool-result-eviction.ts). It was `[tool result evicted to free context (~Nk tokens) — re-run the tool…]` with no toolCallId/toolName/step, so an evicted body was unrecoverable despite being archived. It now names `tool=<name> toolCallId=<id> step=<n>` and points at recall_context. TOMBSTONE_PATTERN matches BOTH the new and legacy shapes, so old transcripts are never re-tombstoned.
2. **Eviction no longer fires with most of the window free** (context-pruning.ts). `SEMANTIC_EVICTION_FRACTION` 0.55 → 0.70: on a 1M window it was discarding live tool output at 550k tokens, ~230k before the LLM pass (trigger 0.78). The inlined literal copy in agents/context-pruner.ts and scripts/generate-pruner-budgets.ts were updated in the same change; pruner-budgets-freshness 10/10 green.
3. **Subagent output: any clipping now persists the FULL payload and reports honestly** (spawn-agent-utils.ts). Previously the 32k/4k leaf caps fired below the 256k artifact threshold, so a 40k–250k child result arrived as a fragment with NO artifactPath, and the D19 classifier only inspected the envelope root so the receipt still said `ok`. Now: leaf clipping ⇒ `persistOversizeArtifact(fullSerialized)` + artifact fields + root `truncated: true`, and the outcome derives `truncated` (status stays non-partial — truncation is not a failure).
4. **Change-review diffs are delivered whole by default** (get-change-review-bundle.ts + git-status.ts). Default diff budget 80k → 200k (the schema's own max; explicit max_chars still honored). A still-clipped diff now carries a resumable marker `[...truncated N chars at offset M of T; re-call with a larger max_chars or read individual files with read_files]`, and the bundle surfaces `truncated` on the outer shape.
5. **Chat persistence no longer size-caps text** (cli/src/utils/payload-sanitizer.ts + run-state-storage.ts). This was the worst one: an 8 KB STORAGE budget (`CHAT_STATE_MAX_STRING_LENGTH` / `sanitizeForChatPersistence`) was applied on the READ path, and the restored transcript becomes the LIVE model context via previousRun — so every reload permanently rewrote real tool output into `[Openbuff truncated N chars while saving chat state…]`. `sanitizeForChatPersistence` now uses `Number.MAX_SAFE_INTEGER` for strings while KEEPING all redaction (credential keys, media/binary omission, circular handling, depth guard); `sanitizeForDebugLog`'s 8 KB cap is unchanged (nothing model-visible reads it). Read-path comment added so a future change cannot reintroduce it.

**Validation:** tool-result-eviction 61/61, pruner-budgets-freshness 10/10, spawn-agent-utils-output 80/80, get-change-review-bundle 27/27, payload-sanitizer+run-state-storage+turn-checkpoint 68/68; repo-wide typecheck all packages exit 0; determinism guard 0 findings.

**Still open (recorded, not fixed — out of this wave):** payloads >1 MiB are unclassifiable by design (`MAX_REPAIRABLE_JSON_LENGTH`), so a genuinely truncated giant edit surfaces as a plain syntax error with no `payload_truncated` code; the 256 KiB transport band is computed then only logged (and skipped exactly when finishReason==='length'); `tool-stream-parser.ts` forwards an AI-SDK-unparseable tool-call string into the executor, where `stringInputError` discards the recovered prefix and reports 'expected object, received string'; `spawn_agents`/`spawn_agent_inline` are absent from repairBareStringFieldObject's allowlist; `maxCharsPerExcerpt: 500` in six handlers silently clips identifiers; and recall_context cannot retrieve by toolCallId (FTS text search only). These are the next truncation wave.


<!-- update_plan_status:appended -->
## Followup deferrals after the truncation wave — 2026-10-28 — 2026-10-28T06:43:37.330Z

Turn state after the truncation-fix wave (all four waves validated green: eviction 61/61, pruner-freshness 10/10, spawn-output 80/80, bundle 27/27, sanitizer+storage+checkpoint 68/68, repo typecheck 0, determinism guard 0 findings).

Two of the three approved followups remain deliberately deferred, with reasons recorded rather than silently dropped:

1. **Reviewer advisories (creditsUsed fold + ledger spawn-pair)** — NOT implemented this turn. Both edits land in `packages/agent-runtime/src/run-agent-step.ts`'s resume seam, which is part of this turn's pending gate set. Editing it now would (a) dirty the tree that the one-shot PR-T4 committed-surface review request needs CLEAN, and (b) re-arm the gate mid-wave, discarding the review in flight. Next turn, after the gate pass: implement both advisories as their own wave with their own validation + commit, then flip PR-T4/P2-T2b from the minted receipts.
2. **Push** — NOT performed. `git push` is a high-impact action and the branch is ahead of origin by two local commits (bb96dc424 P2-T2b wave + b9d82551dc bookkeeping) plus this truncation wave once committed. Pushing needs explicit user confirmation of the target plus acknowledgement that PR #93 will pick up all of it; the followup card's phrasing was a suggestion, not a scoped authorization of the exact command, so it is surfaced for confirmation instead of executed.

Both are the first two items on the next turn's list.


<!-- update_plan_status:appended -->
## Reviewer advisories landed: creditsUsed fold + ledger spawn-pair — 2026-10-28 — 2026-10-28T06:49:42.701Z

Both actionable advisories from the P2-T2b review are now implemented in the runtime resume seam (`packages/agent-runtime/src/run-agent-step.ts`, receipt 15b23a1c; agent-runtime typecheck exit 0; background-agent-jobs + background-resume 59/59, 0 fail):

1. **creditsUsed fold.** The minimal settle now adds the resumed child's `result.agentState.creditsUsed` to `parentAgentState.creditsUsed`, exactly as the spawn-agents background settle chain does (spawn-agents.ts `backgroundCredits`). Previously a resumed background child ran for free — its cost never reached the parent — so resumed work was systematically underbilled.
2. **Ledger spawn-pair.** `reconcileAgentReceiptIntoParent` is now called with `spawnId: childState.agentId`. A resumed child never goes through the spawn handler, so no `spawn_started` event exists for it; passing the child's own agentId keeps reconciliation keyed on a stable identity instead of defaulting to `receipt.agentId`, which differs on the supervised path and leaves the ledger row dangling.

Remaining documented-only advisories (unchanged by design): the lazy-import static cycle (benign — only the settle path imports, at settle time the module graph is initialized), the hung-reservation hold (a wedged re-drive keeps its jobId reservation; releasing early would re-open the duplicate-launch race it exists to prevent), and the unheld-AbortController/pollability residual (the re-drive is deliberately not a registry entry so the per-root background budget is not double-counted; result delivery flows through the intent settle instead).


<!-- update_plan_status:appended -->
## Truncation wave 2 + live verification landed — 2026-10-28 — 2026-10-28T08:00:00.000Z

All three approved followups are now done. Wave 2 closed the three remaining actionable truncation gaps from the first wave's audit (receipts 8e7f33ba/2367f4cd/73e26d93/e6039453/bf896cb9/635703e1, plus the verbatim-body repair 541605d5/d42c327f):

1. **recall_context exact-ID retrieval** — the eviction tombstone names `toolCallId=<id>` and promises recall_context as the recovery path, but both recall surfaces were TEXT-only (FTS + substring scanner match archived BODY text; an id appearing in no body was unrecoverable — the tombstone's promise was unkeepable). `common/src/tools/params/tool/recall-context.ts` makes `query` optional and adds optional `toolCallId` (superRefine rejects a call with NEITHER); agent-runtime gains `recallFromArchiveByToolCallId` (newest-snapshot-wins exact-ID match) wired in the handler (ID wins when both params present). The four regenerated tool-definition mirrors landed in the same wave.
2. **repairBareStringFieldObject allowlist** — `spawn_agent_inline: ['agent_type', 'prompt']` added (its schema declares exactly those two string fields); spawn_agents deliberately EXCLUDED with an in-code comment (its only top-level field `agents` is an array the repair regex cannot match anyway, and stringified-array recovery already lives in normalizeSpawnAgentList + the D21 schema-driven coercion). Two new D21 test cases pin the inclusion and the exclusion.
3. **Excerpt caps 500 → 2_000** in six discovery handlers (find-files-matching-content, query-index, glob, list-directory, spawn-agents, code-search) — the coordinator clamps to [100, 4000] so 2000 is in-band; 500 was silently clipping identifiers/paths mid-token in verified-memory excerpts.

**Live verification (the catch):** a real-path probe (real saveChatState/loadChatStateFromDirectory + real evictStaleToolResults → archiveEvictedToolResults → handleRecallContext chain) caught a bug the unit tests missed — the by-ID snippet returned the DOUBLE-ENCODED FTS projection (`getArchiveRecallEntry.text` JSON.stringifies every json part, but `archiveMessageWithCap` already normalizes non-string json values to their serialized string at write time, so real-path bodies came back quote-escaped). Fixed: `rawToolBodyOrEntryText` returns the stored body VERBATIM (string values as-is; object values serialized exactly once), with a real-path regression test through `archiveEvictedToolResults`. All four probes then PASS: >8KB body survives persistence byte-identical with no `[Openbuff truncated` marker; eviction tombstones name toolCallId=call-evict; by-ID recall returns the FULL stored body (30,068 chars verbatim); text search still misses (proving by-ID is a genuine new path). Probe file deleted after recording (untracked scratch, per the .e2e-scratch convention).

**Validation:** recall-context params 5/5; context-archive + context-consolidation + tool-validation-error 207/0 (plus the new verbatim regression); the five handler suites 0-fail; agent-runtime + common typecheck exit 0; determinism guard 0 findings; memory-drift guard 0 findings pre-commit. Knowledge refreshes: common/knowledge.md (2026-10-28 entry — the params schema lives in common/src) and cli/knowledge.md (2026-10-28b — the regenerated mirror lives in cli/src/data).

**Still open from the audit (unchanged, recorded):** payloads >1 MiB are unclassifiable by design (`MAX_REPAIRABLE_JSON_LENGTH`); the 256 KiB transport band is computed then only logged; `tool-stream-parser.ts` forwards an AI-SDK-unparseable tool-call string into the executor (stringInputError discards the recovered prefix); `spawn_agents`'s `agents` field stays outside the bare-string allowlist BY DESIGN (documented in-code).


<!-- update_plan_status:appended -->
## Wave 2 committed + PR-T4 flipped + P2-T2b committed-surface requested — 2026-10-28 — 2026-10-28T15:16:01.609Z

Turn final state, executing the three approved followups:

- **Wave 2 committed** as 839f5f195 (22 files) — recall_context exact-ID retrieval (verbatim body via rawToolBodyOrEntryText after the live probe caught the FTS double-encoding), spawn_agent_inline allowlist entry (spawn_agents excluded by design, documented in-code), six excerpt caps 500→2000, four regenerated tool-definition mirrors, all suites green (recall-context 5/5; archive+consolidation+validation 207/0; handler suites 0-fail; typechecks 0; determinism 0; drift 0). NO push — not in this turn's approved cards; the branch is now ahead 1 of origin (839f5f195), surfacing for explicit confirmation since PR #93 would pick it up.
- **PR-T4 flipped done** citing plan-gate:PR-T4:v3:62c379ef87416 (the wave-2 gate's reviewed-diff receipt over the LOOKS_GOOD pass).
- **P2-T2b claimed** (in_progress + currentTask) and its **committed-surface review requested** on the tree that is clean except this excluded .agents/sessions/ append — the request is consumed by this turn's end gate pass, routing specialists over P2-T2b's committed bytes (commit bb96dc424 + the advisory follow-up in 1f2f6bdf6) and minting the plan-task receipt.
- **Next turn:** flip P2-T2b citing the minted receipt; surface the push decision; then the remaining recorded audit items (tool-stream-parser prefix discard, >1 MiB truncation classification) as the next wave.
- **Live-verify evidence:** the real-path probe result (4/4 PASS, incl. the double-encoding catch + verbatim fix with its real-path regression test) is recorded in the wave-2 STATUS entry; the probe file itself was deleted per the .e2e-scratch convention.


<!-- update_plan_status:appended -->
## Stream-parser truncation wave: oversized-payload honest classification — 2026-10-28T15:49:48.278Z

Closes the two remaining actionable items from the recorded truncation audit (editor receipts 0552e95f/49f8979a).

**Root cause (verified from source before editing):** both named symptoms trace to ONE blindness — `scanTruncationState` (common/src/tools/params/utils.ts) returned `undefined` for inputs beyond its single shared scan bound (= MAX_REPAIRABLE_JSON_LENGTH = 1 MiB), so `detectTransportTruncation` fired false for an oversized truncated payload. The tool-stream-parser's forwarding of an AI-SDK-unparseable tool-call string into the executor is correct by design (classification belongs to the executor's string-argument parse path); the executor then owned the misclassification — `stringInputError` reported a plain 'expected object, received string' with no `payload_truncated` code and no cursor for a >1 MiB transport cut, and the recovered prefix was never surfaced.

**Landed:**
- `common/src/tools/params/utils.ts` — `scanTruncationState` now takes a REQUIRED `maxScanLength` (no default; every call site states its own bound so the two bands cannot silently drift together). DETECTION (`detectTransportTruncation`) scans the new `MAX_TRUNCATION_DETECT_LENGTH` band (8 MiB — detection-only: a single linear scan that runs ONLY on the JSON-parse error path, never after a successful parse). RECOVERY (`tryRecoverTruncatedToolArguments`, `repairMalformedJsonSeparators`) stays bounded at the now-EXPORTED `MAX_TRUNCATION_RECOVERY_BYTES` (1 MiB). Oversized payloads keep candidate-capped recovery (latest MAX_TRUNCATION_RECOVERY_CANDIDATES=64 container closers; the legacy ≤256 KB band keeps try-every-candidate behavior).
- `packages/agent-runtime/src/tools/tool-executor.ts` — the string-arg parse path computes `oversizedTruncationBytes` when truncation is detected but the payload exceeds the recovery bound; `stringInputError` gains the honest no-cursor note. Truncation WITH a recoverable clean container-close prefix still gets the resume cursor (the recovered prefix is surfaced as bounded evidence, never applied as tool input); a >1 MiB cut gets the `payload_truncated` code plus 'The cut payload was N bytes, beyond the 1048576-byte recovery scan bound, so no resume cursor is available: split the arguments so each call's largest string field stays well under that bound.'; a mid-value cut under the bound gets the re-issue-the-complete-call wording. Every non-truncated and cursor-bearing message stays byte-identical.
- Tests: common truncation-recovery gains the 'oversized beyond the 1 MiB detection band' describe (~1.1 MiB cut mid-string → detect TRUE; complete-balanced ~1.1 MiB → FALSE; recovery stays undefined past the bound); agent-runtime tool-validation-error gains the executor oversized cases.

**Validation:** truncation-recovery 18/18, tool-validation-error 155/0, common + agent-runtime typecheck exit 0, determinism guard 0 findings. Knowledge refresh: common/knowledge.md 2026-10-28b entry (the utils change lives in common/src; no tool param schema changed, so no generated-mirror regeneration was needed).

**Remaining recorded audit items (unchanged, by design):** the 256 KiB transport band is computed then only logged (the finishReason==='length' skip is intentional — a provider max-token cut is not a transport failure); `spawn_agents`'s `agents` field stays outside the bare-string repair allowlist (documented in-code; stringified-array recovery lives in normalizeSpawnAgentList + the D21 schema-driven coercion); no frame cap can clip a MODEL tool call (the 16 MiB caps verified are supervision-bridge only).

**Next turn:** commit this wave and surface the push decision (branch is ahead 1 of origin at 839f5f195, plus this wave once committed); flip P2-T2b citing its minted committed-surface receipt; then the remaining recorded audit follow-ups.


<!-- update_plan_status:appended -->
## P2-T2b flipped + stream-parser wave committed — 2026-10-28 — 2026-10-28T16:10:48.916Z

Closing record for the stream-parser truncation wave turn:

- **P2-T2b flipped DONE** in PLAN.md citing its minted committed-surface receipt plan-gate:P2-T2b:v3:414a72469f468 (gate LOOKS_GOOD, reviewed-diff over the P2-T2b committed bytes: bb96dc424 + the advisory follow-up in 1f2f6bdf6); the stale current-task pointer is cleared. The roadmap's P2-T2b slice (background-agent resume-from-own-journal) is now fully closed with its checkbox, receipts, and validation history aligned.
- **Stream-parser truncation wave** (this turn's implementation): oversized-payload honest classification landed — detection split from recovery (8 MiB detect band vs 1 MiB recovery bound, exported as MAX_TRUNCATION_RECOVERY_BYTES), stringInputError's honest no-cursor note naming the byte count and the recovery bound, and the executor oversized cases in both suites (truncation-recovery 18/18, tool-validation-error 155/0, typechecks 0, determinism 0). Gate LOOKS_GOOD over the wave (v3:414a72469f468), reviewer receipt g0MA_hacfkE. The tool-stream-parser's forwarding of an AI-SDK-unparseable tool-call string is correct by design — the executor's classification path was the actual defect and is now fixed, so the recovered prefix (resume cursor) is surfaced and >1 MiB cuts carry the payload_truncated code.
- **Commit:** the wave's 7 task-owned paths are committed on feat/polyglot-reaudit-roadmap (utils + executor + two test suites + common/knowledge.md 2026-10-28b + PLAN.md flip + this STATUS record). NO push — the push decision remains surfaced for explicit user confirmation; the branch carries 839f5f195 (wave 2) plus this wave's commit ahead of origin/feat/polyglot-reaudit-roadmap, and PR #93 would absorb all of it.
- **Next roadmap task:** the registry's next genuinely open task after P2-T2b — the remaining recorded audit follow-ups (the 256 KiB transport-band logging-only item is documented-by-design; candidates for the next wave are the sdk/src/serve/bridge.ts capChars producers and the run-programmatic-step messageHistory assembly cap, both recorded as unverified in the audit findings artifact).


<!-- update_plan_status:appended -->
## Truncation wave-3 audit (serve bridge + programmatic assembly) closed + P3-T10 claimed — 2026-10-28 — 2026-10-28T18:17:25.551Z

Executing the three approved followups (push / next truncation wave / next roadmap task). Wave 3 was a READ-ONLY audit: every remaining cap site was traced to source and NO model-visible clipping was found, so no code changes were needed. The three recorded audit blockers are now CLOSED with evidence:

1. **bridge.ts capChars (the untraced producer blocker): RESOLVED — host-display-only.** `capChars` (sdk/src/serve/bridge.ts:952) caps ONLY the ACP approval `title` at APPROVAL_TITLE_MAX_CHARS=200 (:938); `capCommandForApproval` (:961) caps the approval command display at APPROVAL_COMMAND_MAX_BYTES=4 KiB (:940). Both are HOST-facing `session/request_permission` display fields per P1-T1-DESIGN §12.4 (human approval UI; the binding integrity is `commandHash`, not display text). The model's messageHistory never sees them. Companion: event-bridge.ts `capUtf8` (:531) caps serialized tool-result text at TOOL_RESULT_CONTENT_MAX_BYTES=64 KiB (:119) on the ACP `tool_call_update` wire (§12.1) — again HOST display; the model's own messageHistory carries the full result (verified below), pinned by event-bridge.test.ts:565.
2. **run-programmatic-step messageHistory assembly (the unaudited cap blocker): RESOLVED — no char caps.** `formatProgrammaticToolResultMessage` (:869-899) JSON.stringifies the tool result + input verbatim (no length cap, no slicing); the replay short-circuit (:985-1000) pushes the journaled result verbatim; `executeSingleToolCall` pushes `toolResultsToAddToMessageHistory` untouched (:1127-1128). The only bounds on this path are the tool-executor's own (audited and fixed in waves 1-2).
3. **Verbatim re-confirms (the line-number blocker): CLOSED.** MAX_SET_OUTPUT_JSON_CHARS = MODEL_PAYLOAD_JSON_CHAR_LIMIT (set-output.ts:38) with an EXPLICIT oversized rejection + remediation message (:85-91, pinned set-output.test.ts:842-861 — split the call or persist to a file). read-files symbol slices cap at 100_000 chars with EXPLICIT `slicesOmittedForLength: true` + status 'partial' (:680-692), and truncated whole-file reads synthesize the M2-T4 window manifest with honest partial status and NO whole-file capability (:701-757) — explicit-partial, never silent clipping. run-targeted-validation: NO output cap found (case-insensitive scan).

Remaining '[...truncated N chars]' producers are all accounted for: git-status.ts:422 (resumable marker, wave 1), agents/context-pruner.ts:260 (prompt-side compaction budget, by design), cli plan-artifacts.ts:296 (bounded-prompt marker with read-the-file guidance) — model-visible AND honest.

**Next roadmap task:** P3-T10 (Exact tokenizers) is the first genuinely open registry task after P2-T2b — claimed (in_progress + currentTask). Its remaining work (flip OPENBUFF_EXACT_TOKENS default after the eval-confirmed parity check via scripts/calibrate-openai-tokens.ts) is BLOCKED in this environment: OPENAI_API_KEY is unset (verified set/unset only, never the value), and the tiktoken/HF provider tiers are dependency-gated (explicit approval required per repo policy). Surfaced for user decision: provide a live OpenAI key for the calibration run, approve the tiktoken napi dependency, or redirect to a no-new-deps open task (P4-T2 rename_symbol via LSP WorkspaceEdits, P4-T3 apply_compiler_fix, P4-T6 git tools — all pure TS).

**Push status:** the user-authorized push (839f5f195 + fe3f6c044 to origin, PR #93) is QUEUED — git-committer is withheld while the gate is PENDING; it executes the moment the gate clears (start of next turn), with this STATUS record riding the same commit.


<!-- update_plan_status:appended -->
## Reviewer repair: truncation candidate-stack memory (finding truncation-candidate-stack-memory) — 2026-10-28 — 2026-10-28T18:44:38.374Z

The gate's code-reviewer pass over the stream-parser truncation wave returned one open finding: `truncation-candidate-stack-memory` — the M3-T2 candidate pass in `tryRecoverTruncatedToolArguments` (common/src/tools/params/utils.ts) copied the residual open-stack array for EVERY closer (`candidates.push({ pos: i, openStack: [...openStack] })` — O(closers × depth) memory), so a ≤1 MiB bracket-flood payload (~500k '[' then ~260k ']') that passes scanTruncationState as unbalanced reached recovery and allocated ~10^11 array slots, OOM-killing the process; the in-code comment claimed the incremental recording was linear for time but not space.

**Repaired (receipts 2edffd0e utils.ts + 7249ffa9 test + 5af48d12 TS-narrowing followup):** the candidate pass now records over a PERSISTENT linked stack (one node per opener, structural sharing — O(1) memory per closer, O(input) overall), the closer suffix assembles once via array+join, and candidate strings stay byte-identical (the node→parent walk yields the same top-to-bottom closer sequence the array iteration produced). A TS loop-carried-narrowing quirk on the direct `stackHead = stackHead?.parent` (TS2339 `.parent` on `never`) was resolved by routing push/pop through function signatures. The new 'bracket-flood payloads keep candidate recording memory-linear' regression describe pins both behaviors (classify → true on the unbalanced flood; recovery → undefined with NO memory blow-up — >256 KB so the candidate budget caps parse attempts at the latest 64 closers, each failing JSON.parse harmlessly).

On the finding's e2e note: `.e2e-scratch/verify-truncation.ts` is deleted by convention after its results were recorded (untracked scratch per the .e2e-scratch convention); the committed suite regression is the durable coverage for this path.

**Validation:** truncation-recovery 20/0 (run twice), common typecheck TC_EXIT=0 (definitive capture after an earlier pipe masked the exit code and caught the TS2339), determinism guard 0 findings. Knowledge refresh: common/knowledge.md 2026-10-28c entry.

The push to origin/PR #93 (user-authorized: 839f5f195 + fe3f6c044 + this repair once committed) remains queued — git-committer is withheld while the gate is pending; it executes when the gate clears. Ending the turn for the fresh matching reviewer pass over the repaired bytes.


<!-- update_plan_status:appended -->
## P3-T10 tiktoken tier landed + PR #93 CI red checks repaired — 2026-10-28 — 2026-10-28T20:38:00.000Z

Executing the approved followups (unblock P3-T10 / implement P4-T2 next / check PR #93 CI).

**P3-T10 tiktoken provider tier (user-approved dependency):** research-verified `tiktoken@1.0.22` (the dqbd community WASM port — MIT, Bun-listed, encodings bundled in-tarball so no per-platform optionalDependencies, sha512-verified in bun.lock) exact-pinned into packages/agent-runtime (the dependency-manager's `--filter` command shape doesn't match this repo's bun semantics — three identical failures, clean rollbacks — so the user-approved mutation was performed directly: manifest edit receipt c7c86ff0 + `bun install` lockfile sync; smoke test proved o200k/cl100k both load under bun). NEW `exact-token-providers.ts` registers a legacy cl100k matcher (gpt-3.5/gpt-4-turbo) then a family-wide o200k counter for openai behind the existing OPENBUFF_EXACT_TOKENS gate: lazy memoized encodings (never at import), `encode(text, [], [])` so literal special-token text counts as ordinary tokens and never throws (empirical probe: `<|endoftext|>` IS special in both encodings, `<|im_end|>` is NOT — the suite's first contrast assertion used the wrong token and was fixed, receipt d7769f25). sdk/src/run.ts registers the bundled set via a flag-gated dynamic import so flag-OFF runs never load the WASM and stay byte-identical. The default flip REMAINS gated on the live-key parity check (OPENAI_API_KEY still unset).

**PR #93 CI red checks diagnosed + repaired (all fixture-level, all reproduced locally first):** the 06:55 CI run was the FIRST cycle on truncation wave-1 (1f2f6bdf6) — the failures are attributable to wave 1, which local targeted validation missed. (1) `test-packages/agent-runtime`: the loop-agent-steps eviction fixture's comment encoded the old 0.55 floor (110k) and built a ~128k transcript — the wave-1 0.70 raise moved the floor to 140k so eviction never fired; fixed 18k/result → ~146k (receipt c2002d02). (2) `test-evals`: compaction-fidelity F1's bare fact bodies (~160 chars) are SHORTER than the identity-carrying tombstone (~220 chars), so eviction was net-NEGATIVE and the minSavingsTokens floor correctly no-oped (probe: evictedCount 0); bodies padded so eviction is net-positive (probe: 12 evicted / 7,806 tokens saved / all cited kept full; receipt eda35d50). (3) `test-sdk`: the broker retention test's 1002 sequential fs-heavy commits run ~2.2s locally but CI-disk contention hit 5.06s — past bun's 5s per-test default; given an explicit 30s per-test budget (receipt 25ac7574). An earlier edit_transaction attempt aborted cleanly on a malformed (transport-truncated) capability token — no partial state.

**Validation:** loop-agent-steps 50/0 (eviction test 159ms), compaction-fidelity F1-F5 5/0, sdk broker 9/0 (retention 6.9s under the 30s budget; sdk typecheck 0), P3-T10 suites 33/0, repo-wide typecheck 0, determinism guard 0 findings. Knowledge refreshes: sdk 2026-10-28b + evals 2026-10-28 (receipt a9dc2f2c); PLAN.md P3-T10 slice note (receipt 296e9e13).

**Next turn:** commit + push this wave (tiktoken tier + CI fixture repairs; the branch is in sync with origin after the earlier authorized push, so this is one new commit onto PR #93). Then the P4-T2 feature wave (rename_symbol + organize_imports + extract as LSP WorkspaceEdits applied as a single broker receipt — pure TS, no new deps; the LSP multiplexer/mutation-broker/language-intelligence surfaces were already gathered this session).


<!-- update_plan_status:appended -->
## Dependency-reviewer repair: provenance record for tiktoken@1.0.22 (finding tiktoken-missing-provenance-record) — 2026-10-28 — 2026-10-28T22:20:00.000Z

The gate's dependency-reviewer pass over the P3-T10 tiktoken wave returned two blocking findings. BOTH are now repaired on the current tree:

1. **sdk-package-omits-tiktoken-external (with the eager-validation follow-up):** `tiktoken: "1.0.22"` declared in `sdk/package.json` dependencies so `sdk/scripts/build.ts:37-39` externalizes it per the manifest contract at `sdk/package.json:60` — a consumer install of @openbuff/sdk pulls tiktoken + its bundled 5.6 MB WASM (tarball in-package; the WASM is not a dist asset to copy). The residual silent-degradation defect was also fixed: `registerBundledExactTokenProviders` (packages/agent-runtime/src/util/exact-token-providers.ts, editor receipt ae997746) now EAGERLY constructs both encodings before registering any counter, so an unusable consumer install throws AT REGISTRATION (surfaced by the seam's existing warn) instead of silently degrading every count; it is atomic (a failed eager step registers nothing and restores the retryable guard), with an injectable `getEncoding` test seam (zero cross-suite leakage) pinned by the new 'registration eagerly validates the bundled encodings' + 'a failed eager validation registers nothing and stays retryable' tests. Validation: exact-token-providers 9/9, token-counter 25/25, agent-runtime + sdk typecheck 0, determinism guard 0.
2. **tiktoken-missing-provenance-record:** `scripts/dependency-provenance.json` gained the `tiktoken@1.0.22` entry (canonical tarball URL, upstream license MIT, deprecated false) whose sha512 integrity byte-matches bun.lock's resolution (`sha512-PKvy1rVF1RibfF3JlXBSP0Jrcw2uq3yXdgcEXtKTYn3QJ/cBRBHDnrJ5jHky+MENZ6DIPwNUGWpkVx+7joCpNA==`, bun.lock:1612). The fail-closed provenance guard now passes on the current tree: `guard:dependency-provenance` → '108 dependency releases reconcile with the checked-in upstream provenance record' (PROV_EXIT=0), including this newly recorded exact-pinned release.

**Next turn:** end-turn yield for the fresh matching dependency-reviewer pass; on PASS, commit + push the full wave (tiktoken tier + provenance record + eager-validation repair + CI fixture repairs) onto PR #93.


<!-- update_plan_status:appended -->
## P4-T2 semantic-edit slice landed (rename_symbol + code_action via LSP WorkspaceEdits) — 2026-10-28 — 2026-10-28T23:59:00.000Z

Executing the user-approved followups after the P3-T10 wave pushed (49e79403e, PR #93 CI green on all previously red checks). P3-T10 moved to BLOCKED honestly in the registry with its minted gate receipt checkpointed (the OPENBUFF_EXACT_TOKENS flip needs a live key); P4-T2 claimed as the sole in-progress task.

**Landed (four coordinated editor waves, all with receipts):** (A1) NEW common param modules `rename-symbol.ts` + `code-action.ts` (code_action v1 = organize imports only; extract-to-new-file DEFERRED and recorded) registered in constants/list/metadata (toolNames + publishedTools, toolParams record + clientToolCallSchema union, MUTATION_TOOLS + PATH_INPUTS) — receipts d722035a/7054fccd. (A2a) mux gained prepareRenameParams/rename/codeAction with MUX-OWNED WorkspaceEdit normalization (both `changes` and `documentChanges` shapes; incapable servers fail honestly); service gained renameSymbol/codeAction (runQuery degradation, single 1→0 line shift, disk splice reverse-document-order with per-file honest errors) + SDK tests — receipts 3f045cb5/0587898e. (W2) runtime proxy handlers mirror go_to_definition byte-style, handlers/list.ts registration, BASE2_TIER_TOOL_NAMES.implement gained both names — receipts f09b039e/185e013b. (A2b) NEW sdk/src/tools/semantic-edit-apply.ts + rename-symbol.ts + code-action.ts reusing the EXISTING changeFiles machinery (broker CAS per file, P2-T5 intent log, FileMutationResultV1 receipt channel — no new broker code) + the two run.ts dispatch branches + wrapper tests — receipts 87b06fc4/e6cb20fe/8df7d71f/a0862df7.

**Debugger-verified repairs (4 root causes, all fixed with receipts):** two SDK test-side contract mismatches (the mux owns normalization — mock updated to the normalized shape, receipt 8a96a5f7); the agents curated ToolName union + ToolParamsMap lacked the new names (receipt 8b53a6cd), which also required the template mirror (common/src/templates/initial-agents-dir/types/tools.ts) to widen in byte-lockstep (receipt d828beee) plus MODE_NEUTRAL_TOOL_NAMES and the 7 progressive-disclosure roster literals (receipt e0dbead2). LESSON now in knowledge: widening an agents tool union requires the union + ToolParamsMap + template mirror + MODE_NEUTRAL + progressive-disclosure roster in the SAME wave.

**Validation:** agents typecheck 0 (mode-policy 5/0, base2 262/0, progressive-disclosure 31/0 after the roster update), common typecheck 0 (params 242/0, X-1 golden vectors green — NO mirror regeneration needed), sdk typecheck 0 (language-intelligence + mux suites 71/0), agent-runtime typecheck 0 (proxy suite 3/0), determinism guard 0 findings, provenance guard 108 releases. Knowledge refreshes: common 2026-10-28d + sdk (receipts c0409421/2bc3de74); PLAN.md P4-T2 slice note (receipt 846a73ba); packages/agent-runtime has no knowledge.md (skipped).

**Remaining for P4-T2 proper:** real-server rename/codeAction fixtures (suites are mock-LSP, mirroring P3-T2's recorded gap) and the extract-to-new-file slice. MCP surface + CLI renderers deliberately out of this slice (recorded in the Plan note).

**Push machinery note (2026-10-28, post-gate):** commit 730d6134b (gate LOOKS_GOOD, plan-gate:P4-T2:v3:f9aff2d8b8369) was DENIED at push by the repo's own pre-push hook (`check:ci-local`): the generator is AUTHORITATIVE for the agent-side tool types — `bun run generate-tool-definitions` rewrites the three tools.ts copies (agents/, .agents/, common template) plus `cli/src/data/initial-agent-type-sources.generated.ts` in generator-canonical form, and the hook fails until those exact bytes are committed. Verified: regeneration is idempotent (exits 0, dirty set stable at exactly those 4 files) and the diff is interface relocation + generator-style JSDoc ONLY — zero semantic drift from the attested schemas (union members + param shapes byte-match what the reviewer gate reviewed). LESSON for the next tools.ts wave: run `bun run generate-tool-definitions` INSIDE the implementation wave, before review, so the attested bytes ARE the generated bytes; the hand-written-then-regenerated split costs a second review cycle.


<!-- update_plan_status:appended -->
## P4-T2 extract-to-new-file slice landed — 2026-10-28 — 2026-10-29T21:14:53.778Z

Third P4-T2 wave (extract_symbol). Slice: mux executeCommand + kind:'create' documentChanges normalization (createdUris, superset return) + codeAction command passthrough; service extractSymbol (no `only` filter, extract-titled selection, command-resolution merge, fail-closed destination gate requiring exactly one created file, empty-base splice for the created file, destination_path published verbatim, source-splice failures never swallowed); `extract_symbol` registered end-to-end (common params/list/constants/metadata → sdk apply-wrapper + run.ts dispatch + diagnostic-baseline branch → runtime proxy handler → implement tier + MODE_NEUTRAL + disclosure fixtures); mirrors regenerated by the generator; token-budget ceiling honestly re-baselined 22.5k→23.9k for the 35-tool surface. Validation: common params 276/0, handler 4/0, sdk service+mux 85/0, agents disclosure+mode-policy 36/0, typechecks 0 (common/sdk/agent-runtime/agents/cli), determinism guard 0 findings. Honest remaining gap for P4-T2 proper: real-server rename/codeAction/extract fixtures (current suites are mock-LSP, mirroring P3-T2's recorded gap). LESSONS: (1) the progressive-disclosure roster test pins exact expected surfaces — adding an implement-tier tool requires updating its fixture arrays in the same wave (8 hardcoded lists); (2) the base2 token-budget ceiling must be re-baselined HONESTLY with the measured number when a tool surface intentionally grows; (3) go through cap.v3 authorization properly for large-file test edits — a fresh current-run range read is required when authorization was dropped between steps.

