# Audit findings: cb-rt-edits

- Subsystems: packages
- Features: fuzzy-near-match, indentation-fallback, elision-and-literal-occurrence, diffing-patch-and-transformation-ledger, crlf-bom-restoration, symbol-location, rewrite-symbol-and-structured-imports, syntax-preflight, capability-hashing, structural-reads, read-authorization-state
- Files covered: 16
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [MEDIUM] performance — packages/agent-runtime/src/process-str-replace.ts — Fuzzy near-match (Levenshtein + windowed candidate scoring): CONSUME (bit-parallel Myers in TS); Rust not justified alone
- **Risk:** levenshteinDistance is a full O(n*m) Int32Array DP. With oldString up to LARGE_OLD_STRING_CHAR_THRESHOLD (1500 chars) and 12-48 top candidates (findClosestMatches slice(0, max(12, limit*6)), limit=8 in tryNearMatchAutoCorrect) this is ~50-100M cell updates per failed edit, run twice (autocorrect + diagnostics both call findClosestMatches). Candidate generation also materializes (2*7 window sizes x fileLines) objects and sorts them: ~14x line count allocations on a 100KB file. Latency spike on every drifted edit; not a correctness risk.
- **Fix:** Keep all gating logic (0.92 similarity, margin, subset safety, uniqueness, symbol-identity boost) in TS: it is policy, not compute. Replace the DP with a bit-parallel Myers/Hyyro edit distance (e.g. npm fastest-levenshtein, or a 60-line in-house port) and add an early-exit bound (stop once distance > (1-0.45)*maxLen). Replace full candidate array + sort with a bounded top-K heap. Compute findClosestMatches once and share between autocorrect and diagnostics. Only if profiling still shows hotspots, compile the scorer (strsim/rapidfuzz-rs or triple_accel) to WASM; a napi sidecar is overkill for <2ms-once-optimized work. Unlocks now: sub-10ms near-match on large files; later: token-level (not char-level) similarity for semantic near-match when combined with tree-sitter tokens.
- **Evidence:** process-str-replace.ts: levenshteinDistance, findClosestMatches (window loop minK..maxK, candidates.sort, topCandidates), tryNearMatchAutoCorrect (limit: 8), tryMatchOldStr calls findClosestMatches again for diagnostics. Cost: ~1 day TS; zero boundary cost; no cap.v3 impact. Confidence: high on complexity analysis; needs web verification: fastest-levenshtein current maintenance status and Myers bit-parallel speedup (~10-50x commonly cited) under Bun/JSC.

## [LOW] correctness — packages/agent-runtime/src/generate-diffs-prompt.ts — Indentation fallback: KEEP
- **Risk:** tryToDoStringReplacementWithExtraIndentation only ADDS uniform 1-12 spaces or 1-6 tabs; it never dedents, never handles mixed tab/space, and uses includes() (first-hit, no uniqueness check — uniqueness is enforced later only via replaceAll on the returned string, which could hit multiple sites). Cost is trivial (18 includes scans). Language choice is irrelevant.
- **Fix:** Keep in TS. Optional improvements: compute the common-indent delta once (strip min indent from oldString, then match per-line with a regex anchored to any leading whitespace) to support dedent and mixed indent; assert occurrence count === 1 before returning, matching near-match uniqueness rules.
- **Evidence:** generate-diffs-prompt.ts:1-39 (two fixed loops, includes()); called from process-str-replace.ts tryMatchOldStr before tryCorrectStrayCommentLinePrefix. Cost: hours. Confidence: high.

