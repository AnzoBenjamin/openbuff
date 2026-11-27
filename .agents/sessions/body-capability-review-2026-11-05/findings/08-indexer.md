# 08 — Retrieval, index lifecycle and consumers

Openbuff has a working local lexical/graph retriever, native command discovery, a real CLI query consumer, optional BYOK semantic augmentation, and useful evaluation machinery. Source/vector generations, safety sweeps, and cache ownership need stronger guarantees before broader language or retrieval surfaces graduate. This shard records nine findings: three HIGH and six MEDIUM. All have high confidence, with executed counterexamples and current source anchors; implications beyond the probes are identified separately.

Pinned snapshot: `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`. The structural receipt covers 40 current inventory files and 11,383 inspected lines. Every primary picker range was read; larger files were sampled through the explicit JSON `readRanges`. This is a receipt of inspection, not a full-line audit or correctness guarantee for every listed file.

## Capability maturity and production wiring

| Capability | Maturity | Assurance |
|---|---|---|
| Lexical and heuristic graph discovery | usable | Real-repository unit gate; local differential query probe |
| Native command/validation discovery | usable | Manifest/script fixtures and refresh tests |
| Optional semantic augmentation | partial | Actual manager/store/query with deterministic local vectors |
| Delta/watch freshness and lifecycle | partial | Existing watcher wiring; local manager and fake-clock probes |
| Owned index/vector/chunk persistence | partial | Real temporary-file roundtrips and controlled lock interleaving |
| Optional precision graph | partial | Actual adoption/persistence/query of synthetic precise edges |
| CLI, headless SDK and MCP contracts | partial | Exact dispatch/schema/serializer/render traces |
| Retrieval evaluation and comparisons | usable | Versioned real-repository lexical test and metric/strategy fixtures |

The vertical path is concrete: common `query_index` schema → agent/runtime handler → SDK override dispatch → CLI configuration/embedder factory → `IndexManager` → walker/metadata/graph/postings → query result → TUI. The CLI forwards file hashes, snapshots, related files, status and mutation epoch. Confirmed SDK edits emit create/update/delete/move deltas with workspace revision; unknown terminal/custom/MCP effects fall back to pathless invalidation. Linux+Bun uses a capped directory-watch worker with restart, startup re-sweep and disposal.

Headless SDK runs require a host query override; there is no default `query_index` dispatch branch. MCP requires an injected index, which the CLI supplies, and returns an honest missing-index payload when absent. Its projection drops `indexedHash` and `relatedFiles`; common/CLI output also omits structured chunk identities even though the engine computes them. These are transport maturity gaps, not evidence that the CLI retriever is unwired. Memory skip/narrow can bypass the manager; pair04 owns that policy.

Important strengths are worth retaining. Field-weighted lexical scoring, cached IDF, persisted postings/adjacency, deterministic ties and bounded snippets give a configured model actionable discovery hints. Inbound `references` differs correctly from undirected neighbors. Adjacency receives incidence-coverage validation before reuse. Native manifests contribute ecosystem validation concepts; package scripts retain bounded actual commands. Exact embedding-input hashes include paths, and provider/model/text-version fingerprints omit API keys. Schemas reject unsafe scopes, and the TUI makes stale evidence, diagnostics, coverage and snapshot identity visible.

## Findings

### 08-F1 — HIGH: old vectors describe a newer metadata snapshot

[index-manager.ts:663](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-manager.ts:663) adopts metadata before awaiting vector replacement. The failure branch at line 779 retains a nonempty previous vector set; the filter at line 1086 does not verify current path membership or exact embedding hash without a file-type scope. Changing/deleting embedded files and failing the replacement batch therefore returns stale semantics with new provenance.

The executed probe deleted `old.md`, changed `kept.md`, added `new.md`, then failed embeddings. Revision 2 metadata contained only kept/new, yet the blended query returned old without `indexedHash`; kept’s retained embedding hash differed from its current input. Semantic state still said ready, while the whole index disclosed a semantic build error. The existing outage test adds a file without deleting/changing prior vectors. Publish a coherent pair or retain only hash-matching current vectors. Acceptance must cover held/failed batches plus change/delete/add; the analogous in-flight seam is statically inferred.

### 08-F2 — HIGH: successful persistence can become an oversized cache miss

[index-store.ts:432](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-store.ts:432) writes the complete vector union without a byte budget, while its loader rejects more than 8,000,000 bytes at line 584. The probe persisted 300 finite 1,536-dimensional vectors into 9,697,695 bytes and reloaded zero vectors. A cold manager will re-embed absent exact-input hashes; provider cost/startup delay follows that code path, but neither was measured here.

The metadata reducer also counts UTF-16 `string.length` at line 362 against a loader’s actual byte limit. A 1,024-byte fixture budget accepted 694 code units occupying 1,494 UTF-8 bytes. Enforce symmetric actual-byte policies and partitioned/bounded reusable vector storage. Roundtrip realistic dimensions and multiple fingerprints across cold managers; include CJK/emoji byte cases. Tiny two-element vector tests and ASCII reducer assertions do not establish this workload.

