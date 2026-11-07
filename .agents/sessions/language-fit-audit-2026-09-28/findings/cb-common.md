# Audit findings: cb-common

- Subsystems: common
- Features: language-capability-registry, language-capability-manifest, language-profile-detection, secret-redaction, sensitive-path-policy, content-hash-and-read-capability, stable-hash-fnv1a, project-path-containment, mcp-ssrf-address-guard, mcp-client-and-env-substitution, tool-schema-compilation, tool-param-registry, tool-arg-repair, edit-blocks-parser, xml-streaming-parser, partial-json-delta, string-utils, patterns-and-router-knowledge, job-registry, memory-scoring-contradiction, context-budget-ledger, agent-handoff-session-contracts, harness-control-plane-types, dynamic-agent-template-validation, env-schema, project-file-tree-gitignore, common-package-deps
- Files covered: 31
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] api-contract — common/src/util/language-capabilities.ts:104 — Language capability registry: CODEGEN (data file -> JSON Schema -> TS/Rust/Python)
- **Risk:** LANGUAGE_CAPABILITY_REGISTRY is a 480-line TS const literal (lines 104-576) holding extensions, manifests, LSP argv/transport/rootMarkers, validation stages. A Rust LSP/validation sidecar or Python client can't read it without running Bun or copying the table, so the tables will drift. It also overlaps heavily with Helix languages.toml (language-servers, roots, file-types) and GitHub linguist languages.yml (extensions/filenames).
- **Fix:** Move the registry into a data file, e.g. common/data/languages.toml or .json. Treat the V1 manifest schema as the source of truth, emitted to JSON Schema via z.toJSONSchema and committed. Generate Rust (typify or serde structs with include_str!) and Python (datamodel-code-generator) bindings. Seed extensions and filenames from linguist languages.yml and LSP roots/argv from Helix languages.toml through a pinned import script. Keep the idiom and guidance prose hand-authored. Unlocks: one table shared by the TS runtime and a Rust LSP-launcher/validator shim, and language additions without TS edits. Next: plugin languages supplied as data.
- **Evidence:** language-capabilities.ts:1-14 (ids), 39-47 (LanguageToolSpec), 104-576 (registry); manifest already JSON round-trips (language-capability-manifest.ts:95-105). Cost: M (2-4d: schema export, codegen, linguist/Helix import script, golden test). Confidence: high on the need. Needs web verification: Helix languages.toml license (MPL-2.0) and linguist languages.yml license (MIT), and whether their fields map cleanly (Helix 'roots', 'language-servers').

## [MEDIUM] api-contract — common/src/util/language-capability-manifest.ts:83 — Language capability manifest schema: CODEGEN (publish JSON Schema artifact)
- **Risk:** The versioned V1 schema is Zod-only. Non-TS consumers can't validate it, and the version constant (line 16) isn't carried in any cross-language artifact.
- **Fix:** Emit z.toJSONSchema(languageCapabilityManifestV1Schema) to schemas/language-capability-manifest.v1.json in CI. Add a drift check plus a golden fixture that Rust/Python tests also load. This is the pilot for the general 'Zod -> JSON Schema -> codegen' pipeline.
- **Evidence:** language-capability-manifest.ts:16, 83-86, 95-105. Cost: S (<1d). Confidence: high.

## [LOW] correctness — common/src/util/language-profiles.ts:138 — Language profile detection: KEEP (derive tables from generated registry)
- **Risk:** Prompt-side detection (task-alias regex, path signals) runs cheap, in-process, TS-only logic. getLanguageFamily keeps a second, parallel extension table (lines 112-123) that is deliberately separate from the registry. That duplication will drift once a Rust indexer needs the same family map.
- **Fix:** Keep this in TS. Move the family sets into the same languages data file as a 'family' field so the Rust indexer and code-map share them. Consider linguist heuristics only if ambiguity (.h, .m) becomes a problem.
- **Evidence:** language-profiles.ts:112-164, 166-188, 239-257. Cost: S. Confidence: medium-high.

