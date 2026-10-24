# Audit Report — polyglot-harness-audit-2026-10

Generated 2026-10-09. Synthesized from 9 shard finding files (r1–r8 + r6b) at snapshot `d2df71d608d67a3324faf6271f018ab600c00fab18ad1a67b7964172d6289935`.

Headline stats: **112 findings — 0 CRITICAL, 12 HIGH, 51 MEDIUM, 49 LOW** (4 of the LOWs are explicit positive confirmations, not defects; effective defect count ≈ 108). No exact cross-shard duplicates were found; overlapping aspects of the same root cause are merged into the cross-cutting section and noted inline.

## Top 10 highest-leverage fixes
1. [HIGH] security — sdk/src/serve/bridge.ts:404 — implement GV-18/GV-20 client-MCP gating (SSRF + stdio refusal)
2. [HIGH] security — sdk/src/mcp/server.ts:1247 — require expectedHash plus sensitive-path blocklist on apply_edits
3. [HIGH] security — common/src/util/redact-secrets.ts:15 — fix gh[ours]_ typo; implement D15/D31 gitleaks corpus
4. [HIGH] security — sdk/src/services/harness-enforcement.ts:170 — classify shell-wrapper bodies (bash -c/eval/timeout)
5. [HIGH] security — sdk/src/tools/filesystem-authority.ts:86 — block native/binary executable extensions in owned temp
6. [HIGH] state-mutation — packages/agent-runtime/src/util/workspace-path-leases.ts:16 — bridge leases across process boundary
7. [HIGH] correctness — packages/agent-runtime/src/util/run-journal.ts:343 — replace 32-bit FNV key with canonical-input compare
8. [HIGH] correctness — packages/agent-runtime/src/run-agent-step.ts:1655 — wire production replay seams or surface deferred verdict
9. [HIGH] state-mutation — packages/agent-runtime/src/supervision/supervised-spawn.ts:198 — attest side-effect start; make post-mutation crashes non-restartable
10. [MEDIUM] correctness — packages/agent-runtime/src/util/token-counter.ts — thread routed model into hot-path estimator (~35% context overstatement on every OpenAI run)

## Cross-cutting findings (span multiple shards)

These are the systemic patterns — higher impact than any single bug.

### (a) "Tested-on-paper, not-enforced-in-path" — pinned contracts with no runtime enforcement
- **GV-18/GV-20 client-MCP security gates** (r2): golden fixtures and design doc pin `client_mcp_disabled` / `mcp_url_blocked`; zero implementation in sdk/src — the bridge attaches client MCP servers unconditionally (SSRF + arbitrary stdio spawn). The golden suite stays green because it validates fixture JSON only (r2 test-coverage finding).
- **GV-14 wire-contract disagreement** (r2): pinned `-32600/prompt_in_flight` vs implemented `-32602/session_busy`.
- **OutboundQueue (§12.6 backpressure, 32 MiB cap)** (r2): implemented and unit-tested, wired into no transport.
- **DA1 image-capability parser** (r6): exported, unit-tested, zero production call sites.
- **BuffBench never gates PRs** (r8): `workflow_dispatch`-only or `[buffbench]` commit tag; judge/statistics/proposals regressions merge silently.
- **decideProposalPromotion never invoked in the live loop** (r8): promotion gate exists only in tests.
- **M3-T2 per-family token fudge factors dead on the default path** (r3): model never threaded into the estimator; Anthropic 1.35 applied universally.
- Pattern: fixture/suites that look executable but aren't, and DONE claims whose enforcement path is unwired. Fix pattern: every golden vector should have a driving integration test; every "implemented" contract needs a wired consumer or an explicit strike.

