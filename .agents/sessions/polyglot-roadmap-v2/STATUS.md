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
