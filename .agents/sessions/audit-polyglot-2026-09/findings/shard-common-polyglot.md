# Audit findings: shard-common-polyglot

- Subsystems: common
- Features: streaming-xml-sax-parser, xml-toolcall-parsing, xml-stop-sequences, cap-v3-content-hash-and-read-capabilities, secret-redaction-corpus, partial-json-delta-streaming, min-heap-utility, knowledge-router-table, fnv-stable-hash, language-capability-registry, language-profile-detection, zod-json-schema-export, mcp-client-transport, tool-definition-type-codegen
- Files covered: 14
- Snapshot: 4fc76b0bd48a0b11d651b8f4647bb302dc95344c8b5749411ed1f5fcc3e7a0ba

## [MEDIUM] test-coverage — common/src/util/saxy.ts:307 — saxy.ts is production-orphaned — only its own test imports it; native rewrite unjustified until it has a consumer
- **Risk:** The audit premise that saxy.ts is 'streaming XML parsing shared across surfaces' is false: repo-wide search shows the only importer of Saxy/parseAttrs is its own test (common/src/util/__tests__/saxy.test.ts:3). No package under packages/, sdk/, agents/ consumes it. Any roadmap task that justifies a Rust SAX kernel on throughput grounds would be optimizing dead code. It also carries a latent quadratic behavior if revived: this._textBuffer += chunk (saxy.ts:583,600) repeatedly concatenates for streams with no tag boundary, so an N-chunk tagless stream is O(N^2) in copied bytes.
- **Fix:** Do NOT port to Rust (SPEC principle 1: capabilities, not duplicate implementations; a native SAX core with no consumer is pure cost). Either (a) delete with its test, or (b) wire it back into the XML tool-call stream path if the XML protocol still needs entity-aware tag streaming. If revived and profiling justifies it, a Rust SAX core (SIMD scanning of '<', '&', quote delimiters) with frozen SaxyEvents ABI is the fallback — but that decision is blocked on a live consumer existing.
- **Evidence:** class Saxy extends Transform (saxy.ts:307); only importer found in repo-wide search: common/src/util/__tests__/saxy.test.ts line 3 (import { Saxy } from '../saxy'); no other match under packages/, sdk/, agents/, common/ outside eval fixture JSON.

## [MEDIUM] test-coverage — common/src/util/partial-json-delta.ts:37 — partial-json-delta.ts: orphaned utility AND re-parses whole content per delta — O(n^2) on streamed JSON tool args
- **Risk:** Two problems. (1) Orphaned: repo-wide search finds getPartialJsonDelta/parsePartialJsonObjectSingle imported only by common/src/util/__tests__/partial-json-delta.test.ts — no production consumer, so a 'stream JSON parsing' language-work item has no target. (2) If revived, parsePartialJsonObjectSingle is accidentally quadratic on partial streams: on every chunk it attempts JSON.parse on the whole content (and on content+'}', content+'"}', then every comma-truncated prefix via lastIndexOf(',', ...) loop). For a tool-call arg built across K chunks of size n, cost is O(n^2) total JSON.parse attempts, and getPartialJsonDelta parses BOTH content and previous on every delta, doubling it. JSON.parse failure cost grows with input size, so long streaming tool calls degrade superlinearly.
- **Fix:** Delete or wire up. If the streaming tool-call path needs it again, the correct TS fix is incremental stateful parsing (single-pass scanner that resumes from the previous parse position, e.g. the approach used by partial-json/streaming-json parsers) — not a native port; Bun's JS JSON parse is already native and fast, the cost here is algorithmic (re-parse) not language.
- **Evidence:** while ((commaPos = content.lastIndexOf(',', commaPos - 1)) !== -1) { try { return { ..., params: JSON.parse(content.slice(0, commaPos) + '}') } } catch {} } (partial-json-delta.ts:37-45); getPartialJsonDelta calls parsePartialJsonObjectSingle(content) then parsePartialJsonObjectSingle(previous) (lines 54-58); repo search: sole non-test reference is the eval fixture JSON, no source import.

