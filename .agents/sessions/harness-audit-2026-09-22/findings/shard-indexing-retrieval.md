# Audit findings: shard-indexing-retrieval

- Subsystems: packages/indexer, packages/code-map, packages/internal
- Features: index-build-incremental-freshness, index-persistence-cache-locking, lexical-query-ranking, graph-traversal-query-modes, semantic-retrieval-tier, file-walk-discovery-exclusions, chunk-freshness-sidecar, tree-sitter-parsing-token-scores, code-chunking-structure, grammar-wasm-repair, openai-compatible-provider-streaming, openrouter-provider-streaming-usage
- Files covered: 11
- Snapshot: a0de6357ff5254c1bb8cf2e92d821fd948811744293fe3361209c5d557e95392

## [HIGH] state-mutation — packages/indexer/src/index-store.ts:685 — Cache lock is stolen after 5 minutes without checking whether its owner is still alive
- **Risk:** withCacheLock reclaims a lock purely on mtime age (Date.now() - stat.mtimeMs > STALE_LOCK_MS) before the isLockOwnerDead() liveness probe at line 692. A slow-but-live writer (large metadata.json / semantic-vectors.json serialize + fsync on a big repo) loses mutual exclusion mid-operation, so two processes write the cache concurrently. metadata.json is protected by the builtAt CAS, but chunks.json and semantic-vectors.json have no CAS, so a concurrent writer silently overwrites newer data.
- **Fix:** Always run isLockOwnerDead(lockPath) first and only fall back to the mtime heuristic when the owner is alive but the lock is old; additionally take the lock mtime from a heartbeat file that the holder touches during long operations, and add a compare-on-write (stored ownerToken or generation counter) for chunks.json and semantic-vectors.json.
- **Evidence:** index-store.ts withCacheLock: 'if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) { await fs.promises.rm(lockPath, { force: true }); continue }' runs unconditionally before 'if (await isLockOwnerDead(lockPath))'. isLockOwnerDead() explicitly documents 'Never reclaim our own lock' and ESRCH semantics, i.e. liveness is the intended reclaim criterion, but the age branch bypasses it.

## [MEDIUM] state-mutation — packages/indexer/src/index-store.ts:228 — saveSemanticVectors does unlocked read-modify-write of semantic-vectors.json with no CAS
- **Risk:** The whole vector cache is read, mutated (existing.fingerprints[fingerprint] = {...}), and rewritten inside withCacheLock, but unlike saveIndex (which gates on expectedBuiltAt and currentBuiltAt newest-wins) there is no generation check. Combined with the lock-steal race above, two builders embedding different fingerprints can interleave and one fingerprint's freshly computed vectors are lost, silently degrading semantic recall until the next full rebuild.
- **Fix:** Mirror saveIndex: pass an expectedUpdatedAt/generation and re-read inside the lock before writing, or merge fingerprints by updatedAt on write so a losing writer cannot erase another fingerprint's vectors; also write per-fingerprint files to shrink the write-conflict surface.
- **Evidence:** index-store.ts saveSemanticVectors: 'const existing = (await readSemanticVectorCache(...)) ?? emptySemanticVectorCache(...)' then 'existing.fingerprints[fingerprint] = { updatedAt: Date.now(), vectors: byHash }' then atomicWriteJson(cachePath, existing) - no expectedBuiltAt/newest-wins guard like saveIndex's 'if (currentBuiltAt !== null && currentBuiltAt > index.builtAt) return false'.

## [MEDIUM] state-mutation — packages/indexer/src/index-manager.ts:78 — FIFO eviction of live IndexManager singletons forks state and drops mutation signals
- **Risk:** getInstance evicts the oldest entry whenever 8 project roots have been seen, even if callers still hold and use that instance. A later getInstance(projectRoot) then builds a second instance for the same root: markStale()/markPathsChanged() calls on the evicted instance no longer affect the instance answering queries, so incremental freshness signals are lost and two _build loops race on the same cache directory.
- **Fix:** Track leases (getInstance acquires, a dispose()/release() drops) and only evict unreferenced instances; or make eviction safe by forwarding mutation calls to the current registry entry for the same key instead of leaving a detached instance.
- **Evidence:** index-manager.ts:39 'MAX_INSTANCE_ROOTS = 8'; lines 78-83 delete oldestKey on overflow with no liveness check; markStale/markPathsChanged only mutate 'this' (this.forceRefresh / this.pendingMutationDelta), so a detached instance's signals never reach the registered one.

## [MEDIUM] error-handling — packages/indexer/src/index-manager.ts:519 — One transient embedder failure wipes the entire semantic tier
- **Risk:** _buildVectors catch sets this.fileVectors = [] and records lastBuildError, discarding vectors that were already built and persisted. A single network blip in the BYOK embedder therefore downgrades retrieval to lexical-only for every subsequent query until a later build fully succeeds, with no attempt to keep the last good vectors or reload them from the semantic-vectors.json cache that was written earlier.
- **Fix:** On failure keep the previous this.fileVectors (or reload from loadSemanticVectors) and mark the semantic tier 'stale' instead of clearing it; only clear when the semantic config fingerprint changes.
- **Evidence:** index-manager.ts:515-521: '} catch (err) { console.debug(...); this.fileVectors = []; this.lastBuildError = createBuildError("semantic", err, ...) }' - the persisted cache read at _buildVectors (loadSemanticVectors) is not consulted in the failure path.

