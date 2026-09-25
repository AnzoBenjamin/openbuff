# Audit findings: resolutions-M4-S6

- Subsystems: packages/indexer, packages/code-map, packages/internal, scripts, .github, docs, root-manifests-and-test-bootstrap
- Features: index-build-incremental-freshness, index-persistence-cache-locking, lexical-query-ranking, graph-traversal-query-modes, semantic-retrieval-tier, file-walk-discovery-exclusions, chunk-freshness-sidecar, tree-sitter-parsing-token-scores, code-chunking-structure, grammar-wasm-repair, openai-compatible-provider-streaming, openrouter-provider-streaming-usage, feat-memory-drift-guard, feat-tool-registration-check, feat-agent-config-sync, feat-gate-helpers-generator, feat-pruner-budgets-generator, feat-mutation-gate-runner, feat-ci-local-check, feat-ci-workflow, feat-nightly-e2e-workflow, feat-openbuff-example-config, getting-started-docs, project-knowledge-file, architecture-docs, agents-tools-docs, config-docs-and-examples, request-flow-docs, testing-docs, local-mode-docs, root-package-scripts, test-bootstrap-scm-loader
- Files covered: 40

## [HIGH] state-mutation — packages/indexer/src/index-store.ts:848 — ALREADY-RESOLVED: withCacheLock reclaims by mtime before liveness probe
- **Risk:** Current code reads the lock snapshot once, runs isLockOwnerDead(content) FIRST (deadOwner at :848), and only then applies the STALE_LOCK_MS age fallback for live/ambiguous owners; a 30s token-verified heartbeat (LOCK_HEARTBEAT_MS, :39/:779-796) keeps a live holder's mtime fresh so the age branch cannot fire mid-operation. M3-T3.
- **Fix:** None required; keep liveness-first ordering as an invariant for future edits.
- **Evidence:** index-store.ts:843-859 liveness-first with comment 'The age heuristic below must never preempt this check'; index-store.test.ts:218-221 hunts a dead PID for isLockOwnerDead(ESRCH) coverage

