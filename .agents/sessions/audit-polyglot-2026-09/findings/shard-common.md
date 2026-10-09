# Audit findings: shard-common

- Subsystems: common, agents
- Features: xml-toolcall-parsing, streaming-xml-sax-parser, string-truncation-ansi-utilities, fnv-stable-hash, sha256-content-hash-and-cap-v3-read-capabilities, language-detection-and-profile-prompts, tool-definition-type-generation, basher-command-runner, tmux-cli-orchestration, browser-use-cdp-agent
- Files covered: 11
- Snapshot: 3ce1fa2b4613303fb428bab8463887ba85bd13958dfd9df8c276dee8231f053a

## [LOW] performance — common/src/util/xml-parser.ts:9 — parseToolCallXml: single-regex JS scanner on the hot path of every XML-protocol tool call
- **Risk:** Every LLM tool-call payload in the XML protocol path is regex-parsed in JS. The single global regex over the whole string causes repeated re-scan behavior on large tool outputs, and backtracking over [\s\S]*? is O(n^2) worst case on adversarial/malformed model output. Purely from a feature standpoint this parser caps Openbuff's XML tool protocol: no attributes, no nesting, no numbers — the language (regex) blocks richer tool-call formats users could enable.
- **Fix:** Native XML mini-parser (Rust via napi-rs, or Zig) as an optional NAPI addon with the exact same Record<string,string> return contract; fall back to TS implementation when the native module is absent. Keep the ABI: string key -> trimmed string value.
- **Evidence:** const tagPattern = /(\w+)([\s\S]*?)<\/\1>/g; while ((match = tagPattern.exec(xmlString)) !== null) { result[key] = value } — no nesting, no attributes, only string values.

## [MEDIUM] performance — common/src/util/saxy.ts:493 — Saxy string-based Transform: per-chunk string concatenation and parseEntities allocation on streaming hot path
- **Risk:** The SAX streaming parser runs per streamed LLM chunk on the XML protocol path. Text is accumulated by repeated JS string concatenation (_textBuffer += chunk), entity decoding allocates a parts array and joins per emit, and every character test goes through JS string indexing. Purely feature-wise, JS string semantics (UTF-16 code units, no SIMD memchr) block streaming throughput needed for very long tool outputs and for incremental UI streaming features over huge XML streams.
- **Fix:** Rust SAX core exposed via napi-rs returning typed arrays/strings per event (tagopen/tagclose/text), consumed by a thin TS Transform. Candidate language: Rust (zero-copy SIMD scanning of '<', '&', quote delimiters). ABI to freeze: SaxyEvents shapes (TextNode.contents, TagOpenNode{name,attrs,isSelfClosing,rawTag}, TagCloseNode).
- **Evidence:** class Saxy extends Transform ... private _textBuffer: string ... this._textBuffer += chunk; const parsedText = parseEntities(this._textBuffer); this.emit(Node.text, { contents: parsedText }); parseEntities builds `parts` array and joins.

## [MEDIUM] performance — common/src/util/string.ts:399 — stripAnsi/stripColors regex and suffixPrefixOverlap quadratic scan on terminal-output hot path
- **Risk:** stripAnsi is called on full tmux/terminal captures (referenced by cli e2e and tmux integration tests); the alternation-heavy regex is a known quadratic-backtracking hazard on hostile terminal output. suffixPrefixOverlap is O(n^2) slicing in the overlap loop used by stop-sequence handling on streamed text. truncateStringWithMessage is trivial. These sit on hot paths of every run that surfaces terminal output. Feature-standpoint: JS regex cannot do byte-level SIMD scans, so massive log ingestion (a user-facing feature) is throttled.
- **Fix:** Rust ANSI stripping (byte-level scanner with SIMD skip of ESC runs) via napi-rs with the identical stripAnsi/stripColors output contract; suffixPrefixOverlap as a native two-pointer over bytes. These are pure functions — the easiest safe ABI candidates in common/.
- **Evidence:** const ansiRegex = /\x1B(?:[@-Z\\-_|\[[0-?]*[ -/]*[@-~]|\][^\x1B]*\x1B\\?)/g; return str.replace(ansiRegex, ''); suffixPrefixOverlap loops len from next.length down calling source.endsWith(prefix).

## [LOW] performance — common/src/util/stable-hash.ts:12 — stableHash: per-character JS loop FNV-1a on observation/task-memory checksum paths
- **Risk:** FNV-1a over full task memories and observation fingerprints in a JS char loop; fine for small inputs, a real cost on multi-MB outputs. Feature-standpoint constraint: output is pinned to byte-compatibility by tests (811c9dc5/e40c292c vectors), so any migration must preserve the exact 32-bit algorithm — a native implementation is straightforward but the ABI (8-hex zero-padded lowercase) must be frozen.
- **Fix:** Optional Rust FNV-1a napi-rs with pinned vectors as the compatibility oracle; TS stays canonical for tests. ABI: exact 8-hex lowercase zero-padded output string — frozen forever.
- **Evidence:** let hash = 2166136261; for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619) }