### (b) Divergence/drift between layers — one concept, N copies
- **Hand-copied `FilesystemMutationEvent`** in acp/session-data.ts vs run.ts (r2) — import-cycle workaround, silent drift of the confirmed-mutation channel.
- **Two `<gate-state>` parsers** — CLI regex (tolerant, keeps `origin`) vs SDK parser (strict, drops `origin`, different phase projection) (r2).
- **Four gate file-classification helper copies** plus ~10 parity/freshness test families existing solely to police drift (r7; the D53 Bun.build bundling plan is the correct fix).
- **Three error shapes for one containment refusal** — changeFile throws, replace_range returns errorResult, change-files emits not_applied receipt (r1).
- **Pruner vs runtime token estimators** — chars/3 over text parts (tool messages count 0) vs BPE+fudge over full serialization; budget ledger mixes an exact window with a 1.35-factored measure (r3, two findings).
- **Fragmented secret scanning** — three independent scanners with three different coverage holes: staged-commit scan (PEM/AKIA only, r1), outbound redaction (provider keys only, r2), redact-secrets corpus (5 shapes + a regex typo, r7). No shared corpus.
- **Other duplication**: two hand-synced specialist rosters (r7), `IGNORED_TOP_LEVEL` copy (r6b), dual-language ACP protocol duplication risk vs the planned Rust daemon (r2), no shared language/symbol registry across query_index/LSP/code-map/test-impact (D29 unimplemented, r5).

### (c) Supervision process-boundary gaps — in-process guarantees silently vanish across the fork
- **Lease map is module-local**: supervised children acquire/release in their own process; mutual exclusion silently does not exist exactly where parallel mutation is heaviest; release also lacks an ownership check and any fencing token (r4, three findings).
- **Pre-spawn agentState returned**: supervised child's final messageHistory/workspaceState/taskMemory never flow back to the parent (r4).
- **Parent AbortSignal not propagated**: user cancellation orphans a live, credit-consuming child until its 10-minute deadline (r4).
- Related same-family gaps: unauthenticated parent bridge socket (same-uid pivot to parent apiKey / fetch / credits, r4), `getUserInfoFromApiKey` fails closed to null for children while the dep gate reports "all supplied" (r4), schema-refinement agents fail mid-run under supervision (r4).

### (d) Durability layers without a coordinator (r6)
Four persistence layers (chat-state envelope, turn-checkpoint, run-journal, refs/openbuff/turns) with independent keys and no defined recovery precedence — recovery can mix states across layers after a crash.

## Language-fit verdicts

| Subsystem | Current language right? | SPEC planned placement right? | Rationale |
|---|---|---|---|
| SDK mutation/tool core | Yes (TS) — exception: locking | Rust sidecar for locking: **yes** | zod receipts, diff application, tool dispatch fit TS; userspace pid+token advisory locking re-implements what flock(2) gives for free — the one strictly-better language switch in the audit. |
| ACP serve bridge | Transitional (TS) | D49/D50/D51 Rust daemon: **yes, with a frozen wire contract** | Freeze ext-v1 (golden vectors + schemas generated to both languages) as the only pinned boundary, keep TS a thin adapter; otherwise every schema change costs two drifting implementations. |
| MCP server | Yes (TS) | Fold into the daemon later: yes | Tool projection is schema-heavy TS; no independent language driver. Security gaps here are logic, not language. |
| Dash server | Yes (TS) | Keep out of the Rust daemon: yes | Trivial HTTP dashboard; sha256-digest token compare is the right pattern to copy back to the socket listener. |
| Agent loop / journal / compaction | Yes (TS) | P6-T5 daemon: partially — journal replay protocol (D35) is the real resume mechanism | Event-loop concurrency, streaming, zod schemas fit TS; P9-T4's QuickJS heap-snapshot task text should be rewritten to the D35 journal-replay contract. |
| Subagent supervision | Acceptable (TS) now | D49/D50 process core in Rust: **yes** | Process supervision, signal handling, and group reaping are the daemon's natural job; but lease/abort/state bridging must be fixed regardless of language. |
| Archive recall (compaction) | Yes (bun:sqlite FTS5) | P6-T6 tantivy for archive recall: **no** — scope tantivy to repo search only | Per-call, in-memory, bounded (~6.4 MB) ephemeral corpus; a daemon round-trip + persistence is the wrong tool. |
| Indexer / code-map | Yes (TS) | P6-T6 tantivy for repo-wide index: **yes** | Current additive-IDF/substring scoring diverges from BM25 exactly where tantivy replaces it wholesale; keep TS tier as fallback. |
| CLI/TUI | Yes (TS/React/OpenTUI) | No Rust move planned: correct | The image finding is a misuse of the framework (use native renderables), not a language problem. |
| agents/base2 + contracts | TS is a transitional tax, not a destination | D53 Bun.build bundling: **yes**; QuickJS (D48/P9-T4) only for untrusted: **yes**; agent.yaml (P9-T1) config-shaped only: **yes** | The 4-copy/parity-test tax exists solely because handleSteps is serialized via toString(); D53 deletes it. Don't force programmatic gate logic into YAML. |
| Rust workspace | Yes (Rust) | D48 bubblewrap+seccomp: right on Linux, **needs a platform contract** | CI ships windows-msvc/apple-darwin binaries while the exec role is Linux-only; also amend the "zero external deps" charter before the rusqlite daemon role lands. |
| Evals (BuffBench) | Yes (TS) | No move planned: correct | Statistics/judging are pure TS; the gaps are wiring (gating, promotion invocation), not language. |
| Provider wrappers (packages/internal) | Yes (TS) | No move planned: correct | Drop the vendored openai-compatible copy for upstream; keep the OpenRouter fork with a VENDORED_FROM header and drift check. |

