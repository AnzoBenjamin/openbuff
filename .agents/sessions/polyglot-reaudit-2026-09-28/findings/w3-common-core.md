# Audit findings: w3-common-core

- Subsystems: common
- Features: mcp-client, secret-redaction, xml-sax-parsing, message-conversion, partial-json-delta, path-containment, hashing, cap-v3, string-utils, context-budget, job-registry, tool-contracts, param-normalization, session-state, env-schema
- Files covered: 17
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] security — common/src/mcp/client.ts:470 — [BEST] SSRF guard bypass for client-origin MCP URLs: IPv4-mapped IPv6 in hex form and trailing-dot localhost
- **Risk:** getMCPClient passes the WHATWG URL hostname to isBlockedMcpAddress. The URL parser rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1]. isBlockedIpv6 only matches the dotted mapped form (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/), and for '::ffff:7f00:1' the first hextet is '' so no range check runs. The result is 'not blocked'. The same gap covers IPv4-compatible (::7f00:1), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embeddings. A host of 'localhost.' (trailing dot, which URL keeps) is also not blocked, because the check is lower==='localhost' / endsWith('.localhost'). An untrusted ACP peer can therefore point an http/sse MCP server at loopback or metadata services, which SEC-3 is meant to stop.
- **Fix:** Parse IPv6 into 8 hextets (or use net.BlockList / ipaddr-style parsing). Extract embedded IPv4 for ::ffff:0:0/96, ::/96, 64:ff9b::/96 and 2002::/16, then re-run isBlockedIpv4. Strip trailing dots from the hostname before name checks. Add golden tests that go through new URL(...).hostname, not raw strings.
- **Evidence:** client.ts isBlockedIpv6: `const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)`; `const firstHextet = lower.split(':')[0]` is '' for '::ffff:7f00:1'. getMCPClient: `const hostname = url.hostname.replace(/^\[|\]$/g, '')`. Name check: `lower === 'localhost' || lower.endsWith('.localhost')`.

## [HIGH] security — common/src/util/redact-secrets.ts:42 — [BEST] CRLF text bypasses sensitive-assignment redaction entirely
- **Risk:** redactSensitiveAssignments splits on '\n' only, so each CRLF line ends in '\r'. The assignment regex ends in `.+$` with no m or s flag. In JS, '.' does not match '\r', so `.+` stops before it and `$` (end of input) fails. The replace is a no-op. Any Windows-checked-out .env, appsettings or properties file, and any CRLF tool output, passes API_KEY=... through unredacted into prompts and logs.
- **Fix:** Split on /\r?\n/ and keep the terminator, or use `[^\r\n]+` with an optional `\r?$`. Add CRLF golden vectors.
- **Evidence:** `text.split('\n')` then `line.replace(/^(...)(\s*[:=]\s*).+$/, ...)`: '.' excludes '\r', and there is no multiline flag.

## [HIGH] security — common/src/util/redact-secrets.ts:15 — [POLY][LANG] Token-shape corpus is 5 hand-written JS/GitHub/AWS shapes; D15 gitleaks codegen not implemented
- **Risk:** Only sk-, ghp_, gh[o rus]_, AKIA and Bearer are covered. Credentials common in non-JS ecosystems pass through when they are not in a KEY= assignment: PyPI (pypi-AgEI...), crates.io (cio...), RubyGems (rubygems_...), NuGet (oy2...), npm (npm_...), Docker Hub PATs (dckr_pat_...), GitLab (glpat-...), GitHub fine-grained (github_pat_...), Slack xox*, Stripe sk_live_ (underscore, so it misses sk-), Google AIza..., AWS ASIA temporary keys, PEM private-key blocks and JWTs. Other gaps: the character class `gh[o rus]_` contains a literal space (a typo; it matches 'gh _'). JSON/TOML quoted keys ("apiKey": ...) are missed. Declaration-prefixed assignments (const/let/var/val API_KEY = ...) are missed because the leading-name group captures 'const' and then fails to find a separator. Per SPEC D15 this table should be codegen'd from the gitleaks TOML (P5-T5) so TS and future Rust/Go sidecars share one rule authority.
- **Fix:** Implement the D15 three-mirror step: vendor the pinned gitleaks TOML, generate TOKEN_SHAPES (TS) plus the Rust/Python tables from it, and keep the frozen [REDACTED] output pinned by golden vectors per ecosystem. Short term: fix the class to gh[ours]_; add github_pat_, glpat-, npm_, pypi-, dckr_pat_, rubygems_, ASIA and PEM; accept quoted keys and declaration keywords.
- **Evidence:** TOKEN_SHAPES has 5 entries: `[/(gh[o rus]_[A-Za-z0-9]{20,})/g, ...]`, `[/(AKIA[0-9A-Z]{16})/g, ...]`. SPEC D15: 'the TS TOKEN_SHAPES table is codegen'd from it ... current corpus is 5 token shapes vs ~200 gitleaks rules'.