## [MEDIUM] state-mutation — packages/indexer/src/index-manager.ts:90 — Second embedder is silently ignored: instance key omits embed.cacheKey and wiring happens only once
- **Risk:** getInstanceKey hashes config (incl. semantic.model) but not embed.cacheKey, and 'if (embed && !instance.embed)' binds the first embedder forever. When a host switches BYOK embedding provider/model at runtime, the existing singleton keeps embedding with the old provider while semantic config may show the new model; getSemanticConfigFingerprint(instance.embed) then caches under the stale provider identity, so vectors are wrong for the advertised config and never invalidated.
- **Fix:** Include embed?.cacheKey in getInstanceKey, or when a differing cacheKey is supplied clear fileVectors, recompute the fingerprint, and force a vector rebuild (the code already has that recipe for first wiring at lines 91-95).
- **Evidence:** index-manager.ts:90-96 'if (embed && !instance.embed) { instance.embed = embed; if (this.index && semantic enabled) { this.fileVectors = []; this.forceRefresh = true; this.ensureBuilt() } }' - no else-branch for a changed cacheKey; getInstanceKey (lines 100-115) serializes only projectRoot/config fields.

## [MEDIUM] security — packages/code-map/src/parse.ts:145 — getFileTokenScores joins caller-supplied paths onto projectRoot with no traversal guard
- **Risk:** const fullPath = path.join(projectRoot, filePath) is then statSync/readFileSync'd (loadSourceWithinLimits lines 413-422). filePaths are not checked for '..', absolute paths, or NUL, unlike statProjectFiles which explicitly rejects them. Any caller (or a corrupted mutation delta / index cache feeding path lists) can make the indexer read arbitrary files outside the project - e.g. ~/.ssh/*, .env - and their identifiers/calls flow into token scores, chunk extraction, and ultimately retrieval results and model context (secret leakage).
- **Fix:** Reject paths that are absolute, contain '..' segments, or contain NUL before joining (mirror file-walker.statProjectFiles' guard), and resolve+verify the final absolute path stays under projectRoot before reading.
- **Evidence:** parse.ts:145 'const fullPath = path.join(projectRoot, filePath)'; :413 'fs.statSync(filePath).size'; :422 'fs.readFileSync(filePath, "utf8")'. Contrast file-walker.ts statProjectFiles which skips when 'path.isAbsolute(rawPath) || ... relativePath.split("/").includes("..")'.

## [MEDIUM] security — packages/indexer/src/file-walker.ts:397 — Recursive walk stats with fs.stat (follows symlinks) - TOCTOU escape from the documented no-follow contract
- **Risk:** walkProjectDetailed classifies entries via readdir (so live symlinks are skipped) but then stats with fs.promises.stat(abs), which follows a symlink swapped in between readdir and stat. The target content is then hashed/size-checked as an in-project file, so a concurrent actor (or a repo containing a racing symlink) can pull out-of-project files into the index. statProjectFiles explicitly uses lstat and documents that the walk's readdir no-follow contract forbids this (lines 238-246), so the walk itself violates the invariant it is compared against.
- **Fix:** Use fs.promises.lstat(abs) in walkProjectDetailed and skip stat.isSymbolicLink() entries, exactly like statProjectFiles, so both paths share one no-follow policy.
- **Evidence:** file-walker.ts:397 'stat = await fs.promises.stat(abs)' in the entry.isFile() branch vs :245 'if (stat.isSymbolicLink()) continue' after lstat in statProjectFiles, with the P8.6 comment: 'an out-of-project symlink must not be stat'd/hashed as an in-project file'.

## [MEDIUM] security — packages/code-map/src/grammar-wasm-repair.ts:165 — Unbounded response.arrayBuffer() before hashing enables memory exhaustion from a hijacked asset source
- **Risk:** The verified download path buffers the entire body (new Uint8Array(await response.arrayBuffer())) before the sha256 check. A compromised CDN/mirror (or MITM where TLS is intercepted) can return a multi-GB body: the hash will fail, but only after the process has allocated it, crashing or stalling the build/CLI. Pinned hashes guarantee integrity, not availability or bounded memory.
- **Fix:** Enforce a byte cap (e.g. 20MB, or Content-Length when present) while streaming the body chunks and abort as soon as the cap is exceeded; reject early on missing/oversized Content-Length.
- **Evidence:** grammar-wasm-repair.ts:165 'const bytes = new Uint8Array(await response.arrayBuffer())' followed by 'const actualHash = createHash("sha256")...; if (actualHash !== asset.sha256)'. No size limit exists anywhere in repairGrammarWasm; the abort timeout (ATTEMPT_TIMEOUT_MS) bounds time but not bytes.

## [MEDIUM] security — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:702 — Provider-controlled tool_calls[].index used as raw array index - sparse-array memory blowup
- **Risk:** const index = toolCallDelta.index is taken from the (passthrough) stream schema and used as toolCalls[index] = {...}. A hostile or buggy OpenAI-compatible endpoint can emit index = 1e9 (or negative), creating a huge sparse array or a hidden '-1' slot; repeated deltas amplify allocation. In a BYOK harness the endpoint URL is user-configurable, so a malicious 'compatible' server can DoS the agent process via one SSE chunk.
- **Fix:** Validate index as an integer in [0, MAX_TOOL_CALLS) (e.g. 64) before use; on violation enqueue a stream error part and drop the chunk instead of indexing.
- **Evidence:** openai-compatible-chat-language-model.ts:702-703 'const index = toolCallDelta.index' then ':737 if (toolCalls[index] == null) {... toolCalls[index] = {...} }'; the chunk schema uses '.passthrough()' with only 'index: z.number()' (no integer/bounds check).

## [MEDIUM] correctness — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:883 — Early controller.terminate() on finish_reason 'tool-calls' can drop the trailing usage chunk
- **Risk:** As soon as a chunk reports finish_reason === 'tool-calls' the adapter calls emitFinish(controller) and controller.terminate(). Providers that send usage in a final chunk AFTER the tool-calls finish_reason (common with stream_options.include_usage) never get processed, so the emitted finish part carries undefined/undercounted token usage and provider cost accounting silently undercounts tool-call turns.
- **Fix:** Do not terminate on finish_reason; instead mark tool-calls as complete and let flush() emit the finish after the stream ends (or keep the current fast path only when the same chunk already carried usage), so trailing usage chunks are consumed.
- **Evidence:** openai-compatible-chat-language-model.ts:878-884 'if (finishReason === "tool-calls") { emitFinish(controller); controller.terminate() }' inside transform, while usage is only updated from later chunks via 'if (value.usage != null) { usage.promptTokens = ... }' and emitFinish snapshots usage at call time; finishEmitted then suppresses the flush-time emitFinish.

## [MEDIUM] correctness — packages/internal/src/openrouter-ai-sdk/chat/index.ts:456 — Stream finish emits Number.NaN token usage when the provider sends no usage chunk
- **Risk:** usage is initialized to Number.NaN for inputTokens/outputTokens/totalTokens/reasoningTokens/cachedInputTokens and the flush handler emits it verbatim in the 'finish' part. In non-strict compatibility mode stream_options.include_usage is never requested (line 425), so usage frequently never arrives: downstream token/cost accounting receives NaN, which propagates into sums/reports as NaN instead of being treated as unknown.
- **Fix:** Initialize usage fields to undefined (LanguageModelV2Usage allows undefined) and omit absent values in the finish part; only compute totalTokens when both prompt_tokens and completion_tokens are numbers.
- **Evidence:** openrouter-ai-sdk/chat/index.ts:454-460 'const usage: LanguageModelV2Usage = { inputTokens: Number.NaN, outputTokens: Number.NaN, totalTokens: Number.NaN, reasoningTokens: Number.NaN, cachedInputTokens: Number.NaN }'; :425 'stream_options: this.config.compatibility === "strict" ? { include_usage: true, ... } : undefined'; flush emits 'usage' unconditionally.

## [MEDIUM] correctness — packages/internal/src/openrouter-ai-sdk/chat/index.ts:680 — Missing tool_call index falls back to toolCalls.length - 1, which is -1 for the first call
- **Risk:** When a delta omits 'index' (schema allows nullish) and toolCalls is empty, index becomes -1: toolCalls[-1] = {...} stores the call as a non-index property that array iteration/filter never sees, so the tool call is silently lost or (worse) later merges write into the hidden slot while flush only iterates the array. Even after the first call the fallback points at the previous call rather than appending.
- **Fix:** Use 'toolCallDelta.index ?? toolCalls.length' (append semantics) and clamp to a sane bound like the openai-compatible adapter; verify the resolved index is a non-negative integer before use.
- **Evidence:** openrouter-ai-sdk/chat/index.ts:680 'const index = toolCallDelta.index ?? toolCalls.length - 1'; flush iterates 'for (const toolCall of toolCalls)' which skips the '-1' property, so an index-less first tool call never reaches the 'tool-call' stream part.

## [MEDIUM] error-handling — packages/internal/src/openrouter-ai-sdk/chat/index.ts:685 — InvalidResponseDataError thrown inside TransformStream.transform escapes as a stream failure instead of an error part
- **Risk:** The tool-call branch throws (lines 685/692/699 and 'Tool call is missing') from inside the transform callback. That errors the whole stream: no {type:'error'} part is emitted, flush() never runs (so unsent tool calls and the 'finish' part are dropped), and consumers that only handle error stream parts see an abrupt stream termination - inconsistent with the openai-compatible adapter which enqueues error parts and continues.
- **Fix:** Replace the throws with controller.enqueue({ type: 'error', error: ... }) + finishReason = 'error' (and skip the malformed delta), matching openai-compatible-chat-language-model.ts's chunk-error handling.
- **Evidence:** openrouter-ai-sdk/chat/index.ts:683-701 three 'throw new InvalidResponseDataError({...})' calls inside 'transform(chunk, controller)', plus 'throw new Error("Tool call is missing")' at :708/:721; contrast openai-compatible adapter: 'finishReason = "error"; controller.enqueue({ type: "error", error: chunk.error })'.

## [MEDIUM] correctness — packages/indexer/src/query.ts:916 — Persisted queryData.adjacency is trusted without coverage validation - silently drops graph edges
- **Risk:** buildAdjacency returns early when a persisted adjacency map exists, attaching only the edges listed there. isValidQueryData (index-store) range-checks edge indexes but never verifies that every graph.edges entry is referenced, so a structurally valid but partial/corrupt adjacency (e.g. truncated by an older writer or hand-edited cache) silently removes import/call edges for unlisted nodes: neighbors/path/references queries then return wrong blast-radius results with no diagnostic.
- **Fix:** Validate coverage at load (each edge index appears exactly once across adjacency values and count === edges.length); on mismatch rebuild adjacency from graph.edges like the existing queryData rebuild fallback.
- **Evidence:** query.ts:908-920 'function buildAdjacency(edges, persisted?) { if (persisted) { for (const [nodeId, edgeIndexes] of Object.entries(persisted)) { const nodeEdges = edgeIndexes.map((edgeIndex) => edges[edgeIndex])...; return adjacency } }'; index-store.ts isValidQueryData only checks 'value < 0 || value >= edgeCount' per index.

## [MEDIUM] correctness — packages/code-map/src/parse.ts:490 — buildTokenCallers: documented global fallback for cross-language definitions is not implemented
- **Risk:** The comment promises resolution is 'unambiguous in the caller's language (or globally when no same-language definition exists)', but 'const eligible = sameLanguage' never falls back to candidates. Since getLanguageFamily splits .ts from .js (and .c from .cpp), a call from a TS file to a symbol defined only in JS - even when globally unambiguous - produces no caller edge, so blast-radius/references queries under-report referrers in polyglot repos without any diagnostic.
- **Fix:** Implement the documented rule: use sameLanguage when non-empty, else fall back to candidates, and resolve only when that list has exactly one entry (mirroring chunks.ts's 'distinct.size !== 1' rule).
- **Evidence:** parse.ts:483-491 comment 'Resolve only when the raw name is unambiguous in the caller's language (or globally when no same-language definition exists)' vs code 'const sameLanguage = candidates.filter(...); const eligible = sameLanguage; const definingFile = eligible.length === 1 ? eligible[0]?.filePath : undefined' - candidates is never used when sameLanguage is empty.

## [MEDIUM] correctness — packages/code-map/src/chunks.ts:552 — Outgoing chunk references link the first same-name target without the ambiguity rule used for calledBy
- **Risk:** For outgoing references the code takes candidates (possibly several unrelated same-name definitions), dedupes by qualifiedName+kind, then pushes one reference and 'break's - so when distinct.size > 1 it still links an arbitrary first target. calledBy (line 571+) explicitly refuses to guess ('if (distinct.size !== 1) return'). The asymmetry yields wrong reference edges (and thus wrong chunk-level blast radius) exactly in the ambiguous case the design says to avoid.
- **Fix:** Apply the same unambiguous rule on the outgoing path: only emit a reference when the distinct target set has exactly one member (or mark multi-target results as ambiguous instead of picking one).
- **Evidence:** chunks.ts:543-560: 'const candidates = (bySimpleName.get(site.name) ?? []).filter((idx) => idx !== owner); if (candidates.length === 0) return; ... seenTargets.add(key); if (chunk.references.length < MAX_CHUNK_REFERENCES) { chunk.references.push({...}) } break' vs :571-583 'if (distinct.size !== 1) return' in the calledBy pass.

## [MEDIUM] correctness — packages/indexer/src/chunk-freshness.ts:195 — Inline hash match still reports ORPHAN - live unmodified chunks can be discarded after a sidecar write failure
- **Risk:** When the sidecar lacks the stable id (saveIndex writes the sidecar best-effort and can fail while metadata.json commits), evaluateChunkFreshness's inline fallback proves the chunk exists and is unmodified (inline.hash === selector.contentHash) yet falls through to { state: 'ORPHAN', reason: 'unknown-stable-chunk-id' }. Callers that drop ORPHAN chunks therefore discard fresh chunk references whenever the sidecar lags - a fail-closed choice that is stricter than the evidence supports and contradicts the documented FRESH definition (stableChunkId exists AND hash matches).
- **Fix:** Return FRESH (or SNAPSHOT-OLD when snapshotIds differ) when the inline lookup finds the stable id with an equal hash; reserve ORPHAN for 'not in sidecar AND not in live index'.
- **Evidence:** chunk-freshness.ts:185-195: 'const inline = inlineChunkHash(index, selector.path, stableId); if (inline.hash !== undefined && inline.hash !== selector.contentHash) { return { state: "STALE", reason: "inline-hash-mismatch" } } return { state: "ORPHAN", reason: "unknown-stable-chunk-id" }' - an equal inline hash takes the ORPHAN branch.

## [MEDIUM] state-mutation — packages/code-map/src/chunks.ts:171 — Global chunkMemo is unbounded and cleared only by tests
- **Risk:** chunkMemo is a module-level Map keyed by file path holding full CodeChunk arrays (calls/calledBy/imports/references + hashes). There is no size cap or eviction; per the code's reference graph only __tests__/chunks.test.ts calls clearChunkMemo. In the long-lived CLI/SDK process (which supports up to 8 project roots) memory grows with every file ever chunked, and entries from one project are visible to another (same relative path), enabling cross-project memo/alias reuse lookups.
- **Fix:** Bound chunkMemo with an LRU (entry count or bytes) like IndexManager's instance cache, scope keys by projectRoot, and clear it when a build for a root completes or the root is evicted.
- **Evidence:** chunks.ts:171 'const chunkMemo = new Map<string, { contentHash: string; chunks: CodeChunk[] }>()'; writes at :652/:674/:701; only clearChunkMemo() clears it and it is referenced solely from packages/code-map/src/__tests__/chunks.test.ts (index reference map).

## [MEDIUM] state-mutation — packages/indexer/src/index-store.ts:797 — saveIndex/saveSemanticVectors mutate the user's .git/info/exclude by default
- **Risk:** ensureGitInfoExcludes runs on every persist and appends '/<cacheDir>/' to .git/info/exclude whenever writeGitExclude is true (the default, flipped only via the global setWriteGitExclude). This is an unadvertised, persistent side effect on repository metadata owned by the user's git tooling: it changes repo-local ignore behavior without consent, is triggered by ordinary index refreshes, and the module-global toggle leaks across projects in one process.
- **Fix:** Default the write off (or gate it behind an explicit openbuff.json/CLI opt-in), scope the toggle per projectRoot, and prefer the cache dir's own .gitignore-equivalent documentation over rewriting git state.
- **Evidence:** index-store.ts:25-35 'let writeGitExclude = true; export function setWriteGitExclude(...)'; :976-802 appends `${prefix}${excludeLine}\n` to path.join(projectRoot, '.git/info/exclude') from saveIndex/saveSemanticVectors/saveChunkSidecar entry points.

## [MEDIUM] error-handling — packages/indexer/src/semantic.ts:137 — Missing/empty batch embeddings are dropped silently - permanent holes in semantic recall
- **Risk:** buildFileVectors only pushes a vector 'if (vector && vector.length > 0)'; a provider returning fewer vectors than inputs, order-shuffled results, or per-item empties silently omits those files from the semantic tier (they then never match semantically) with no diagnostic, no retry, and no record in IndexStatus. Combined with index-manager's all-or-nothing catch (which drops everything on a thrown batch), embedding failures are either invisible or total.
- **Fix:** Assert embeddings.length === batch.length and dimension consistency, retry failed batches with backoff, and surface skippedPaths/count via the existing diagnostics/coverage channels so semantic gaps are visible in getStatus().
- **Evidence:** semantic.ts:133-145 'const embeddings = await embed(batch.map(...)); for (let j = 0; j < batch.length; j++) { const vector = embeddings[j]; if (vector && vector.length > 0) { vectors.push(...) } }' - no else branch, no count check against batch.length.

## [MEDIUM] performance — packages/indexer/src/file-walker.ts:464 — Synchronous readFileSync per directory inside the async walk blocks the event loop
- **Risk:** loadIgnorePatterns uses fs.readFileSync and is called 3x per directory (.gitignore/.openbuffignore/.codebuffignore) from the async walkProjectDetailed recursion and from isIgnoredLikeWalk. On repos with thousands of directories this is thousands of blocking syscalls interleaved with awaited stats, stalling every other task (including agent tool execution) in the same process during each refresh.
- **Fix:** Use fs.promises.readFile with the existing try/catch, batch the three lookups per directory (e.g. Promise.all + a Set of existing names), and keep the per-directory matcher cache.
- **Evidence:** file-walker.ts:462-470 'function loadIgnorePatterns(filePath: string): string[] { try { const content = fs.readFileSync(filePath, "utf8") ... } catch { return [] } }', called from walkProjectDetailed's walk() matcher construction and isIgnoredLikeWalk's directoryMatcherCache builder.

## [MEDIUM] performance — packages/code-map/src/parse.ts:413 — Fully serial parse loop with blocking statSync/readFileSync per file
- **Risk:** getFileTokenScores awaits parseTokensForScoring one file at a time over up to 10k files, and the default (no readFile) path does fs.statSync + fs.readFileSync per file. A cold index of a large repo is therefore thousands of sequential blocking reads plus sequential tree-sitter parses with zero concurrency, making first-query latency dominate agent startup.
- **Fix:** Read files with fs.promises.readFile and run parseTokensForScoring over a bounded concurrency pool (e.g. 8-16, respecting the byte budget with an atomic counter), keeping fairParseOrder's round-robin fairness for budget truncation.
- **Evidence:** parse.ts:141-230 the 'for (const filePath of fairParseOrder(filePaths))' loop awaits 'parseTokensForScoring' per file; loadSourceWithinLimits :413 'fs.statSync(filePath).size' and :422 'fs.readFileSync(filePath, "utf8")'; getKnownFileSize :579 does another statSync per skipped file.

## [LOW] security — packages/indexer/src/query.ts:317 — Index-derived repo text flows unsanitized into explanation/snippet fields consumed by the agent LLM
- **Risk:** explanation (explainResult), matchedSnippets (commandMatchedSnippets/concept strings), and chunk snippets embed attacker-controllable repository text (comments, identifiers, concepts extracted from files) into query_index results that the harness injects into the model prompt. A malicious repo can embed prompt-injection payloads in symbol names/headings/concepts to steer the agent; nothing marks these fields as untrusted data.
- **Fix:** Keep the fields but wrap them in an explicit untrusted-data delimiter/annotation in the tool result contract, and/or strip control characters and cap per-field length (snippets are capped at 5 entries but each is unbounded source text).
- **Evidence:** query.ts:317 'explanation: explain ? explainResult(result, ...)' builds strings from result.matchedSnippets and relatedFiles; commandMatchedSnippets pushes raw 'concept' strings (e.g. 'script:...') straight from indexed file content into matchedSnippets.

## [LOW] security — packages/internal/src/openrouter-ai-sdk/chat/index.ts:63 — supportedUrls advertises arbitrary-URL fetch for application/* (SSRF surface)
- **Risk:** 'application/*': [/^data:application\//, /^https?:\/\/.+$/] tells the AI SDK any http(s) URL is fetchable, including internal hosts (169.254.169.254, localhost services). Model- or repo-supplied URLs can then be turned into server-side requests with the user's network position (SSRF), and the fetched bytes enter the prompt.
- **Fix:** Restrict to data: URIs or an explicit host/scheme allowlist, and exclude link-local/loopback/private ranges before any fetch; mirror the narrower image/* pattern style.
- **Evidence:** openrouter-ai-sdk/chat/index.ts:58-64 'readonly supportedUrls = { "image/*": [...], "application/*": [/^data:application\//, /^https?:\/\/.+$/] }'.

## [LOW] security — packages/code-map/src/grammar-wasm-repair.ts:165 — Repaired WASM bytes are written but never re-verified at load, and the gdscript asset is fetched from a third-party fork
- **Risk:** Integrity relies on the sha256 pin at download time; resolveGrammarWasmSource re-hashes local candidates but languages.ts later loads whatever path repairGrammarWasm returned (and the repair dir may be shared/writable). Additionally the gdscript wasm is fetched from a raw.githubusercontent.com fork (code-atlas) rather than a released artifact, so its availability/integrity trust anchor is a mutable third-party repo path - weaker supply-chain provenance than the jsdelivr package pins.
- **Fix:** Re-hash the file at load time before Parser.init (or mark repaired files read-only + verify once per process), and vendor all grammar wasms (including gdscript) into the published package so builds never depend on network fetches or third-party forks.
- **Evidence:** grammar-wasm-repair.ts:76-88 gdscript asset 'sourceUrl: https://raw.githubusercontent.com/lusiem/code-atlas/2e41606.../grammars-vendored/tree-sitter-gdscript.wasm'; repairGrammarWasm returns targetPath after rename with no consumer-side re-hash (resolveGrammarWasmSource stats repaired only for size).

## [LOW] error-handling — packages/code-map/src/grammar-wasm-repair.ts:195 — Retry loop uses fixed 2s delay - no exponential backoff, jitter, or Retry-After handling
- **Risk:** 5xx/429 retries sleep a constant retryDelayMs (default 2000) and ignore the Retry-After header. N parallel repair attempts (e.g. a fleet of CI builds) hammer a struggling CDN in lockstep and keep getting 429s, extending the worst-case 3x30s stall instead of backing off; the error surfaced after exhaustion does not distinguish rate limiting from server failure.
- **Fix:** Honor Retry-After when present, otherwise use exponential backoff with jitter (e.g. 1s/2s/4s +/- 25%), and include the final HTTP status in the failure reason (the code does the latter for the lastHttpStatus branch only).
- **Evidence:** grammar-wasm-repair.ts:106-108 'MAX_REPAIR_ATTEMPTS = 3 ... DEFAULT_RETRY_DELAY_MS = 2_000'; :193-195 'if (attempt < MAX_REPAIR_ATTEMPTS) { await sleep(retryDelayMs) }' - constant delay; the 429 branch records only lastHttpStatus with no Retry-After read.

## [LOW] error-handling — packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts:135 — Stream error message appends raw provider error metadata (param/code/details) to Error.message
- **Risk:** createOpenAICompatibleStreamError concatenates up to 2000 chars of provider-supplied type/param/code/status/details JSON into the Error message that propagates to user-visible logs and agent transcripts. Provider error details can echo request fragments or internal endpoint information (information leakage) and the free-form metadata is attacker-influenced when the endpoint is untrusted.
- **Fix:** Return a short sanitized message and keep the metadata on a structured field (e.g. error.providerMetadata) that callers can log behind a debug flag.
- **Evidence:** openai-compatible-chat-language-model.ts:127-145 'const streamError = new Error(trimmedMetadataText ? `${error.message} ${trimmedMetadataText}` : error.message)' where trimmedMetadataText is JSON.stringify of type/param/code/status/details truncated to 2000 chars.

## [LOW] correctness — packages/indexer/src/semantic.ts:188 — Semantic/lexical blend double-counts shared paths and lets one cosine dominate the lexical signal
- **Risk:** blendSemanticScores adds hit.score * maxLexical * weight to the lexical score for paths in both lists (double counting evidence) while semantic-only hits get the same magnitude scale, so a cosine of ~1 with weight 1 equals the best possible lexical score regardless of how many fields matched. Ranking is therefore sensitive to the arbitrary max-lexical scaling and is not a principled fusion (no RRF/min-max normalization), producing unstable orderings when the lexical score range shifts.
- **Fix:** Fuse with reciprocal-rank fusion or per-signal min-max normalization with separate tunable weights, and treat overlap as one signal (max or weighted mean) instead of a sum.
- **Evidence:** semantic.ts:183-192 'const maxLexical = Math.max(1e-9, ...lexical.map((r) => r.score)); ... const scaled = hit.score * maxLexical * weight; merged.set(hit.path, (merged.get(hit.path) ?? 0) + scaled)'.

## [LOW] performance — packages/code-map/src/chunks.ts:449 — Each file is parsed at least twice per chunk extraction (structure + call sites) plus per-chunk substring scans
- **Risk:** buildChunks awaits parseFileStructure (a full tree-sitter parse) and then extractCallSites (a second full parse of the same content), and the per-chunk import pass runs chunkText.includes(n) over every import name for every chunk (chunks x imports x names substring scans). On large files this doubles parse CPU and adds O(chunks*imports*names*len) string scans to every incremental re-chunk.
- **Fix:** Parse once and share the tree/query captures between structure and call-site extraction, and precompute per-file name sets / use the bySimpleName map instead of substring includes for import relevance.
- **Evidence:** chunks.ts:443-450 buildChunks: 'const symbols = await parseFileStructure(content, filePath, ...); ... const callSites = await extractCallSites(content, filePath)' where extractCallSites (:236+) does 'cfg.parser.parse(content)' again; :595 'const nameHit = (imp.names ?? []).some((n) => callNames.has(n) || chunkText.includes(n))' inside the per-chunk loop.

## [LOW] performance — packages/indexer/src/file-walker.ts:411 — Per-prefix candidate cap equals maxFiles, so walk memory is O(topLevelPrefixes x maxFiles)
- **Risk:** candidatesByPrefix stores up to maxFiles (default 20k) WalkedFile entries per top-level prefix before the global round-robin trim. A monorepo with hundreds of top-level packages can therefore accumulate millions of candidate entries (paths + stat metadata) in memory on every refresh just to keep 20k, causing GC pressure and large transient heaps.
- **Fix:** Cap each prefix bucket at ceil(maxFiles / prefixCount) or use a bounded reservoir/heap per prefix, keeping the same round-robin fairness guarantee for truncation.
- **Evidence:** file-walker.ts:406-420 'const prefixCandidates = candidatesByPrefix.get(prefix) ?? []; if (prefixCandidates.length >= maxFiles) continue; prefixCandidates.push({...})' - the cap is the global maxFiles per prefix, and all buckets are retained until the final while loop.

## [LOW] performance — packages/indexer/src/index-store.ts:748 — atomicWriteJson pretty-prints large index artifacts (2x bytes and CPU on every refresh)
- **Risk:** JSON.stringify(value, null, 2) is used for metadata.json (up to 20k file entries) and semantic-vectors.json (thousands of float arrays), roughly doubling file size and serialization time on each build, and doubling read/parse cost at every loadIndex/loadSemanticVectors. For embeddings this is pure overhead on a hot refresh path.
- **Fix:** Serialize compactly (JSON.stringify(value)) for the large data files, or split vectors into a binary format (e.g. f32 buffer) keyed by hash.
- **Evidence:** index-store.ts:748 'await handle.writeFile(JSON.stringify(value, null, 2), "utf8")' inside atomicWriteJson, used by saveIndex (metadata.json), saveSemanticVectors, and saveChunkSidecar.

## [LOW] performance — packages/indexer/src/query.ts:257 — Scoring rescans all fields per query token and the IDF fallback scans the whole corpus
- **Risk:** scoreFile loops tokens x (symbols + headings + concepts + imports + chunks) with lowercase substring checks per pair, and computeIdfForTokens falls back to fileContainsToken over every file for any token missing from postings (e.g. after a queryData rebuild or partial postings). For 20-token queries on 20k-file indexes this is a multi-million-comparison hot path per query.
- **Fix:** Precompute per-file lowercase concatenated field text / token sets at build time (store in queryData), and cache IDF per (index, token) instead of recomputing per query.
- **Evidence:** query.ts:352-420 scoreFile's nested 'for (const token of tokens)' over per-field loops; computeIdfForTokens (:430-450) 'if (df === undefined) { df = 0; for (const file of Object.values(index.files)) { if (fileContainsToken(file, token)) df++ } }'.

## [LOW] state-mutation — packages/indexer/src/query.ts:934 — fileTypeSetCache is keyed on the caller's mutable array reference
- **Risk:** matchesFileType caches the normalized Set in a WeakMap keyed by the fileTypes array identity. A caller that reuses one options object and mutates options.fileTypes in place between queries gets the stale normalized Set from the first call, silently filtering with outdated extensions (wrong result set, no error).
- **Fix:** Copy the array on first use (or key the cache by a joined string key), so mutation of the caller's array cannot poison the cache.
- **Evidence:** query.ts:932-946 'const fileTypeSetCache = new WeakMap<string[], Set<string>>(); ... let normalizedFileTypes = fileTypeSetCache.get(fileTypes); if (!normalizedFileTypes) { normalizedFileTypes = new Set(fileTypes.map(normalizeFileType)); fileTypeSetCache.set(fileTypes, normalizedFileTypes) }'.

## [LOW] state-mutation — packages/indexer/src/index-manager.ts:200 — waitUntilReady timeout resolves silently and leaks the timer
- **Risk:** Promise.race([buildPromise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]) returns void either way: callers cannot tell a slow/hung build from a ready index (queries then return empty with ready:false), and the losing setTimeout is never cleared, keeping the event loop alive up to timeoutMs after the build finished.
- **Fix:** Return a boolean (or status) from waitUntilReady and use a cancellable timer (clearTimeout in a finally), optionally surfacing 'timed out waiting for index build' in getStatus().
- **Evidence:** index-manager.ts:195-201 'await Promise.race([this.buildPromise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])' - no clearTimeout and no return value differentiation.

## [LOW] correctness — packages/code-map/src/chunks.ts:701 — Files with content but zero extracted chunks are never memoized and re-parse on every call
- **Risk:** extractCodeChunksDetailed only memoizes when 'chunks.length > 0 || content.length === 0'. A non-empty file that yields no definitions (data files, configs, unsupported-but-parsed shapes) is re-parsed on every incremental refresh since neither the memo nor the previousChunks fast path is populated for it, wasting CPU in the common 'unchanged file' case.
- **Fix:** Memoize empty results too (the previousChunks path already treats 'cached.length === 0' as valid reuse), keyed by contentHash.
- **Evidence:** chunks.ts:699-702 'if (chunks.length > 0 || content.length === 0) { chunkMemo.set(filePath, { contentHash: currentHash, chunks }) }' - zero-chunk non-empty files skip the memo while the reuse path at :640-656 would happily return them.

## [LOW] api-contract — packages/indexer/src/index-store.ts — saveChunkSidecar changed return type Promise<void> -> Promise<boolean> - silent behavior change for compiled consumers
- **Risk:** The in-file signature note documents that saveChunkSidecar previously returned Promise<void> and silently dropped invalid input, and now returns Promise<boolean> that can be false. Consumers built against the old .d.ts that assume the call committed will treat a rejected sidecar write as success and keep stale chunk-freshness data; Promise<void>-typed adapters still compile, so the change is invisible at build time.
- **Fix:** Re-baseline consumers to branch on the boolean, and record the change in the package changelog/API docs (or ship a new major of the store API) so downstream code cannot silently mis-assume commit semantics.
- **Evidence:** index-store.ts saveChunkSidecar doc comment: 'this function previously returned Promise<void> and silently dropped invalid input; it now returns Promise<boolean> ... consumers built against the previous .d.ts should re-baseline and branch on the boolean instead of assuming every call committed.'

## [LOW] api-contract — packages/internal/src/openrouter-ai-sdk/chat/index.ts — providerOptions.openrouter and extraBody are spread last and can override messages/model/tools
- **Risk:** doGenerate/doStream build 'const args = { ...this.getArgs(options), ...openrouterOptions }' and getArgs itself spreads config.extraBody/settings.extraBody last. Any caller-supplied key (including 'messages', 'model', 'tools', 'stream') silently overrides the standardized request built from the LanguageModelV2 prompt - an undocumented contract inversion where 'provider options' act as a full request override, and a config typo can send a different prompt than the SDK assembled.
- **Fix:** Filter spread keys to an allowlist of OpenRouter-only fields (as the openai-compatible adapter does by excluding known option keys) and reject/ignore reserved keys like messages/model/tools/stream.
- **Evidence:** openrouter-ai-sdk/chat/index.ts doGenerate/doStream: 'const args = { ...this.getArgs(options), ...openrouterOptions }'; getArgs: '// extra body: ...this.config.extraBody, ...this.settings.extraBody' placed after 'messages: convertToOpenRouterChatMessages(prompt)'.

## [LOW] dependency-hygiene — packages/internal/src/openrouter-ai-sdk/chat/index.ts:39 — Provider layer imports a type from the top-level 'ai' package
- **Risk:** import type { FinishReason } from 'ai' couples packages/internal's OpenRouter provider to the full AI SDK package purely for a union type that duplicates the provider-interface finish reasons (mapOpenRouterFinishReason already produces them). This invites version skew between 'ai' and '@ai-sdk/provider', and an undeclared/over-broad dependency in the package manifest if 'ai' is only a devDependency.
- **Fix:** Type the local variable as LanguageModelV2FinishReason (already imported) or define a small local union, dropping the 'ai' import entirely.
- **Evidence:** openrouter-ai-sdk/chat/index.ts:39 "import type { FinishReason } from 'ai'" used only for 'let finishReason: FinishReason = "other"', while LanguageModelV2FinishReason is imported from '@ai-sdk/provider' and mapOpenRouterFinishReason maps into that space.

## [MEDIUM] test-coverage — packages/internal/src/openrouter-ai-sdk/chat/index.ts — Tool-call streaming state machine has no test coverage - only usage-accounting tests reference this module
- **Risk:** Per the codebase reference graph the only test files importing OpenRouterChatLanguageModel are tests/stream-usage-accounting.test.ts and tests/usage-accounting.test.ts. The intricate provider-quirk handling this adapter exists for - index-less tool_call deltas, mid-stream throws, flush-time unsent-call emission, reasoning/text interleaving, billing-summary suppression - is therefore unverified, and the three findings above (NaN usage, -1 index, transform throws) are exactly the untested paths.
- **Fix:** Add deterministic stream-shape tests feeding synthetic SSE chunk sequences: missing/shifted tool_call index, absent usage, error mid-stream, and finish without [DONE], asserting the emitted LanguageModelV2StreamPart sequence.
- **Evidence:** Index reference map for 'OpenRouterChatLanguageModel' lists only: packages/internal/src/openrouter-ai-sdk/facade.ts, provider.ts, tests/stream-usage-accounting.test.ts, tests/usage-accounting.test.ts. The transform handler spans ~250 lines of branching (index fallback :680, throws :685-708, flush unsent calls :783-800) with no test importer exercising stream shapes.

## [LOW] test-coverage — packages/indexer/src/index-store.ts:685 — Lock-lifecycle races (stale steal, dead-owner reclaim, timeout) have no deterministic multi-writer test
- **Risk:** withCacheLock/isLockOwnerDead encode three-way reclaim logic (mtime age, process.kill(pid,0) ESRCH, 10s timeout) whose correctness under interleaving - the HIGH finding above - cannot be regression-tested today: the code reads the real clock (Date.now) and the real process table, so a test can only observe the happy path. Any refactor of the reclaim order can reintroduce live-lock stealing silently.
- **Fix:** Inject a clock and a process-liveness probe (defaults to Date.now / process.kill) and add tests that simulate: live-but-slow owner past STALE_LOCK_MS, dead owner, and contending writers on semantic-vectors.json.
- **Evidence:** index-store.ts:680-700 the reclaim branch ordering and 'isLockOwnerDead' using 'process.kill(pid, 0)' directly; reference map shows index-store.test.ts/p8-lite.test.ts import loadIndex/saveIndex/computeIndexSnapshotId but nothing constructs a second-process lock holder.

## Coverage receipt

### Subsystems
- packages/indexer
- packages/code-map
- packages/internal

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

### Files
- packages/indexer/src/index-manager.ts
- packages/indexer/src/index-store.ts
- packages/indexer/src/query.ts
- packages/indexer/src/semantic.ts
- packages/indexer/src/file-walker.ts
- packages/indexer/src/chunk-freshness.ts
- packages/code-map/src/parse.ts
- packages/code-map/src/chunks.ts
- packages/code-map/src/grammar-wasm-repair.ts
- packages/internal/src/openai-compatible/chat/openai-compatible-chat-language-model.ts
- packages/internal/src/openrouter-ai-sdk/chat/index.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
