# Independent archive/restoration review

Reviewer: `/root/b04_lock_cas`. This review covers root-authored archive and restoration machinery only. The curated inventory is a supplied fixed input authored earlier by this reviewer; this report does not independently approve that inventory, implementation cards, product behavior, cleanup, ledger promotion, staging, or commits.

## Decision

Approve the repaired helper for restoring the exact pinned snapshot on a cooperative, quiescent filesystem. `checked-archive-review.json` records 22 passing independent controls and binds the reviewed source, checked recipe, historical recipes and receipts, archive, and inventory. Its SHA-256 is `4eecf89149e7204c9b1eb4ef2fb951b4ea5e2d957ba81236bb2cd7429774881b`.

The reviewed rehydrator is `3fbf1b955b018357f6758cccf698eaf283511916c11273347d887027bdd51871`. The archive is `301f2e8ef2e17a1b0416b54b907328b186947fd5f76f261ee7457ddcc66e4271`: 6,305,471 compressed bytes containing 119 distinct regular objects, 42,467,666 distinct content bytes, and an exact mapping to 186 selected paths. Every archived object, original selected file, and freshly restored file matched the supplied inventory. Repeated restoration reported zero new writes and preserved the destination tree.

## Findings and repairs

The initial helper (`cb58e42a82b4007f2d8987480949f45ae225317ae7c2e6f073dd1b1566c344af`) failed two independent controls:

1. Optimized Python disabled assertions and falsely reported successful verification while a foreign existing file remained. `optimized-mode-control.json` preserves that failure.
2. A manifest-selected 4,096-header archive reached eager `getmembers()` before member-count rejection. It performed no destination writes, but the parser consumed all headers. `parser-bound-control.json` preserves that result.

The checked helper refuses optimized Python before artifact work and pins the exact archive size and digest before opening the tar parser. The independent replay verified `-O`, `-OO`, and `PYTHONOPTIMIZE=1/2` refusal for the helper, builder, and control entry points. Replaying the 4,096-header archive with both the pinned manifest and a forged matching manifest produced zero `tarfile.open` calls and zero destination writes.

Independent controls also verified refusal of foreign existing bytes, external and matching internal leaf symlinks, a missing target through an internal ancestor symlink, a non-inventoried traversal path, and a wrong manifest archive hash. Destination contents and existing outside sentinels remained unchanged.

`normal-mode-foreign-control.json` was produced during the repair and binds the checked helper, not the initial one. Its exit 1 is an expected refusal of foreign bytes; its recorded 186 destination hashes were unchanged. The interrupted tool invocation did not create the originally contemplated `INITIAL-REVIEW.md`.

`initial-source/` and `initial-bindings.json` preserve the first reviewed source. `checked-source/` preserves the reviewed repaired source and recipes. Original receipts remain unchanged; checked receipts are separate artifacts.

## Limits

- Path-based ancestor checks do not isolate concurrent ancestor replacement. This is not an OS-security boundary.
- Interrupted I/O can leave partial newly created files. Restoration is not an atomic multi-file transaction.
- Existing matching files reached through internal ancestor aliases can be accepted. Universal directory-symlink rejection is not claimed.
- Parser boundedness comes from accepting only the exact known archive digest and size. This is not a generic hostile-archive parser.
- A staged fresh-checkout replay is separate from this archive approval and will require its own evidence.

The review script writes only new independent evidence and owned temporary fixtures. It does not edit the archive, original evidence, inventory, product files, validator, or ledger.