## Cohesion verdict

**Macro assessment: the architecture coheres at the protocol level and leaks at the duplication and process-boundary level.**

Seams that **hold**:
- **PrintModeEvent single vocabulary** — one print-mode channel across stream/tool surfaces; no shard finding contradicts it.
- **PR-T1 receipt envelope through all settle paths** — the child-entry single-envelope contract and settle chain (r4) are consistent end-to-end; the cracks around it (pre-spawn agentState, restart duplication) are at the state edges, not the envelope.
- **Journal → receipt → ACP event bridge** — journal replay, receipts, and the ext-v1 event bridge share one vocabulary and the journal path is well-tested; the failure is in what the *runtime* does with replay (logging-only seams), not in the bridge itself.
- Broker CAS/receipt pipeline, grammar-wasm checksum gating (r5), gate-state fail-closed prune/supersede bodies (r7), and dev-dep isolation in the CLI (r6b) verified sound.

Seams that **don't** hold — the cross-cutting list above: (a) contracts enforced nowhere at runtime, (b) N-copy drift across layers/languages, (c) process-boundary state loss in supervision, (d) uncoordinated durability layers, plus fragmented secret scanning.

## Plan-vs-code fidelity

12/12 highest-stakes DONE claims spot-verified across shards: **CONFIRMED**. One with a documented nuance: the journal-replay/P2-T2 claim is confirmed, with the documented nuance that the built-in resume path is classify-and-log (logging-only seams) and real recovery depends on a caller-injected `resumeDriver`, with background-agent re-drive explicitly deferred. Zero drifted or missing claims.

## Findings by domain

### Security
- [HIGH] sdk/src/tools/filesystem-authority.ts:86 — owned-temp blocklist omits .exe/.dll/.so/.jar/.wasm/.msi/.vbs — staged native binaries executable by the next terminal command — add native formats + 0o700 noexec scratch root.
- [HIGH] sdk/src/services/harness-enforcement.ts:170 — shell-wrapper evasion of the high-impact classifier (bash -c/eval/timeout/nice) — recursively classify wrapper bodies; add regression test.
- [HIGH] sdk/src/mcp/server.ts:1247 — MCP apply_edits clobbers any file (expectedHash:null) with no sensitive-path gate — require expectedHash / fail closed; apply isSensitivePath to edit paths.
- [HIGH] sdk/src/serve/bridge.ts:404 — client MCP servers attached with no GV-18/GV-20 enforcement (SSRF, arbitrary stdio) — implement §12.3 transport gate before connection.
- [HIGH] common/src/util/redact-secrets.ts:15 — 5 hand-written secret shapes, `gh[o rus]_` typo, D15/D31 codegen absent — fix class; add missing prefixes/PEM/JWT; implement gitleaks codegen.
- [MEDIUM] sdk/src/serve/socket-listener.ts:334 — 16 MiB NDJSON cap missing on socket transport — wrap with limitNdJsonLineBytes.
- [MEDIUM] sdk/src/serve/outbound.ts:108 — outbound redaction covers provider keys only (GITHUB_TOKEN, AWS, DB URLs pass) — extend credential key surface + shape prefixes.
- [MEDIUM] packages/agent-runtime/src/supervision/parent-bridge-server.ts:200 — bridge socket has no per-connection auth; same-uid pivot to parent apiKey/fetch/credits — per-server secret or SO_PEERCRED check.
- [MEDIUM] common/src/mcp/client.ts:207 — blanket origin-mark can upgrade unmarked untrusted configs to trusted — provenance-checked marking only.
- [MEDIUM] common/src/mcp/client.ts:551 — project-origin MCP configs get process-env $VAR expansion and unrestricted egress — restrict substitution / gate first connection.
- [LOW] sdk/src/tools/run-terminal-command.ts:30 — staged-commit secret scan matches only PEM/AKIA — broaden patterns; pluggable scanner.
- [LOW] sdk/src/serve/socket-listener.ts:351 — auth length pre-check leaks token length — compare sha256 digests (dash pattern).
- [LOW] cli/src/utils/run-state-storage.ts:455 — checkpoint temp file 0644 + sweep deletes concurrent writers' temps — mode 0o600; pid-scoped sweep.
- [LOW] packages/indexer/src/index-store.ts:1050 — pid-reuse makes a stale lock look alive for 5 min — boot-unique owner token or bounded wait.