## [HIGH] correctness — common/src/util/messages.ts:131 — [BEST] Tool results with media before json are silently dropped along with their tool call
- **Risk:** convertToolResultMessage turns each media output into a role:'user' message and each json output into its own role:'tool' message, in output order. filterOrphanModelToolMessages clears pendingToolCallIds on any user message. For an MCP result like [image, text] (common for screenshot/browser tools), the tool-result that follows is dropped as an orphan. stripUnansweredToolCalls then removes the matching assistant tool-call. The model sees an unexplained image with no call or text result. Several json outputs also produce several tool messages with the same toolCallId; some providers reject duplicate tool_result ids.
- **Fix:** Emit exactly one tool message per toolCallId, with the json outputs merged into it or a placeholder when only media exists. Place any media-as-user message after the tool message. Add tests for [media, json] and [json, json] orderings.
- **Evidence:** `return message.content.map((c) => { if (c.type === 'json') ... role: 'tool' ... if (c.type === 'media') ... role: 'user' })`; filterOrphanModelToolMessages: non-assistant/non-tool branch runs `pendingToolCallIds.clear()`; callMCPTool maps image to media and text to json in server order.

## [MEDIUM] api-contract — common/src/util/stable-hash.ts:14 — [LANG] stableHash (FNV-1a) hashes UTF-16 code units, not bytes, so it cannot be reproduced in Rust/Python/Go from a UTF-8 string
- **Risk:** charCodeAt feeds 16-bit code units into an algorithm conventionally defined over bytes, with XOR of values up to 0xFFFF. A Rust sidecar applying FNV-1a to UTF-8 bytes gets different checksums for any non-ASCII text (non-English comments, CJK paths, emoji). Persisted task-memory checksums and git_status fingerprints would then diverge across languages. The pinned vectors are ASCII-only, so they don't catch this.
- **Fix:** Freeze the contract explicitly. Either define it as FNV-1a over UTF-16LE code units and document it, adding non-ASCII and astral golden vectors a Rust port must match, or version-bump to FNV-1a over UTF-8 bytes (TextEncoder) with a migration for persisted checksums. The djb2 quickHash in messages.ts:~437 has the same property but is telemetry-only.
- **Evidence:** `hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619)`; the doc pins only '' and 'a' vectors.

## [MEDIUM] api-contract — common/src/util/content-hash.ts:68 — [LANG] cap.v3 HMAC key is a per-process random secret, so no sidecar or SDK in another language can verify or mint capabilities
- **Risk:** READ_CAPABILITY_SIGNING_KEY = randomBytes(32) lives only in the TS process. A future Rust/Go sidecar that performs edits cannot authenticate cap.v3 tokens without calling back into TS. Frozen-contract consumers can only check the content-hash half, which is byte-reproducible: sha256 over UTF-8 after CRLF to LF. Two related gaps: lone surrogates encode to U+FFFD, so distinct JS strings collide. Lone CR and BOM are not normalized. The design needs an explicit decision before P7.
- **Fix:** Document in the frozen contract that cap.v3 verification is TS-authority only and sidecars must RPC to verify. Alternatively define a key-sharing handshake (a per-session key passed to sidecars over the local transport) plus golden vectors for encode/decode, including scopeFingerprint input normalization.
- **Evidence:** `const READ_CAPABILITY_SIGNING_KEY = randomBytes(32)` with the comment 'cap.v3 is an in-process runtime capability'; `normalizeLineEndings` only replaces /\r\n/g.