## [LOW] test-coverage — common/src/util/min-heap.ts:4 — min-heap.ts is dead code in production — no consumers outside its test; TS-is-right (delete or keep, no native work)
- **Risk:** MinHeap is imported only by common/src/util/__tests__/min-heap.test.ts. It is a clean, correct O(log n) binary heap, but with zero production callers there is no hot path and therefore no language-choice question. Flagged explicitly so the parent does not score 'min-heap native kernel' as an opportunity.
- **Fix:** TS-is-right / delete-or-wire. If the bandit router (SPEC R-E 'learned router and bandit') lands and needs a bounded priority queue, reuse this tested implementation; only consider a native heap if profiling shows GC pressure from millions of entries, which is unlikely at the scales here.
- **Evidence:** export class MinHeap<T> { private heap: { item: T; score: number }[] = [] } (min-heap.ts:4-5); search for MinHeap|min-heap across packages/, sdk/, agents/, common/ matches only min-heap.ts and min-heap.test.ts.

## [MEDIUM] security — common/src/util/redact-secrets.ts:15 — redact-secrets.ts corpus is 5 token shapes + 1 keyword regex — gitleaks Go plan is correct for coverage but hot-path inline redaction stays TS
- **Risk:** The entire corpus is 5 token regexes (sk- OpenAI, ghp_/gho_/ghu_/ghs_/ghr_ GitHub, AKIA AWS, Bearer header), one SENSITIVE_KEYWORD assignment regex, and one URL userinfo regex. It misses JWTs (eyJ...), Google/Slack/Stripe/anthropic keys, generic high-entropy assignments for keys not matching the keyword list, and multi-line JSON/YAML secret blocks. It IS on a hot path (run-agent-step.ts redacts every message part and system prompt before it reaches context/logs), so correctness of the corpus matters more than speed. The SPEC P5-T5 plan (Go gitleaks, ~200 rules + entropy + allowlists) is the right answer for CORPUS coverage and live verification — but it does not obviate this TS file: gitleaks is a sidecar/CLI, while stream-time per-message redaction must stay in-process to avoid serializing every LLM chunk over IPC.
- **Fix:** Two-sided: (1) keep redactSecretValues in TS on the per-message hot path (JS regex on 50KB strings is adequate; SPEC reaudit already concluded 'rules portable; corpus maintenance is the Go value'); (2) make the Go gitleaks sidecar (P5-T5) the rule authority and EXPORT the corpus as language-neutral data — generate the TS regex table from the gitleaks TOML ruleset in the three-mirror codegen step, so TS and Go scanners stay in sync by construction. Do not hand-sync two corpora. This preserves the frozen contract: redacted output shape '[REDACTED]' and the pass-through-unchanged guarantee.
- **Evidence:** TOKEN_SHAPES = [[/(sk-[A-Za-z0-9_-]{16,})/g,...],[/(ghp_[A-Za-z0-9]{20,})/g,...],[/(gh[o rus]_...)/g,...],[/(AKIA[0-9A-Z]{16})/g,...],[/(Bearer\s+...)/g,'Bearer [REDACTED]']] (redact-secrets.ts:15-21); SENSITIVE_KEYWORD regex (line 12); URL_CREDENTIALS (line 28); called per-message in packages/agent-runtime/src/run-agent-step.ts:160,167,808,811,2968.

## [HIGH] api-contract — common/src/util/content-hash.ts:95 — content-hash.ts cap.v3: process-random HMAC key makes the contract irreducibly TS-in-process; grammar is the frozen cross-language ABI
- **Risk:** cap.v3 tokens are HMAC-signed with a per-process random key (module-scope randomBytes(32)); decode verifies with timingSafeEqual. Consequences for the polyglot roadmap: (1) no sidecar or native module can mint or verify cap.v3 tokens without receiving the key over IPC — the capability is inherently in-process, so any 'native edit kernel' design must keep token issuance/verification in the TS core or add a key-sharing ABI; (2) the token grammar cap.v3.<start>.<end>.<base64url-sha256>.<base64url-scope>.<base64url-hmac> plus CRLF→LF normalization (normalizeLineEndings) is consumed by ~20 modules across packages/agent-runtime and sdk (read_files, replace_range, str_replace, write-file, edit-transaction, rewrite_symbol, sdk mutation-capabilities) and is already listed as frozen in SPEC locked-decision 5 — correctly so.
- **Fix:** Keep encode/decode entirely in TS (SPEC R-B 'native parse tier' and any Rust daemon must NOT take this over; the one sanctioned cross-process case is the SPEC's future Rust file-watcher/index daemon verifying snapshots, which requires transmitting the per-process key over a private channel and a constant-time compare — document as a v4 concern, not a migration). No native opportunity; flagged as a migration constraint. Publish the token grammar + golden vectors as a frozen spec before any sidecar touches it.
- **Evidence:** const READ_CAPABILITY_SIGNING_KEY = randomBytes(32) (content-hash.ts:95, module scope); signature = createHmac('sha256', key).update(signedPayload)... timingSafeEqual (encode ~line 175, decode ~line 200); token grammar validated by /^cap\.v3\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{43})...$/ in decodeReadCapabilityToken.