## [HIGH] security — common/src/util/redact-secrets.ts:15 — Secret redaction rules: CONSUME + CODEGEN (gitleaks rule set shared TS+Rust)
- **Risk:** There are only 5 token shapes (sk-, ghp_, gh[ours]_, AKIA, Bearer) plus a keyword heuristic. Missing: Slack xox*, Stripe sk_live/rk_live, Google AIza, JWTs, private-key PEM blocks, Anthropic sk-ant (partly covered by sk-), GitLab glpat-, npm_, and others. The class at line 18, [o rus], includes a literal space. Any future Rust sidecar (terminal/log streaming) would need its own copy of the rules.
- **Fix:** Consume gitleaks' config/gitleaks.toml (regex + keywords + entropy) as a vendored, pinned data file. Generate a JSON rule table that both the TS redactor and a Rust redactor load, and add keyword prefiltering (Aho-Corasick) before running each regex. In Rust, use the regex crate plus aho-corasick, which is linear-time and has no ReDoS risk. In TS, keep JS RegExp or use re2-wasm for untrusted patterns. Keep the local 'lines without matches pass through unchanged' contract as a shared golden test corpus. Unlocks: identical redaction in the TS prompt path and the Rust PTY/log path, plus ~200 provider rules at no maintenance cost. Next: entropy scoring.
- **Evidence:** redact-secrets.ts:11-21 (SENSITIVE_KEYWORD, TOKEN_SHAPES), 27 (URL creds), 33-48, 63-68. Callers: agent-runtime run-agent-step.ts, system-prompt/prompts.ts, common/util/error.ts. Cost: M (2-3d including an RE2/JS regex-dialect compatibility pass; gitleaks uses Go RE2 syntax, which is mostly JS-compatible apart from some inline flags). Confidence: high. Needs web verification: gitleaks license (MIT), current rule count, and whether any rules use RE2-only syntax.

## [HIGH] security — common/src/util/sensitive-paths.ts:3 — Sensitive-path policy table: CODEGEN (policy data shared with Rust shim)
- **Risk:** isMandatorySensitiveReadPath is the single refusal predicate used by read-subtree, the terminal-command policy, the indexer file-walker, the router, path containment and CLI attachments. If a Rust file-walker or exec shim reimplements it, the security policy forks. The rules are pure data (extension set, basename set, env-template suffixes, parent-dir pairs) plus a few regexes.
- **Fix:** Extract to common/data/sensitive-paths.json: extensions, basenames, suffixes, the id_* regex, {parent, basename} pairs, and 'any-ancestor' rules such as gh/hosts.yml. Keep a small evaluator in TS and in Rust (the globset crate if rules move to globs), and pin both with a shared golden vector file generated from the existing sensitive-paths.test.ts cases. Optionally cross-check against gitleaks' path allowlist and trufflehog's file-type lists. Unlocks: a Rust indexer/walker and sandbox shim enforcing byte-identical policy.
- **Evidence:** sensitive-paths.ts:3-49 (tables), 51-61 (toPortablePath), 108-138 (dir-aware), 141-167 (predicate). referencedBy: 7 callers across 4 packages. Cost: S-M (1-2d). Confidence: high.

## [MEDIUM] api-contract — common/src/util/content-hash.ts:119 — Content hash + cap.v3 read capability: HYBRID (spec the token format; key stays in-process)
- **Risk:** The cap.v3 wire format is `cap.v3.<start>.<end>.<b64url sha256>.<b64url scopeFp>.<b64url hmac>`, with the scope fingerprint sha256(projectId\0path\0runId). It is documented only in TS comments. The HMAC key is randomBytes(32) per process (line 69), so a Rust edit applier or sidecar could never verify tokens unless it shares the key or delegates verification. The CRLF normalization rule is also a cross-language contract.
- **Fix:** Write a short language-neutral spec with test vectors (fixed key) for normalizeLineEndings, getContentHash, the scope fingerprint and token encoding. Put verification behind one owner (the TS runtime) via IPC, or pass the key to a trusted sidecar over an inherited fd. Don't write the key to disk. Rust crates: sha2, hmac, subtle, base64 (URL_SAFE_NO_PAD). Unlocks: a Rust mutation shim that can authorize edits against the same capabilities.
- **Evidence:** content-hash.ts:12-29 (hash), 64-69 (prefix/key), 94-103 (fingerprint), 119-147 (encode), 154-205 (decode). 25+ call sites in agent-runtime and sdk. Cost: S for spec+vectors, M if a Rust verifier is built. Confidence: high.