### 08-F3 — MEDIUM: unrelated candidates consume the scoped query budget

[query-data.ts:139](/home/ben/Code/CLI/openbuff/packages/indexer/src/query-data.ts:139) stops substring expansion after 4,096 global candidate paths. [query.ts:275](/home/ben/Code/CLI/openbuff/packages/indexer/src/query.ts:275) creates that set before applying path/type filters. A common substring can eliminate every relevant result in a requested prefix even when that prefix has only one candidate.

In a 5,001-file synthetic index, query `aaa`, prefix `zzz`, type `py` returned nothing with accelerators; without `queryData` it returned `zzz/aaatarget.py`. Walker/parser coverage need not be partial, so no status explains the loss. Apply scopes while constructing candidates, retain a bounded workload, and disclose intentional query truncation. Acceptance compares accelerated/baseline retrieval for sole scoped matches beyond the unscoped cap, independently by prefix and type.

### 08-F4 — MEDIUM: fair-share walking drops below-budget files

[file-walker.ts:458](/home/ben/Code/CLI/openbuff/packages/indexer/src/file-walker.ts:458) trims earlier buckets as each top-level prefix appears. Quotas divide the global maximum equally without reclaiming unused demand; discarded tails cannot refill the final round-robin result.

A real temporary tree with 90 files under `a`, one under `b`, and `maxFiles=100` returned 51 and reported 40 skipped. All 91 eligible files would fit. Current fairness tests use equally oversubscribed buckets, so they miss uneven under-budget coverage. Retain all candidates until the global budget fills, then use bounded fair selection with spillover. Acceptance requires complete coverage whenever eligible count fits, deterministic representation when oversubscribed, and O(maxFiles) candidate memory.

### 08-F5 — MEDIUM: routine refresh removes persisted precision

[metadata-indexer.ts:741](/home/ben/Code/CLI/openbuff/packages/indexer/src/metadata-indexer.ts:741) rebuilds the graph even on unchanged source, ignoring persisted precise edges. Every manager build passes loaded metadata through this update path. Adoption’s documentation describes cross-session persistence, but routine reconciliation loses the enrichment.

The probe adopted and persisted one precise reference: `references` returned `a.md`. After an unchanged refresh, persisted precise count was zero and references were empty, with the same source-content snapshot ID. Cold-session loss follows the same load/update trace. The CLI honestly says adopted edges last until the next rebuild, mitigating surprise; this is a precision durability gap, not a requirement to run all SCIP tools automatically. Retain unchanged fingerprint-bound enrichment, invalidate it safely when inputs change, and expose expiry. Acceptance includes restart/unchanged refresh and changed-input invalidation. Pair07 owns extraction/runner assurance.

### 08-F6 — MEDIUM: source-content ID cannot fence graph adoption

[index-store.ts:658](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-store.ts:658) hashes version/root/revision and file paths/hashes, excluding graph/configuration. [index-manager.ts:874](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-manager.ts:874) uses this as the adoption guard and persistence compares the manager’s current build time.

Two synthetic scans captured one base. The first adopted precise edge A; its snapshot ID remained equal to the base. A stale second merge was then accepted and final precision contained only B. Sequential arrivals reproduce overlapping scans without launching indexers. Keep source identity, add a retrieval-generation/config fence, and reject or rebase stale graph results. Acceptance must preserve the first merge when a second captured result arrives after a graph-only change.

### 08-F7 — MEDIUM: a known changed path can still retain old bytes

[metadata-indexer.ts:572](/home/ben/Code/CLI/openbuff/packages/indexer/src/metadata-indexer.ts:572) reuses the indexed hash when size/mtime match, even for explicit changed paths. The manager stamps the delta revision unless parsing degraded. The code acknowledges timestamp-preserving same-size writes as an optimization tradeoff; that does not make the resulting incorporation claim accurate.

The fixture rewrote Alpha to Bravo with equal size/restored mtime. A precise hint reported revision 17 and ready status while retaining the old hash; a later pathless refresh still returned Alpha. This does not imply ordinary SDK writes usually preserve timestamps. Force hashing for explicit changes and give unknown changes a genuine integrity mode or richer stat identity. Acceptance proves both known-hint and documented safety-sweep convergence without re-reading unrelated unchanged paths on every delta.

### 08-F8 — HIGH: reclaim can displace a newly acquired live lock

[index-store.ts:1164](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-store.ts:1164) separately reads/verifies stale bytes and renames the lock path. Another waiter can reclaim/acquire between those operations. The defensive post-rename restore via `link` can fail after a third waiter exclusive-creates the free namespace, leaving the active owner only in scratch.