## [MEDIUM] api-contract — common/src/util/language-capabilities.ts:11 — language-capabilities.ts registry is the native-tier capability manifest — TS is right for the data, but its toolSpecs/parser fields are the contract a Rust parse tier must honor
- **Risk:** The registry is the answer to 'what does the language registry enable for a native tier': it already declares, per language, the tree-sitter grammar names (tools.parser), the LSP launch specs (toolSpecs with argv/transport/detect/rootMarkers), and validation stages (focused/project). It is pure static data — TS is unambiguously the right language for it — but it is currently inert: the parser names are strings nobody loads, and toolSpecs exist for an LSP tier the runtime does not yet host. It is exactly the manifest a Rust tree-sitter + LSP sidecar (SPEC R-C: tree-sitter preflight, LSP multiplexer) should consume, so the roadmap should treat it as the capability advertisement format rather than rewriting it in Rust.
- **Fix:** Keep the registry in TS as the language-neutral descriptor source; the SPEC's Rust tree-sitter/LSP tier (R-C) should CONSUME this registry (e.g. serialize it once at startup over the sidecar handshake) rather than reimplementing it. If the native tier needs machine-readable export, emit it via the same z.toJSONSchema pipeline as tool schemas. Freeze SupportedLanguageId, LanguageToolRole, LanguageValidationStage as a versioned contract (golden vector test on the serialized registry).
- **Evidence:** export type LanguageToolSpec = { role: LanguageToolRole; argv: readonly string[]; transport?; detect?; rootMarkers?; minVersion? } (language-capabilities.ts:59-66); toolSpecs argv ['typescript-language-server','--stdio'] (line ~100), ['pyright-langserver','--stdio'], ['rust-analyzer'], ['gopls'], ['clangd'], GDScript transport 'tcp' port 6005.

## [LOW] performance — common/src/util/language-profiles.ts:239 — language-profiles.ts per-language signal regexes re-run over task text each call — TS fix (single combined scan) beats a native port
- **Risk:** detectLanguageProfilesFromTask tests each of 12 languages' alias/manifest/extension regex arrays over the full task text every call. Regexes are precompiled at module load (good), but execution is O(languages x signals x textLen) and the patterns are mostly literal substrings run through the regex engine. This is prompt-construction-time (once per step, not per chunk), so measured cost is likely sub-ms — a native port would buy nothing user-visible today. The TS-only improvement is data-shape, not language: literal alias strings could be tested with a single lowercase substring scan instead of regex.
- **Fix:** TS-only micro-fix first: combine each language's alias patterns into one compiled alternation regex and short-circuit on an Aho-Corasick-style prefilter (or a single combined alternation over all aliases to find candidate languages before per-language tests). No native work justified at 12 languages; revisit only if the registry grows 3-5x and profiling shows it hot.
- **Evidence:** const LANGUAGE_SIGNAL_REGEXPS = new Map(SUPPORTED_LANGUAGE_IDS.map(...aliases: capability.taskAliases.map(taskAliasRegexp), ...)) (language-profiles.ts:239-257); signals.aliases.some((pattern) => pattern.test(taskText)) in detectLanguageProfilesFromTask (lines ~267-288); buildLanguageLookups precomputes extension maps.

## [MEDIUM] api-contract — common/src/tools/compile-tool-definitions.ts:27 — zod-schema.ts + compile-tool-definitions.ts: JSON Schema (z.toJSONSchema io:'input') is the language-neutral contract — pin it as the frozen artifact; hand-rolled TS mapper degrades to any
- **Risk:** compileToolDefinitions runs at build time only (scripts/generate-tool-definitions.ts) so there is no runtime perf question — TS is right. But the pipeline defines the de facto cross-language ABI: z.toJSONSchema(schema, { io: 'input' }) output is converted to TS by a hand-rolled jsonSchemaToTypeScript/getTypeFromJsonSchema mapper that silently degrades unhandled shapes to 'any' (tuple types, string patterns/formats, prefixItems, anyOf nested inside object properties without sibling properties, $ref). schemaToJsonStr (zod-schema.ts) also deletes $schema and stringifies — used in agent prompts. The JSON Schema itself is the language-neutral contract the SPEC already commits to (locked decision 5 'tool schemas (three-mirror codegen)', R-F 'JSON Schema tool descriptors'); the TS-specific mapper is a consumer, not the contract.
- **Fix:** Keep codegen in TS. Improvement: (1) make z.toJSONSchema output the primary published artifact — write the JSON Schema per tool alongside the TS interfaces so Rust/Go/Python bindings can consume it (SPEC R-F 'JSON Schema tool descriptors', R-A 'Generated Python/Go SDKs'); (2) pin golden-vector tests on the JSON Schema output so the intermediate cannot drift silently; (3) fix the mapper's `any` fallback to throw in CI (or emit `unknown`) so schema regressions surface at build time. No native opportunity.
- **Evidence:** const jsonSchema = z.toJSONSchema(schema, options); delete jsonSchema['$schema']; return JSON.stringify(jsonSchema, null, 2) (zod-schema.ts:10-20); jsonSchema = z.toJSONSchema(parameterSchema, { io: 'input' }) (compile-tool-definitions.ts:27); getTypeFromJsonSchema fallback 'return \'any\'' (line ~163).

