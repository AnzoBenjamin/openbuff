# Independent supplement and fresh-checkout review

Reviewer: `/root/b04_lock_cas`.

## Decision

Approve the root-authored supplemental archive/restorer and the reviewed staged materialization for exact evidence availability and frozen ledger consistency, with the filesystem and scope limits below. No actionable finding remains in this review scope.

The primary receipt is `supplement-and-checkout-review.json`, SHA-256 `0dff64e433f84396c5f49025fc6ad27b0ad8b7a6a773c6ebe608ccfbbe09b0e4`. The review independently checks the implementation and materialized bytes. The curated inventory and gap classification are fixed supplied inputs authored earlier by this reviewer; this review does not independently approve those inputs or any implementation card.

## Supplemental archive

The B30 toy repository had 27 required files classified for direct Git publication: 26 `.git` metadata files and `README.md`, totaling 27,922 bytes. Git represented their containing repository as a Gitlink, so the first materialization omitted them. `git-fixture-gap.json` records all 108 matching frozen authority edges and the scan of all 2,644 required paths. The toy repository's separate 415-byte memory fixture was already covered by the original archive.

The supplement contains 25 distinct regular objects, 27,759 distinct content bytes, and 12,146 compressed bytes. Every object and original file matches the fixed inventory and gap receipt. Reviewed identities:

- Archive: `f298550c8f8f24965d9be2fd707cf6e0261716a33cce77ba1a49f7673de3b531`.
- Manifest: `6de54c8670bd9602051a421ba1b228e4d06bc5645fa9816fdcc8f98447f1bfcf`.
- Rehydrator: `f936c122fef9f6a86f86a6f529f14882795198cd46f236dd3e62c34a102bab6f`.

The 23 independent controls passed. They cover fresh restoration of all 27 files; unchanged repeat restoration; builder reproduction in an owned copied tree without changing matching artifacts; ordinary and optimized-Python refusal; foreign files, symlinks, directory and ancestor collisions; modified manifests; and a 4,096-header malformed archive. Modified archive/manifest controls made zero tar-parser calls and zero destination writes. The original fixture and reviewed bindings remained unchanged.

The helper pins the inventory, gap receipt, manifest, archive digest, and compressed size before parsing. It validates every existing destination and archive object before beginning restoration, uses exclusive/no-follow leaf creation, and rejects ancestor symlinks even for existing matching targets.

## Exact staged checkout

Reviewed materialization: `/tmp/openbuff-first-wave-index-z4vfoeq2`.

Reviewed index snapshot SHA-256: `e8b34416c2c0a29d5867f6712f35677229ec020eff8a5994d1da28805b2fe880`.

Independent verification matched all 4,765 materialized files/symlinks to their staged Git blob identities, with zero Gitlink or unmerged entries. `reviewed-index.nul` preserves the index listing and `materialized-staged-bindings.json` records each blob and materialized content hash. All 2,644 inventory file hashes and sizes matched. Both restoration helpers reported zero new writes on the already restored checkout, and all inventory hashes still matched after validation.

The staged index remained unchanged throughout review. The original ledger, validator, fixture, original archive and archive review bindings were preserved. Parent materialization log hashes also matched their receipt.

The independent frozen validator replay exited 0 with `valid: true` and no errors. Its accepted set was exactly B01, B02, B03, B04, B08, B18, B30 and B36; 31 nodes remained pending. Validator SHA-256 was `6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c`, and ledger SHA-256 was `108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758`.

## Limits

- Restoration assumes a cooperative, quiescent filesystem. Path-based checks do not isolate concurrent ancestor replacement.
- Interrupted I/O can leave partial new files. Restoration is not an atomic multi-file transaction.
- Parser boundedness relies on the exact pinned archive identity; no generic hostile-archive guarantee is claimed.
- This approval establishes evidence availability and frozen ledger consistency for the recorded index and bindings. It does not approve product behavior, the reviewer's own inventory/implementation, staging or commits, installed binaries/providers, unavailable platforms, or future cards.

Only new evidence under this review directory and owned temporary fixtures was written. Historical evidence, the original inventory/archive/review, product source, ledger, validator and Git staging were not edited.