The controlled probe injected scheduling at actual rename/link calls: actor A acquired after verification, the helper displaced A, actor C exclusive-created before restore, and reclamation returned false with C in the namespace and A in scratch. This proves an allowed interleaving, not observed production corruption or a three-process stress result. Mutual exclusion protecting CAS/newest-wins is broken. Current “restore race” tests start with fresh bytes and early-return before that seam. Use a proven atomic/fenced ownership primitive. Acceptance forces the verify/reacquire window and proves at most one active writer across processes.

### 08-F9 — MEDIUM: incremental liveness starves safety reconciliation

[index-manager.ts:1112](/home/ben/Code/CLI/openbuff/packages/indexer/src/index-manager.ts:1112) schedules sweeps from the latest snapshot age. Every precise refresh assigns a new `builtAt`, while complete deltas deliberately omit unrelated filesystem changes. Missed/capped watcher subtrees depend on this fallback.

The fake-clock probe advanced twelve minutes with target-only deltas every four minutes. Each age reset to zero; an externally changed sibling kept its original hash and final status remained ready. Repeating this transition postpones reconciliation indefinitely during a busy session; no real twelve-minute or watcher-exhaustion run was performed. Track last full reconciliation independently and honor its deadline despite ongoing deltas. Acceptance discovers an unobserved sibling within the declared interval during continuous edits, including watcher degradation/cap conditions.

## Assurance and all eight domains

The parent’s full indexer suite receipt is 413 pass/0 fail; this shard did not rerun it. Exact test mechanics include a real repository lexical quality gate, fake-provider semantic tests, cache/delta failure cases, and real Linux file events through classification/debounce into a recording manager. Those watcher tests are stronger than callback stubs, but do not prove edit-to-fresh-query behavior under exhaustion. The retrieval quality test injects one-unit timing samples; Python/Rust/Go strategy cases use hand-populated metadata. Neither establishes actual multilingual task success, semantic quality, provider cost, or large-repository latency.

- **Security:** sensitive/ignore/no-follow discovery and opt-in egress are concrete safeguards. No new injection/auth/secret vulnerability is claimed; cooperative policy and worker threads are not OS isolation.
- **Correctness:** the nine counterexamples identify generation, coverage, freshness and ownership invariants; parser semantics remain with pair07.
- **State mutation:** detached-holder forwarding, epochs/revisions and bounded watcher cleanup work; vector/graph generations, sweep deadlines and reclaim fencing need repair.
- **Error handling:** structured build errors and stale fallback exist. Query embedding errors are debug-only fallbacks; readiness timeout cancels the wait rather than the build.
- **Performance:** accelerators/yields/batches/caps are real. Caps must preserve declared recall and actual byte bounds; optimality was not measured.
- **Dependency hygiene:** selected dependencies are declared; indexer pins oxc-resolver/TypeScript and declares Bun 1.3.5. Full lockfile/advisory/package-platform assurance is outside this shard.
- **Test coverage:** discriminating probes expose cases absent from green fixtures. Changed/deleted vectors, realistic dimensions, uneven quotas, scoped caps and post-verification races need regression coverage.
- **API contract:** canonical CLI output is useful. Retrieval generation, empty readiness, headless defaults and cross-transport provenance remain uneven.

## Executable work for the grounded plan

The JSON contains five bounded packages with triggers, source anchors, prerequisites, language decisions, acceptance probes, regression checks, completion evidence and stop/defer rules. Start with freshness/generation truth (P1) and byte/lock persistence (P3), preserving existing delta and lexical machinery. Then give precision graphs a valid generation fence and expiry policy (P2), and repair scoped recall/fair spillover against measured workloads (P4). Finally unify adapters and prove held-out target-language tasks through actual implementations, tests and commands (P5).

These repairs fit the current TypeScript authority. Existing ecosystem indexers should supply precision over versioned boundaries when warranted. Defer automatic SCIP runs, broad language expansion, new ranking defaults or engine ports until correctness, ownership, cancellation and measured workload evidence meet explicit gates. Optional repo-map/PageRank exports are useful APIs; they do not change default retrieval or prove a learning loop.

## Coverage limits and artifacts

All extra probes ran locally on Bun 1.3.14/Linux; the package/root suite targets Bun 1.3.5. The observed failures concern deterministic data/filesystem transitions, but cross-platform frequency and production performance remain unmeasured. No private configuration/index/credential, external provider, installation, network call or source mutation was used. Pair07 owns parser/LSP/import/SCIP extraction; pair06 owns mutation/edit authority; pair04 owns memory/compaction. Their findings are not duplicated here.

Detailed source ranges, evidence-versus-inference statements, lifecycle states, strengths, domain assessments and work-package acceptance live in `08-indexer.json`. Reproduce with `evidence/08-indexer-probes.ts`, `08-freshness-lock-probes.ts` and `08-safety-sweep-probe.ts`; their JSON receipts preserve exact observations. The probes and fixtures are owned under `/tmp/openbuff-body-review-2026-11-05/evidence/08-*`.