## [MEDIUM] error-handling — common/src/mcp/client.ts:17 — mcp/client.ts transport robustness: clients never closed, tool cache never invalidated, no timeouts/retry, isError dropped — all TS-only fixes, no language work
- **Risk:** Transport lifecycle gaps that no language choice fixes but a robustness pass must: (1) runningClients is append-only — clients are never disconnected; every getMCPClient spawns a stdio child process or HTTP/SSE connection that lives forever, leaking child processes on long sessions and after config changes; (2) listToolsCache is never invalidated — tools added/removed on the server after first list are invisible for the process lifetime; (3) client.connect and callTool have no timeout or retry — a hung stdio server stalls the agent step indefinitely; (4) callMCPTool maps result.content but ignores result.isError, so MCP tool errors are returned to the model as ordinary text output with no error signal; (5) env substitution origin guard (client-origin configs used literally) is correct and must be preserved in any rewrite.
- **Fix:** TS-only fixes: (1) add idle-TTL eviction + client.close() on shutdown (onClose hook in sdk/src/run.ts); (2) invalidate listToolsCache on server notifications/tools/list_changed and on call failures; (3) wrap connect/callTool with a timeout + one reconnect attempt, surfacing the tier per SPEC principle 6; (4) propagate result.isError into the ToolResultOutput contract so the agent sees tool errors instead of success-shaped text. No language change — the TS MCP SDK (@modelcontextprotocol/sdk) is the ecosystem-canonical client; a Rust MCP client would duplicate it against SPEC principle 2.
- **Evidence:** runningClients: Record<string, Client> = {} (client.ts:17) written at line 217 (runningClients[key] = client) with no disconnect path; listToolsCache assigned once at line 230 and never cleared; callMCPTool does `const callResult = await client.callTool(...args)` then maps callResult.content without reading callResult.isError (client.ts:242-291).

## [LOW] correctness — common/src/mcp/client.ts:121 — stable-hash.ts FNV-1a is fine in TS, but mcp/client.ts defines a second, semantically different stableHash (sha256-of-JSON) — naming hazard for the frozen algorithm
- **Risk:** Two different functions named stableHash coexist: the canonical FNV-1a util (stable-hash.ts, output byte-compat pinned by golden vectors, header says 'Do not fork this algorithm') and mcp/client.ts's local sha256(JSON.stringify(value)) used only for cache keys. The name collision invites accidental import of the wrong one (they are not interchangeable: FNV-1a is 32-bit and order-sensitive to string form; sha256-of-JSON.stringify is key-order dependent for objects). Also JSON.stringify-based hashing is not stable across key insertion order, which the cache key only avoids because hashRecordValues sorts explicitly.
- **Fix:** TS-only: rename the MCP helper (e.g. hashStableJson) or re-export a shared canonical stable-hash module per surface; add a lint rule or comment cross-referencing stable-hash.ts's do-not-fork warning. Keep FNV-1a in TS — Bun/JIT runs a 1-char-per-iteration loop at memory speed for the small inputs it hashes; a napi call would cost more than the loop.
- **Evidence:** function stableHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') } (mcp/client.ts:121-123); export function stableHash(text: string) FNV-1a loop with pinned vectors '811c9dc5'/'e40c292c' (stable-hash.ts:12-22).

