# Clarification of the historical staging description

The sentence in the sealed `../REVIEW.md` stating “Git represented their containing repository as a Gitlink, so the first materialization omitted them” is not substantiated by a preserved historical index entry. I withdraw that causal description. The initial failure manifest repeated the same explanation, but its recorded validator output proves missing files, not Gitlink representation.

The demonstrated failure is omission of 27 required embedded-repository files from the first materialization: 26 `.git` metadata files and `README.md`. The known fixture stage is empty: the sealed reviewed index has no entry at or below the fixture path and no Gitlinks, and the read-only index query recorded alongside this clarification also returns no fixture entry. These observations do not establish that the initial failed index ever contained a Gitlink.

The statement in `../git-fixture-gap.json` recommending omission of an embedded Git link should likewise be read as an unsubstantiated proposed operation, not evidence of an existing link or an operation actually performed. The verified correction is restoration of the 27 missing files from the separately pinned supplement.

This is a documentary correction only. It preserves the existing review, gap receipt, manifests, historical evidence and index. The independently verified archive hashes, 23 supplemental controls, 4,765 matching staged blobs, 2,644 matching required files and frozen-validator result remain unchanged. No validation was rerun and no staging operation was performed for this clarification.
