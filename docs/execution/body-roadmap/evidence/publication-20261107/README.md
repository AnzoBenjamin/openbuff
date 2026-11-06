# Publication inventory — 2026-11-07

The exact live eight-card ledger has a **2,644-file publication/restoration closure**. No missing or mismatched required binding was found. Nothing was staged, committed, pushed, removed, or changed outside this new inventory directory. The archive and rehydrator remain leader work.

Use these final inventories:

- `curated-required-files.json`: every required repo-relative file, current SHA-256, byte count, reason, Git tracking/ignore state and disposition.
- `curated-direct-files.nul`: **2,458 ordinary publication files**, 56,905,911 bytes. This is the direct-stage candidate set; it includes already tracked source dependencies.
- `force-stage-logs.nul`: **165 required ignored `.log` files** within the direct set, requiring explicit staging if untracked. The ignore rule is retained per file in the JSON inventory.
- `curated-archive-files.nul` and `curated-archive-requirements.json`: **183 exact historical paths** recommended for content-addressed archival and restoration, rather than staging their scratch directory trees.
- `context-restoration-files.nul`: **three ignored context inputs** whose exact bytes must be restored for the unchanged validator on a fresh checkout.
- `required-files.nul`: the union of direct, historical archive and context inputs. **This is a complete restoration set, not a stage-all list.**

All inventory destinations are repository-relative. The ten historical job artifacts are actual files beneath `docs/execution/body-roadmap/evidence/B18/post-route/independent-review/initial-run/tmp/`, including one 10 MiB log; they are not external `/tmp` destinations.

## Why these files are required

`trace-validator.py` observes actual `file_binding` and JSON-load calls in the unchanged validator, SHA `6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c`. The live ledger SHA is `108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758`. Validation passes with eight accepted cards and 31 pending nodes. The literal trace requires **2,546 unique files** across 131 semantically loaded authority documents. `validator-reference-trace-v2.json.gz` preserves every distinct binding edge and origin.

The remaining required files come from the explicitly requested final architecture review/manifest, integration/build/install evidence, promotion records, four RWEB planning files and separate planning approval, plus execution scaffolding. Supplementary structured references are followed within those declared authority families. Current-source/context maps are classified separately from artifact references. The validator explicitly hashes historical sealed JSON as raw data without recursively interpreting its internal, potentially stale references; this inventory preserves that boundary. It does not treat every path-shaped string, Markdown link, or historical source map as active authority.

The mandatory cache files are **incidental broad artifact seals**, not evidence that the product needs a Bun cache or any extra capability has been accepted:

- **B04: six `.pile` paths.** The original `final-binding/independent-review/manifest.json` seals them as command evidence, and the current `final-binding/independent-countersignature/{approval,review}.json` and accepted manifest/receipt retain them.
- **B18: 101 `.pile` paths.** The current `post-route/independent-countersignature/{approval,review}.json` and accepted manifest/receipt seal current and preserved earlier evidence, including those cache bytes.
- **B02: nine SQLite journal fixtures.** These support the actual runtime/SDK/journal consumer oracle and should retain their exact database bytes.
- **57 `.openbuff/memory/task-memory.json` fixtures** are sealed under B02 (nine), B18 (47) and B30 (one). They are synthetic historical consumer state, not the user's live home/profile. All are included in the archive recommendation.

The exact authority-to-path mapping is in `curated-archive-requirements.json`; the trace includes the validator's labels and original document paths. Omitting these bytes without restoration would break the existing seals. This task did not trim or rewrite any seal.

## Archive size and context restoration

Estimates below are measured in memory using a deterministic USTAR with one `sha256/<digest>` entry per distinct content hash, fixed metadata and gzip level 9. **No pack was written.** A path-to-content manifest and verifier will add a small amount of metadata.

| Set | Original paths | Distinct contents | Deduplicated bytes | Gzip estimate |
|---|---:|---:|---:|---:|
| Required `.pile` caches | 107 | 43 | 21,352,975 | 4,416,417 |
| Historical archive including journals, job artifacts and synthetic memory | 183 | 116 | 32,235,763 | 4,454,109 |
| Historical archive plus all three context inputs | 186 | 119 | 42,467,666 | 6,305,503 |

The context inputs are:

| Repo-relative destination | Bytes | Meaning |
|---|---:|---|
| `cli/src/agents/bundled-agents.generated.ts` | 4,200,755 | Ignored generated source, directly bound by current command context. Restore these exact bytes or explicitly stage the source; rebuilding alone is not an exact-hash guarantee. |
| `node_modules/typescript/bin/tsc` | 45 | Installed dependency context, not a publication source file. |
| `node_modules/typescript/lib/tsc.js` | 6,031,103 | Installed dependency context, not a product binary. A locked dependency installation may supply it, but the recorded hash must match. |

All three expected hashes are in both final structured inventories. Do not stage `node_modules` wholesale. A content-addressed pack can restore all 186 specified paths, or the leader can restore dependency/generated context separately and verify it before running the frozen validator.

## Exclusions and publication limits

**714 unreferenced `.pile` files totaling 183,710,099 bytes are excluded.** No required file is a product binary or native/browser asset. The 33 repo-local build/install asset paths and 37 external filesystem mentions are recorded separately in `external-context-paths.final.json`; they are environment/build context, not archive destinations. JSON pointers and canonical agent IDs are explicitly separated from filesystem paths.

The sole supplementary external structured artifact reference is the installed CLI binary under `/home/ben/.local/share/openbuff-test/`. Its recorded installation/probe receipts are included; the executable and installed assets are excluded. The external installed-smoke `/tmp/.../workspace`, pinned user Bun runtime, and root-owned RWEB feasibility distribution/home/browser data are also excluded. Fresh proof replay may require a compatible toolchain, but that does not justify committing it.

`ordinary-doc-companions.nul` separately lists the B05 and B19 preparation pages linked by the publication README. These are documentation companions, not eight-card proof prerequisites. Ordinary links and contextual snapshots are retained in `context-and-exclusions.json.gz` without silently expanding the acceptance closure. RWEB feasibility documents being created by the leader are outside this frozen selection.

Publication is **not yet self-contained without restoration**. The leader must preserve the selected archive bytes and exact context inputs, materialize the curated source/evidence set, and run the unchanged validator against that fresh checkout. The inventory proves file dependency and current-byte consistency; it does not independently approve an archive implementation, product behavior, or additional roadmap cards.

Only final outputs listed in `inventory-artifacts.nul` are recommended for publishing this inventory itself. The large uncompressed discovery trace and initial intermediate JSON remain local working artifacts and are excluded from that list.
