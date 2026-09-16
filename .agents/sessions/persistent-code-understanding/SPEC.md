SPEC — Persistent Codebase Understanding (chunk store + understanding memory)

Objective: Turns reuse prior learning without re-exploring. Two stores linked by digest, disk remains truth.

Stores:

- A. Code store (precise, chunk-addressed): File -> Chunk{chunkId sha256(path+qualifiedName+kind+startHash), qualifiedName, kind, signature, lineRange, docComment, hash} + edges defines/imports/calls/references at chunk granularity. Persisted in sqlite tables files/chunks/edges/chunk_fts/chunk_embeddings. Incremental by hash+mtime.
- B. Understanding store (sqlite memory-v2 existing): observation.recorded kind fact/decision/discovery + evidence[]{artifact, selector file|line-range|symbol|chunk, contentDigest sha256:hex, excerpt<=1KB, capturedAt} x<=32 + workspaceRevision/snapshotId. Reuse iff digest+revision/snapshot match via contextMatches.

Non-goals: V2 default authority, V1 removal, release/commit/push, new dependencies without approval, hosted embeddings/cloud sync.

Frozen decisions (from dynamic-cross-session-memory SPEC):

1. sqlite-v2-opt-in fail-closed, no V1 re-activation on degradation.
2. Canonical events append-only, projections rebuildable.
3. Envelope/selector/coverage/failure/CAS semantics preserved, additive only.
4. No dependency addition authorized. FTS5 via bun:sqlite only, embeddings via existing EmbedFn BYOK injection.
5. Persisted text untrusted evidence, never instruction authority.
6. Owner-only files, bounded sizes (32 evidence, 32 selectors, 16k detail, 1KB excerpt, 12k prompt/2k child).
7. Every reuse gated on workspaceRevision/snapshotId + contentDigest + indexSnapshotId covering hash.

Requirements:

- R-A chunk store: tree-sitter extract via structure.ts + tree-sitter-queries, module-scoped resolve, sqlite persist, incremental, SimHash near-dup quarantine, generated/vendored down-weight.
- R-P0 contracts additive: clarify selector kinds, rename semantic-match->lexical-match additively.
- R-P1 enriched capture: evidence[] with digests+excerpts, content-bearing detail.
- R-P2 verification promotion: verify(selector,digest,revision)->verified, mismatch->invalidated.
- R-P3 consolidation via claim.consolidated, preview max5, supersede sources.
- R-P4 coverage all 5 dims incl not-covered+gaps, cap5/turn.
- R-P5 retrieval: FTS5+postings+cosine+graph, planner selector-exact->verified-shortcircuit->graph->lexical fill, deterministic.
- R-P6 prompt tiered reusable vs reread, DTO-only, bounds kept.
- R-P7 memory-first DiscoveryMemoryPort, handlers query B first, claimDiscoveryShard second line.
- R-P8 lifecycle append-only, owner-only, rebuild guard, authority-flip rollback.