## [MEDIUM] correctness — common/src/util/content-hash.ts:95 — content-hash read-capability HMAC key is process-random — any native component cannot validate cap.v3 tokens without a shared-secret ABI
- **Risk:** Cap.v3 tokens are HMAC-signed with a per-process random key; a native component could not re-derive tokens minted by the TS host and vice versa unless the key is shared over IPC. The token grammar (cap.v3 start end digest scopeFingerprint signature, all base64url 43-char) is the de facto ABI for every edit tool; it must stay stable across any language split. This is the highest-stakes cross-language contract surface in the shard.
- **Fix:** Keep token minting/verification in TS. If a native layer ever re-verifies tokens, it must receive the per-process key over a private channel and implement constant-time compare — otherwise leave this entirely in TS. No native opportunity; flagged as a migration constraint.
- **Evidence:** const READ_CAPABILITY_SIGNING_KEY = randomBytes(32); encodeReadCapabilityToken/decodeReadCapabilityToken use createHmac('sha256', key) with timingSafeEqual; cap.v3.<start>.<end>.<digest>.<scope>.<sig> format is validated by 20+ consumers across packages/agent-runtime and sdk.

## [LOW] api-contract — common/src/util/language-capabilities.ts:11 — LANGUAGE_CAPABILITY_REGISTRY is the frozen cross-language ABI for language detection and validation-stage promotion
- **Risk:** The registry already names tree-sitter grammars per language but TS only stores the strings — no actual parsing. A Rust tree-sitter integration (napi-rs) would turn these metadata entries into real incremental parsers, enabling new features: incremental syntax-aware diffing, symbol extraction for rewrite_symbol, per-language indentation inference for edits. The contract (SupportedLanguageId union, LanguageToolRole, LanguageValidationStage) is exported and consumed by prompts and validation, so it must remain stable across any native split.
- **Fix:** Rust registry (tree-sitter grammars compile natively in Rust) exposed over napi-rs with the same LanguageCapability shape serialized as JSON; TS type layer generated from the same JSON schema. ABI to freeze: SupportedLanguageId union, LanguageToolRole keys, LanguageValidationStage union, and the registry's field names.
- **Evidence:** export const SUPPORTED_LANGUAGE_IDS = ['typescript','python','rust','go','java','csharp','cpp','ruby','php','swift','kotlin','gdscript'] as const; tools: tools({ parser: ['tree-sitter-typescript', ...] }); validation: { focused: [...], project: [...] }

## [LOW] performance — common/src/util/language-profiles.ts:170 — Per-language regex arrays re-tested over task text on every language-step call
- **Risk:** detectLanguageProfilesFromTask runs 12 languages × (aliases + manifests + manifestExtensions + sourceExtensions) regex .test() calls over the full task text on every language-step call; regex compilation was already hoisted (see comment) but execution is still O(languages × signals × text). Feature-standpoint: JS cannot share one compiled multi-pattern automaton across signals, so task-text language sniffing latency scales linearly with registry size — blocking richer registry growth (dozens of languages).
- **Fix:** Native single-pass scanner (Rust regex crate with Aho-Corasick prefilter, or a combined regex compiled once) via napi-rs returning the same Set of language ids. ABI: SupportedLanguageId values only — easy contract.
- **Evidence:** const LANGUAGE_SIGNAL_REGEXPS = new Map(SUPPORTED_LANGUAGE_IDS.map((languageId) => { const signals = ...; return [languageId, { aliases: capability.taskAliases.map(taskAliasRegexp), ... }] })); signals.aliases.some((pattern) => pattern.test(taskText))

