# Source assurance after recovery

The original 558-file whole-byte hash map is unavailable. Four recovered prior validator results reported `baselineSourceHashes=558` and `changedSource=[]`, at 2026-11-06 00:12:38, 00:14:36, 00:31:28 and 00:40:01 UTC. Their complete recorded result objects and capture provenance are retained in [SOURCE-STABILITY.json](SOURCE-STABILITY.json). These are historical comparisons; a new comparison to that missing map cannot be performed.

The present Git HEAD is `e65c06c0ae783130998bd9ab18c8d35320e40ea8`, matching the recorded review HEAD. Recovered numbered source output supplies 258 contiguous windows across 173 files, with 38,692 unique captured lines. 258 windows match present source after the explicitly recorded line normalization. There are 0 differing lines and 0 conflicting historical line observations. [The detailed binding](evidence/recovered-source-line-bindings.json) carries normalized hashes and capture provenance for every window.

Line agreement does not certify original whole-file bytes, original line endings, or uninspected tails. The user's modified `cli/knowledge.md`, `common/knowledge.md` and `sdk/knowledge.md` are excluded from stability comparisons. Present status is recorded in the JSON without reading private environment/provider values or historical product logs.

The root validator generated `CURRENT-FILE-HASHES.json` after report recovery. It is a fresh present-file baseline, separately named and dated. It must not be relabeled as the original 558-file audit baseline. Structural inspection coverage, historical diagnostic observations, source stability and product readiness remain separate assurance claims.