## [LOW] correctness — common/src/util/stable-hash.ts:14 — FNV-1a stableHash: KEEP (pin vectors cross-language)
- **Risk:** It hashes UTF-16 code units via charCodeAt, not UTF-8 bytes. A naive Rust port (fnv crate over bytes) would give different digests for non-ASCII input, which breaks persisted task-memory checksums. mcp/client.ts:530 and types/workspace-state.ts also define their own stableHash functions.
- **Fix:** Keep it in TS. If ported, document the 'UTF-16 code units' semantics and pin non-ASCII vectors (e.g. 'é', emoji) in a shared vector file. Dedupe the other local stableHash definitions.
- **Evidence:** stable-hash.ts:14-21; duplicates in mcp/client.ts:530, types/workspace-state.ts (outline). Cost: XS. Confidence: high.

## [MEDIUM] security — common/src/util/project-path-containment.ts:55 — Project path containment: HYBRID (keep TS; spec + vectors for Rust shim; consider cap-std)
- **Risk:** This 1217-line module (escapesRoot, raw '..' refusal, win32 trailing-dot/space alias refusal, realpath-nearest-ancestor, owned-temp and external-read roots) is the core sandbox boundary. The containment checks are TOCTOU by construction: lexical plus realpath at check time, then a later open. A Rust sidecar that performs the file ops is the right place for race-free containment.
- **Fix:** Keep the TS policy for the prompt and tool layer. For a Rust exec or file shim, use cap-std/cap-fs-ext (openat-based, rejects escapes at open time) or openat2 RESOLVE_BENEATH on Linux, so the check and the open are the same syscall. Export the win32 alias and '..' rules plus test vectors as data so both layers agree on refusals.
- **Evidence:** project-path-containment.ts:55-63, 81-83, 120-137, 159-163, 172-194, 1051-1135. Cost: L if moved to Rust (3-5d plus Windows testing); S for vectors. Confidence: medium. Needs web verification: cap-std Windows semantics for trailing-dot aliases.

## [MEDIUM] security — common/src/mcp/client.ts:404 — MCP SSRF address guard: CONSUME (ipaddr.js in TS / std::net + ipnet in Rust)
- **Risk:** The IPv4 shorthand/octal/hex canonicalization and CIDR checks are hand-rolled. The IPv6 check only looks at the first hextet plus ::ffff:dotted, so it misses ::ffff:7f00:1 (hex-mapped), NAT64 64:ff9b::/96, 6to4 2002::/16 embedding private v4, IPv4-compatible ::a.b.c.d, and site-local fec0::/10. The code notes it duplicates agent-runtime web-search-utils, which means two forked copies of a security policy. There is no DNS-resolution check (documented).
- **Fix:** In TS, use ipaddr.js (parse + range() with 'private', 'loopback', 'linkLocal', 'uniqueLocal', 'reserved', 'ipv4Mapped' and toIPv4Address()), or node:net BlockList over a shared CIDR table. Move the blocked CIDR list to a shared data file (common/data/blocked-networks.json) consumed by both TS copies and any Rust proxy (std::net::IpAddr + ipnet, with Ipv6Addr::to_ipv4_mapped). Check after DNS resolution at connect time: a custom undici dispatcher lookup in TS, or a resolver hook in a Rust egress proxy.
- **Evidence:** mcp/client.ts:310-388 (shorthand), 404-430, 432-453 (v4 ranges), 455-473 (v6 first-hextet only). Cost: S (1d) for the TS consume + shared table; M for a DNS-aware egress. Confidence: high on the v6 gaps (from reading the code). Needs web verification: ipaddr.js range names in the current release and Node BlockList IPv4-mapped handling.

## [LOW] dependency-hygiene — common/src/mcp/client.ts:594 — MCP client + env substitution/origin marking: KEEP (official TS SDK)
- **Risk:** @modelcontextprotocol/sdk is the reference implementation, so there's no benefit to moving it. The config-origin WeakMap trust model (markMCPConfigOrigin) is TS-in-memory only, and a sidecar can't see origins.
- **Fix:** Keep it in TS. If MCP servers get launched from a Rust supervisor, serialize origin as an explicit field in the MCP config JSON Schema rather than a WeakMap side table. The Rust SDK (rmcp) exists if needed later.
- **Evidence:** mcp/client.ts:4-7 imports, 128-226 origin map, 503-528, 594-734. Cost: n/a. Confidence: medium. Needs web verification: rmcp maturity.