## [LOW] performance — common/src/tools/compile-tool-definitions.ts:27 — compileToolDefinitions converts Zod schemas via z.toJSONSchema and a hand-rolled mapper — the tool-param ABI is the cross-language contract surface
- **Risk:** Build-time only (scripts/generate-tool-definitions.ts), so not a runtime hot path — but it defines how common/ tool param schemas become the published TS types. The hand-rolled JSON-Schema→TS mapper silently degrades to `any` on unhandled schemas (prop.anyOf inside objects without properties, tuple types, string patterns, format). Feature-standpoint: TS-only codegen blocks generating native-side bindings (Rust structs, Go types) from the same schemas — a polyglot migration would need this to emit more than TypeScript.
- **Fix:** Keep codegen in TS (it is build-time, not hot-path) but pin the JSON-Schema intermediate representation as the stable ABI: any future Rust/TS schema bridge should speak the same z.toJSONSchema(io:'input') output. No native opportunity; migration constraint only.
- **Evidence:** jsonSchema = z.toJSONSchema(parameterSchema, { io: 'input' }); typeDefinition = jsonSchemaToTypeScript(jsonSchema); function getTypeFromJsonSchema(prop: any): string — hand-rolled type mapping with `any` fallback.

## [MEDIUM] correctness — agents/basher.ts:115 — basher builds the full-log pipeline as a shell string — native PTY runner would remove shell quoting/PIPESTATUS fragility
- **Risk:** basher composes a multi-line bash script (pipefail, tee, PIPESTATUS, grep -E, head -N, rm) around the untrusted user command using hand-rolled single-quote escaping. Quoting edge cases (a command containing the quote-escape sequence, or a failure_pattern with regex metacharacters passed through shellQuote into grep) and non-bash shells break the pipeline; string-assembled shell is the classic injection surface. Feature-standpoint: because orchestration is shell-string assembly, basher cannot offer structured features like streaming structured stdout/stderr events or exit-code attribution per pipe stage.
- **Fix:** Rust runner (napi-rs sidecar) using std::process::Command with inherited fds: no wrapper shell for the orchestration, tee semantics via native pipe-to-file copy, failure-line extraction via the regex crate. ABI: basher inputSchema params (command, what_to_summarize, save_full_log, retain_full_log, failure_pattern, max_failure_lines, timeout_seconds, process_type, cwd, detach) and the set_output data shape must stay identical — they are the cross-language contract.
- **Evidence:** const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`; const commandToRun = shouldSaveFullLog ? ['set -o pipefail', `(${command}) 2>&1 | tee ${shellQuote(fullLogPath!)}`, 'status=${PIPESTATUS[0]}', ...grep -n -E ...].join('\n') : command

## [HIGH] error-handling — agents/tmux-cli.ts:490 — tmux-cli orchestrates a 100+ line bash helper written to /tmp — TUI automation is shell-out orchestration TS cannot do natively
- **Risk:** A 130-line bash helper script is embedded as a TS template literal, written to /tmp, and invoked via run_terminal_command; wait-idle polls capture-pane every 250ms with $(date +%s) arithmetic and string-compare stability detection. Failure modes: bash availability, perl dependency for --strip-ansi, subshell quoting through the setupScript heredoc concatenation, and 120s hard caps baked into bash. Feature-standpoint: TS cannot drive a PTY natively, so richer features (structured ANSI-screen model, incremental screen diffs for the agent, reliable resize handling) are blocked.
- **Fix:** Rust PTY/tmux orchestrator (napi-rs or sidecar binary using portable-pty or direct tmux control-mode `tmux -C`): native byte-stream pane reading gives real idle detection (byte-count deltas with adaptive timers), eliminates per-poll capture-pane round-trips, and replaces the embedded bash with typed Rust code. ABI to freeze: tmux-cli outputSchema (overallStatus/summary/sessionName/results/scriptIssues/captures/lessons) and the helper command names are the contract with the parent agent.
- **Evidence:** const helperScript = `#!/usr/bin/env bash ... case "$CMD" in ... tmux capture-pane -t "$SESSION" -S - -p 2>/dev/null || echo "" ... STABLE_START=$(date +%s) ... sleep 0.25`; const setupScript = 'set -e\n' + "find /tmp -maxdepth 1 ... rm -rf {} +" + 'cat > ' + helperPath + " << 'TMUX_HELPER_EOF'\n" + helperScript + 'TMUX_HELPER_EOF\n' ...