## [LOW] performance — packages/agent-runtime/src/structural-read.ts — Literal occurrence walk + elision matching: KEEP (fix quadratic line mapping in TS)
- **Risk:** findLiteralOccurrences calls getLineNumberAtIndex, which rescans from offset 0 for every occurrence start AND end, making allowMultiple/diagnostic walks O(n*k) on 100KB+ files. process-str-replace also counts occurrences with split(oldStr).length-1 (materializes arrays) in several places. findElidedOldStringMatches recursion is bounded (stops at >1 match). All string-search primitives (indexOf) are already native in JSC.
- **Fix:** Keep in TS. Carry a running (offset,line) cursor inside findLiteralOccurrences so line mapping is incremental (O(n) total), and replace split-based counts with the bounded indexOf walk already used elsewhere. No language move: indexOf is already SIMD-native in Bun.
- **Evidence:** structural-read.ts: getLineNumberAtIndex (loop from 0), findLiteralOccurrences, nthLiteralOccurrenceIndex; process-str-replace.ts: split(normalizedOldStr).length - 1 in bogus-anchor loop, uniqueStaleStrip, tryMatchOldStr count. Cost: hours. Confidence: high.

## [MEDIUM] performance — packages/agent-runtime/src/process-edit-transaction.ts — Diffing (patch generation, CRLF re-diff, transformation ledger via diffChars): HYBRID (derive ledger from splices in TS; CONSUME imara-diff/similar only for display/semantic diffs)
- **Risk:** appendTransformationLedgerEntries runs jsdiff diffChars(before, after) over the WHOLE file after every transaction action. jsdiff Myers is O(N*D) in JS with per-char change objects; a large rewrite in a file near MAX_TRANSACTION_FILE_BYTES can take seconds and large memory. Worse, a char-level diff is a heuristic reconstruction of an edit the runtime already knows exactly (every processTransactionEdit branch performs a known splice), so provenance can be attributed to the wrong bytes when the diff chooses a different alignment (e.g. repeated tokens), which then drives replace_range overlap/provenance decisions (state-mutation correctness). createPatch is also called per path and again per str_replace.
- **Fix:** Now (TS): have each edit branch return explicit splice records {beforeStart, beforeEnd, afterText} (str_replace already knows offsets via occurrence walk; replace_range/rewrite_symbol know line spans) and build ledger entries directly — no diff at all, exact provenance, O(edits). Keep jsdiff createPatch for the unified patch sent to the client (hunk output must stay byte-compatible). Later: CONSUME imara-diff (Rust, histogram/Myers, fastest mainstream) or `similar` via napi-rs for semantic/display diffs and 3-way structural merges; pair with difftastic/gumtree-style tree diff (tree-sitter based) for AST-aware merges of concurrent agent edits. napi boundary cost: copying two JS strings to Rust UTF-8 (~1 GB/s) is negligible vs diff cost, but it adds prebuilt binaries per platform for the CLI.
- **Evidence:** process-edit-transaction.ts: appendTransformationLedgerEntries (diffChars loop), mapOriginalOffset/mapWorkingOffsetToOriginal, final createPatch loop; process-str-replace.ts: createPatch + restoreLineEndingsFromOriginal(diffLines). Cost: splice-ledger refactor ~2-3 days TS with existing tests; imara-diff napi ~1 week incl. build matrix. cap.v3 unaffected (ledger is internal). Confidence: medium-high; needs web verification: imara-diff vs similar benchmarks, napi-rs prebuild story under Bun.

## [MEDIUM] correctness — packages/agent-runtime/src/process-str-replace.ts — CRLF/BOM handling: KEEP in TS, replace diff-based EOL restoration with offset tracking; add BOM + lone-CR policy
- **Risk:** normalizeLineEndings only rewrites CRLF; lone CR (classic Mac) and U+FEFF BOM are untreated. Hashes cover BOM bytes, so a BOM-bearing line 1 hashes differently from an editor-stripped read, and oldString matching on line 1 fails silently when the model omits the BOM. restoreLineEndingsFromOriginal re-derives per-line endings via diffLines, which can misassign CRLF/LF to moved or duplicated lines in mixed-EOL files and costs a second full diff per str_replace. process-file-block/isLargeFileContent and structural-read.mintSliceCapability use their own inline /\r\n/g replaces (duplicated normalization).
- **Fix:** Keep in TS (pure string ops, already native regex). Define one canonical normalizer in common/content-hash that strips/remembers a leading BOM and records the EOL style; restore by line index from the known splice records (see diffing finding) instead of diffLines. Decide explicitly whether lone CR is a line break; document in cap.v3 hash spec. No language move — a Rust port gives no benefit here.
- **Evidence:** common/src/util/content-hash.ts:12-29 (normalizeLineEndings CRLF-only, getContentHash); process-str-replace.ts: getDominantLineEnding, restoreLineEndingsFromOriginal (diffLines); process-structured-edit.ts PHP_OPEN_TAG_REGEX is the only BOM awareness; structural-read.ts mintSliceCapability inline replace. Cost: 1-2 days + hash-spec note; changing BOM treatment IS a cap.v3 hash-semantics change → version bump or freeze decision. Confidence: high on code; BOM mismatch impact unverified at runtime.

