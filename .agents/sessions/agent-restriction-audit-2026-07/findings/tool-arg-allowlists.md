# Audit findings: tool-arg-allowlists

- Subsystems: sdk-search-tools, cli-git-slash-commands, agents-security-reviewer, common-tool-params, agent-runtime-tool-handlers
- Features: ripgrep-flag-allowlist, git-pathspec-arg-parsing, security-reviewer-params, glob-list-directory-params, search-result-caps
- Files covered: 8

## [MEDIUM] api-contract — sdk/src/tools/find-files-matching-content.ts:635 — [B] parseSafeRipgrepFlags rejects combined short flags (e.g. -ni), forcing a re-search

- **Risk:** The allowlist matches whole tokens against fixed Sets (switchesWithoutValue L635, switchesWithValue L651). A single-dash bundle such as `-ni` (= -n + -i) or `-iw` is never split, so it fails the exact-token check and returns `Unsupported ripgrep flag '-ni'` (unsupportedFlag L713-721). `-n` is habitually emitted by models and is even special-cased as a no-op (redundantLineNumberSwitches L660,L668), but the moment it is bundled with another safe short flag the whole search is rejected. This is the exact 'Unsupported ripgrep flag -ni' friction noted in the prior run: the rejected content is a benign case-insensitive line-numbered search, not an injection attempt.
- **Fix:** Before the per-token loop, expand any token matching /^-[a-zA-Z]{2,}$/ into individual `-x` short flags, then validate each against the existing Sets. Only expand pure single-dash alpha bundles (never `--long` or value-bearing forms). This keeps the dangerous-flag allowlist intact while accepting `-ni`, `-iw`, `-in`, etc. Minimal, mechanical relaxation.
- **Evidence:** L635 `const switchesWithoutValue = new Set([...])`; L660 `redundantLineNumberSwitches = new Set(['-n','--line-number'])`; L713-721 unsupportedFlag() rejects any unrecognized token. No branch splits `-ni` into `-n`+`-i`.

## [MEDIUM] api-contract — sdk/src/tools/find-files-matching-content.ts:651 — [B] find_files_matching_content blocks -o/--only-matching and -c/--count, common harmless output modes

- **Risk:** The value/no-value Sets (L635-659) permit only case/word/fixed/multiline modifiers plus -g/-t/-T. Harmless, read-only output selectors that models routinely reach for — `-o`/`--only-matching`, `-c`/`--count`/`--count-matches`, `-v`/`--invert-match` — are all rejected with the generic Unsupported-flag error (L719). None of these mutate files or run commands; they only change how ripgrep reports matches. The rejection produces a dead-end for a legitimate query and pushes the agent to retry or abandon.
- **Fix:** Add `-v`/`--invert-match` and `-c`/`--count`/`--count-matches` (no-value) and, for code_search where JSON parsing tolerates it, `-o`/`--only-matching` to the allowlist. `--count` for this tool changes stdout framing (counts, not paths) so if that breaks the -l/JSON parser, either translate it to a post-filter or document it as code_search-only. Keep excluding the genuinely dangerous flags (--pre, -r/--replace, -z/--null, --files, -0).
- **Evidence:** L651-659 switchesWithValue only has -g/--glob,-t/--type,-T/--type-not; L635-649 no-value set lacks -o,-c,--count,-v. Allowed-flags string at L719 confirms the closed set.

## [LOW] api-contract — sdk/src/tools/code-search.ts:108 — [C] code_search context flags (-A/-B/-C) are already allowed — prior 'context flags blocked' concern does not apply here

- **Risk:** The prior run's worry that `-A/-B/-C` are blocked is TRUE only for find_files_matching_content, not code_search. code_search explicitly adds `-A`,`-B`,`-C`,`--after-context`,`--before-context`,`--context` via extraSwitchesWithValue (L108-119) because its JSON parser already handles context events. So there is no over-strictness to fix for context flags in code_search; the correct guidance (already in unsupportedFlag recovery text) is to route context-needing searches to code_search.
- **Fix:** No change to code_search context handling. Optionally improve the find_files recovery message so it names -A/-B/-C explicitly (it already says 'Use code_search only when you need its documented context flags.'). Keep as-is (C).
- **Evidence:** L100-107 comment 'code_search additionally allows the -A/-B/-C context flags'; L108-119 extraSwitchesWithValue lists all six context forms.

