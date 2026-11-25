# Index persistence and lifecycle validation

Production source is frozen after independent-read pipelining.

- Full indexer suite: 786 passed, 0 failed across 29 files.
- Final affected lifecycle, manager, semantic and native parity suite after pipelining: 59 passed, 0 failed.
- Code-map suite with packaged SDK assets: 180 passed, 0 failed across 13 files.
- Indexer and code-map TypeScript checks passed; CJS-compatible module resolver tests: 21 passed.
- Native/embedded/portable ports preserve all 1006 numeric values exactly, including fractional filesystem mtimes. Rust requires serde_json float_roundtrip for content-addressed object integrity.
- Shipped-source retrieval quality: Recall@3 0.944444, MRR 0.972222, nDCG@3 0.970309.

The pipeline overlaps 11 independent reference tables and at most four immutable-object read pages, each capped at 256 keys. Generation ancestors, mutations, lease checks and atomic publication remain sequential. Raw logs and structured results are included next to this file; fresh-process timing/work-count evidence is in INDEX-BENCHMARK.md and index-lifecycle-benchmark.json.

These checks use temporary projects or read-only shipped-source retrieval. User caches and canonical memory stores are untouched. No commit or push was made.
