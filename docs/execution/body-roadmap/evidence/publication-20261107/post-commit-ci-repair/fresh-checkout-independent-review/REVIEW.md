# Independent repaired-checkout verification

Approve the exact staged materialization `/tmp/openbuff-ci-repair-index-2cnl65ge` for evidence availability and frozen ledger consistency.

Reviewed index SHA-256: `3b9697d1c50a1e7db164ec7119b607b9cbbecc01ba6b292b8f52b68360d4f7ea`.

Reviewer: `/root/b04_lock_cas`. The independent receipt is `review.json`, SHA-256 `52d92d6823324b0843e5e27c01e620093bfb3dae06b5d2efbab98617719616c8`.

All 4,869 actual materialized staged entries match their Git blob identities and symlink/file types. Executable-bit modes also match. There are no Gitlinks or unmerged entries. The compressed index snapshot and per-file bindings preserve the exact reviewed identities.

The historical inventory remains unchanged at SHA-256 `f12426acfb0e68b64a584a08a46ed830a305f3045cdf7bf02c6ffda5f07f5731`. Exactly 2,641 of its paths retain their original hashes and sizes. Three paths use the independently approved delta, SHA-256 `4450aed4a38b1630fe5715ddf6cb00785a5e718475dcb35c9a06c49e557fc30e`: the memory-drift guard, its test and the ledger. Every override binds its original inventory hash and approved replacement hash; no other override is allowed. All 2,644 effective required paths matched before and after validation.

Both archives and their helpers retain their previously approved bytes. Root's restoration logs were hash-verified, and the resulting 186 base-archive paths plus 27 supplemental Git-fixture paths independently matched their fixed content hashes. No restoration was rerun by this reviewer.

The materialized ledger is byte-identical to the approved candidate and current live ledger, SHA-256 `64bdc49206f2e3efad0393dad82048134c4403e43bef8bdb26696251bbf7b07b`. Active acceptance receipts, manifests, independent reviews and required command evidence for all eight accepted nodes are present with their exact hashes, including the renewed B01/B36 authorities.

The independently invoked frozen validator exited 0 with `valid: true`, no errors, exactly eight accepted nodes and 31 remaining. Its bytes retain SHA-256 `6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c`. This is an evidence consistency check; no product tests or product commands were run.

The staged index and protected original inventory, archives, helpers, previous review seals, approved ledger and frozen validator remained unchanged during the review. Only new evidence in this review directory was written.

This approval covers the recorded exact index and three-path repair delta. Subsequent publication metadata is a separate index change. No implementation self-approval, provider/native execution assurance, further card acceptance or full-roadmap completion is inferred.