## [MEDIUM] api-contract — cli/src/commands/git-command-args.ts:1 — [B] FORBIDDEN_SHELL_CHARACTERS blocks ( ) [ ] { } for /git slash commands, rejecting valid git pathspecs

- **Risk:** FORBIDDEN_SHELL_CHARACTERS = /[\n\r;$`|&<>()[\]{}\\]/ (L1) is tested against the RAW input BEFORE tokenization (L5), and every arg is later single-quoted by quoteShellArgument (L38-39) before being joined into the final `git diff|status ...`string. Because each argument is single-quoted, brackets/braces/parens cannot be shell-expanded — yet they are blocked at parse time. This rejects perfectly valid git usage: bracket globs`git diff 'src/\*\*/[abc].ts'`, brace sets `git diff 'src/{a,b}.ts'`, and magic pathspecs `git diff ':(exclude)dist'`. The block conflates glob/expansion metacharacters (neutralized by single-quoting) with true shell operators (`; | & $ \` < > backtick`) that are the real injection risk.
- **Fix:** Split the class: keep hard-blocking the genuine injection set `[\n\r;$\`|&<>\\]`(these break out of or chain commands even when the parser mis-handles them). Allow`( ) [ ] { }`through the parser since quoteShellArgument single-quotes them and buildSafeGitCommand only ever targets`diff`/`status`. Add a test asserting `parseSafeGitArgs(":(exclude)dist")`and`'{a,b}.ts'` survive and are correctly single-quoted.
- **Evidence:** L1 regex includes ()[]{}; L5 pre-tokenization test throws 'Shell operators and expansions are not allowed here.'; L38 quoteShellArgument single-quotes each arg; L44-45 buildSafeGitCommand joins quoted args.

## [LOW] api-contract — agents/security-reviewer/security-reviewer.ts:34 — [B] security-reviewer rejects snapshot_id and accepts only snapshot_fingerprint (strict param-name allowlist)

- **Risk:** inputSchema.params.required = ['changed_files','snapshot_fingerprint'] (L34) and the spawnerPrompt explicitly warns `snapshot_id is not accepted` (L10-11). A caller that passes the very common `snapshot_id` key gets a spawn-time validation failure even though the intent is identical. This is a naming-allowlist strictness, not a safety control — the token is opaque and simply echoed back as snapshotFingerprint.
- **Fix:** Accept `snapshot_id` as an alias for `snapshot_fingerprint` (normalize either key to snapshotFingerprint), or relax the required check to accept whichever of the two is present. Keep requiring exactly one of them so the echo-back invariant holds. Low-risk, purely ergonomic.
- **Evidence:** L10-11 spawnerPrompt 'snapshot_id is not accepted'; L22-30 only snapshot_fingerprint property declared; L34 required list.

## [LOW] api-contract — agents/security-reviewer/security-reviewer.ts:128 — [C] security-reviewer toolNames are read-only by design — keep

- **Risk:** toolNames is limited to read_files, read_outline, code_search, git_status, set_output with spawnableAgents: [] (L128-137). This is an intentional least-privilege boundary for an adversarial reviewer that must not mutate code ('Do not modify code. Review only.' in instructionsPrompt). There is no readable-path glob restriction on the reviewer itself; the SECURITY_SENSITIVE_GLOBS list lives in base2.ts as a spawn TRIGGER, not a read filter. No over-strictness on readable paths exists to relax.
- **Fix:** Keep. The read-only tool set is a correct guardrail, not friction. If reviewers need broader discovery, add find_files_matching_content (also read-only) rather than write tools.
- **Evidence:** L128-136 toolNames read-only list; L137 spawnableAgents: []; instructionsPrompt 'Do not modify code. Review only.'

## [LOW] test-coverage — agents/**tests**/security-glob-parity.test.ts:97 — [C] security-glob-parity test enforces doc/matcher sync — keep