### Correctness
- [HIGH] packages/agent-runtime/src/util/run-journal.ts:343 — journal replay keyed on 32-bit FNV-1a; collision replays wrong tool result — key on canonical input (or re-compare + sha256).
- [HIGH] packages/agent-runtime/src/run-agent-step.ts:1655 — built-in resume never re-drives children/background jobs (logging-only seams) — wire production seams or surface a deferred verdict.
- [HIGH] packages/agent-runtime/src/util/background-agent-jobs.ts:211 — core ring vs view ring sequence drift silently loses chunks for cursor consumers — one sequence space derived from the snapshot.
- [HIGH] cli/src/components/image-card.tsx:64 — raw terminal escape sequences injected into OpenTUI `<text>` render as garbage — use native image renderable or raw-stdout writer.
- [MEDIUM] packages/agent-runtime/src/run-agent-step.ts:2155 — routed model never threaded into token estimator; Anthropic 1.35 applied universally (~35% overstatement) — thread model through counter/budget/ledger.
- [MEDIUM] packages/agent-runtime/src/util/archive-recall-index.ts:105 — FTS5 path not byte-identical to scanner (adjacency vs substring) — post-filter with the scanner predicate or fix the contract.
- [MEDIUM] agents/context-pruner.ts:100 — pruner estimator (chars/3, tool messages = 0) disagrees with runtime estimator — single trigger input + same-estimator budget math.
- [MEDIUM] packages/agent-runtime/src/supervision/supervised-spawn.ts:271 — restart delay cap Number.MAX_SAFE_INTEGER still fires setTimeout immediately — clamp to 2^31-1 / practical max.
- [MEDIUM] packages/agent-runtime/src/supervision/child-entry.ts:150 — getUserInfoFromApiKey null for children while dep gate says supplied — bridge a projection or surface in receipt errors[].
- [MEDIUM] cli/src/utils/turn-snapshots.ts:470 — concurrent snapshot captures fork the private ref chain (last-writer-wins update-ref) — single-flight queue + CAS update-ref.
- [MEDIUM] cli/src/utils/turn-snapshots.ts:940 — bisection rewrites the tracked tree with no guard against concurrent turns/edits — refuse during active runs; verify tree per probe.
- [MEDIUM] cli/src/utils/text-layout.ts:44 — Array.from code-point splitting breaks grapheme width accounting — Intl.Segmenter grapheme iteration.
- [MEDIUM] packages/indexer/src/scip-ingest.ts:332 — merged index served with queryData deleted; postings fast path gone until rebuild — rebuild queryData on merge.
- [MEDIUM] evals/buffbench/run-buffbench.ts:244 — decideProposalPromotion never invoked in the live loop — wire it into the proposals flow with recorded verdicts.
- [MEDIUM] rust/crates/openbuff-native/src/lib.rs:74 — D49 exec role (bubblewrap+seccomp) Linux-only while CI ships darwin/windows binaries — cfg-gate platform contract now.
- [MEDIUM] agents/base2/base2.ts:11835 — gate fingerprint `files-v4` format ambiguous for paths with tab/newline — length-prefix/JSON-encode paths, bump to v5, adversarial golden.
- [LOW] sdk/src/tools/file-change-hooks.ts:695 — configured hooks run under assistant mode; high-impact shapes hard-denied with no approval path — hooks policy namespace.
- [LOW] sdk/src/services/harness-enforcement.ts:634 — approval consume path unreachable outside run_terminal_command branch — thread approvals or dedicated hook namespace.
- [LOW] packages/agent-runtime/src/util/run-journal.ts:1146 — tail-window completion scan is provably dead code — delete or mark defensive no-op.
- [LOW] packages/agent-runtime/src/tool-stream-parser.old.ts:1 — dead superseded parser in src — delete.
- [LOW] packages/agent-runtime/src/util/context-archive.ts:329 — recallFromArchive early-exit overstates archivedAt provenance — return only searched snapshots.
- [LOW] packages/agent-runtime/src/util/context-budget.ts:1 — ledger mixes exact window with 1.35-factored measures — price lines with the routed model's factor.
- [LOW] packages/agent-runtime/src/supervision/parent-bridge-server.ts:435 — rehydrateParams depth>12 silently drops structures — loud warning or fail closed.
- [LOW] packages/indexer/src/scip-ingest.ts:375 — SCIP symbol→definition last-writer-wins for multiply-defined symbols — set of definitions or documented single-definition pick.
- [LOW] packages/code-map/src/grammar-wasm-repair.ts:323 — grammar checksum gating sound (confirmation) — optional fsync before rename.
- [LOW] cli/src/utils/index-workspace-watcher.ts:160 — new-directory events force whole-session markStale; warn latch caps at 32 silently — split ambiguity kinds; aggregate counter.
- [LOW] cli/src/utils/tree-sitter-client.ts:220 — untrusted mkdtemp dir never cleaned; parsersRegistered=true with zero parsers — exit cleanup; set flag only when parsers>0.
- [LOW] common/src/tools/params/edit-blocks.ts:109 — EB-SEC-1 gate compares UTF-16 length to a byte cap — use Buffer.byteLength.
- [LOW] evals/buffbench/statistics.ts:251 — Wilcoxon varW<=0 returns applicable:true with neutral z=0/p=1 — return applicable:false with reason.

