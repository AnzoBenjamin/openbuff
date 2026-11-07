# Audit findings: w1-runtime-edits-preflight

- Subsystems: packages, common
- Features: edit-transaction, str-replace, near-match-autocorrect, syntax-preflight, structural-read, rewrite-symbol, read-outline, replace-range, structured-edit, file-block, edit-blocks, line-coordinates
- Files covered: 23
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [CRITICAL] state-mutation — packages/agent-runtime/src/tools/handlers/tool/rewrite-symbol.ts:104 — [POLY] rewrite_symbol on grammar-less brace-free languages can replace everything from the symbol to EOF
- **Risk:** If tree-sitter returns no match (no grammar for Lua/Elixir/Julia/Nim/Haskell/Scala/Dart/Zig/shell/Makefile, or the parser fails), extractSlices uses regexSlice. For files that are not .py, regexSlice counts braces. In a language with no braces (`def ... end`, `function ... end`, `do ... end`, layout rules), foundBrace never becomes true, so the loop runs to the last line and endLine ends up at EOF. rewrite-symbol.ts:110-116 then MINTS a capability for this heuristic slice (`slice.readCapability ?? mintSliceCapability(...)`), even though structural-read documents heuristic slices as read-only. It passes the rest of the file as oldString to str_replace. Preflight reports 'No syntax validation available' for these languages, and the large-file shrink guard exists only in write_file. Result: every definition after the target symbol is silently deleted.
- **Fix:** Never mint a capability for a heuristic slice. Fail closed with 'use read_files ranges + replace_range' when structure is null or has no AST match. In regexSlice, return null when no brace is found by the time the next line at the same or lower indentation is reached. Add an indentation/`end`-keyword strategy chosen per language profile (common/src/util/language-profiles). Add tests for a .lua/.ex/.jl rewrite_symbol that assert no out-of-slice bytes change.
- **Evidence:** structural-read.ts:459 `const isPython = filePath.endsWith('.py')`. The brace branch (~l.480-497) ends with `if (foundBrace && braceCount <= 0) break`, so it never breaks without a brace and endLine = lines.length-1. structural-read.ts extractSlices doc: 'heuristic slices are read-only and require an exact range read'. rewrite-symbol.ts:104-117 mints `readCapability: slice.readCapability ?? mintSliceCapability({...}).readCapability` and passes it as basedOnRead (l.187-191). preflight-syntax-validation.ts:94-106 returns valid:true when available:false.

## [HIGH] correctness — packages/agent-runtime/src/process-str-replace.ts:2330 — [POLY] Indentation-tolerant match drops the re-indented newString and bypasses the uniqueness gate (breaks Python/YAML/Makefile)
- **Risk:** tryToDoStringReplacementWithExtraIndentation computes both an indented searchContent and an indented replaceContent. tryMatchOldStr returns only `oldStr: newChange.searchContent`, and the caller then substitutes the ORIGINAL un-indented normalizedNewStr. Effects by language: in Python, bodies get dedented, which can change semantics while still parsing, e.g. a statement escapes an if-block. In YAML, keys are silently re-parented. In Makefiles, recipe TAB prefixes are lost ('missing separator'). The shifted search string is also checked only with `includes`, never counted, and the caller applies it with replaceAll. So with allowMultiple=false, every occurrence of the indented block is rewritten, skipping the 'Found N occurrences' gate that exact matches get.
- **Fix:** Return and use newChange.replaceContent (a structured `replacementOverride`) wherever the indentation fallback matched. Require that the indented search occur exactly once, or honor allowMultiple and occurrence diagnostics as the exact path does. Handle dedent and mixed tab/space by computing the common leading-whitespace delta per line rather than a uniform prefix. Add tests: a Python nested-block edit, a YAML nested-key edit, a Makefile recipe edit, and a duplicate indented block with allowMultiple=false.
- **Evidence:** generate-diffs-prompt.ts:7-36 returns {searchContent, replaceContent}. process-str-replace.ts tryMatchOldStr: `if (newChange) { ... return { success: true, oldStr: newChange.searchContent } }`, so replaceContent is discarded. Caller: `currentContent = normalizedCurrentContent.replaceAll(updatedOldStr, () => normalizedNewStr)` and replaceWithinValidatedRange(... newStr: normalizedNewStr), with no count check on updatedOldStr.