- **Risk:** This test extracts SECURITY_SENSITIVE_GLOBS and SECURITY_SENSITIVE_NAME_SUBSTRINGS from base2.ts and asserts every token is documented in securityReviewSection prose (L97-128). It is a cohesion invariant, not a runtime argument restriction, so it does not block any user/agent action. It only fails CI if the two lists drift. No end-user friction.
- **Fix:** Keep as-is. It prevents silent divergence between the phase-gate matcher and the model-facing prose. Not a candidate for relaxation.
- **Evidence:** L102 asserts SECURITY_SENSITIVE_NAME_SUBSTRINGS === ['secret','token','apikey']; L110-117 asserts every glob token documented; L119-127 asserts '.env' documented.

## [MEDIUM] correctness — sdk/src/tools/code-search.ts:43 — [B] code_search default per-file cap maxResults=15 can silently hide relevant matches

- **Risk:** maxResults defaults to 15 per file (L43) and globalMaxResults to 250 (L44). Files exceeding 15 matches are truncated and recorded in filesLimitedByMaxResults, surfaced as 'limited to 15 results per file'. The truncation IS reported (good), but 15 is low for real searches (e.g. finding every call site of a common symbol in one large file), so agents can act on partial results and miss occurrences. This is a usability cap, not injection protection.
- **Fix:** Raise the per-file default (e.g. 30-50) or make it clearly overridable per call, while keeping globalMaxResults and maxOutputStringLength as the real memory guards. The truncation message already exists, so the main change is a more generous default. Soften, don't remove — the global/byte caps stay.
- **Evidence:** L43 `maxResults = 15`; L44 `globalMaxResults = 250`; truncation surfaced via filesLimitedByMaxResults and 'limited to ${maxResults} results per file' message near close handler.

## [LOW] correctness — sdk/src/tools/find-files-matching-content.ts:50 — [B] find_files_matching_content maxFiles=100 cap truncates discovery but is surfaced

- **Risk:** maxFiles defaults to 100 (L50) with HARD_MATCH_LIMIT=5000 (L33). When exceeded, results stop and `truncated: true` plus a 'results capped' message are returned (buildSuccessPayload / buildMessage), so truncation is not silent. Still, 100 files is easy to hit on broad patterns in a monorepo, causing incomplete file discovery that the agent may not compensate for.
- **Fix:** Consider raising the default maxFiles (e.g. 250) or emphasizing the truncated flag more strongly in the message so agents narrow the pattern. Keep HARD_MATCH_LIMIT as the memory backstop. Minor soften.
- **Evidence:** L50 `maxFiles = 100`; L33 `HARD_MATCH_LIMIT = 5_000`; buildMessage emits '(results capped; consider narrowing the pattern or flags)'.

## [LOW] api-contract — common/src/tools/params/tool/glob.ts:8 — [C] glob and list_directory params carry no result cap or pattern restriction — nothing to relax

- **Risk:** The glob inputSchema only requires a non-empty pattern (L10-16, min(1)) and an optional cwd; there is no result cap, denylist, or pattern restriction in the param schema. The handler (packages/agent-runtime/src/tools/handlers/tool/glob.ts L8-20) simply forwards to the client with no filtering. list-directory.ts likewise only takes a path. So the 'glob result caps that hide files' concern does not originate here — any capping happens client-side, outside these files.
- **Fix:** No change in these files. If a client-side glob cap exists and hides files, audit that layer separately; the param/handler layer imposes no over-strict restriction.
- **Evidence:** glob.ts L10-16 pattern.min(1) only; no maxResults field; handler glob.ts L18-19 `return { output: await requestClientToolCall(toolCall) }`; list-directory.ts L9-11 path only.

## Coverage receipt

### Subsystems

- sdk-search-tools
- cli-git-slash-commands
- agents-security-reviewer
- common-tool-params
- agent-runtime-tool-handlers

### Features

- ripgrep-flag-allowlist
- git-pathspec-arg-parsing
- security-reviewer-params
- glob-list-directory-params
- search-result-caps

### Files

- sdk/src/tools/code-search.ts
- sdk/src/tools/find-files-matching-content.ts
- cli/src/commands/git-command-args.ts
- agents/security-reviewer/security-reviewer.ts
- agents/**tests**/security-glob-parity.test.ts
- common/src/tools/params/tool/glob.ts
- common/src/tools/params/tool/list-directory.ts
- packages/agent-runtime/src/tools/handlers/tool/glob.ts