### State mutation
- [HIGH] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2738 — supervised spawn returns pre-spawn agentState; child state never flows back — carry final state slice in the receipt or gate parent consumers.
- [HIGH] packages/agent-runtime/src/supervision/supervised-spawn.ts:198 — nonzero_exit restart re-runs the whole body after side effects (duplicate mutations/credits) — side-effect attestation or idempotent restart keys.
- [HIGH] packages/agent-runtime/src/util/workspace-path-leases.ts:16 — lease registry process-local; mutual exclusion vanishes across supervision boundary — bridge or persist leases.
- [MEDIUM] sdk/src/serve/bridge.ts:437 — gate-state parsed from raw model text; prompt-injected `<gate-state>` forges the ext-v1 channel — structured gate events; text advisory only.
- [MEDIUM] packages/agent-runtime/src/util/context-archive.ts:34 — archive worst case ~200M chars per agent state, no aggregate byte cap — aggregate budget, oldest-first.
- [MEDIUM] packages/agent-runtime/src/util/workspace-path-leases.ts:101 — release has no ownership check and no fencing token — require ownerAgentId; add generation numbers.
- [MEDIUM] cli/src/utils/turn-snapshots.ts:658 — retention writes repo-global refs/replace grafts, unbounded and pushed by --mirror — openbuff-namespaced watermark or guarded cleanup.
- [MEDIUM] cli/src/utils/run-state-storage.ts:270 — writeJsonAtomic fallback unlinks the authoritative file before rename (non-atomic window) — rename-with-backup semantics.
- [MEDIUM] packages/indexer/src/index-store.ts:826 — saveChunkSidecar has no CAS/newest-wins gate — gate on snapshotId/builtAt like saveIndex.
- [LOW] sdk/src/services/workspace-mutation-broker.ts:521 — broker receipts directory grows without bound — prune newest-K under the workspace lock.
- [LOW] packages/agent-runtime/src/util/orchestration-ledger.ts:23 — no spawn_finished idempotency; checksum recomputed post-compaction — dedupe by spawnId; compaction chain marker.
- [LOW] packages/indexer/src/index-store.ts:222 — saveIndex returns true when tier-4 cap skip persisted nothing — tri-state or persisted:false marker.
- [LOW] agents/base2/gate-state.ts:554 — presence-is-gate-active and normalization assumptions are cross-site invariants — named enforcer; normalize receipt.files at mint.
- [LOW] evals/buffbench/run-buffbench.ts:244 — verified positive: proposal dry-run never persists (confirmation) — optionally record the decision report.

