# Audit findings: p3-coherence-f-lsp-tools

- Subsystems: sdk-lsp-multiplexer, sdk-language-intelligence, sdk-run-tool-dispatch, common-language-capability-registry, common-tool-params, agent-runtime-tool-handlers, cli-tool-renderers
- Features: P3-T1, P3-T2, LI-01
- Files covered: 24

## [LOW] correctness — sdk/src/services/lsp-multiplexer.ts — P3-T1 verdict: MATCHES — one warm server per (languageId, rootUri), registry-driven selection, cold-start + memory limits all verified as claimed (incl. both remediation fixes)
- **Risk:** Informational verdict anchor for the P3-T1 plan claims. Server selection is genuinely registry-driven, not a hard-coded map: resolveLanguage maps the file extension through LANGUAGE_CAPABILITY_REGISTRY and selectServerSpec picks the languageServer tool spec via getLanguageToolSpecs; non-stdio specs (gdscript tcp) are rejected with a typed LspServerUnavailableError. One warm server per (languageId, rootUri) is enforced by the servers Map keyed `${languageId}:${rootUri}` with rootMarker-aware upward walk (defaultRootResolver, memoized, MAX_ROOT_WALK_DEPTH=32), LRU touch, maxServers=4 eviction with a serialized registration chain that reserves the slot BEFORE the child starts, and a single-flight `starting` map so concurrent cold starts join one child. Cold-start handling (bounded startupTimeoutMs initialize handshake, typed timeout/spawn-failed errors, one restart-with-backoff then gave-up) and memory limits (bounded pending map 256, bounded frame buffer 8 MiB fail-closed, bounded root-resolution cache 512 entries) are implemented as claimed. The two remediation fixes landed: dead-entry cold-start replacement and unparseable-frame/uncorrelated-response rejection.
- **Fix:** No action needed; informational verdict anchor confirming P3-T1's claims against current source.
- **Evidence:** lsp-multiplexer.ts:~780-830 resolveLanguage iterates LANGUAGE_CAPABILITY_REGISTRY extensions and selectServerSpec uses getLanguageToolSpecs(languageId).find(spec => spec.role === 'languageServer'), rejecting non-stdio/empty-argv specs as 'tcp-transport'/'no-server-spec'; acquire() keys servers on `${languageId}:${rootUri}` with root from rootResolver({filePath, rootMarkers: spec.rootMarkers ?? []}); DEFAULT_MAX_SERVERS=4 with evictIfNeeded LRU + registrationChain slot reservation; single-flight `starting` map prevents duplicate cold-start children; dead-entry replacement branch ('Dead entry: a restart that gave up leaves the cached connection permanently not-running... fall through to the single-flight cold start') verified in acquire(); consume() tears the connection down on a malformed header ('malformed LSP header: missing Content-Length') and on an invalid/oversize Content-Length, and handleMessage rejects uncorrelated non-JSON/non-object/non-numeric-id responses with a structured protocol error while keeping the connection up — both remediation fixes are present and pinned by lsp-multiplexer.test.ts.