## [MEDIUM] state-mutation — packages/indexer/src/index-store.ts:226 — ALREADY-RESOLVED: saveSemanticVectors unlocked read-modify-write with no CAS
- **Risk:** saveSemanticVectors now takes options.expectedUpdatedAt, re-reads inside the lock, drops the write on generation mismatch, and union-merges over the on-disk entry (current write's vectors win; carried hashes bounded by MAX_CARRIED_SEMANTIC_VECTORS) so a losing writer cannot erase another fingerprint's vectors. M3-T3.
- **Fix:** None required.
- **Evidence:** index-store.ts:226 'options: { expectedUpdatedAt?: number } = {}' and :284-292 strictly-advancing updatedAt

## [MEDIUM] state-mutation — packages/indexer/src/index-manager.ts:127 — ALREADY-RESOLVED: FIFO eviction of live IndexManager singletons forks state
- **Risk:** Detached-instance gate: ensureBuilt/waitUntilReady/query/queryBlended forward to the registered singleton via instances.get(this.instanceKey); forwardPendingMutationsTo drains pendingMutationDelta/forceRefresh and mirrors the singleton's post-forward epoch via advanceEpochAfterForward (monotonic, no-regress). No second _build loop; signals always reach the instance answering queries. M3-T3.
- **Fix:** None required.
- **Evidence:** index-manager.ts:127-144 detached gate; :195-225 forwardPendingMutationsTo + advanceEpochAfterForward

## [MEDIUM] error-handling — packages/indexer/src/index-manager.ts:685 — ESCALATED: one transient embedder failure wipes the entire semantic tier
- **Risk:** catch in _buildVectors still sets this.fileVectors = [] and records lastBuildError; the persisted cache read (loadSemanticVectors) is not consulted on failure, so one embedder blip downgrades retrieval to lexical-only until a later full build succeeds.
- **Fix:** In _buildVectors catch: keep previous fileVectors or reload via loadSemanticVectors, mark semantic tier stale, clear only when getSemanticConfigFingerprint changes. Add regression test asserting a failed embed leaves prior vectors queryable.
- **Evidence:** index-manager.ts:685-693 catch keeps 'this.fileVectors = []' and never consults loadSemanticVectors in the failure path

## [MEDIUM] state-mutation — packages/indexer/src/index-manager.ts:94 — ESCALATED: second embedder silently ignored (cacheKey omitted from key and wiring)
- **Risk:** getInstanceKey still serializes only projectRoot/config fields (no embed.cacheKey) and getInstance still binds the first embedder forever ('if (embed && !instance.embed)'), so a runtime BYOK provider swap silently keeps the stale embedder and fingerprint.
- **Fix:** In getInstance: when instance.embed && embed.cacheKey !== instance.embed.cacheKey, rewire embed, clear fileVectors, forceRefresh, ensureBuilt(). Add test mirroring index-manager-semantic.test.ts 'reuses persisted vectors' with two differing cacheKeys.
- **Evidence:** index-manager.ts:94-101 first-wiring branch has no else for changed cacheKey; :109-120 getInstanceKey payload

## [MEDIUM] security — packages/code-map/src/parse.ts:145 — ESCALATED: getFileTokenScores joins caller-supplied paths onto projectRoot with no traversal guard
- **Risk:** getFileTokenScores still does path.join(projectRoot, filePath) with no '..'/absolute/NUL rejection before statSync/readFileSync in loadSourceWithinLimits, unlike statProjectFiles' guard; a corrupted index cache can read arbitrary files outside the project.
- **Fix:** Reject absolute paths, '..' segments, and NUL before joining; resolve and verify the final absolute path stays under projectRoot (mirror statProjectFiles); add regression tests in packages/code-map/__tests__/parse.test.ts.
- **Evidence:** parse.ts:145 join without guard vs file-walker.ts statProjectFiles lstat/no-dotdot discipline; loadSourceWithinLimits :413/:422 reads the joined path

## [MEDIUM] security — packages/indexer/src/file-walker.ts:426 — ALREADY-RESOLVED: recursive walk stats with fs.stat (follows symlinks) — TOCTOU escape
- **Risk:** walkProjectDetailed now lstat()s file entries and skips isSymbolicLink(), matching statProjectFiles' documented no-follow contract; directory recursion also re-verifies with lstat at the recursion point (walk-dir-swap-after-lstat-window). M3-T3.
- **Fix:** None required.
- **Evidence:** file-walker.ts:422-431 lstat comment 'P8.6: lstat (not stat) so a symlink swapped in between readdir and stat is skipped', :400-411 dir re-verify

## [MEDIUM] security — packages/code-map/src/grammar-wasm-repair.ts:165 — ESCALATED: unbounded response.arrayBuffer() before hashing enables memory exhaustion
- **Risk:** Verified bytes are still buffered via 'new Uint8Array(await response.arrayBuffer())' before the sha256 check; a hijacked asset source can force multi-GB allocation before the hash fails.
- **Fix:** Enforce a byte cap (e.g. 20MB) while streaming the body and abort on excess; reject early on missing/oversized Content-Length. Add a grammar-wasm-repair.test.ts case feeding an oversized ReadableStream body.
- **Evidence:** grammar-wasm-repair.ts:165 unchanged; releaseBody (:119) bounds sockets, not bytes

## [MEDIUM] security — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:702 — ESCALATED (out-of-scope): provider-controlled tool_calls[].index used as raw array index
- **Risk:** toolCallDelta.index (unbounded z.number(), passthrough schema) is still used as a raw array index; a hostile compatible endpoint can force a huge sparse allocation from one SSE chunk. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Validate index as integer in [0, 64) before use; enqueue an error stream part and drop the chunk on violation.
- **Evidence:** shard evidence: 'const index = toolCallDelta.index' then 'toolCalls[index] = {...}'; schema '.passthrough()' with 'index: z.number()'

## [MEDIUM] correctness — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:878 — ESCALATED (out-of-scope): early controller.terminate() on tool-calls drops the trailing usage chunk
- **Risk:** controller.terminate() on finish_reason 'tool-calls' still discards trailing include_usage chunks, undercounting tool-call turn usage. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Mark tool-calls complete and let flush() emit finish after the stream ends (or keep the fast path only when the same chunk already carried usage).
- **Evidence:** shard evidence: emitFinish(controller); controller.terminate() on tool-calls while usage updates arrive in later chunks

## [MEDIUM] correctness — packages/internal/src/openrouter-ai-sdk/chat/index.ts:456 — ESCALATED (out-of-scope): stream finish emits Number.NaN token usage
- **Risk:** usage is still initialized to Number.NaN and emitted verbatim when the provider sends no usage chunk (include_usage only requested in strict mode). HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Initialize usage fields to undefined and omit absent values; compute totalTokens only from both numeric parts.
- **Evidence:** shard evidence: usage literal Number.NaN fields emitted in finish part

## [MEDIUM] correctness — packages/internal/src/openrouter-ai-sdk/chat/index.ts:680 — ESCALATED (out-of-scope): missing tool_call index falls back to toolCalls.length - 1
- **Risk:** index-less first tool_call still lands in hidden slot toolCalls[-1] and is dropped by the array-iterating flush. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Use 'index ?? toolCalls.length' (append) and clamp to a sane bound; verify non-negative integer before use.
- **Evidence:** shard evidence: 'index ?? toolCalls.length - 1'; flush iterates the array only

## [MEDIUM] error-handling — packages/internal/src/openrouter-ai-sdk/chat/index.ts:685 — ESCALATED (out-of-scope): InvalidResponseDataError thrown inside transform escapes as stream failure
- **Risk:** InvalidResponseDataError throws inside transform still error the whole stream instead of emitting an error part, so flush() and the finish part are lost. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Replace throws with controller.enqueue({type:'error'}) + finishReason='error' and skip the malformed delta, matching openai-compatible-chat-language-model.ts.
- **Evidence:** shard evidence: three InvalidResponseDataError throws plus 'Tool call is missing' inside transform; flush skipped on stream error

## [MEDIUM] correctness — packages/indexer/src/query.ts:906 — ESCALATED: persisted queryData.adjacency trusted without coverage validation
- **Risk:** buildAdjacency still trusts a present persisted adjacency map wholesale; isValidQueryData only range-checks per-index values, so a partial/corrupt adjacency silently drops graph edges for unlisted nodes.
- **Fix:** Validate coverage at load (each edge index appears exactly once across adjacency values and count === edges.length); on mismatch rebuild adjacency from graph.edges; add regression test with a truncated persisted adjacency.
- **Evidence:** query.ts:911-918 early return on persisted; index-store.ts isValidQueryData per-index range checks only

## [MEDIUM] correctness — packages/code-map/src/parse.ts:490 — ESCALATED: buildTokenCallers documented global fallback not implemented
- **Risk:** buildTokenCallers still uses 'const eligible = sameLanguage' with no fallback to all candidates, contradicting the adjacent comment; cross-language unambiguous calls produce no caller edge.
- **Fix:** Implement the documented rule: use sameLanguage when non-empty else candidates, resolve only when exactly one entry; add a cross-language unambiguous-definition test.
- **Resolution note (2026-09-25):** the fallback was implemented, then REVERTED to same-language-only: the indexer's pre-existing pinned contract (packages/indexer/src/call-navigation.test.ts 'does not create cross-language raw-name call edges') contradicts a cross-language fallback, and the audit's own comment-vs-code reading was stale relative to that pinned test. The conservative tested contract wins: stale comment corrected, code-map test rewritten to pin the same-language-only rule plus the single-definition positive case; the indexer call-navigation test passes unchanged.
- **Evidence:** parse.ts:486-492 comment 'or globally when no same-language definition exists' vs 'const eligible = sameLanguage'

## [MEDIUM] correctness — packages/code-map/src/chunks.ts:552 — ESCALATED: outgoing chunk references lack the calledBy ambiguity rule
- **Risk:** The outgoing-reference pass still pushes the first deduped target and breaks when distinct.size > 1, while calledBy refuses ambiguous guesses — asymmetry yields wrong chunk-level blast radius.
- **Fix:** Apply the same unambiguous rule on the outgoing path (emit only when distinct targets == 1, or mark ambiguous). Update chunks.test.ts expectations for ambiguous same-name cases.
- **Evidence:** chunks.ts:548-561 loop pushes then breaks vs :580 'if (distinct.size !== 1) return'

## [MEDIUM] correctness — packages/indexer/src/chunk-freshness.ts:194 — ALREADY-RESOLVED: inline hash match still reports ORPHAN
- **Risk:** evaluateChunkFreshness now returns { state: 'FRESH', reason: 'inline-hash-match' } when the inline lookup proves the stable id exists with an equal hash; ORPHAN is reserved for not-in-sidecar AND not-in-live-index. M3-T3 chunk-freshness labels.
- **Fix:** None required.
- **Evidence:** chunk-freshness.ts:194-202 'return { state: "FRESH", reason: "inline-hash-match" }'

## [MEDIUM] state-mutation — packages/code-map/src/chunks.ts:171 — ESCALATED: global chunkMemo is unbounded and not scoped by project
- **Risk:** chunkMemo is still an unbounded module-level Map keyed by bare file path; long-lived processes grow it with every chunked file and same-relative-path entries leak across projects.
- **Fix:** Bound chunkMemo with an LRU cap, scope keys by projectRoot, and clear on root build completion/eviction (mirror IndexManager's bounded instance cache); add a memo-eviction test.
- **Evidence:** chunks.ts:171 'const chunkMemo = new Map<...>()' with clearChunkMemo only in src/__tests__/chunks.test.ts

## [MEDIUM] state-mutation — packages/indexer/src/index-store.ts:46 — ESCALATED (partial): saveIndex still mutates .git/info/exclude by default
- **Risk:** writeGitExclude still defaults true; the P8.6b work added session-level dedupe (writtenGitExcludeLines) bounding the write rate, but the unadvertised .git/info/exclude mutation persists by default and the toggle remains module-global.
- **Fix:** Default the write off (or gate behind explicit openbuff.json/CLI opt-in), scope the toggle per projectRoot; document the side effect.
- **Evidence:** index-store.ts:46 'let writeGitExclude = true'; :1096-1112 appendFile with session dedupe

## [MEDIUM] error-handling — packages/indexer/src/semantic.ts:136 — ESCALATED: missing/empty batch embeddings dropped silently
- **Risk:** buildFileVectors still drops empty/missing embeddings with no else branch and no length assertion against batch.length; semantic recall holes are invisible in getStatus().
- **Fix:** Assert embeddings.length === batch.length and dimension consistency; retry failed batches with backoff; surface skippedPaths/count via diagnostics/coverage channels into getStatus().
- **Evidence:** semantic.ts:136-145 'if (vector && vector.length > 0)' with no else branch or batch.length assertion

## [MEDIUM] performance — packages/indexer/src/file-walker.ts:493 — ESCALATED: synchronous readFileSync per directory inside the async walk
- **Risk:** loadIgnorePatterns still uses fs.readFileSync and is called 3x per directory from the async walk and from isIgnoredLikeWalk's matcher builder; thousands of blocking syscalls interleave with awaited stats.
- **Fix:** Use fs.promises.readFile with the existing try/catch and batch the three lookups per directory (Promise.all + Set of names), keeping the per-directory matcher cache.
- **Evidence:** file-walker.ts:493-503 readFileSync; :315-317 and :374-378 three sequential loadIgnorePatterns calls per dir

## [MEDIUM] performance — packages/code-map/src/parse.ts:144 — ESCALATED: fully serial parse loop with blocking statSync/readFileSync per file
- **Risk:** getFileTokenScores still awaits parseTokensForScoring one file at a time with statSync/readFileSync on the default path and another statSync per skipped file; cold index latency is dominated by sequential blocking reads.
- **Fix:** Read with fs.promises.readFile and run parseTokensForScoring over a bounded concurrency pool (8-16) respecting the byte budget atomically, keeping fairParseOrder for truncation fairness.
- **Evidence:** parse.ts:144-222 sequential await loop; loadSourceWithinLimits :413/:422 sync I/O; getKnownFileSize sync stat

## [LOW] security — packages/indexer/src/query.ts:317 — ACCEPTED: index-derived repo text flows unsanitized into explanation/snippet fields
- **Risk:** Accepted with rationale: explanation/matchedSnippets embed repository-derived text, but all repository content read by the agent is equally attacker-controllable and already passes through the harness's untrusted-data handling; delimiting these specific fields adds contract churn without reducing the actual injection surface. Snippets are already capped at 5 entries and chunk snippets are bounded id/name/line strings.
- **Fix:** None now; revisit if the tool result contract gains a structured untrusted-data channel.
- **Evidence:** query.ts:317 explanation built from matchedSnippets; commandMatchedSnippets pushes raw concept strings

## [LOW] security — packages/internal/src/openrouter-ai-sdk/chat/index.ts:63 — ESCALATED (out-of-scope): supportedUrls advertises arbitrary-URL fetch for application/*
- **Risk:** supportedUrls still advertises /^https?:\/\/.+$/ for application/*, an SSRF surface to internal hosts. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Restrict to data: URIs or an explicit host/scheme allowlist; exclude link-local/loopback/private ranges before fetch.
- **Evidence:** shard evidence: supportedUrls map with /^https?:\/\/.+$/ pattern

## [LOW] security — packages/code-map/src/grammar-wasm-repair.ts:76 — ESCALATED: repaired WASM never re-verified at load; gdscript asset from third-party fork
- **Risk:** Repaired bytes are still not re-hashed at load time, and gdscript still pins a raw.githubusercontent.com fork URL (mutable third-party repo path) rather than a released artifact.
- **Fix:** Re-hash at load time before Parser.init (or mark repaired files read-only and verify once per process); vendor gdscript into the published package.
- **Evidence:** grammar-wasm-repair.ts:76-88 sourceUrl; resolveGrammarWasmSource stats repaired only for size (:249-256)

## [LOW] error-handling — packages/code-map/src/grammar-wasm-repair.ts:194 — ESCALATED: retry loop uses fixed 2s delay, no backoff/jitter/Retry-After
- **Risk:** The retry loop still sleeps a constant retryDelayMs and ignores Retry-After; parallel repair attempts hammer a rate-limited CDN in lockstep.
- **Fix:** Honor Retry-After when present, else exponential backoff with jitter; include the final HTTP status for all exhaustion paths.
- **Evidence:** grammar-wasm-repair.ts:193-196 constant sleep; :174-185 retry branch reads no headers

## [LOW] error-handling — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:135 — ESCALATED (out-of-scope): stream error message appends raw provider metadata
- **Risk:** createOpenAICompatibleStreamError still appends up to 2000 chars of provider-supplied metadata JSON to Error.message, leaking request fragments into user-visible transcripts. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Return a short sanitized message and keep metadata on a structured field (error.providerMetadata) logged behind a debug flag.
- **Evidence:** shard evidence: createOpenAICompatibleStreamError concatenates JSON.stringify of type/param/code/status/details truncated to 2000 chars

## [LOW] correctness — packages/indexer/src/semantic.ts:188 — ACCEPTED: semantic/lexical blend double-counts shared paths and is not a principled fusion
- **Risk:** Accepted with rationale: the additive blend is a deliberate, pinned product behavior — semantic.test.ts asserts the additive merge ('b.ts gets both lexical + semantic') and exact weight scaling, and queryBlended integration tests depend on it. Switching to RRF/min-max is a retrieval-quality redesign, not a defect fix; the arbitrary max-lexical scaling is documented in the function comment.
- **Fix:** None now; revisit only as part of a deliberate retrieval-quality change with updated pinned tests.
- **Evidence:** semantic.ts:183-190 unchanged additive fusion; semantic.test.ts:185-231 pins the additive and weight-scaling behavior

## [LOW] performance — packages/code-map/src/chunks.ts:443 — ESCALATED: each file parsed twice per chunk extraction plus per-chunk substring scans
- **Risk:** buildChunks still awaits parseFileStructure and then extractCallSites (a second full parse), plus per-chunk substring scans over import names.
- **Fix:** Parse once and share tree/query captures between structure and call-site extraction; precompute per-file name sets instead of substring includes.
- **Evidence:** chunks.ts:443-450 two parses; :595 substring includes inside the per-chunk loop

## [LOW] performance — packages/indexer/src/file-walker.ts:441 — ESCALATED: per-prefix candidate cap equals maxFiles, walk memory is O(prefixes x maxFiles)
- **Risk:** candidatesByPrefix still caps each top-level prefix at maxFiles (default 20k) before the global round-robin trim, so wide monorepos accumulate O(prefixes x maxFiles) candidate entries per refresh.
- **Fix:** Cap each prefix bucket at ceil(maxFiles / prefixCount) or use a bounded reservoir per prefix, preserving round-robin fairness for truncation.
- **Evidence:** file-walker.ts:441-453 per-prefix push with the global cap; results trimmed only by the final round-robin loop

## [LOW] performance — packages/indexer/src/index-store.ts:1059 — ESCALATED: atomicWriteJson pretty-prints large index artifacts
- **Risk:** atomicWriteJson still pretty-prints with JSON.stringify(value, null, 2) for metadata.json, semantic-vectors.json, and the chunk sidecar, roughly doubling bytes and CPU on every refresh.
- **Fix:** Serialize compactly for the large data files (or split vectors into a binary f32 buffer keyed by hash).
- **Evidence:** index-store.ts:1059 'JSON.stringify(value, null, 2)' used by all three save entry points

## [LOW] performance — packages/indexer/src/query.ts:577 — ESCALATED: scoring rescans all fields per token; IDF fallback scans the whole corpus
- **Risk:** scoreFile still rescans all fields per query token and computeIdfForTokens still falls back to fileContainsToken over every file for tokens missing from postings.
- **Fix:** Precompute per-file lowercase concatenated field text/token sets into queryData at build time and cache IDF per (index, token).
- **Evidence:** query.ts:575-586 whole-corpus fallback; :444+ nested per-token field loops

## [LOW] state-mutation — packages/indexer/src/query.ts:934 — ESCALATED: fileTypeSetCache keyed on the caller's mutable array reference
- **Risk:** fileTypeSetCache is still a WeakMap keyed on the caller's mutable array identity; in-place mutation of options.fileTypes between queries silently serves the stale normalized Set.
- **Fix:** Copy the array on first use (or key the cache by a joined string key); add a test mutating options.fileTypes between queries.
- **Evidence:** query.ts:932-948 WeakMap keyed by the caller's array reference

## [LOW] state-mutation — packages/indexer/src/index-manager.ts:327 — ESCALATED: waitUntilReady timeout resolves silently and leaks the timer
- **Risk:** waitUntilReady still returns void from an unlabelled Promise.race and never clears the losing setTimeout; callers cannot distinguish a hung build from readiness and the timer pins the event loop up to timeoutMs.
- **Fix:** Return a boolean/status and clear the timer in a finally; surface 'timed out waiting for index build' in getStatus().
- **Evidence:** index-manager.ts:326-331 plain Promise.race with an uncancellable setTimeout

## [LOW] correctness — packages/code-map/src/chunks.ts:700 — ESCALATED: zero-chunk non-empty files are never memoized and re-parse every call
- **Risk:** extractCodeChunksDetailed still memoizes only 'chunks.length > 0 || content.length === 0', so non-empty files yielding zero chunks are re-parsed on every refresh.
- **Fix:** Memoize empty results too (keyed by contentHash); the reuse path already treats cached.length === 0 as valid.
- **Evidence:** chunks.ts:700-702 'if (chunks.length > 0 || content.length === 0)' gates the memo set

## [LOW] api-contract — packages/indexer/src/index-store.ts:601 — ACCEPTED: saveChunkSidecar Promise<void> -> Promise<boolean} silent behavior change
- **Risk:** Accepted with rationale: the boolean return is an intentional, in-code-documented contract change; saveChunkSidecar is internal to the indexer workspace (no .d.ts is published from this repo, and the package is consumed from source), so the 'compiled consumers mis-assume' risk does not materialize in-tree. In-repo callers already branch on the boolean.
- **Fix:** None now; if the store API is ever republished as a package, record the change in its changelog/API docs at that time.
- **Evidence:** index-store.ts saveChunkSidecar doc comment 'this function previously returned Promise<void> and silently dropped invalid input; it now returns Promise<boolean> ... consumers ... should re-baseline and branch on the boolean'

## [LOW] api-contract — packages/internal/src/openrouter-ai-sdk/chat/index.ts:456 — ESCALATED (out-of-scope): providerOptions.openrouter and extraBody can override standardized request keys
- **Risk:** providerOptions.openrouter and extraBody are still spread last and can override messages/model/tools/stream. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Filter spread keys to an OpenRouter-only allowlist; reject/ignore reserved keys (messages/model/tools/stream).
- **Evidence:** shard evidence: '{ ...this.getArgs(options), ...openrouterOptions }'; extraBody spread after messages

## [LOW] dependency-hygiene — packages/internal/src/openrouter-ai-sdk/chat/index.ts:39 — ESCALATED (out-of-scope): provider layer imports a type from the top-level 'ai' package
- **Risk:** Provider layer still imports a type from the top-level 'ai' package, coupling it to the full AI SDK. HARD FORBIDDEN scope: packages/internal/**.
- **Fix:** Type the local variable as LanguageModelV2FinishReason (already imported) or a small local union; drop the 'ai' import.
- **Evidence:** shard evidence: import type { FinishReason } from 'ai' used only for 'let finishReason: FinishReason = "other"'

## [MEDIUM] test-coverage — packages/internal/src/openrouter-ai-sdk/chat/index.ts:1 — ESCALATED (out-of-scope): no tool-call streaming state-machine test coverage
- **Risk:** Tool-call streaming state machine remains covered only by usage-accounting tests; the NaN-usage / -1-index / transform-throw paths are exactly the untested ones. HARD FORBIDDEN scope: packages/internal/** (and its tests).
- **Fix:** Add deterministic stream-shape tests feeding synthetic SSE chunks (missing/shifted index, absent usage, mid-stream error, finish without [DONE]) asserting the emitted LanguageModelV2StreamPart sequence.
- **Evidence:** shard evidence: only usage-accounting test importers; transform spans ~250 lines of branching with no stream-shape tests

## [LOW] test-coverage — packages/indexer/src/index-store.test.ts:685 — ALREADY-RESOLVED: lock-lifecycle races lack deterministic multi-writer tests
- **Risk:** Deterministic lock-lifecycle tests now exist: index-store.test.ts constructs dead-owner lock files (walks PIDs to force ESRCH), covers reclaimStaleLock (stale-content match, fresh-content refusal, already-reclaimed, no-scratch-files, displaced-live-lock restore) and releaseOwnedLock (owned delete, foreign-content refusal, missing lock), and the liveness-first reorder makes the stolen-live-lock case structurally impossible rather than test-dependent.
- **Fix:** None required.
- **Evidence:** index-store.test.ts:630-735 reclaimStaleLock suite (match/mismatch/gone/scratch-cleanup/displaced-restore) and :738+ releaseOwnedLock suite; dead-pid hunting at :218-221

## Coverage receipt

### Subsystems
- packages/indexer
- packages/code-map
- packages/internal
- scripts
- .github
- docs
- root-manifests-and-test-bootstrap

### Features
- index-build-incremental-freshness
- index-persistence-cache-locking
- lexical-query-ranking
- graph-traversal-query-modes
- semantic-retrieval-tier
- file-walk-discovery-exclusions
- chunk-freshness-sidecar
- tree-sitter-parsing-token-scores
- code-chunking-structure
- grammar-wasm-repair
- openai-compatible-provider-streaming
- openrouter-provider-streaming-usage
- feat-memory-drift-guard
- feat-tool-registration-check
- feat-agent-config-sync
- feat-gate-helpers-generator
- feat-pruner-budgets-generator
- feat-mutation-gate-runner
- feat-ci-local-check
- feat-ci-workflow
- feat-nightly-e2e-workflow
- feat-openbuff-example-config
- getting-started-docs
- project-knowledge-file
- architecture-docs
- agents-tools-docs
- config-docs-and-examples
- request-flow-docs
- testing-docs
- local-mode-docs
- root-package-scripts
- test-bootstrap-scm-loader

### Files
- packages/indexer/src/index-store.ts
- packages/indexer/src/index-manager.ts
- packages/indexer/src/query.ts
- packages/indexer/src/semantic.ts
- packages/indexer/src/file-walker.ts
- packages/indexer/src/chunk-freshness.ts
- packages/indexer/src/index-store.test.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/chunks.ts
- packages/code-map/src/grammar-wasm-repair.ts
- packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts
- packages/internal/src/openrouter-ai-sdk/chat/index.ts
- scripts/memory-drift-guard.ts
- scripts/check-tool-registration.ts
- scripts/sync-agent-config.ts
- scripts/generate-gate-helpers.ts
- scripts/generate-pruner-budgets.ts
- scripts/run-mutation-gate.ts
- scripts/check-ci-local.ts
- scripts/package.json
- .github/workflows/ci.yml
- .github/workflows/nightly-e2e.yml
- .github/actions/setup-project/action.yml
- README.md
- AGENTS.md
- knowledge.md
- docs/architecture.md
- docs/agents-and-tools.md
- docs/configuration.md
- docs/request-flow.md
- docs/testing.md
- docs/local-mode.md
- openbuff.json.example
- package.json
- test/setup-scm-loader.ts
- bunfig.toml
- sdk/src/provider-config.ts
- common/src/constants/local-mode.ts
- openbuff.d.example/providers.json
- cli/src/commands/command-registry.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