### Error handling
- [MEDIUM] sdk/src/run.ts:2446 — SYNC run_terminal_command defaults to infinite timeout — bounded default (300s) with explicit -1 opt-in.
- [MEDIUM] packages/agent-runtime/src/tool-stream-parser.ts:226 — XML tool calls awaited inline with no error boundary; one throw kills the stream — per-call try/catch emitting an error chunk.
- [MEDIUM] packages/agent-runtime/src/supervision/parent-bridge-server.ts:223 — oversized reply destroys the whole socket, killing all in-flight requests — per-method result budget with structured failure reply.
- [MEDIUM] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3000 — supervised child ignores parent AbortSignal; runs to 10-min deadline after cancellation — bridged cancel notification.
- [MEDIUM] packages/code-map/src/grammar-wasm-repair.ts:203 — Retry-After honored up to 3600s per attempt (2-hour stall) — cap at 30s / bound total wall-clock.
- [LOW] sdk/src/services/acp/session-data.ts:344 — journal write failures swallowed while hasJournal() advertises resume/replay — degrade the capability map honestly.
- [LOW] packages/agent-runtime/src/run-agent-step.ts:1675 — replay telemetry counts logging-only seams as attempted/succeeded — executed:false marker.
- [LOW] packages/agent-runtime/src/supervision/process-supervisor.ts:346 — killed set before kill attempt; internal_error discards stdout diagnostics — set post-kill; include captured bytes.
- [LOW] evals/buffbench/statistics.ts:79 — empty pairs return all-zero CI sentinel — structured empty verdict.

### Performance
- [MEDIUM] sdk/src/tools/change-file.ts:641 — edit_transaction does ~3N full-file reads + ~4N hashes per transaction — carry prepare-time hash; drop the subsumed recheck.
- [MEDIUM] packages/indexer/src/index-store.ts:32 — LOCK_TIMEOUT_MS (10s) shorter than a 47MB save's critical section — scale deadline with artifact size / heartbeat-aware wait.
- [MEDIUM] packages/indexer/src/query.ts:617 — scoring is not BM25 (no TF saturation/length norm; substring candidate scan on hot path) — interim BM25 in TS; tantivy cutover replaces it wholesale.
- [MEDIUM] cli/src/hooks/use-viewport-window.ts:947 — anchor layout effect runs every render with three O(N) array copies per scroll tick — explicit dep array; memoize topSpacer.
- [MEDIUM] cli/src/utils/index-workspace-watcher.ts:100 — synchronous existsSync/statSync per watcher event on the UI thread — classify inside the debounced flush.
- [LOW] sdk/src/tools/node-filesystem.ts:120 — bounded range read scans the entire file byte-by-byte — Buffer.indexOf scanning + early-exit fast path.
- [LOW] cli/src/components/image-card.tsx:57 — sync readFileSync + base64 of full image per card render — async read, memoize per path.
- [LOW] agents/context-pruner.ts:13 — 3,347-line single definition with ~80 inline helpers blocked from extraction by serialization — sequence after D53 bundling.