## [MEDIUM] correctness — sdk/src/run.ts — workspace_symbol's per-language warm-server routing is production-dead — run.ts only ever passes {query}, so the multiplexer's filePath-aware branch is unreachable from real callers
- **Risk:** The multiplexer implements a filePath-parameterized workspaceSymbol branch (resolve the language from the filePath extension, route to THAT language's warm server) plus the LspChildHandle surface to support it, but the language-intelligence service's workspaceSymbol() only accepts {query} and the run.ts handler forwards only {query}. In production the query always degrades to the context-free warm-anchor path (latestWarmEntry / warmEntryForWorkspaceSymbol). The per-language routing is dead code masquerading as a selectable behavior, and workspace_symbol's input schema (query-only) cannot express the routing the implementation advertises.
- **Fix:** Either thread an optional filePath/query context through workspaceSymbolParams + the service + the run.ts handler to activate the per-language warm routing, or mark the filePath branch as reserved-for-future-use in the module doc so the dead seam is recorded rather than silently claimed.
- **Evidence:** run.ts:2697-2701 `workspaceSymbol(resolveLanguageIntelligence(), input as { query: string })`; language-intelligence.ts service workspaceSymbol accepts only {query} and calls mux.workspaceSymbol(params.query) with no second argument; lsp-multiplexer.ts workspaceSymbol(query, filePath) filePath branch (~line 990-1020, 'when a filePath context is provided, the language is derived from its extension...') is reachable only from tests. referencedBy for createLspMultiplexer shows only language-intelligence.ts + tests.

## [LOW] state-mutation — sdk/src/run.ts — Document sync is receipt-driven at the tool-dispatch layer, not invoked by the WorkspaceMutationBroker itself; delete actions are never didClose'd, leaving stale open-document state in warm servers
- **Risk:** The plan claims 'Document sync goes through the mutation broker.' The implementation calls syncMutatedFiles in run.ts's post-commit block keyed on the confirmed actions of the broker-issued FileMutationResultV1 receipt — so it is receipt-driven, but WorkspaceMutationBroker never calls it; the sync seam lives entirely in the tool-dispatch path. Functionally equivalent for the happy path, but two residues follow: (1) the plan wording overstates broker integration; (2) delete actions are filtered out of syncedPaths, so a file that was previously didOpen'd into a warm server keeps its stale content in the server's open-document state after the file is deleted on disk (LSP servers may keep answering references against the phantom document).
- **Fix:** Record the precise wording in the plan note (receipt-driven post-commit sync at the dispatch layer), and consider forwarding delete actions to syncFile({close:true}) so warm servers drop documents that no longer exist.
- **Evidence:** run.ts:2813-2830 — the sync block sits inside handleToolCall's post-mutation enrichment, deriving syncedPaths from getConfirmedAppliedActionsV1(mutationValue) with `.filter(changed => changed.action !== 'delete')`; WorkspaceMutationBroker (workspace-mutation-broker.ts) has zero references to language-intelligence or syncFile (code_search over sdk/src shows the broker referenced only by mcp/server.ts, node-filesystem.ts, run.ts:809, and tests).

## [LOW] test-coverage — sdk/src/__tests__/language-intelligence.test.ts — P3-T2 fixture caveat is accurate in substance (zero real-server tests) but understates the per-language mock coverage — 11 languages have registry spawn-spec pins, not just ts+py
- **Risk:** The plan note says 'per-language fixture tests remain mock-based (ts+py) at the LSP layer.' Verified: there are NO real-server fixture tests anywhere (every LSP test drives the injected fake peer/fake multiplexer). However the parenthetical '(ts+py)' is narrower than what exists: language-intelligence.test.ts's 'per-language resolution' describe covers only ts+py (via mocked unavailable errors), but lsp-multiplexer.test.ts's SPAWN_ARGV_CASES pins extension→language→languageServer-spec→exact spawn argv for 11 languages (typescript, python, rust, go, java, csharp, cpp, ruby, php, swift, kotlin) plus the tcp-only gdscript rejection. The caveat is honest about the missing real-server gate but under-credits the mock breadth.
- **Fix:** Optionally sharpen the plan note to 'mock-based at the LSP layer (zero real-server fixtures; per-language coverage = 11-language spawn-spec pin, ts+py query fixtures)' so the caveat names what the mocks do cover.
- **Evidence:** language-intelligence.test.ts:199-247 — test.each over [['src/foo.ts','typescript'],['src/foo.py','python']] with an injected makeMultiplexer throwing LspServerUnavailableError; lsp-multiplexer.test.ts:517-554 SPAWN_ARGV_CASES pins 11 stdio argvs hermetically; no test file spawns a real server (grep for pyright/tsserver/rust-analyzer in sdk/src/__tests__ shows only fake-peer or CLI-diagnostic fixtures); PLAN.md P3-T2 entry carries the honest PARTIAL-gate note.

## [LOW] api-contract — common/src/tools/params/tool/go-to-definition.ts — P3-T2 verdict: MATCHES — all four tools exist end-to-end (param schemas, tool-union registration, SDK dispatch handlers, agent-runtime handlers, CLI renderers)
- **Risk:** Informational verdict anchor for the P3-T2 plan claims. Every one of go_to_definition / find_references / hover_type / workspace_symbol has a Zod param schema in common/src/tools/params/tool, is a member of toolParams/toolNames/metadata, is dispatched in sdk/src/run.ts's handleToolCall, is registered in the agent-runtime handler list, and has a CLI renderer registered in the tool-component registry. No tool is missing a handler or renderer — the specific coherence-gap check passes clean.
- **Fix:** No action needed; informational verdict anchor confirming P3-T2's structural claims.
- **Evidence:** All four files present with inputSchema (1-based line 1..1_000_000, character 0..100_000; query 1..512 for workspace_symbol) and outputSchema carrying locations/hover/symbols + unavailable{reason,languageId?} + errorMessage; common/src/tools/list.ts:112-115 registers all four params and :317-330 pins them in the CodebuffToolCall schema; common/src/tools/metadata.ts:37-62 lists all four; packages/agent-runtime/src/tools/handlers/list.ts:109-112 registers handleGoToDefinition/handleFindReferences/handleHoverType/handleWorkspaceSymbol; cli/src/components/tools/registry.ts:41-46 registers all four components from language-intelligence.tsx.

## [LOW] correctness — sdk/src/services/symbol-enrichment.ts — Known unwired P3 seam persists adjacent to this shard's scope: symbol-enrichment's enrichFileSymbols (hover/documentSymbol/inlayHint tier, P3-T6) has no production consumer
- **Risk:** The P3 phase's prior finding of an unwired enrichment seam remains true in the current tree: enrichFileSymbols is exported and fully tested against the multiplexer but is referenced only by its own test file — no production caller feeds documentSymbol/hover/inlayHint enrichment into any user-visible surface. This is adjacent to (not part of) P3-T1/T2, and the sibling shard p3-coherence-d-enrich-impact-build is expected to own the verdict; recorded here only as a cross-shard anchor so the F shard's dead-seep sweep is complete.
- **Fix:** Wire enrichFileSymbols into a real consumer (query_index / read_files enrichment path) or document it as an eval-only export like rankedRepoMap (P3-T9's accepted status) so the plan's DONE verdicts stay honest.
- **Evidence:** code_search for enrichFileSymbols outside its own module returns only symbol-enrichment.test.ts; the module's docblock documents the seam as a P3-T6 deliverable consumed by callers that were never wired. This shard records it for completeness; the detailed treatment belongs to the enrichment shard (p3-coherence-d-enrich-impact-build).

## Coverage receipt

### Subsystems
- sdk-lsp-multiplexer
- sdk-language-intelligence
- sdk-run-tool-dispatch
- common-language-capability-registry
- common-tool-params
- agent-runtime-tool-handlers
- cli-tool-renderers

### Features
- P3-T1
- P3-T2
- LI-01

### Files
- sdk/src/services/lsp-multiplexer.ts
- sdk/src/services/language-intelligence.ts
- sdk/src/services/symbol-enrichment.ts
- sdk/src/run.ts
- sdk/src/tools/go-to-definition.ts
- sdk/src/tools/find-references.ts
- sdk/src/tools/hover-type.ts
- sdk/src/tools/workspace-symbol.ts
- sdk/src/__tests__/lsp-multiplexer.test.ts
- sdk/src/__tests__/language-intelligence.test.ts
- common/src/util/language-capabilities.ts
- common/src/tools/params/tool/go-to-definition.ts
- common/src/tools/params/tool/find-references.ts
- common/src/tools/params/tool/hover-type.ts
- common/src/tools/params/tool/workspace-symbol.ts
- common/src/tools/list.ts
- common/src/tools/metadata.ts
- packages/agent-runtime/src/tools/handlers/list.ts
- packages/agent-runtime/src/tools/handlers/tool/go-to-definition.ts
- packages/agent-runtime/src/tools/handlers/tool/find-references.ts
- packages/agent-runtime/src/tools/handlers/tool/hover-type.ts
- packages/agent-runtime/src/tools/handlers/tool/workspace-symbol.ts
- cli/src/components/tools/registry.ts
- cli/src/components/tools/language-intelligence.tsx

### Domains
- correctness
- state-mutation
- error-handling
- api-contract
- test-coverage