## [HIGH] correctness — packages/agent-runtime/src/util/preflight-syntax-validation.ts:85 — [POLY] Python and Go preflight use hand-rolled heuristics instead of the shipped tree-sitter grammars; valid code is rejected
- **Risk:** The .py and .go paths never call detectSyntaxErrorViaTreeSitter, even though P0-T5 is marked done 'for all 13 languages'. The heuristics reject valid code: (1) Python backslash line continuations (`x = a + \` followed by an indented line) fail with 'indentation increases without a preceding block colon', because getPythonLineStates tracks only bracket depth. (2) The escape check `content[index-1] !== '\\'` misreads strings that end in an escaped backslash (`"C:\\"`), so the quote state flips and brace/paren counts go wrong. (3) Go bodyless function declarations (assembly-backed `func f(x int) int`) and multi-line backtick raw strings whose lines begin with if/for/func trip isGoBlockStatementMissingOpeningBrace. Each false rejection tells the model 'Do NOT resubmit', which blocks legitimate edits.
- **Fix:** Route .py/.pyi/.go through the tree-sitter hasError path, keeping the heuristics only as the fallback when available:false. Better still, gate on an error DELTA (see the diagnostic-delta finding). Add regression tests for backslash continuation, escaped-backslash strings, bodyless Go funcs, and Go raw strings.
- **Evidence:** preflight-syntax-validation.ts:82-90 dispatches JS→Bun, .py→validatePythonSyntax, .go→validateGoSyntax; only 'remaining supported languages' reach detectSyntaxErrorViaTreeSitter (l.94). Line 360: `if (char === quote && content[index - 1] !== '\\') quote = undefined`. getPythonLineStates (l.~395-440) has no backslash-continuation handling. PLAN.md:38 P0-T5 marked [x].

## [HIGH] correctness — packages/agent-runtime/src/process-str-replace.ts:2090 — [POLY] Near-match auto-correct falls back to bracket balance for grammar-less languages, including indentation-sensitive YAML/Nim/Haskell
- **Risk:** When detectSyntaxErrorViaTreeSitter returns available:false (YAML, TOML, JSON, Vue/Svelte SFCs, Markdown, Haskell, Nim, shell, Makefile, or any grammar init failure), the ONLY structural gate on a ~92%-similar auto-correct is `isResultDelimiterBalanced`. That check says nothing about indentation-scoped languages. A near-match that lands on a sibling YAML mapping or a mis-indented Nim block passes. Preflight then also reports valid:true, so the auto-corrected edit is written with no real validation. This is a silent fail-open path in precisely the languages where whitespace carries meaning.
- **Fix:** When the grammar is unavailable, disable near-match auto-correction (return diagnostics only), or at minimum do so for extensions flagged indentation-sensitive in language-profiles. Add cheap real parsers where they exist: JSON.parse for .json, a YAML parser (e.g. the `yaml` package, pinned) for .yml/.yaml, and a TOML parser for .toml. Use them both here and in preflightValidateSyntax, and log/count the available:false outcome instead of staying silent.
- **Evidence:** tryNearMatchAutoCorrect: `if (syntax.available) { if (syntax.hasError) return null } else if (!isResultDelimiterBalanced(best.closestBlock, newStr)) { return null }`. isResultDelimiterBalanced counts only ()[]{} (l.1737). languages.ts:386-412 returns available:false for any extension without a config. preflight-syntax-validation.ts:101-106 returns valid:true.

## [HIGH] state-mutation — packages/agent-runtime/src/process-edit-transaction.ts:1144 — [POLY] replace_range, rewrite_symbol and structured edits in edit_transaction rewrite whole CRLF files as LF (or mixed)
- **Risk:** str_replace restores original line endings (restoreLineEndingsFromOriginal). The other transaction paths do not. replace_range builds content from getLineCoordinates(...).normalized and `lines.join('\n')`. rewrite_symbol uses `normalizeLineEndings(initialContent).split('\n')...join('\n')`. structured insert_import appends a literal `\n`, and the Go block insert adds `\t${specifier}\n`. On Windows or .gitattributes eol=crlf repos, one small edit turns every line into a diff (whole-file churn and review noise) or mixes CRLF and LF. Both break .bat/.cmd files and some parsers.
- **Fix:** Factor restoreLineEndingsFromOriginal into a shared helper (common/util) and apply it to every transaction edit's output relative to that edit's input content. Make structured inserts use the dominant line ending of the file. Add tests for CRLF replace_range, rewrite_symbol and insert_import.
- **Evidence:** process-edit-transaction.ts replace_range: `const { normalized, lines } = coordinates` … `lines.splice(...); return lines.join('\n')` (l.1144-1156) and the mappedRange branch slices `normalized`. rewrite_symbol l.1222-1228: `normalizeLineEndings(initialContent).split('\n')` … `lines.join('\n')`. process-structured-edit.ts:421 `\t${specifier}\n` and insertImport `${importStatement}\n`. CRLF tests exist only for str_replace (process-str-replace.test.ts:68-116) and insert_text.

## [HIGH] performance — packages/agent-runtime/src/process-str-replace.ts:1397 — [BEST] Unbounded O(n·m) Levenshtein on candidate windows stalls on long oldStrings and minified or long-line files
- **Risk:** findClosestMatches runs full DP Levenshtein on up to max(12, 6*limit) = 48 candidates when limit=8 (the auto-correct path). Nothing caps length. On a minified file or a single very long line, a candidate window is the entire line (hundreds of KB), and oldStrings can be tens of KB (the large-oldString nudge starts at 1.5K chars). 48 × 100K × 50K is about 2.4e11 cell updates, which blocks the event loop for minutes during a failed edit. Candidate generation also materializes about 7·N objects and sorts them, O(N log N), per failure.
- **Fix:** Use a banded/threshold Levenshtein (Ukkonen, band k = ceil((1-0.45)·maxLen), early exit), or Myers/Hyyrö bit-parallel edit distance, which is O(⌈m/64⌉·n). Skip candidates whose length ratio already rules out similarity ≥ 0.45. Cap candidate text at e.g. 20K chars and fall back to line-level token similarity beyond that. Keep top-K with a bounded heap instead of sorting all 7N windows.
- **Evidence:** levenshteinDistance l.1397-1427 allocates a full-width row and has no threshold. findClosestMatches: windows K = L-3..L+3 over all lines pushed into `candidates`, then `candidates.sort` (l.1511), then `topCandidates = candidates.slice(0, Math.max(12, limit * 6))`, each passed to levenshteinDistance(candidateText, oldStr). tryNearMatchAutoCorrect calls it with limit: 8.

## [MEDIUM] correctness — packages/agent-runtime/src/tools/handlers/tool/str-replace.ts:384 — [LANG] Preflight judges absolute syntax validity, not a delta; files with pre-existing parse errors cannot be edited (P3-T3 design input)
- **Risk:** preflightValidateSyntax is called only on the candidate content, never on the original. tree-sitter grammars often lag the language (new syntax, C/C++ macros, templated YAML/Jinja, Kotlin/Swift edge cases), and some repos simply contain broken files. For such a file, any edit, even fixing a comment, is rejected with 'Do NOT resubmit'. The same applies to edit_transaction and write_file.
- **Fix:** Implement tier-0 of P3-T3 now: parse before and after, and reject only when the post-edit tree has ERROR/MISSING nodes that do not map to pre-existing ones (compare counts, or node spans shifted through the edit ledger). For tiers 1-2, key LSP/compiler diagnostics by (code, message, enclosing symbol path) rather than line, so line shifts are not counted as new errors. Treat a timeout as advisory, not blocking. This is better than the planned 'reject if new LSP errors' alone because it works without daemons.
- **Evidence:** str-replace.ts:384-386 `preflightValidateSyntax(path, fileProcessingResult.content)`, edit-transaction.ts:1151-1153 and write-file.ts:623-625 likewise pass only the new content. preflight-syntax-validation.ts:94-100 rejects on `res.available && res.hasError`. PLAN.md:101 P3-T3 [ ].

## [MEDIUM] correctness — packages/agent-runtime/src/process-structured-edit.ts:613 — [POLY] Regex import ranges misplace inserts for Python multi-line/local imports and over-match TS `import x = require()`
- **Risk:** The Python regex `^[ \t]*(?:from ... import .+|import .+)` also matches indented imports inside functions or try-blocks. getImportInsertionOffset picks the LAST range, so a new top-level import can be inserted after an indented local import inside a function body. That is a syntax error, or the import silently becomes local. Parenthesized `from x import (\n a,\n b)` matches only its first line, so the insertion lands inside the parentheses. For JS, JS_IMPORT_REGEX's lazy `[\s\S]*?\s+from` lets `import fs = require('fs')` or other non-`from` imports extend to the next `from '…'`, so remove_import can delete intervening code.
- **Fix:** Derive import ranges from the tree-sitter grammars that already ship: import_statement/import_from_statement at module level only, JS import_statement nodes, and so on. An ast-grep rule per language (P4-T1) is another option. Restrict the Python fallback to column-0 imports and handle parenthesized continuation. Add tests for local imports, parenthesized from-imports and TS import-equals.
- **Evidence:** process-structured-edit.ts:613 Python regex allows `[ \t]*` leading indent. getImportInsertionOffset: `if (ranges.length > 0) return ranges[ranges.length - 1].end`. JS_IMPORT_REGEX l.8-9 `/^import(?:\s+type)?(?:\s+[\s\S]*?\s+from\s+['"][^'"]+['"]|...)/gm`.

## [MEDIUM] correctness — packages/agent-runtime/src/structural-read.ts:76 — [POLY] rewrite_symbol comment/attribute extension is C-family only; decorators, #-comments, docstrings and attributes are orphaned or duplicated
- **Risk:** extendRangeToPrecedingComment recognizes only `/* */` and `//`. Python/Ruby/shell/Nim `#` comments, Haskell/Lua/SQL `--`, Python/Java/TS decorators, Rust `#[attr]` and C# `[Attr]` are not pulled into the span. When the model's replacement content includes the decorator or doc comment, as models routinely do, the result has duplicated decorators or duplicated docs. The flat name-equality match (`s.name === symbol`) also has no qualified form (Class.method, impl Foo::bar, Go receiver methods). Same-named methods across classes force occurrence indexes, which drift between reads.
- **Fix:** Make comment and attribute extension language-profile-driven. Better, take the span from the tree-sitter wrapping node (decorated_definition, attribute_item siblings, preceding comment siblings). Accept dotted qualified symbol paths resolved against SymbolRange depth/parent. Add tests for a Python decorated def with a # comment and a Rust fn with /// and #[inline].
- **Evidence:** structural-read.ts:88 `/\*\/\s*$/` and l.113 `/^\s*\/\//` are the only comment patterns. extractSlices/rewrite-symbol filter `structure?.filter((s) => s.name === symbol)`. rewrite-symbol.test.ts covers .py/.rs/.go (l.442-542) but without decorators or attributes.

## [MEDIUM] api-contract — common/src/tools/params/edit-blocks.ts:41 — [POLY] D22 edit blocks reject legitimate content with 7+ '=', '<' or '>' at line start (rST/Markdown/Setext headings, ASCII rulers)
- **Risk:** MARKER_PREFIXES uses startsWith, so any body line beginning with `=======`, e.g. a Setext/rST heading underline `==========` or a banner in a Haskell/SQL/YAML comment block that begins at column 0, raises marker_collision. Git conflict markers in fixtures do the same. Docs-heavy repos therefore cannot use block payloads, and a line that is exactly `=======` in CRLF payloads mis-segments (documented EB-SEC-2). Before flipping the eval flag, the format needs a collision-free escape.
- **Fix:** Use a variable-length fence, as CommonMark code fences do: the opening marker picks N ≥ 7 characters (`<<<<<<<<<< SEARCH`), and only lines exactly equal to that N-length divider or close marker are structural. The model picks N longer than any run in the content. Compare markers before stripping \r, or require an exact \r\n divider in CRLF payloads to close EB-SEC-2. Alternatively, keep JSON metadata and move bodies into length-prefixed segments. Add rST/Markdown fixtures to evals/edit-blocks.
- **Evidence:** edit-blocks.ts:41 `const MARKER_PREFIXES = ['<<<<<<<', DIVIDER_MARKER, '>>>>>>>']`. lineStartsWithMarkerPrefix uses `line.startsWith(prefix)`. The SEARCH/REPLACE body loops return marker_collision on any match. The module doc admits the EB-SEC-2 CRLF divider mis-segmentation.

## [MEDIUM] performance — packages/agent-runtime/src/process-edit-transaction.ts:944 — [BEST] Transformation ledger re-derives edit spans with unbounded diffChars (O((N+M)·D)) instead of recording exact spans
- **Risk:** Every successful transaction edit runs diffChars(before, after) over the whole normalized file to rebuild provenance. Each edit processor already knows its exact [start, end) spans. On 100KB+ files with a large replace_range or rewrite_symbol (D in the tens of thousands of characters), Myers char diff is quadratic-ish and has no timeout or maxEditLength. On repetitive text it can also attribute an insertion to a different but equal offset than the one actually edited, which weakens the overlap-check reasoning.
- **Fix:** Have each edit processor (str_replace occurrences, replace_range splice, rewrite_symbol splice, structured insert/remove) return its exact edit spans and append those to the ledger directly. Use diff only as a fallback, with jsdiff's `timeout`/`maxEditLength` options, and mark the path unmappable on timeout (fail closed). For P4-T7, imara-diff's histogram algorithm via napi is the right tool, but only if X-2 shows a need. Recording exact spans makes a diff unnecessary here.
- **Evidence:** process-edit-transaction.ts:944 `for (const part of diffChars(beforeContent, afterContent))` inside appendTransformationLedgerEntries, called after every edit with full normalized prior/result content. The call passes no options.

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/read-outline.ts:97 — [POLY] read_outline fallback for grammar-less languages is a JS/TS regex; Lua/Elixir/Haskell/Nim/shell/YAML get empty or bogus outlines
- **Risk:** When tree-sitter cannot parse, regexOutline recognizes only class/interface/type/function/const-arrow and a loose `name(args)` method pattern, which flags calls like `print(x)` as methods in Python/Ruby-style code. The warning banner helps, but the model gets no usable navigation for most non-grammar languages, and false 'method' entries steer rewrite_symbol toward the heuristic slicer (see the CRITICAL finding).
- **Fix:** Fall back to universal-ctags (`--output-format=json`, 100+ languages) when it is available on PATH, or add per-language-profile declaration regexes (def/defp/defmodule, function…end, `^name ::`, proc/func, shell `name()`). Emit nothing rather than guessed 'method' entries for unknown extensions.
- **Evidence:** read-outline.ts:97-104 falls back to regexOutline. Patterns l.203-217 are TS/JS keyword forms. methodMatch `/^\s*(async\s+)?(\w+)\s*\([^)]*\)\s*(\{|\b)/` matches any call statement.

## [MEDIUM] correctness — .agents/sessions/polyglot-roadmap-v2/PLAN.md:113 — [LANG] P4-T1/P4-T2/P4-T4/P2-T5 mechanism review: ast-grep coverage, WorkspaceEdit versioning, crash atomicity
- **Risk:** P4-T1: @ast-grep/napi's built-in languages are the web set (JS/TS/TSX/HTML/CSS). Python/Go/Rust/Java etc. need registerDynamicLanguage with separately built @ast-grep/lang-* parsers, and the tree-sitter ABI can mismatch the web-tree-sitter WASM grammars already shipped. Two grammar sets could then disagree about the same file. P4-T2: WorkspaceEdit application without versioned TextDocumentEdit and a pre-apply hash check can apply stale edits. P2-T5: the plan's intent log alone does not give crash atomicity across files. It needs write-temp, fsync(file), rename, fsync(dir), plus roll-forward/rollback on startup. renameat2(RENAME_EXCHANGE) is Linux-only; Windows needs ReplaceFileW/MoveFileEx(MOVEFILE_REPLACE_EXISTING|WRITE_THROUGH).
- **Fix:** P4-T1: pin one grammar source (either ast-grep dynamic languages built from the same grammar revisions as code-map, or tree-sitter queries plus a pattern layer over web-tree-sitter). Always follow with the error-delta gate from the preflight finding. P4-T2: require versioned documentChanges, verify each document's content hash against cap.v3 before apply, and route through the ledger. P4-T4: prefer these ecosystem tools as the correctness oracle for language-specific refactors (libCST, rust-analyzer SSR, OpenRewrite); the plan is right. P2-T5: journal of {txId, path, preHash, tempPath} with fsync ordering, per-OS atomic replace, and recovery on boot.
- **Evidence:** PLAN.md:91 P2-T5 '[ ] intent log … renameat2 later', :113 P4-T1 '@ast-grep/napi … all 13 grammars', :114 P4-T2 LSP WorkspaceEdits, :116 P4-T4 codemods. code-map already loads web-tree-sitter grammars (languages.ts getLanguageConfig).

## [LOW] correctness — packages/agent-runtime/src/util/preflight-syntax-validation.ts:58 — [POLY] Extension dispatch misses .mjs/.cjs/.mts/.cts/.pyi; symbol-identity boost is JS-only
- **Risk:** isJavaScriptLikePath and getBunTranspilerLoader ignore .mjs/.cjs/.mts/.cts, which drop to the tree-sitter path and may skip validation entirely. .pyi skips the Python validator. getSymbolIdentityBoost parses every language with Bun's 'ts' loader, so only JS/TS files benefit from the corroboration, which makes near-match behavior asymmetric across languages.
- **Fix:** Map .mjs/.cjs→js and .mts/.cts→ts, and .pyi→python. Implement symbol identity through code-map parseFileStructure (language-agnostic) instead of Bun.Transpiler, or disable it for non-JS paths explicitly.
- **Evidence:** l.58-65 getBunTranspilerLoader handles only .tsx/.jsx/.ts/.js. l.67 `/\.(?:ts|tsx|js|jsx)$/`. process-str-replace.ts getTranspiledTopLevelSymbolName uses `getBunTranspilerLoader(path) ?? 'ts'`.

## [LOW] test-coverage — common/src/util/line-coordinates.ts:147 — [BEST] Confirmation: capability re-anchoring fails closed on ambiguity/over-budget; minor rolling-hash opportunity
- **Risk:** Confirmed correct: re-anchoring relocates only on a unique exact hash match and refuses when the scan exceeds its budget, instead of doing a prefix scan. The cost is O(lines × window) SHA-256 work up to a 2M line-product budget, so large capabilities on large files return over_budget and force re-reads.
- **Fix:** Optional: hash each line once, then use a rolling polynomial hash over line hashes to find candidate windows in O(lines), and confirm with SHA-256 only on candidates. That raises the effective budget without weakening fail-closed behavior.
- **Evidence:** reanchorCapabilityRange l.147-195: unique-match requirement, `ambiguous`/`over_budget` results, MAX_REANCHOR_SCAN_LINE_PRODUCT = 2_000_000, getRangeSlice per candidate.

## Coverage receipt

### Subsystems
- packages
- common

### Features
- edit-transaction
- str-replace
- near-match-autocorrect
- syntax-preflight
- structural-read
- rewrite-symbol
- read-outline
- replace-range
- structured-edit
- file-block
- edit-blocks
- line-coordinates

### Files
- packages/agent-runtime/src/process-str-replace.ts
- packages/agent-runtime/src/process-edit-transaction.ts
- packages/agent-runtime/src/process-structured-edit.ts
- packages/agent-runtime/src/process-file-block.ts
- packages/agent-runtime/src/structural-read.ts
- packages/agent-runtime/src/util/preflight-syntax-validation.ts
- packages/agent-runtime/src/tools/handlers/tool/rewrite-symbol.ts
- packages/agent-runtime/src/tools/handlers/tool/read-outline.ts
- packages/agent-runtime/src/tools/handlers/tool/replace-range.ts
- packages/agent-runtime/src/generate-diffs-prompt.ts
- common/src/tools/params/edit-blocks.ts
- common/src/util/line-coordinates.ts
- packages/code-map/src/languages.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- packages/agent-runtime/src/tools/handlers/tool/str-replace.ts
- packages/agent-runtime/src/tools/handlers/tool/edit-transaction.ts
- packages/agent-runtime/src/tools/handlers/tool/write-file.ts
- packages/agent-runtime/src/__tests__/process-str-replace.test.ts
- packages/agent-runtime/src/__tests__/preflight-syntax-validation.test.ts
- packages/agent-runtime/src/__tests__/generate-diffs-prompt.test.ts
- packages/agent-runtime/src/__tests__/process-structured-edit.test.ts
- packages/agent-runtime/src/__tests__/rewrite-symbol.test.ts
- packages/agent-runtime/src/__tests__/structural-read.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