### Dependency hygiene
- [MEDIUM] cli/package.json:37 — @gravity-ai/api declared, never imported (supply-chain surface) — remove or gate behind the first importing PR.
- [MEDIUM] cli/package.json:48 — posthog-node declared, never imported — remove or move to the importing workspace package.
- [MEDIUM] packages/internal/src/openai-compatible/openai-compatible-provider.ts:1 — two hand-rolled vendored provider wrappers drifting from upstream — use upstream for the plain wrapper; VENDORED_FROM header for the fork.
- [LOW] sdk/src/tools/run-terminal-command.ts:4 — deep relative cross-package imports bypass the @codebuff/common alias — use the package alias.
- [LOW] sdk/src/tools/transaction-intent-log.ts:561 — userspace pid+token advisory locking re-implements kernel primitives — consolidate on flock via native helper; TS right for everything else.
- [LOW] sdk/src/services/acp/acp-agent.ts:1169 — dual-language protocol risk: TS bridge re-implements the Rust daemon's future surface — freeze ext-v1 wire contract as the single boundary.
- [LOW] packages/indexer/src/ts-module-resolver.ts:207 — oxc primary tier correct; alias behavior differs between tiers — wire oxc tsconfig aliases to the fallback too.
- [LOW] cli/package.json:53 — yoga-layout undeclared intent (probable transitive pin) — document or remove.
- [LOW] cli/package.json:35 — caret ranges on high-churn runtime deps with no frozen-lockfile CI check — lockfile verification or tightened ranges.
- [LOW] cli/src/native/ripgrep.ts:58 — vendored-rg digest verification fails OPEN for unpinned paths — invert the default; release-checklist assertion.
- [LOW] cli/src/utils/turn-snapshots.ts:60 — undeclared system git/chmod toolchain assumed on PATH — document + one-shot startup probe.
- [LOW] cli/src/utils/index-dir-watch.ts:22 — IGNORED_TOP_LEVEL duplicated to break a cycle (drift risk) — leaf module or structural-equality test.
- [LOW] cli/src/utils/terminal-images.ts:9 — no defect (confirmation) — optional header-comment cleanup.
- [LOW] cli/package.json:58 — dev-deps correctly confined to tests (confirmation) — optional no-restricted-imports lint rule.
- [LOW] rust/crates/openbuff-native/src/lib.rs:74 — "zero external deps" charter conflicts with planned rusqlite daemon role — scope the charter; pre-register the dependency set.

### Test coverage gaps
- [MEDIUM] sdk/src/__tests__/harness-enforcement.test.ts:1 — no tests for classifier evasion, owned-temp binaries, custom-tool self-certified receipts, or transaction read amplification — four targeted tests.
- [MEDIUM] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:3007 — no real-shell-grandchild reap test; no cross-process lease test — real-child e2e + two-process lease conflict test.
- [MEDIUM] packages/indexer/src/index-manager.ts:928 — no regression tests for queryData degradation or sidecar clobber — ingest → query regression test.
- [MEDIUM] .github/workflows/buffbench.yml:5 — evals never gate PRs — deterministic unit gate + required check on buffbench-critical paths.
- [LOW] common/src/protocol/__tests__/acp-ext-v1.golden.test.ts:525 — semantic security vectors (GV-17/18/20/29/30) validated as fixture JSON only — integration test driving runServe.
- [LOW] cli/src/utils/terminal-images.ts:220 — DA1 parser test-only, production detection env-only — wire the probe or delete the parser.
- [LOW] .github/workflows/rust-workspace.yml:110 — no cargo clippy/fmt gate — add `-D warnings` clippy + fmt --check.