## [MEDIUM] correctness — common/src/util/content-hash.ts:70 — [BEST][POLY] Scope fingerprint path is not case- or Unicode-normalized; same file under different spelling fails auth on macOS/Windows
- **Risk:** normalizeScopeComponent only unifies slashes and drops '.' segments. On case-insensitive NTFS/APFS, 'Src/Foo.cs' and 'src/foo.cs' name the same file but get different fingerprints. So do NFC and NFD spellings of non-ASCII paths (macOS returns NFD from readdir). Valid capabilities are rejected, forcing re-read loops. This fails closed, not open. Scope fingerprint inputs are also part of any cross-language cap contract.
- **Fix:** Canonicalize the path component from the resolver's realFullPath-relative form, NFC-normalize it, and on case-insensitive volumes case-fold it. Pin with golden vectors.
- **Evidence:** `withForwardSlashes.split('/').filter((segment) => segment !== '' && segment !== '.').join('/')`, with no .normalize('NFC') and no case folding.

## [MEDIUM] security — common/src/util/project-path-containment.ts:420 — [BEST] Win32 alias refusal covers trailing dot/space only; NTFS ADS and 8.3 short names reach sensitive files
- **Risk:** refusesWin32AliasedSensitivePath strips trailing [ .]+ only. On Windows, '.env::$DATA' and 'credentials.json:$DATA' open the main stream of the sensitive file. 8.3 short names (e.g. CREDEN~1.JSO) and '\\?\' device-namespace spellings also bypass exact basename matching. So owned-temp and external-read roots can still expose the files this guard exists to protect. On POSIX/macOS, whole-/tmp reach additionally exposes other tools' artifacts (e.g. krb5cc_<uid> Kerberos caches, ssh-* agent dirs) unless sensitive-paths lists them. I did not verify the sensitive-paths coverage.
- **Fix:** Refuse any win32 segment containing ':' after the drive letter, and any '~<digit>' short-name segment under temp/external roots. Compare against GetLongPathName/realpath.native output. Extend the mandatory-sensitive list with krb5cc_*, ssh-*/agent.* and similar temp-resident credentials.
- **Evidence:** `segments.map((segment) => segment.replace(/[ .]+$/, ''))` is the only alias normalization; getOwnedTempRoots admits the whole os.tmpdir() and /tmp root.