## [HIGH] api-contract — common/src/tools/compile-tool-definitions.ts:24 — Tool schema compilation: CODEGEN (commit JSON Schema artifacts; generate SDKs)
- **Risk:** compileToolJsonSchemas already produces per-tool JSON Schema, but only at runtime or on demand, and the only generator (jsonSchemaToTypeScript) is a hand-written TS emitter that throws on unsupported shapes. Python, Go and Rust clients and sidecars have no canonical tool contract.
- **Fix:** In CI, write schemas/tools/<name>.input.json (and output schemas from tools/results/filesystem.ts) with a drift check. Generate SDKs with off-the-shelf tools rather than extending the hand emitter: typify (Rust), datamodel-code-generator (Python/pydantic), quicktype or go-jsonschema (Go). Optionally replace jsonSchemaToTypeScript with json-schema-to-typescript. Unlocks: typed Python/Go/Rust SDKs, a Rust shim validating tool calls with the jsonschema crate, and provider-agnostic tool publishing.
- **Evidence:** compile-tool-definitions.ts:12-31 (JSON artifact), 37-90 (TS emitter), 107-120 (hand converter). Cost: M (2-3d). Confidence: high. Needs web verification: z.toJSONSchema output fidelity for refinements/transforms (these don't serialize; io:'input' mitigates).

## [MEDIUM] api-contract — common/src/tools/list.ts:162 — Tool param registry + clientToolCallSchema: CODEGEN (discriminated union to JSON Schema)
- **Risk:** clientToolCallSchema (lines 162-324) is the wire contract between runtime and client (CLI/SDK) and exists only as Zod. Some params rely on Zod transforms and refinements (input aliases, applyToolInputAliases) that JSON Schema can't express, so non-TS clients would accept or reject different inputs.
- **Fix:** Split each tool into a strict canonical schema (exported as JSON Schema) and a TS-only leniency layer (aliases/repair) that runs before validation. Document that only the runtime applies leniency. Generate the client tool-call union for non-TS clients.
- **Evidence:** tools/list.ts:69 (applyToolInputAliases), 75-141, 162-334. Cost: M. Confidence: medium (outline plus imports only; refinements not individually inspected).

## [LOW] correctness — common/src/tools/params/utils.ts:200 — Tool-argument repair/truncation recovery: KEEP
- **Risk:** LLM-output leniency (repairMalformedJsonSeparators, tryRecoverTruncatedToolArguments, comma-split rejoin, spawn-agent normalization) is heuristic, changes often, and belongs where the model output is received. It isn't a contract and shouldn't be ported.
- **Fix:** Keep it in TS. Make sure the canonical JSON Schemas (above) describe the post-repair shape only.
- **Evidence:** params/utils.ts:76-124, 139-186, 200-273, 371-484, 491-619, 761-850. Cost: n/a. Confidence: high.

## [LOW] correctness — common/src/tools/params/edit-blocks.ts:106 — SEARCH/REPLACE edit-block parser: KEEP
- **Risk:** A small line-oriented parser behind an env flag. Its grammar is an LLM-facing format; nothing needs Rust performance here.
- **Fix:** Keep it in TS. If a Rust applier ever consumes blocks, pass it the parsed JSON (edit_transaction shape), not the raw text.
- **Evidence:** edit-blocks.ts:36-41 markers, 61-94 env flag, 106-251 parser. Cost: n/a. Confidence: high.

## [LOW] dependency-hygiene — common/src/util/saxy.ts:307 — Saxy streaming XML parser (vendored): KEEP (or CONSUME saxes/htmlparser2 later)
- **Risk:** This is a vendored ~740-line Transform-stream SAX parser used for legacy XML tool-call parsing. As vendored code it takes no upstream fixes. Throughput isn't a concern at LLM token rates.
- **Fix:** Keep it. If maintenance becomes an issue, replace it with saxes (maintained, well-formedness-checking) or htmlparser2 for lenient parsing. Moving to Rust (quick-xml) has no benefit at LLM token rates.
- **Evidence:** saxy.ts:4-5 (node:stream), 118-269 (entities/attrs), 307-741 class. xml-parser.ts:8-26 parseToolCallXml. Cost: S if replaced. Confidence: medium.

## [LOW] dependency-hygiene — common/src/util/partial-json-delta.ts:41 — Partial-JSON streaming delta: KEEP
- **Risk:** Uses the partial-json npm dependency (^0.1.7, an open range on a 0.x package) for streaming tool-arg previews. It's UI-side and TS-appropriate.
- **Fix:** Keep it, and pin partial-json to an exact version (0.x minor bumps can break).
- **Evidence:** partial-json-delta.ts:1-89; package.json dependency 'partial-json': '^0.1.7'. Cost: XS. Confidence: high.

## [LOW] correctness — common/src/util/string.ts:183 — String utils (pluralize, stripAnsi, truncate): KEEP / CONSUME optional
- **Risk:** Contains a hand-maintained pluralize (lines 54-243) and ANSI regexes. These are presentation helpers, not contracts.
- **Fix:** Keep them. Optionally swap in the pluralize and strip-ansi packages, or Bun.stripANSI if available, to delete ~200 lines.
- **Evidence:** string.ts:54-243, 376-384. Cost: XS. Confidence: medium. Needs web verification: Bun.stripANSI availability in bun 1.3.11.

## [LOW] api-contract — common/src/util/router.ts:53 — Knowledge router + patterns index parsing: KEEP (document file formats)
- **Risk:** The router table and patterns index are ad-hoc Markdown/text formats parsed in TS (parseRouterTable, parsePatternsIndex). They're prompt-assembly features, so language fit is fine, but the file formats are implicit.
- **Fix:** Keep them in TS. Add a short format spec, or JSON Schema if they become JSON, so non-TS tooling (editors, a Python eval harness) can author or validate them.
- **Evidence:** router.ts:53-99, 136-240; patterns.ts:53-114. Cost: XS. Confidence: medium (outline-level read).

## [MEDIUM] api-contract — common/src/util/job-registry.ts:387 — Job registry (background jobs, events, waiters): KEEP impl; CODEGEN event/snapshot contract
- **Risk:** The in-process registry (bounded event buffers, TTL sweeps, owner checks, async-iterator streams) is fine in TS. But JobEvent/JobSnapshot/JobState are TS interfaces only, so a Rust process supervisor emitting job output can't share the event shape, cursors or truncation semantics.
- **Fix:** Keep the registry in TS. Define JobEvent, JobSnapshot, JobState and the bounds constants as a Zod or JSON Schema (or protobuf if a gRPC/IPC sidecar lands) and generate Rust structs. Unlocks: a Rust PTY/process sidecar streaming events straight into the registry.
- **Evidence:** job-registry.ts:24-59 (states), 117-201 (Job/Event/Snapshot/Wait), 204-228 (limits), 387-1072 class. Cost: S-M. Confidence: medium-high.

## [LOW] correctness — common/src/util/usefulness-scorer.ts:56 — Memory usefulness scoring + contradiction detection: KEEP (version constants already present)
- **Risk:** Deterministic scoring and topic hashing (sha256 via node:crypto). They're versioned (USEFULNESS_SCORE_MODEL_VERSION), but results persisted in memory-v2 would need byte-identical reimplementation if a Rust memory store took over.
- **Fix:** Keep them in TS. If memory moves to a Rust/SQLite service, pin golden vectors for scoreUsefulness, deriveTopicKey and compareCodePoints ordering first.
- **Evidence:** usefulness-scorer.ts:1-88; contradiction-detector.ts:24-54, 102-154. Cost: n/a. Confidence: medium.

## [LOW] correctness — common/src/util/context-budget.ts:16 — Context budget ledger formatter: KEEP
- **Risk:** This is CLI presentation of the ContextBudgetLedger. No contract risk.
- **Fix:** Keep it. The ledger type itself should be included in the session-state schema export (see agent-handoff/session-state finding).
- **Evidence:** context-budget.ts:10-77; types/session-state.ts:193-238. Cost: n/a. Confidence: high.

## [HIGH] api-contract — common/src/types/agent-handoff.ts:82 — Agent handoff/receipt + session-state contracts: CODEGEN (JSON Schema, versioned)
- **Risk:** agentHandoffSchema and agentReceiptSchema are the orchestrator<->subagent protocol (schemaVersion 1). AgentState/SessionState (session-state.ts:383-743) is a large TS type that is persisted and sent to the SDK/CLI, and parts of it are TS types only rather than Zod. A Python or Go SDK, a remote worker, or a Rust orchestrator shim can't produce or validate them. AgentState is a plain TS type, so it can't be exported mechanically.
- **Fix:** Treat the handoff/receipt Zod schemas as source of truth and export JSON Schema (they already use jsonValueSchema, so they're serializable). For SessionState, convert the wire-visible subset to Zod (or TypeBox), export it, and generate Python/Go/Rust models. Consider protobuf only if gRPC transport is adopted. JSON Schema is simpler given the Zod investment. Unlocks: generated SDKs that resume or inspect sessions, and remote/polyglot subagents.
- **Evidence:** agent-handoff.ts:4-21, 82-110, 123-218; session-state.ts:29-100 (zod parts), 383-611 (TS-only AgentState), 696-743. Cost: M-L (3-5d; AgentState conversion is the bulk). Confidence: high on the need, medium on effort.

## [MEDIUM] api-contract — common/src/types/harness-control-plane.ts:126 — Harness control-plane records: CODEGEN (TS types -> schema)
- **Risk:** WorkspaceLease, SnapshotRef, TaskRecord, ChangeOwnershipReceipt, ApprovalGrant and VersionedHarnessRecord (optimistic revision) are TS types with no runtime schema. A control plane is exactly what external services, sidecars and dashboards consume.
- **Fix:** Rewrite them as Zod schemas (or define them in JSON Schema, protobuf or TypeSpec first) and generate TS/Rust/Go. Put the assertExpectedRevision semantics in the spec.
- **Evidence:** harness-control-plane.ts:1-136 (types), 138-147 (assertExpectedRevision). Cost: S-M. Confidence: medium (outline-level).

## [MEDIUM] api-contract — common/src/types/dynamic-agent-template.ts:112 — Dynamic agent template schema + validation: CODEGEN (publish JSON Schema for .agents/*.json/ts authoring)
- **Risk:** DynamicAgentDefinitionSchema is the user-authored agent format, but it embeds function schemas (handleSteps, LoggerSchema) that JSON Schema can't express. agent-validation.ts round-trips JSON Schema -> Zod through zod-from-json-schema (pinned 0.4.2). Non-TS authors (Python agent definitions, editor validation) get no schema.
- **Fix:** Split the template into a data part (JSON Schema exported to schemas/agent-template.v1.json for editor $schema autocomplete and Python authoring) and a code part (handleSteps, TS only). Keep the zod-from-json-schema dependency pinned, and consider replacing it with ajv for validating user inputSchema to cut a 0.x dependency.
- **Evidence:** dynamic-agent-template.ts:18-61, 70-109 (function schemas), 112-342; templates/agent-validation.ts:1, 311-385. Cost: S-M. Confidence: medium.

## [LOW] correctness — common/src/env-schema.ts:5 — Client env schema: KEEP
- **Risk:** This is NEXT_PUBLIC_ env for the web app. The explicit per-key process.env references are required by Bun's static injection, so it's TS/Bun-specific by nature and no sidecar needs it.
- **Fix:** Keep it.
- **Evidence:** env-schema.ts:5-13, 34-54. Cost: n/a. Confidence: high.

## [MEDIUM] correctness — common/src/project-file-tree.ts:164 — Project file tree + gitignore walker: MOVE->Rust (ignore crate) or CONSUME
- **Risk:** A BFS walk using fs.stat per entry and a hand-rolled rebaseGitignorePattern (lines 283-329). A gitignore file is parsed per directory and merged by re-adding all rules at every level (line 202), so cost grows roughly O(depth x rules). Rebasing approximates git semantics, so edge cases (negation across levels, '**' anchoring, core.excludesFile, .git/info/exclude) differ from git and ripgrep. The ripgrep-backed code_search and the indexer therefore see different file sets. There is also a second BINARY_EXTENSIONS copy separate from the indexer (line 43-47 comment).
- **Fix:** Use the Rust ignore crate (the one ripgrep uses; WalkBuilder is parallel and handles .gitignore/.ignore/global excludes and custom ignore filenames like .openbuffignore) through a napi-rs addon or an existing Rust sidecar. It would return the FileTreeNode JSON and share the sensitive-path and binary-extension data tables. Short of that, use `git ls-files -co --exclude-standard` inside git repos. Move BINARY_EXTENSIONS into the shared languages/filetypes data file. Unlocks: one walker for tree, indexer and search, with consistent ignore semantics and faster large repos.
- **Evidence:** project-file-tree.ts:48-148 (binary set), 164-275 (walk; 196-202 per-dir parse+merge), 277-329 (rebase), 331-372 (parseGitignore), 415-460 (isFileIgnored walks ancestors each call). Cost: M (napi-rs addon plus cross-platform builds: 3-5d); S for the git ls-files fallback. Confidence: medium-high. Needs web verification: ignore crate custom ignore filename API (add_custom_ignore_filename).

## [MEDIUM] dependency-hygiene — common/package.json:35 — common package dependencies: KEEP (pin + split server-only deps)
- **Risk:** common, which will be the contract package, pulls server/auth/DB dependencies (@auth/drizzle-adapter, next-auth, pg, posthog-node) that every consumer, including any future codegen or SDK build, inherits. Most versions are open caret ranges (only ignore, lodash and zod-from-json-schema are exact). @types/* packages sit in dependencies instead of devDependencies. exports.default './src*.ts' is missing a slash (line 12).
- **Fix:** Pin exact versions. Move @types/* to devDependencies. Split a dependency-free @codebuff/contracts package (Zod schemas + generated JSON Schemas + data tables) out of common, so codegen and non-TS consumers don't depend on the auth or DB stack. Fix the exports default path to './src/*.ts'.
- **Evidence:** common/package.json:7-13 (exports typo line 12), 35-52 (deps). Cost: S (pinning/fix); M (contracts package split). Confidence: high.

## Coverage receipt

### Subsystems
- common

### Features
- language-capability-registry
- language-capability-manifest
- language-profile-detection
- secret-redaction
- sensitive-path-policy
- content-hash-and-read-capability
- stable-hash-fnv1a
- project-path-containment
- mcp-ssrf-address-guard
- mcp-client-and-env-substitution
- tool-schema-compilation
- tool-param-registry
- tool-arg-repair
- edit-blocks-parser
- xml-streaming-parser
- partial-json-delta
- string-utils
- patterns-and-router-knowledge
- job-registry
- memory-scoring-contradiction
- context-budget-ledger
- agent-handoff-session-contracts
- harness-control-plane-types
- dynamic-agent-template-validation
- env-schema
- project-file-tree-gitignore
- common-package-deps

### Files
- common/src/util/language-capabilities.ts
- common/src/util/language-capability-manifest.ts
- common/src/util/language-profiles.ts
- common/src/util/redact-secrets.ts
- common/src/util/sensitive-paths.ts
- common/src/util/content-hash.ts
- common/src/util/stable-hash.ts
- common/src/util/project-path-containment.ts
- common/src/util/saxy.ts
- common/src/util/xml-parser.ts
- common/src/util/partial-json-delta.ts
- common/src/util/string.ts
- common/src/util/patterns.ts
- common/src/util/router.ts
- common/src/util/job-registry.ts
- common/src/util/contradiction-detector.ts
- common/src/util/usefulness-scorer.ts
- common/src/util/context-budget.ts
- common/src/mcp/client.ts
- common/src/tools/compile-tool-definitions.ts
- common/src/tools/list.ts
- common/src/tools/params/utils.ts
- common/src/tools/params/edit-blocks.ts
- common/src/types/agent-handoff.ts
- common/src/types/session-state.ts
- common/src/types/dynamic-agent-template.ts
- common/src/types/harness-control-plane.ts
- common/src/env-schema.ts
- common/src/project-file-tree.ts
- common/src/templates/agent-validation.ts
- common/package.json

### Domains
- api-contract
- security
- correctness
- dependency-hygiene