## [HIGH] correctness — packages/agent-runtime/src/structural-read.ts — Symbol location (tree-sitter structure + regex fallback + comment attachment): HYBRID (keep web-tree-sitter; move comment/decorator attachment and name resolution into tree-sitter queries)
- **Risk:** Symbol ranges come from @codebuff/code-map parseFileStructure (tree-sitter WASM), but extendRangeToPrecedingComment is a JS-family regex: only '/* */' and '//' are recognized, so Python '#' comments/docstrings-above, Ruby '#', Rust '///' outer-attributes '#[derive]', Python/TS decorators, Java annotations and C# '[Attr]' are NOT pulled into the slice. rewrite_symbol then replaces the body but leaves or duplicates decorators/doc comments — silent multi-language correctness drift. Name matching is flat (s.name === symbol), so methods on different classes collide (disambiguated only by occurrence index). regexSlice fallback is brace/indent heuristic (read-only, correctly un-capabilitied).
- **Fix:** Keep tree-sitter via WASM (already cross-runtime, works in Bun/Node, no native build). Add per-language tags/locals queries (tree-sitter tags.scm conventions) that return the full declaration node INCLUDING leading comment/decorator/attribute siblings (use node.previousNamedSibling of comment/decorator kinds), and support qualified names (Class.method) from the AST parent chain. Consider @ast-grep/napi as the query layer: it bundles native tree-sitter grammars for ~20 languages with a pattern language, giving qualified-symbol lookup and rewrite in one dependency. Native tree-sitter napi (node-tree-sitter) is ~2-3x faster than WASM but brings per-platform binaries and has had Bun compatibility gaps; parse time is not the bottleneck here, so prefer WASM/ast-grep. Unlocks now: correct rewrite_symbol for Python/Rust/Java/C#; next: qualified symbol addressing, AST-aware read_outline, semantic diffs keyed by symbol identity.
- **Evidence:** structural-read.ts: getFileStructure (dynamic import of code-map), extendRangeToPrecedingComment (regex /\*\/\s*$/ and /^\s*\/\//), extractSlices (filter s.name === symbol), regexSlice/stripStringsAndComments; rewrite-symbol.ts uses the same extendRangeToPrecedingComment. Cost: query-based attachment ~1 week across top 10 languages; ast-grep napi adoption ~1-2 weeks plus binary distribution. cap.v3: slice spans change (start lines move up), which invalidates in-flight symbol capabilities once — acceptable, no token format change. Confidence: high on the comment-attachment gap; needs web verification: @ast-grep/napi Bun support and bundled language list, web-tree-sitter vs node-tree-sitter perf ratio.

## [MEDIUM] correctness — packages/agent-runtime/src/process-structured-edit.ts — rewrite_symbol + structured import edits (insert/remove_import): CONSUME (ast-grep napi or tree-sitter queries) for imports; rewrite_symbol keeps TS orchestration
- **Risk:** Import detection/insertion is ~40 per-language regexes. Known gaps: Python parenthesized multi-line 'from x import (\n a,\n b)' is matched only up to the first line (PY regex '.+' single-line), Rust multi-line 'use a::{\n b,\n c};' uses [^;]+ which spans lines but the line regex is gm-anchored inconsistently, TS imports inside comments/strings can be matched, Go single-line 'import "x"' outside a block is inserted as a new line not merged. rewrite_symbol delegates to handleStrReplace with the old slice as oldString, which is correct but inherits every symbol-location limitation above and cannot rename or reorder members.
- **Fix:** Replace getImportRanges/isValidImportStatement/getImportModuleSpecifier with tree-sitter import-node queries (import_statement, import_from_statement, use_declaration, import_declaration, preproc_include, using_directive) through the same code-map loader, or ast-grep rules per language; keep the insertion-offset policy (shebang, use strict, coding cookie, package line) in TS. For rewrite_symbol keep TS orchestration (capability, str_replace delegation) and swap only the locator. Unlocks next: multi-language rewrite_symbol with member-level targets, rename-symbol with scoped references (ast-grep/tree-sitter locals), structural merges of import blocks (dedupe/sort) without regex drift.
- **Evidence:** process-structured-edit.ts: buildImportLineRegex, getImportRanges, isValidImportStatement, insertIntoGoImportBlock, getImportInsertionOffset; rewrite-symbol.ts: handleRewriteSymbol → handleStrReplace with oldString=match.oldString. Cost: ~1-2 weeks for 12 languages with existing tests as oracle; boundary cost negligible (one parse per edit, already done for preflight). No cap.v3 change. Confidence: medium (gaps inferred from regex shape; not executed).

## [MEDIUM] correctness — packages/agent-runtime/src/util/preflight-syntax-validation.ts — Syntax preflight: HYBRID (keep Bun.Transpiler for JS/TS; replace hand-rolled Python/Go validators with tree-sitter ERROR check; CONSUME oxc-parser for Node JS/TS fallback)
- **Risk:** JS/TS uses Bun.Transpiler (Zig, fast, accurate) but is skipped entirely in Node. Python and Go use hand-written heuristics even though detectSyntaxErrorViaTreeSitter is already used for every other language: Python indentation check ignores backslash continuations, lambda/dict colons at line end ('d = {' ... ':' ) and match/case; Go check flags multi-line func signatures and misses real errors. False positives BLOCK valid edits (formatPreflightErrorMessage tells the model not to resubmit), false negatives let broken files land. Near-match gate (tryNearMatchAutoCorrect) uses tree-sitter, so two different syntax oracles disagree for the same file.
- **Fix:** Route .py and .go through detectSyntaxErrorViaTreeSitter (fail-open when unavailable) and keep delimiter balance only as the no-grammar fallback. For Node runtime, CONSUME oxc-parser (napi, Rust) or keep fail-open; oxc also returns precise error spans for better recovery messages. Longer term: one preflight oracle shared by near-match, edit_transaction, write_file, str_replace.
- **Evidence:** preflight-syntax-validation.ts: validateJavaScriptLikeSyntax (Bun guard), validatePythonSyntax/getPythonLineStates/opensPythonBlock, validateGoSyntax/isGoBlockStatementMissingOpeningBrace, preflightValidateSyntax tree-sitter branch for others; edit-transaction.ts preflight loop over transactionResult.files. Cost: ~2-3 days to switch py/go to tree-sitter; oxc-parser napi ~2 days + platform binaries. tree-sitter parse on 100KB file typically single-digit ms (needs web verification). Confidence: medium-high.

## [LOW] performance — common/src/util/content-hash.ts — Capability hashing (sha256 + HMAC cap.v3): KEEP
- **Risk:** Hashing/HMAC use node:crypto (native OpenSSL/BoringSSL in Bun) — already best-in-class; a Rust port gains nothing and would force the cap.v3 token format (line range, hash, scope fingerprint, signature) to be frozen and duplicated across two languages. Minor waste: validateReadCapability and getCurrentValidatedReadRange split the whole file per replacement, and updateValidatedRangesAfterEdit re-splits and re-slices every range after every replacement (O(ranges x file) per edit).
- **Fix:** Keep in TS. If a Rust sidecar is introduced later, keep minting/verification of cap.v3 exclusively in the TS runtime and pass only plain ranges across the boundary so the token contract has one implementation. Cheap TS fix: compute line coordinates once per replacement (common/line-coordinates getLineCoordinates already exists) and reuse.
- **Evidence:** common/src/util/content-hash.ts:1-29 (createHash/createHmac from node:crypto, getContentHash over LF-normalized content); process-str-replace.ts validateReadCapability, updateValidatedRangesAfterEdit; read-authorization.ts remintConfirmedPostEditAnchors. Cost: none/hours. Confidence: high.

## [LOW] performance — packages/agent-runtime/src/tools/handlers/tool/read-files.ts — Structural reads (windows/around/symbol blocks, outline, authority ladder): KEEP
- **Risk:** Work is I/O-bound (requestOptionalFile round trips) plus string splitting; the only compute is tree-sitter parsing (already WASM) and repeated normalizeLineEndings(...).split('\n') on the same content in read-files (anchor mint, coverage, manifest) and structural-read builders. read_outline regex fallback is TS-oriented only. Blocks are built sequentially with await in a loop, although loadBlockFile is memoized.
- **Fix:** Keep in TS. Cache per-path line coordinates alongside blockFileCache; run independent block builders with Promise.all (bounded) to overlap I/O; extend read_outline fallback via tree-sitter queries (see symbol-location finding) rather than more regex.
- **Evidence:** read-files.ts: completeEditAnchor + coverage both split content, loadBlockFile memo, sequential for-await over windowRequests/aroundRequests/symbolBlockRequests; structural-read.ts buildWindowBlock/buildAroundBlock/buildSymbolBlock; read-outline.ts regexOutline fallback; read-authority-ladder.ts classifyReadBlockAuthority (pure). Cost: hours. Confidence: high.

## [LOW] state-mutation — packages/agent-runtime/src/tools/handlers/tool/edit-read-state.ts — Read-authorization / edit-read state machine (reread markers, sticky auth, confirmed anchors, large-overwrite guard): KEEP
- **Risk:** This is policy over mutable per-run maps (FileProcessingState), tightly coupled to handler control flow and model-facing prose. Moving it across a language boundary would duplicate state and invite drift between the TS handlers and a sidecar; no compute benefit.
- **Fix:** Keep in TS. If polyglot, expose this state only as an in-process TS module; any Rust component should be stateless (parse/diff/match) and receive content + ranges, never authority state.
- **Evidence:** edit-read-state.ts: markEditRequiresFreshRead, clearEditRereadRequirement, strictEditAuthorizationError; read-authorization.ts remintConfirmedPostEditAnchors; edit-transaction.ts substituteConfirmedPostEditCapabilities and strict gate; process-file-block.ts describeUnsafeLargeFileOverwrite. Cost: none. Confidence: high.

## Coverage receipt

### Subsystems
- packages

### Features
- fuzzy-near-match
- indentation-fallback
- elision-and-literal-occurrence
- diffing-patch-and-transformation-ledger
- crlf-bom-restoration
- symbol-location
- rewrite-symbol-and-structured-imports
- syntax-preflight
- capability-hashing
- structural-reads
- read-authorization-state

### Files
- packages/agent-runtime/src/process-str-replace.ts
- packages/agent-runtime/src/process-edit-transaction.ts
- packages/agent-runtime/src/process-structured-edit.ts
- packages/agent-runtime/src/process-file-block.ts
- packages/agent-runtime/src/structural-read.ts
- packages/agent-runtime/src/generate-diffs-prompt.ts
- packages/agent-runtime/src/util/preflight-syntax-validation.ts
- packages/agent-runtime/src/util/read-authorization.ts
- packages/agent-runtime/src/tools/handlers/tool/edit-transaction.ts
- packages/agent-runtime/src/tools/handlers/tool/rewrite-symbol.ts
- packages/agent-runtime/src/tools/handlers/tool/replace-range.ts
- packages/agent-runtime/src/tools/handlers/tool/read-files.ts
- packages/agent-runtime/src/tools/handlers/tool/read-outline.ts
- packages/agent-runtime/src/tools/handlers/tool/read-authority-ladder.ts
- packages/agent-runtime/src/tools/handlers/tool/edit-read-state.ts
- common/src/util/content-hash.ts

### Domains
- performance
- correctness
- state-mutation