### API/ABI contract breaks
- [MEDIUM] sdk/src/run.ts:2222 — custom tool definitions bypass the external-mutation attestation downgrade — same downgrade scan or reject mutation-shaped payloads.
- [MEDIUM] sdk/src/tools/change-file.ts:106 — three divergent error shapes for containment refusal across write tools — one structured not_applied shape.
- [MEDIUM] sdk/src/services/acp/acp-agent.ts:856 — GV-14 pins -32600/prompt_in_flight vs implemented -32602/session_busy — align one way.
- [MEDIUM] sdk/src/services/acp/session-data.ts:23 — hand-copied FilesystemMutationEvent can drift — extract to a leaf module, single vocabulary.
- [MEDIUM] sdk/src/services/acp/session-data.ts:161 — two drifted `<gate-state>` parsers (CLI vs SDK) — one canonical parser in common.
- [MEDIUM] packages/agent-runtime/src/supervision/parent-bridge-server.ts:262 — notify budget keyed on child-controlled id prefix; BRIDGE_CLOSE_ID echoable — classify by method; reserve the id.
- [MEDIUM] packages/agent-runtime/src/supervision/child-bridge-client.ts:351 — zod refinements/transforms fail closed mid-run under supervision — spawn-time eligibility pre-flight.
- [MEDIUM] packages/agent-runtime/src/util/archive-recall-index.ts:1 — P6-T6 tantivy wrong for archive recall — scope tantivy to repo search.
- [MEDIUM] packages/agent-runtime/src/util/run-replay-driver.ts:1 — P9-T4 QuickJS heap-snapshot text contradicts the D35 journal-replay protocol — rewrite the task text; add P2-T2b backlog item.
- [MEDIUM] sdk/src/services/language-intelligence.ts:4 — no shared symbol/language registry across four surfaces (D29 unimplemented) — one registry + canonical symbol-ID scheme.
- [MEDIUM] cli/src/utils/run-journal-path.ts:73 — four durability layers with no recovery precedence — one coordinator validating turn ids across layers.
- [MEDIUM] agents/base2/gate-files.ts:8 — four gate-helper copies + ~10 parity tests; D53 bundling is the correct fix — proceed with D53 in planned order.
- [MEDIUM] agents/base2/spawn-contract.ts:186 — two hand-synced specialist rosters over one population — derive both from one descriptor.
- [LOW] sdk/src/dash/server.ts:495 — dash handle URL ships the bearer token in the query string by default — print base URL + token separately.
- [LOW] packages/agent-runtime/src/util/context-budget.ts:1 — budget ledger window vs measured lines in incompatible token scales — state the estimator; price consistently. *(merged with r3 correctness entry above; same root)*
- [LOW] agents/base2/base2.ts:7293 — prompt-section budgets are ad-hoc per-site magic numbers — centralize budget constants.
- [LOW] packages/internal/src/openrouter-ai-sdk/provider.ts:18 — OpenRouterProvider extends LanguageModelV2 (factory typed as instance) — type after the upstream provider shape.

## Coverage

Shards read and finding counts (all files present and non-empty):
- r1-sdk-mutation-core.md: 13 findings (22 files audited)
- r2-protocol-serve.md: 14 findings (16 files)
- r3-agent-loop.md: 14 findings (14 files)
- r4-supervision.md: 16 findings (10 files)
- r5-index-intel.md: 12 findings (16 files)
- r6-cli-tui.md: 14 findings (13 files)
- r6b-cli-deps.md: 9 findings (9 files)
- r7-agents-contracts.md: 10 findings (17 files)
- r8-rust-evals-providers.md: 10 findings (19 files)
- **Total: 112 findings across 9 shards (~136 file-audits), all at snapshot d2df71d.**

Explicitly out of scope (not audited): `agents-graveyard/`, `docs/`, `.agents/` (except this session's scratchpad), `.github` plumbing beyond the CI workflows named in r8, `scripts/` tmux/tmux-viewer tooling, `test/` setup, and config directories.

Honest limitations:
- Feature-level evidence is heuristic-grade (shard-level static reading); the 12 highest-stakes DONE claims were source-verified, the rest were not individually re-verified.
- This synthesis is static-audit-only: no tests, builds, or runtime probes were executed.
- No raw source files were read during synthesis; unclear points below need a human or re-audit.

## Needs follow-up
- Whether `allowClientMcp` / any serve config flag exists as a design knob for the GV-18/20 gate (affects the recommended refusal error shape).
- The mint-site normalization of `receipt.files` (r7 gate-state invariant) was not read by any shard — verify before acting on supersession.
- Whether the `@gravity-ai/api` and `posthog-node` declarations are reserved for imminent provider/analytics work (affects remove-vs-wire).
- Whether the SDK's build pipeline actually resolves the deep relative imports in run-terminal-command.ts against built artifacts (r1) — would change severity if builds consume source only.
- The `yoga-layout` entry's status as a deliberate transitive pin for @opentui/core — confirm with the OpenTUI version justification.