## [MEDIUM] error-handling — common/src/util/saxy.ts:400 — [BEST] Saxy._final never invokes its callback for unclosed tags, so the stream never finishes
- **Risk:** When input ends inside a tag (waiting tagOpen/tagClose) or with a non-empty tag stack, _final returns without calling callback(). The Transform never emits 'finish' and never errors, so any consumer awaiting the end hangs on truncated model output. Separately, parseEntities uses String.fromCharCode, which truncates code points above U+FFFF (e.g. &#128512; for an emoji) and wraps invalid values instead of rejecting them.
- **Fix:** Always call callback(), either plain or with a soft error, on those branches; emit any leftover raw text first. Use String.fromCodePoint with range validation (0..0x10FFFF, excluding surrogates) and pass invalid entities through.
- **Evidence:** `case Node.tagOpen: case Node.tagClose: // callback(new Error('Unclosed tag')) return` and `if (this._tagStack.length !== 0) { // callback(...) return }`; `parts.push(String.fromCharCode(value))`.

## [MEDIUM] performance — common/src/util/partial-json-delta.ts:28 — [BEST] Comma-backtrack loop can spin forever on a leading comma and is O(n^2) per streamed chunk
- **Risk:** The loop `while ((commaPos = content.lastIndexOf(',', commaPos - 1)) !== -1)` does not terminate when content[0] is ','. lastIndexOf(',', -1) clamps fromIndex to 0 and returns 0 on every iteration, so the input ',' hangs the event loop. In the normal case, each call re-parses the whole prefix once per comma and runs twice per delta (content and previous). That is quadratic in payload size on the streaming hot path.
- **Fix:** Break when commaPos === 0 (or loop while commaPos > 0). Cache the previous parse result instead of re-parsing `previous`. Consider an incremental tokenizer.
- **Evidence:** `let commaPos = content.length; while ((commaPos = content.lastIndexOf(',', commaPos - 1)) !== -1) { try { ... JSON.parse(content.slice(0, commaPos) + '}') } catch {} }`

## [MEDIUM] correctness — common/src/util/job-registry.ts:720 — [BEST] sweep() defaults to Date.now() while timestamps use the injected clock
- **Risk:** completedAt comes from this.clock.now() (P2-T1 deterministic clock), but sweep(now = Date.now()) compares it against the real wall clock. With a fake clock starting near 0, every settled job is swept on the next get/list/assertOwned. With a clock ahead of real time, jobs are never swept. Deterministic replays and tests see phantom 'not_found'.
- **Fix:** Default `now` to this.clock.now().
- **Evidence:** `sweep(now = Date.now()): void { ... now - record.job.completedAt > record.bounds.settledTtlMs`; appendEvent: `const timestamp = this.clock.now()`.

## [MEDIUM] api-contract — common/src/tools/compile-tool-definitions.ts:28 — [LANG] D17 JSON Schema artifacts describe the strict input shape, not the lenient shape the TS runtime accepts
- **Risk:** Tool params run through z.preprocess helpers (coerceToArray, coerceToObject, normalizeTransactionEditList, normalizeSpawnAgentList). With io:'input', z.toJSONSchema emits only the inner schema. A Python/Go client codegen'd from the artifact (P7-T6) will reject or never produce payloads that the TS dispatcher accepts, such as stringified arrays, alias keys and comma-split fragments. Server-side validation in another language would diverge from TS. Separately, parameter descriptions are interpolated into /** */ comments unescaped, so a '*/' in a description breaks the generated .d.ts.
- **Fix:** Publish the artifact as the canonical strict wire contract and state in the artifact that D21 normalization is a TS-side tolerance, or emit x-openbuff-coercions annotations. Add cross-language validation golden vectors. Escape '*/' in descriptions.
- **Evidence:** `artifacts[toolName] = z.toJSONSchema(parameterSchema, { io: 'input' })`; `const comment = prop.description ? `  /** ${prop.description} */\n` : ''`.

## [MEDIUM] api-contract — common/src/tools/params/utils.ts:75 — [BEST] Silent JSON separator repair and array-item re-decoding go against D21 'logged and counted' and change data
- **Risk:** repairMalformedJsonSeparators deletes ',,' and trailing commas without logging, so '[1,,2]' silently becomes '[1,2]' and drops a hole. In normalizeSpawnAgentList, known array keys (paths, directories, filePaths, patterns) get parseJsonBounded applied per item. String items like '2024', 'true' or 'null' (valid directory names in many ecosystems) become number, boolean or null. Schema validation then fails or the value is mis-typed.
- **Fix:** Only unwrap items that are themselves JSON-quoted strings or objects, never primitive-literal strings. Emit a counted repair event per D21 for separator repairs and array unwraps.
- **Evidence:** `paramsRecord[key] = parsedValue.map((item) => parseJsonBounded(item))`; separator repair branch: `if (input[next] === ',' || input[next] === '}' || input[next] === ']') { repaired = true; continue }` with no log. SPEC D21: 'logged and counted (never silently)'.

## [MEDIUM] api-contract — common/src/types/session-state.ts:380 — [LANG] AgentState/SessionState is a TS-only type with no schema artifact for sidecar or SDK codegen
- **Risk:** Persisted session state is consumed across processes, but AgentState is a plain TS type. It uses TS-only constructs: (string & {}) for AgentTemplateType, `inputSchema: {}`, `Record<string, any>` and unknown. Only a few fragments have zod schemas. Rust/Python consumers must hand-mirror it, which is the drift class D17 exists to prevent. Also, the restore sanitizer accepts uppercase hex (SHA256_CONTENT_HASH_PATTERN has the /i flag), while content-hash.ts mints and requires lowercase (/^sha256:([a-f0-9]{64})$/). A restored uppercase hash then fails at remint or compare time instead of at the restore boundary.
- **Fix:** Define a zod schema for the persisted AgentState subset (or a versioned SessionStateV1 wire schema), publish its JSON Schema with golden vectors next to the tool artifacts, and drop /i from the hash pattern.
- **Evidence:** `const SHA256_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i`; `export type AgentState = { ... }` with no schema; `| (string & {})`.

## [LOW] state-mutation — common/src/mcp/client.ts:620 — [BEST] MCP client registry races and never evicts; cache-key ordering uses locale-dependent sort
- **Risk:** Concurrent getMCPClient calls for the same key both connect, and the second overwrites runningClients[key], leaking a live stdio child or socket. Clients that crash or close are never removed, and listToolsCache is never invalidated. hashRecordValues sorts with localeCompare, so the identity depends on the ICU locale and is not reproducible in another language. The local function name stableHash (sha256 over JSON) shadows the unrelated util/stable-hash FNV contract.
- **Fix:** Memoize the in-flight connect promise per key and remove entries on transport close or error. Sort keys by code unit (a < b) and rename the local helper.
- **Evidence:** `if (key in runningClients) return key ... await client.connect(transport); runningClients[key] = client`; `.sort(([a], [b]) => a.localeCompare(b))`.

## [LOW] correctness — common/src/util/string.ts:34 — [BEST] Truncation helpers split surrogate pairs; MIDDLE mode can return the full string when maxLength is small
- **Risk:** truncateString and truncateStringWithMessage slice by UTF-16 unit, which can leave lone surrogates that serialize to U+FFFD or invalid UTF-8 in provider payloads. In MIDDLE mode, when maxLength < marker length, `length` is <= 0 and `str.slice(-0)` returns the whole string, so the output is longer than the input. isWhitespace uses /\s/, which includes Unicode spaces (e.g. U+00A0), contrary to its XML-spec docstring. transformJsonInString interpolates `field` into a RegExp unescaped.
- **Fix:** Back off one unit when the cut lands between a high and low surrogate. Clamp `length` to at least 0 and return the marker alone when there is no room. Use /[ \t\r\n]/ for XML whitespace. Escape `field`.
- **Evidence:** `const length = Math.floor((maxLength - middle.length) / 2); return str.slice(0, length) + middle + str.slice(-length)`; `export const isWhitespace = (character: string) => /\s/.test(character)`.

## [LOW] security — common/src/util/messages.ts:690 — [BEST] Schema-validation failure logs the whole aggregated history unredacted
- **Risk:** validateModelMessages logs `{ message, aggregated: messages }` at error level. That includes file contents and tool outputs that can carry secrets. The thrown message is redacted downstream via error.ts, but I did not verify that the logger payload is.
- **Fix:** Log indices, roles and sizes only, or pass the payload through redactSecretValues before logging.
- **Evidence:** `logger.error({ message, aggregated: messages, error: result.error }, ...)`.

## [LOW] dependency-hygiene — common/src/env-schema.ts:26 — [BEST] Local-first defaults ship a PostHog host pointing at app.posthog.com
- **Risk:** The default NEXT_PUBLIC_POSTHOG_HOST_URL is https://app.posthog.com, with a placeholder key. Any analytics client initialized from these defaults would make outbound calls from a local-first harness. I did not verify whether a client is initialized at runtime.
- **Fix:** Default the host to empty or undefined and treat telemetry as opt-in when unconfigured.
- **Evidence:** `NEXT_PUBLIC_POSTHOG_API_KEY: 'openbuff-local', NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://app.posthog.com'`.

## Coverage receipt

### Subsystems
- common

### Features
- mcp-client
- secret-redaction
- xml-sax-parsing
- message-conversion
- partial-json-delta
- path-containment
- hashing
- cap-v3
- string-utils
- context-budget
- job-registry
- tool-contracts
- param-normalization
- session-state
- env-schema

### Files
- common/src/mcp/client.ts
- common/src/util/redact-secrets.ts
- common/src/util/xml-parser.ts
- common/src/util/saxy.ts
- common/src/util/messages.ts
- common/src/util/partial-json-delta.ts
- common/src/util/project-path-containment.ts
- common/src/util/content-hash.ts
- common/src/util/stable-hash.ts
- common/src/util/string.ts
- common/src/util/context-budget.ts
- common/src/util/job-registry.ts
- common/src/tools/compile-tool-definitions.ts
- common/src/tools/params/utils.ts
- common/src/types/session-state.ts
- common/src/env-schema.ts
- .agents/sessions/polyglot-roadmap-v2/SPEC.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
