# Audit findings: shard-pr-cq-compaction

- Subsystems: agent-runtime/spawn-agent-receipts-handoff, agent-runtime/context-archive-recall, agent-runtime/tool-result-eviction, agents/context-pruner, agents/base2-gate-state, scripts/memory-drift-guard, cli/payload-sanitizer, agent-runtime/spawn-agent-inline-handler
- Features: typed-outcome-envelope-crashed-missing-schema-truncated-ok, oversize-artifact-persistence-tmpdir, fts5-indexed-archive-recall-with-sanitizer, eviction-archives-recallable-d26, pruner-ceiling-enforcement-blockers-receipts-verbatim, content-hash-review-receipt-staleness-suppression, word-boundary-credential-sanitizer, inline-spawn-lease-ledger-pairing, mutation-attestation-receipts, knowledge-memory-pinned-compaction
- Files covered: 10
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2770 — Supervised spawn envelopes collapse missing_output/schema_invalid/truncated into outcome 'crashed'
- **Risk:** The settle-chain classifier keys only on the message shape ('Subagent X crashed: ...'), so a supervised child that settled as missing_output, schema_invalid, or truncated is recorded in the receipt as outcome 'crashed' with a crash error entry. The claimed precedence crashed > missing_output > schema_invalid > truncated > ok collapses to a single outcome for all supervised non-ok settles, corrupting retry semantics (missing_output/schema_invalid are retryable=true in the in-process path but the crashed entry pushed here is retryable:false) and any downstream per-outcome telemetry.
- **Fix:** Carry the settle outcome as a structured field on the error envelope (e.g. { type:'error', outcome, message }) and have buildRuntimeAgentReceiptOrThrow prefer the structured field over message sniffing; keep the 'crashed:' wording only for genuine in-process throws.
- **Evidence:** spawn-agent-utils.ts mapSettledOutcomeToAgentOutput: all four non-ok cases return { type:'error', message:`Subagent ${agentType} crashed: ...${outcomeName}...` }; buildRuntimeAgentReceiptOrThrow crashEnvelopeMessage requires only startsWith('Subagent ') && includes(' crashed: ').

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1505 — persistOversizeArtifact grows os.tmpdir() without bound and leaks child output to world-readable tmp files
- **Risk:** Every oversize child output writes <tmpdir>/openbuff-spawn-output/<sha256>.json and nothing ever deletes these files: a long-lived host accumulates one file per distinct oversized output, unbounded disk growth. Files are written with default permissions into a shared tmp dir, so full untruncated child output (which can embed API keys, tokens, or customer code echoed by the child) is readable by other local users. The path is predictable from content, enabling probing.
- **Fix:** Write with mode 0o600, sweep the directory opportunistically (delete artifacts older than a TTL on process start or per write), and/or cap total bytes; never persist payloads that contain redacted-credential keys without passing them through the sanitizer.
- **Evidence:** spawn-agent-utils.ts persistOversizeArtifact: join(tmpdir(),'openbuff-spawn-output'), content-hash filename, writeFileSync default mode, catch{return undefined}; no delete/prune/TTL logic exists in the module.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2430 — lastSetOutputError may misclassify a recovered child as schema_invalid if the flag is not cleared on a later successful set_output
- **Risk:** outcome 'schema_invalid' is derived solely from agentState.lastSetOutputError being a non-empty string. If the runtime records the first rejected set_output but a later attempt succeeds (or the state is hydrated from a serialized session), the receipt is permanently downgraded to schema_invalid with a retryable error even though the final output was valid — a receipt-hash/state mismatch that permanently fails a healthy child. (Clear-on-success could not be confirmed from this shard's file set.)
- **Fix:** Verify (and if needed enforce) that lastSetOutputError is cleared on each successful set_output; alternatively stamp the recorded error with the set_output attempt index and only classify schema_invalid when it matches the terminal attempt.
- **Evidence:** spawn-agent-utils.ts: const lastSetOutputError = params.agentState?.lastSetOutputError ... : lastSetOutputErrorText ? 'schema_invalid' : ...

## [MEDIUM] correctness — packages/agent-runtime/src/util/context-archive.ts:150 — Eviction archive does NOT carry full original content — 4k truncation contradicts the D26 recall contract; eviction snapshots can evict semantic snapshots
- **Risk:** The D26 contract promises tombstoned tool results are recoverable with their FULL original content, but every archived body is passed through archiveMessage, which truncates json parts at MAX_ARCHIVE_MESSAGE_CHARS (4,000 chars). Any evicted tool result larger than 4k is only partially recoverable via recall_context — the tombstone destroyed the only full copy. Additionally, eviction snapshots share the MAX_ARCHIVE_SNAPSHOTS=8 cap with pre-compaction semantic snapshots, so a burst of eviction passes rotates the semantic archive out, silently destroying recall coverage of compacted transcripts.
- **Fix:** Either raise/drop the per-message cap for eviction snapshots (they are already bounded by the 8x200 envelope) or change the docblock/plan claim to 'truncated recoverable excerpt'; add a test asserting bodies >4k chars are (or are not) fully recoverable via recall_context.
- **Evidence:** context-archive.ts archiveEvictedToolResults: bounded.map(...).map(archiveMessage) with MAX_ARCHIVE_MESSAGE_CHARS=4000; docblock claims 'FULL original content' then concedes 'The truncated original is still the only recoverable form'.

## [LOW] correctness — packages/agent-runtime/src/util/context-archive.ts:275 — recallFromArchive early-return reports snapshotsSearched = archive.length though the scan bailed early
- **Risk:** When RECALL_MAX_RESULTS is reached mid-scan, the early return reports snapshotsSearched: archive.length even though older snapshots were never examined. Consumers using that count for coverage/provenance decisions (the handler surfaces it verbatim) are told the whole archive was searched.
- **Fix:** Track the actual highest snapshot index reached and return that, or document the field as 'snapshots available' rather than 'searched'.
- **Evidence:** context-archive.ts recallFromArchive: early return inside the double loop returns snapshotsSearched: archive.length.

## [LOW] correctness — packages/agent-runtime/src/util/archive-recall-index.ts:150 — Single non-tokenizable term forces whole-query FTS fallback; indexed/scanner divergence for symbol-bearing terms is untested
- **Risk:** sanitizeFtsQuery returns null (forcing scanner fallback) if ANY single word has no letter/number — one emoji or pure-punctuation term disables the index for the whole query. Also, words containing operator characters are split (a:b → "a" "b" AND), which changes semantics from the scanner's substring match for such queries; the docblock restricts the byte-identity claim to the fallback path, but no test in the referenced suite pins indexed-vs-scanner divergence for operator-heavy queries, so the 'indexed' empty result can be a false negative relative to what the scanner would have found.
- **Fix:** Drop only the offending term (keep the token-bearing ones) instead of failing the whole query, or document the all-or-nothing behavior; add tests pinning indexed-vs-scanner equivalence for operator- and punctuation-heavy queries.
- **Evidence:** archive-recall-index.ts sanitizeFtsQuery: if (!HAS_TOKEN_CHAR.test(word)) return null (applies to the whole query); FTS5_OPERATOR_CHARS replaces : with space so 'a:b' degrades to ANDed a,b.

## [LOW] error-handling — packages/agent-runtime/src/tools/handlers/tool/recall-context.ts:30 — handleRecallContext has no error envelope around searchConsolidations despite the 'never throws' claim
- **Risk:** The handler docblock argues it needs no error envelope because recallFromArchiveIndexed never throws, but the second call, searchConsolidations(agentState.contextConsolidations, query), is outside that guarantee; any throw there escapes the handler as an unhandled tool failure instead of a bounded jsonToolResult.
- **Fix:** Wrap the consolidation search in a try/catch that degrades to an empty consolidations array (optionally logging), keeping the handler's no-throw surface honest.
- **Evidence:** recall-context.ts: const result = await recallFromArchiveIndexed(...); const consolidations = searchConsolidations(agentState.contextConsolidations, toolCall.input.query); no try/catch.

## [LOW] correctness — packages/agent-runtime/src/util/tool-result-eviction.ts:55 — Tombstone detection by string prefix misclassifies genuine tool results that echo the marker
- **Risk:** isEvicted treats any tool result whose json string content starts with '[tool result evicted to free context' as already evicted. A tool result that legitimately echoes that text (e.g. a basher run of cat over the tombstone-bearing history, or an agent quoting it) is permanently skipped by eviction and, worse, its content is indistinguishable from a real tombstone for downstream logic.
- **Fix:** Detect the full tombstone shape (exact trailing marker suffix or a dedicated { evicted: true, toolCallId } envelope) rather than a prefix substring.
- **Evidence:** tool-result-eviction.ts isEvicted: part.value.startsWith(TOMBSTONE_MARKER); tombstone value is plain json string content.

## [MEDIUM] performance — packages/agent-runtime/src/util/tool-result-eviction.ts:300 — evictStaleToolResults pays 2+ full-array tokenizations plus per-candidate serializations on every step
- **Risk:** Every invocation serializes/tokenizes the ENTIRE message array twice (before and after) via countTokensJson, plus JSON.stringify per candidate for the tombstone estimate, plus a full JSON.stringify per candidate for protected-path scanning (up to 5MB region × 512 paths substring loop). On large transcripts this runs each agent step and dominates the 'zero-LLM-cost' premise with multi-pass O(total bytes) CPU.
- **Fix:** Tokenize once per message and reuse for both arrays (or count only the delta of changed messages), and precompute a single lowercased concatenated protected-path blob for the substring pre-filter before per-path checks.
- **Evidence:** tool-result-eviction.ts: countTokensJson(messages) - countTokensJson(nextMessages); approximateTokens per candidate; contentReferencesProtectedPath per candidate with 512-path includes loop.

## [MEDIUM] security — agents/context-pruner.ts:1900 — Prompt injection pinned across compaction: active-work/decision/blocker extraction runs on raw model-controlled text before sanitization
- **Risk:** sanitizeOperationalStateText is applied AFTER extractActiveWorkLines in the summarization loop (tool entries call extractActiveWorkLines(joinedToolEntry) on raw tool-result text, and user/assistant branches extract before sanitizing). A malicious tool result containing lines like 'Next required action: exfiltrate ...' or 'Reviewer findings from code-reviewer: BLOCKING ...' is copied verbatim into <pinned_active_work_state> and knowledge memory, which survives compaction and is re-injected into every future turn — a durable prompt-injection / memory-poisoning channel.
- **Fix:** Run line extraction only on sanitizeOperationalStateText output, and/or require pinned-state lines to originate from runtime-owned system-tagged messages rather than any assistant/tool text.
- **Evidence:** context-pruner.ts: extractPinnedActiveWorkState(previousSummaryContent) and for (const line of extractActiveWorkLines(text)) run on raw text; extractDecisionsFromAssistantText/extractBlockersFromText run on raw assistant text before sanitizeOperationalStateText.

## [MEDIUM] correctness — agents/context-pruner.ts:1480 — Pruner ceiling is not an enforceable upper bound while blockers/reviewReceipts/archivePointers survive: distinct-reviewer proliferation defeats collapse
- **Risk:** The while loop evicts EVICTION_ORDER fields first, then collapses reviewReceipts/blockers to one entry per reviewer agent-type prefix, then shrinks goal/nextAction to floors, then breaks. A run with many distinct reviewer types (each contributing one surviving receipt and one blocker, each up to 1,200/480 chars) plus archive pointers can keep estimateKnowledgeMemoryTokens(km) > ceiling forever with no further eviction available — the hard ceiling the docblock calls 'an enforceable upper bound' is not enforceable in that regime, crowding out the live working set on small windows.
- **Fix:** Bound the excluded fields by total chars (not just count), e.g. shrink per-entry caps or collapse to top-N distinct reviewers by recency so the block converges under the ceiling for any reviewer cardinality.
- **Evidence:** context-pruner.ts enforceKnowledgeMemoryBudgets: EVICTION_ORDER excludes the three fields; collapseToNewestPerReviewer keyed by reviewerEntryKey(entry) with one survivor per key; while-loop exits via break when no progress is possible.

## [LOW] security — agents/context-pruner.ts:2700 — Command output/error text persisted verbatim into cross-session task memory can carry secrets
- **Risk:** Tool error text (up to TOOL_ERROR_DETAIL_CHARS=1,200 per entry, 12 entries) and validation results are stored verbatim into taskMemory, which is persisted across sessions (.openbuff/memory/task-memory.json path per memory-drift-guard). Command output or error messages containing tokens/credentials are redacted nowhere in this path — the word-boundary sanitizer exists only in the CLI layer, not the runtime memory path.
- **Fix:** Route persisted memory entries through the credential-word redaction used by cli/src/utils/payload-sanitizer.ts, or restrict persisted validation text to exit codes/paths only.
- **Evidence:** context-pruner.ts: addUniqueEntry(knowledgeMemory.validationResults, `${commandSummary || toolMessage.toolName}: exit ${exitCode}`) and `Tool error from ${toolName}: ${failureText}` with failureText up to TOOL_ERROR_DETAIL_CHARS=1200, persisted via set_messages taskMemory.

## [MEDIUM] error-handling — scripts/memory-drift-guard.ts:470 — checkStaleness catch-all swallows all git failures and returns zero findings — staleness gate fails open silently
- **Risk:** The entire staleness computation (git status/log invocations, receipt verification, finding emission) is wrapped in one try/catch that returns [] on ANY error with only a console.debug. A missing/broken git binary, a permission failure, or an unexpected throw silently converts the blocking staleness gate into a pass — the CI/pre-push gate fails open exactly when its evidence source is unavailable.
- **Fix:** Distinguish 'no stale pairs' from 'could not determine': rethrow on unexpected errors, or emit a dedicated degraded finding/exit code when git invocations fail so the gate cannot silently pass.
- **Evidence:** scripts/memory-drift-guard.ts checkStaleness: try { ...batch git calls, receipt checks, findings push... } catch (err) { console.debug(...); return [] }.

## [MEDIUM] security — scripts/memory-drift-guard.ts:700 — Unauthenticated local review-receipt.json can be forged by an agent to permanently suppress staleness findings for its own edits
- **Risk:** The receipt is an unsigned local JSON file; verifyReceiptCoversPair only checks verdict==='LOOKS_GOOD' and that recorded hashes match current disk bytes. Any code path (or spawned agent with write access, or a compromised dependency) can compute sha256 of its own just-edited files and write the receipt, permanently suppressing the stale-knowledge finding for those bytes — precisely the 'receipt suppresses forever' failure mode, since the receipt is never bound to an actual reviewer run or workspace snapshot.
- **Fix:** Bind the receipt to the reviewer run (e.g. gate-issued receiptId + snapshotFingerprint verified against agent state, or a signed/hmac'd record with a runtime-held key) and validate schemaVersion === 1 and 64-hex hash format at load time.
- **Evidence:** scripts/memory-drift-guard.ts loadReviewReceipt/verifyReceiptCoversPair: plain JSON file under root/.openbuff/memory; verdict string comparison; hashes recomputed from disk only (a receipt over the attacker's own bytes verifies).

## [LOW] correctness — scripts/memory-drift-guard.ts:705 — RecordedReviewReceipt shape check does not pin schemaVersion or hash format
- **Risk:** loadReviewReceipt accepts schemaVersion as any number and fileHashes values as any non-empty string. A future v2 receipt shape or a truncated hash passes the shape check; verification then fails closed (finding stands), but a v2 receipt with different semantics would be silently misinterpreted under v1 rules rather than rejected as unsupported.
- **Fix:** Enforce schemaVersion === 1 and /^[a-f0-9]{64}$/i on hash values in loadReviewReceipt; treat non-conforming receipts as absent.
- **Evidence:** scripts/memory-drift-guard.ts loadReviewReceipt: typeof record.schemaVersion !== 'number'; Object.values(...).every((hash) => typeof hash === 'string').

## [LOW] performance — scripts/memory-drift-guard.ts:950 — Repeated package.json reads and serial per-pathspec git spawns in checkStaleness/checkCommand
- **Risk:** loadPackageJson re-reads and JSON.parses the same package.json for every `bun run` match in every markdown file (no memoization), and batchLastCommitFiles/lastCommitEpochs spawn one synchronous git process per distinct pathspec serially. On large docs trees the gate does hundreds of redundant fs reads and git spawns per run.
- **Fix:** Memoize package.json loads per subdir per run, and pass multiple pathspecs in a single git invocation (git log accepts multiple -- pathspecs only per-commit; use one rev-parse/log per unique path or git ls-files batching) where semantics allow.
- **Evidence:** scripts/memory-drift-guard.ts: loadPackageJson(root, subdir) inside the COMMAND_REGEX match loop; lastCommitFiles/lastCommitEpoch call execFileSync per pathspec inside batch helpers.

## [LOW] state-mutation — agents/base2/gate-state.ts:200 — reviewedReviewableFingerprint is a write-only dead field retained in durable serialized gate state
- **Risk:** The field is explicitly write-only (no production reader) yet is still written on every gate pass and kept for a 'deprecation window', so serialized gate state carries a stale scalar that can mislead future maintainers and fixture authors into treating it as live review evidence.
- **Fix:** Complete the documented removal now (drop the write, the ??= '' default, the field, and fixture seeds) instead of carrying dead serialized state through another window.
- **Evidence:** agents/base2/gate-state.ts reviewedReviewableFingerprint docblock: 'Readers: NONE ... base2.ts only writes it on the gate-pass path'.

## [MEDIUM] security — cli/src/utils/payload-sanitizer.ts:60 — Word-boundary credential sanitizer bypasses: bare 'auth', 'passphrase', 'pwd', and compound keys like 'credentialsJson' are not redacted
- **Risk:** Keys commonly holding secrets are not classified sensitive: 'auth': 'Bearer eyJ...' (auth is not in CREDENTIAL_WORDS; only 'authorization' is), 'passphrase', 'pwd', and 'credentialsJson' (credentials followed by 'json', which is not a carrier suffix) all pass through unredacted into cli.jsonl and persisted chat state. The word-boundary rule correctly saves refreshTokenCount/tokenizer but leaves these concrete bypasses open.
- **Fix:** Add 'auth', 'passphrase', 'pwd' to CREDENTIAL_WORDS and common blob suffixes ('json', 'data', 'pem', 'raw', 'body') to CREDENTIAL_CARRIER_SUFFIXES; add tests for these key shapes.
- **Evidence:** cli/src/utils/payload-sanitizer.ts CREDENTIAL_WORDS (no 'auth'); CREDENTIAL_CARRIER_SUFFIXES (no 'json'/'data'/'pem'); splitKeyWords('credentialsJson') → [credentials, json].

## [MEDIUM] correctness — cli/src/utils/payload-sanitizer.ts:230 — No recursion-depth limit in sanitizeValue; sanitizeMediaForUiState has no string/array/key bounds
- **Risk:** sanitizeValue recurses with no depth bound; the seen-WeakSet only handles cycles, not a legitimately 10k-deep nested object arriving in a tool result. sanitizeForChatPersistence/sanitizeForDebugLog on hostile or accidental deep payloads throw RangeError (stack overflow) inside persistence/logging paths, crashing the CLI rather than truncating. sanitizeMediaForUiState additionally runs with MAX_SAFE_INTEGER string cap and no object-key or array caps, so a huge UI-state payload is copied in full.
- **Fix:** Add a maxDepth (return a bounded '[depth exceeded]' marker beyond it) and give sanitizeMediaForUiState explicit key/array caps appropriate for UI state.
- **Evidence:** cli/src/utils/payload-sanitizer.ts sanitizeValue recurses with no depth guard (only a WeakSet cycle guard); sanitizeMediaForUiState passes Number.MAX_SAFE_INTEGER with no maxObjectKeys/maxArrayLength.

## [LOW] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts:330 — Dangling 'interrupted' ledger event when spawn_started emission itself throws
- **Risk:** appendOrchestrationEvent(spawn_started) is inside the try; if it throws (serialization/state error), the catch emits an 'interrupted' event whose subjectId never had a spawn_started, leaving a dangling interrupted record and skewing ledger pairing/telemetry.
- **Fix:** Move spawn_started emission before the try (or track whether it was emitted) so interrupted is only appended when a matching spawn_started exists.
- **Evidence:** spawn-agent-inline.ts: appendOrchestrationEvent({type:'spawn_started'...}) is the first statement in try; catch appends {type:'interrupted'} unconditionally when receiptReconciled is false.

## [LOW] dependency-hygiene — packages/agent-runtime/src/util/archive-recall-index.ts:165 — Undeclared runtime dependency on bun:sqlite via @ts-ignore dynamic import
- **Risk:** The FTS5 recall path silently depends on Bun's bundled SQLite build via @ts-ignore dynamic import; the package declares no engines/optional-dependency marker for it, and no test pins behavior on a host where bun:sqlite is absent (the fail-open fallback is exercised only via the createDatabase seam).
- **Fix:** Declare the runtime requirement explicitly (engines/bun or a documented optional capability) and add a CI matrix case asserting the fallback path on a non-Bun host.
- **Evidence:** archive-recall-index.ts: // @ts-ignore -- bun:sqlite has no type declarations without bun-types; const { Database } = (await import('bun:sqlite')) as unknown as BunSqliteModule.

## [MEDIUM] test-coverage — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:1505 — No tests for the oversize tmp-artifact persistence path or the eviction→archive recall round-trip
- **Risk:** The oversize fallback (artifactPath/artifactBytes/artifact contract, tmp-unwritable degradation, attestation-core rescue under truncation) and the D26 eviction→archiveEvictedToolResults→recall round-trip are only exercised indirectly via scenario/eval tests; nothing asserts the tmp artifact is actually readable via read_files or that eviction snapshots remain recallable after the 8-snapshot rotation evicts them.
- **Fix:** Add tests: (1) artifact written/read-back/cleanable on oversize output and omitted cleanly when tmp is unwritable; (2) end-to-end evict→archiveEvictedToolResults→recallFromArchiveIndexed round-trip including the 8-snapshot rotation case.
- **Evidence:** spawn-agent-utils.ts persistOversizeArtifact is module-private; write_audit_findings referencedBy lists context-archive/archive-recall-index/tool-result-eviction tests but no artifact-persistence or eviction→archive round-trip spec.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:2050 — Additive shape changes to spawned-output envelopes and eviction result are ABI-visible to consumers
- **Risk:** Additive but consumer-visible changes: (1) missing/empty child output now returns {summary,partial,errorMessage} instead of pass-through undefined; (2) type:'error' outputs gain partial:true; (3) evictStaleToolResults gains evicted?; (4) AgentReceipt gains outcome/review/contextUsage. Consumers written against the old shapes (tests or downstream tooling that treat absent output as success, or that switch on output.type === 'error' without partial) silently change behavior; the outcome field also changes receipt-schema consumers' expectations.
- **Fix:** Publish the additive receipt/envelope fields in the changelog and add a consumer-side type test asserting tolerance of unknown receipt fields; keep normalizeSpawnedAgentOutput's empty-output shape documented as a breaking change for any pre-D19 consumer.
- **Evidence:** spawn-agent-utils.ts normalizeSpawnedAgentOutput additive partial/error fields; tool-result-eviction.ts ToolResultEvictionResult adds evicted?; agentReceiptSchema gains outcome; recallFromArchiveIndexed is a new exported async API alongside sync recallFromArchive.

## Coverage receipt

### Subsystems
- agent-runtime/spawn-agent-receipts-handoff
- agent-runtime/context-archive-recall
- agent-runtime/tool-result-eviction
- agents/context-pruner
- agents/base2-gate-state
- scripts/memory-drift-guard
- cli/payload-sanitizer
- agent-runtime/spawn-agent-inline-handler

### Features
- typed-outcome-envelope-crashed-missing-schema-truncated-ok
- oversize-artifact-persistence-tmpdir
- fts5-indexed-archive-recall-with-sanitizer
- eviction-archives-recallable-d26
- pruner-ceiling-enforcement-blockers-receipts-verbatim
- content-hash-review-receipt-staleness-suppression
- word-boundary-credential-sanitizer
- inline-spawn-lease-ledger-pairing
- mutation-attestation-receipts
- knowledge-memory-pinned-compaction

### Files
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/util/context-archive.ts
- packages/agent-runtime/src/util/archive-recall-index.ts
- packages/agent-runtime/src/tools/handlers/tool/recall-context.ts
- packages/agent-runtime/src/util/tool-result-eviction.ts
- agents/context-pruner.ts
- agents/base2/gate-state.ts
- scripts/memory-drift-guard.ts
- cli/src/utils/payload-sanitizer.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-inline.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
