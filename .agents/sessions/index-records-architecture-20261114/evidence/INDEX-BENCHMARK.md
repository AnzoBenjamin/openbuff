# Index lifecycle evidence

Recorded 2026-11-14T22:05:47.085Z. 803 indexed files; 3 repetitions per backend, each phase in a fresh process.

| Backend | Cold discovery ms | Cached discovery ms | Cached reconciliation ms | One-file change ms | One-file row writes | One-file put value bytes |
|---|---:|---:|---:|---:|---|---|
| embedded | 2233.4 | 571.4 | 766.0 | 404.5 | 30, 30, 30 | 8782, 8782, 8782 |
| native | 3182.9 | 1001.1 | 1199.3 | 412.5 | 30, 30, 30 | 8782, 8782, 8781 |

Every cached discovery was available with unverified freshness while reconciliation continued. Every no-change reconciliation parsed zero files, updated zero graph sources and changed zero postings. Every one-file update hashed, parsed and updated one source; its row-write bound was asserted. Precise edge and producer dependency digests remained identical through cached process reopening, unrelated edits and abrupt native service restart.

Reproduce from repository root: `bun .agents/sessions/index-records-architecture-20261114/evidence/index-lifecycle-benchmark.ts`. Optional variables: `INDEX_BENCHMARK_FILES`, `INDEX_BENCHMARK_REPETITIONS`, `INDEX_BENCHMARK_EXECUTABLE`.

Operation clocks begin before manager construction. The JSON artifact separately records process wall time, native executable SHA-256, every work counter, live storage bytes and observed SQLite/WAL allocation. Put-value byte counts measure committed JSON payloads; they do not claim total physical disk writes. Fixtures are generated locally and deleted; user caches are untouched.