## [MEDIUM] security — agents/browser-use/browser-use.ts:253 — browser-use agent wraps CDP via out-of-process tool; untrusted-capture neutralization and prompt-injection surface are string-transform defenses in TS
- **Risk:** The agent itself is thin (it delegates to a browser_logs CDP tool elsewhere), but its prompt-injection defense is string-level fence neutralization and its actions include evaluate (arbitrary JS in page context) — TS cannot offer memory-safe isolation for the CDP bridge. Feature-standpoint: TS blocks native browser automation (no direct CDP binary protocol support without heavy JS deps), so the current design keeps the browser process-out. A Rust CDP component would enable: out-of-process crash isolation, native WebSocket frame multiplexing for many parallel tabs, and screenshot/video pipeline in native code.
- **Fix:** Rust CDP bridge (chromiumoxide or headless_chrome crates, or reuse chrome-devtools-protocol Rust bindings) as a native sidecar exposing the same action set over a length-prefixed JSON stream; TS keeps the agent definition and policy gate. ABI: the browser_logs action schema and outputSchema results/consoleErrors/lessons shapes must stay stable — they are the tool contract.
- **Evidence:** const neutralized = raw.replace(/```/g, '\\`\\`\\`'); return ('### UNTRUSTED DATA — ' + label + ... '```' + fence + '\n' + neutralized ...; tmux send-keys -t "$SESSION" $'\\x1b[200~'"$TEXT"$'\\x1b[201~'

## [MEDIUM] test-coverage — agents/tmux-cli.ts:690 — tmux teardown runs in a finally-yielded shell command — no process-group supervision means orphaned sessions on crash
- **Risk:** Teardown after STEP_ALL shells out with silent failure suppression (>/dev/null 2>&1); if the helper process or tmux dies abnormally there is no native supervision, so orphaned sessions are only cleaned by the 24h sweep and the parent's manual kill-session instructions. Feature-standpoint: a native supervisor (Rust) would enable guaranteed cleanup via process groups and would let tmux-cli expose live session monitoring as a user-facing feature.
- **Fix:** Rust sidecar owns session lifecycle natively: crash-safe process supervision (parent-death signal), structured JSON events instead of scraped stdout. Keep the set_output contract for the agent-level ABI.
- **Evidence:** try { yield 'STEP_ALL' } finally { yield { toolName: 'run_terminal_command', input: { command: helperPath + " stop '" + sessionName + "' >/dev/null 2>&1; rm -f '" + helperPath + "'>", timeout_seconds: 15 } } } — teardown correctness depends on bash semantics of the concatenated string.

## [LOW] dependency-hygiene — common/src/util/string.ts:48 — randBoolFromStr imports lodash's sumBy for a 64-bit-free modulo check; pluralize tables are pure data — no native win, but rewrite-cost note for common/ leaf
- **Risk:** randBoolFromStr pulls the whole lodash package for a char-code sum; pluralize carries ~100 hand-curated exception words that are English-only — feature-standpoint this blocks localized pluralization in any non-English UI. Pure-TS micro-optimizations (no lodash import, charCode loop) are cheaper than any native migration; no language change needed here.
- **Fix:** Keep in TS (correct, low-cost); the only migration note is to freeze pluralize/randBoolFromStr outputs if any native component ever needs parity. No native opportunity.
- **Evidence:** import { sumBy } from 'lodash'; export const randBoolFromStr = (str: string) => { return sumBy(str.split(''), (char) => char.charCodeAt(0)) % 2 === 0 }; const IRREGULAR_PLURALS: Record<string, string> = { person: 'people', ... }; suffixPrefixOverlap loops len from next.length down calling source.endsWith(prefix).

## [LOW] correctness — common/src/util/saxy.ts:380 — Saxy schema-validation fallback converts tags to text mid-stream — cross-chunk tag-stack state can desync on schema mismatch
- **Risk:** Schema-conversion branches (non-schema tags emitted as text) and the unclosed-node handling in _final contain commented-out error callbacks (// callback(new Error('Unclosed tag')), // callback(new Error(`Unclosed tags: ...`))) — silent data-dependent behavior that a typed state-machine rewrite (Rust enum state machine) would make impossible by construction. Feature-standpoint: correctness of streaming XML parsing gates whether Openbuff can trust long XML tool outputs; a memory-safe native parser would enable guarantees JS cannot (no prototype pollution, no regex state, exhaustive match).
- **Fix:** Rust SAX core with a state machine makes these invariants compile-time expressible (enum state, match exhaustion); ABI unchanged — SaxyEvents shapes frozen. Candidate language: Rust with zero-copy &str slicing.
- **Evidence:** if (this._tagStack.length === 1) { if (!this._schema[tagName]) { const rawTag = input.slice(chunkPos - 1, tagClose + 1); this.emit(Node.text, { contents: rawTag }); chunkPos = tagClose + 1; continue } } ... if (this._tagStack.length !== 0) { return } in _final with the error callback commented out.

## [HIGH] api-contract — common/src/util/content-hash.ts:148 — cap.v3 token grammar is the frozen ABI between all mutation tools — a native edit layer must reproduce encode/decode byte-for-byte
- **Risk:** The token format (cap.v3.<start>.<end>.<base64url-sha256>.<base64url-scope>.<base64url-hmac>) is consumed by read_files, replace_range, str_replace, write-file, edit-transaction, rewrite_symbol, and mutation-capabilities across packages/agent-runtime and sdk — the widest cross-module contract in the codebase. Any polyglot migration must treat this grammar plus getContentHash normalization (CRLF→LF then sha256) as frozen ABI; a native component computing hashes differently would invalidate every outstanding edit token.
- **Fix:** Publish the token grammar as a frozen versioned spec (document + golden vectors) before any native component touches it; keep encode/decode in TS for now. New features this unlocks if honored: cross-process capability validation in a Rust file-watcher daemon, or native snapshot verification. Candidate language for any future verifier: Rust (constant-time eq via subtle crate).
- **Evidence:** return { startLine, endLine, hash: `sha256:${digest.toString('hex')}`, scopeFingerprint, tokenVersion: 'v3' } — validated against /^cap\.v3\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/ by decodeReadCapabilityToken across all edit tools.

## [MEDIUM] performance — common/src/util/language-capabilities.ts:100 — tree-sitter grammars declared as metadata only — tree-sitter highlight/query leverage is the top ecosystem win of a Rust native layer
- **Risk:** The registry already names the tree-sitter grammar for every supported language, but TS cannot load tree-sitter grammars without heavy native addons — so the capability data is inert prompt metadata. A Rust tree-sitter binding (napi-rs exposing tree-sitter queries) would turn this into live capability: syntax-aware edit validation, symbol navigation, incremental re-parse on edit, structural search. This is the single largest new-feature unlock in common/.
- **Fix:** Rust tree-sitter integration over napi-rs: grammars compiled natively, incremental parsing with Tree edits, query capture of defs/refs. ABI to freeze: SupportedLanguageId, LanguageToolRole, LanguageValidationStage; new native API should be additive, not a replacement of the registry.
- **Evidence:** tools({ parser: ['tree-sitter-typescript', 'tree-sitter-javascript'], languageServer: ['tsserver', 'typescript-language-server'], ... }) — all 12 languages declare tree-sitter parsers as strings but no grammar binding exists in common/.

## Coverage receipt

### Subsystems
- common
- agents

### Features
- xml-toolcall-parsing
- streaming-xml-sax-parser
- string-truncation-ansi-utilities
- fnv-stable-hash
- sha256-content-hash-and-cap-v3-read-capabilities
- language-detection-and-profile-prompts
- tool-definition-type-generation
- basher-command-runner
- tmux-cli-orchestration
- browser-use-cdp-agent

### Files
- common/src/util/xml-parser.ts
- common/src/util/saxy.ts
- common/src/util/string.ts
- common/src/util/stable-hash.ts
- common/src/util/content-hash.ts
- common/src/util/language-capabilities.ts
- common/src/util/language-profiles.ts
- common/src/tools/compile-tool-definitions.ts
- agents/basher.ts
- agents/tmux-cli.ts
- agents/browser-use/browser-use.ts

### Domains
- performance
- api-contract
- error-handling
- correctness
- security