## [LOW] performance — common/src/util/xml-parser.ts:8 — xml-parser.ts + xml.ts: trivial regex/string helpers — explicitly TS-is-right, no native unlock
- **Risk:** parseToolCallXml is a 20-line single-regex scanner over already-complete tool-call payloads (typically <1-10KB, measured ~0.5-1ms in eval fixtures). Worst-case lazy-backtracking on malformed input is bounded by input size and does not matter at these lengths. xml.ts is two template-literal string builders. No native port can unlock anything: the outputs are plain JS objects consumed in-process, and round-tripping strings over napi would cost more than the parse.
- **Fix:** TS-is-right. Optional hardening only: replace the regex with a single-pass indexOf('<') scanner (linear, ~15 lines) if adversarial input is a concern; keep the exact Record<string,string> contract. No native or other-language work is justified; do not schedule a Rust XML kernel for these files.
- **Evidence:** const tagPattern = /<(\w+)([\s\S]*?)<\/\1>/g while ((match = tagPattern.exec(xmlString)) !== null) (xml-parser.ts:8-14); export function closeXml(toolName: string): string { return `</${toolName}>` } (xml.ts:10-13).

## [LOW] performance — common/src/util/router.ts:87 — router.ts: cold-path synchronous fs + line parser — explicitly TS-is-right
- **Risk:** ROUTER.md is a small markdown table parsed with line splitting; loadRouterTable does fs.existsSync + fs.readFileSync once per consumer call (packages/agent-runtime/src/templates/strings.ts). This is cold-path prompt assembly: even a 10KB file read is negligible next to an LLM call. Nothing here is compute-bound; the knowledge CONTENT loading dominates. No language opportunity; also no codegen opportunity (the format is a user-facing markdown contract, not a schema).
- **Fix:** TS-is-right. Optional TS hardening: memoize loadRouterTable per projectRoot+mtime, and consider caching parsed ROUTER.md across steps in the agent runtime. No codegen or native work.
- **Evidence:** if (!projectRoot || typeof projectRoot !== 'string') return {}; const routerPath = path.join(projectRoot, ROUTER_FILENAME); if (!fs.existsSync(routerPath)) return {} (router.ts:87-89); routeKey = agentId ? [`${agentId}:${taskType ?? 'general'}`, agentId].find(...) : undefined (resolveRoutedKnowledgeFiles).

## [LOW] dependency-hygiene — common/src/util/zod-schema.ts:9 — zod-schema.ts schemaToJsonStr: conversion is uncached and swallows all errors to 'None' — TS-only memoization fix
- **Risk:** schemaToJsonStr calls z.toJSONSchema on every invocation with no memoization; it is called from packages/agent-runtime/src/templates/prompts.ts when rendering agent prompts with tool schemas. Repeated renders of the same schema re-run full JSON Schema conversion each time. Additionally, the catch(error) returns 'None' for ANY failure, including a schema zod cannot convert — silently replacing a tool's parameter documentation with the literal string 'None' in prompts, which can mask schema bugs.
- **Fix:** TS-only: cache z.toJSONSchema output keyed by schema identity (WeakMap) for repeated prompt renders; distinguish unconvertible schemas (log once) from plain-object input so 'None' is not a silent swallow. Keep in TS; zod is TS-native and there is no alternative-language schema engine worth a sidecar here.
- **Evidence:** if (schema instanceof z.ZodType) { const jsonSchema = z.toJSONSchema(schema, options) ... } catch (error) { return 'None' } (zod-schema.ts:9-25); import z from 'zod/v4' (line 1).

## Coverage receipt

### Subsystems
- common

### Features
- streaming-xml-sax-parser
- xml-toolcall-parsing
- xml-stop-sequences
- cap-v3-content-hash-and-read-capabilities
- secret-redaction-corpus
- partial-json-delta-streaming
- min-heap-utility
- knowledge-router-table
- fnv-stable-hash
- language-capability-registry
- language-profile-detection
- zod-json-schema-export
- mcp-client-transport
- tool-definition-type-codegen

### Files
- common/src/util/xml-parser.ts
- common/src/util/xml.ts
- common/src/util/saxy.ts
- common/src/util/content-hash.ts
- common/src/util/redact-secrets.ts
- common/src/util/partial-json-delta.ts
- common/src/util/min-heap.ts
- common/src/util/router.ts
- common/src/util/stable-hash.ts
- common/src/util/language-capabilities.ts
- common/src/util/language-profiles.ts
- common/src/util/zod-schema.ts
- common/src/mcp/client.ts
- common/src/tools/compile-tool-definitions.ts

### Domains
- performance
- api-contract
- security
- correctness
- error-handling
- test-coverage
- dependency-hygiene
