# Audit findings: shard-p1-acp-serve

- Subsystems: sdk-acp-protocol, sdk-serve-bridge, sdk-serve-transports, sdk-mcp-server, common-mcp-client, common-mcp-dns-pinning
- Features: SEC-4-unix-socket-auth, SEC-7-project-root-containment, SEC-3-SSRF-guard-client-origin, NEW-1-mcp-origin-registry, NEW-3-credential-holdback, NEW-4-sanitize-outbound-chokepoint, NEW-6-sensitive-path-redaction, NEW-7-dns-rebinding-pinning, sec12_6-frame-limits-backpressure, GV-24-replay-no-rawIO, GV-27-holdback-no-split, GV-28-chokepoint, ext-v1-dispatch, journal-replay, approval-bridge, ask-user-elicitation-bridge, mcp-read-tools, apply-edits-mutations
- Files covered: 13
- Snapshot: 5c80253b458f8b07b8ca33e50cc3d6ad7e6cda07ef1715ba8adffd8c77905ab7

## [HIGH] security — sdk/src/serve/serve.ts:76 — SEC-7 containment is never wired into production serve transports (projectRoot omitted in both stdio and socket paths)
- **Risk:** SEC-7 (§12.5) project-root containment is enforced in createAcpAgent only when options.projectRoot is set. runServe never forwards a projectRoot (or allowedAdditionalDirectories) to either transport: serveAcpOverStdio({promptHandler, sessionData}) and serveAcpOverSocket({promptHandler, sessionData, socketPath, token, signal}) both omit it, so resolveSessionCwd short-circuits to the permissive pre-P1-T2 behavior. A malicious ACP client can call newSession/loadSession with any absolute cwd (or file:// authority variant) and the agent operates outside the intended root; additionalDirectories are accepted unvalidated.
- **Fix:** Add projectRoot (and allowedAdditionalDirectories) to RunServeOptions and pass them through to both serveAcpOverStdio and serveAcpOverSocket; fail loudly (or refuse socket/stdio serve) when projectRoot is omitted so containment cannot be silently disabled.
- **Evidence:** resolveAcpServeOptions passes agentOptions through untouched; RunServeOptions has no projectRoot field; acp-agent.ts resolveSessionCwd returns `input` verbatim when options.projectRoot === undefined, and the rejectUncontainedCwd path is only reached when projectRoot is set.

## [HIGH] security — common/src/mcp/dns-pinning.ts:271 — Node/undici https path skips the pin entirely, leaving the DNS-rebinding TOCTOU window open between per-request validation and connect
- **Risk:** On Node/undici (supportsTlsServerName === false) a client-origin https MCP URL is fetched with its ORIGINAL hostname, so the socket connect performs a fresh DNS resolution after resolvePinnedMcpAddress validated the earlier answers. An attacker controlling DNS TTLs can answer with a public IP during validation and a loopback/metadata IP at connect time, reaching internal services despite NEW-7. The code comment documents the trade-off but the resulting SSRF window remains open on the most common runtime.
- **Fix:** On runtimes without tls.serverName support, refuse client-origin https MCP servers (fail closed) instead of falling back to un-pinned fetching; or resolve once and reuse a cached DNS answer (custom lookup via undici Agent/connect.lookup) so validation and dial share one resolution.
- **Evidence:** Branch `if (requestUrl.protocol === 'https:' && !supportsTlsServerName) { return fetch(input, requestInit) }` — no pinnedUrl rewrite and no DNS-cache guard; the doc comment itself notes the per-request re-validation 'still refuses a hostname that resolves to a blocked address', which is the check-then-connect pattern the TOCTOU defeats.

## [MEDIUM] error-handling — sdk/src/serve/bridge.ts:300 — Idle-flush timer fire-and-forgets updates without catching rejections — unhandled rejection can kill the serve process
- **Risk:** The per-turn setInterval callback calls `void input.update(piece)` and `void options.onSessionUpdate?.(...)` with no rejection handler. input.update is the ACP connection's sessionUpdate — a client that disconnects mid-turn makes these rejects; an unhandled rejection terminates the serve process in Node's default mode, converting a normal client hang-up into a server crash affecting every connected session.
- **Fix:** Attach a catch (log + swallow or abort the turn's signal) to each fire-and-forget emit inside the interval; alternatively track promise results and surface the first failure on the turn.
- **Evidence:** Inside setInterval callback: `void input.update(piece)` and `void options.onSessionUpdate?.({...})` — no .catch(); compare the awaited loops in flushHoldbacks and the handleEvent message path.

## [MEDIUM] correctness — sdk/src/services/acp/acp-agent.ts:640 — Concurrent prompt() on the same session silently replaces the AbortController; no per-session turn lock
- **Risk:** prompt() unconditionally assigns session.abortController = new AbortController() without cancelling a still-running turn for the same session. Two concurrent session/prompt calls on one session both run the handler; cancel() aborts only the latest controller, so the first turn becomes uncancellable and its streaming updates interleave with the second turn's on the same connection. Bridge state (holdback windows keyed by sessionId/messageId, per-turn pendingReverseRequests) also assumes one turn per session.
- **Fix:** Reject a second prompt on a session with an in-flight turn (or abort the prior turn first), and keep a Set of active controllers per session so cancel tears down all of them.
- **Evidence:** sessions.get(params.sessionId) then session.abortController = abortController with no in-flight check; cancel() reads only the single stored controller.

## [MEDIUM] state-mutation — sdk/src/services/acp/acp-agent.ts:620 — Session map is capped at 16 but never evicted — permanent DoS after 16 sessions
- **Risk:** newSession/loadSession insert into the private sessions Map but nothing ever deletes from it (the agent implements neither session/list nor session/close, and there is no eviction). After 16 sessions over the process lifetime (per connection for socket mode, per process for stdio), every newSession throws limit_exceeded forever — a trivially reachable permanent denial of service for a long-lived serve process, with no operator remediation short of restart.
- **Fix:** Add an eviction/LRU policy (or a session/close handler that deletes the entry) so the cap recycles; at minimum reject only when the cap is hit AND no idle session can be reaped, and expose teardown on connection close.
- **Evidence:** Both newSession and loadSession check `sessions.size >= MAX_LIVE_SESSIONS` and set() entries; grep of the module shows no sessions.delete or eviction path (no session/close/list is implemented by design).

## [MEDIUM] security — sdk/src/services/acp/acp-agent.ts:990 — Ext methods serve session data for any sessionId with no per-connection ownership check
- **Risk:** The ext dispatchers pass the client-supplied sessionId straight into the process-wide AcpSessionData (one bridge instance serves every socket connection) without checking it against the per-connection sessions map. A connection that guesses or learns another connection's session id (ids are also accepted by session/load) can read that session's receipts, gate state, and capability map — cross-connection data disclosure within the serve process.
- **Fix:** Validate the sessionId against the per-connection sessions map (and/or scope the sessionData store per connection) before serving any ext method; unknown or foreign ids should fail with invalid_params/method_not_found.
- **Evidence:** Both extMethod branches call options.sessionData.getReceipts/getGateState/getCapabilities with the client-supplied sessionId before any ownership check; AcpSessionData is a single process-wide instance per resolvedOptions.

## [MEDIUM] security — sdk/src/serve/socket-listener.ts:176 — Bind→chmod race: the unix socket accepts connections before chmod 0o600 is applied
- **Risk:** chmodSync(socketPath, 0o600) runs in the listen callback, but the socket file exists and accepts connections from the moment bind completes. In that window the socket's mode is umask-dependent (typically 0755&~umask → connectable by other local users), so a different-uid local peer can connect and reach the token prompt before the owner-only mode is applied. SEC-4's OS-credential layer is therefore not atomic.
- **Fix:** Chmod the path immediately after bind resolves (or bind into a 0700 dir with the socket pre-created with restrictive umask, or chmod in the 'listening' event before any client can win the connect race — ideally create the socket file with 0600 via umask(0o077) before listen).
- **Evidence:** server.listen(socketPath, () => { chmodSync(socketPath, 0o600); onListening?.(...) }) — no fchmod-before-publish or umask tightening; the window is unbounded under scheduler delay.

## [MEDIUM] security — sdk/src/serve/event-bridge.ts:500 — tool_call rawInput bypasses the NEW-3 credential-value holdback entirely
- **Risk:** For a tool_call whose locations are not sensitive-path matches, `payload.rawInput = event.input` is emitted verbatim. The NEW-3 holdback and its value-level credential redaction are applied ONLY to message/thought chunks; rawInput frames rely solely on sanitizeOutbound's pattern list (three well-known KEY= pairs + sk- shapes). A tool input embedding a configured credential value that has no recognizable shape (custom providers.json apiKeyEnv value, generic tokens) crosses the ACP wire unredacted.
- **Fix:** Run the credential-value substitution (or a redactAllStringsDeep pass over rawInput) whenever credentialValues are configured, and treat unknown server names/values as sensitive by default for client-origin servers.
- **Evidence:** payload.rawInput = anyLocationSensitive(locations) ? redactSensitiveRawInput(event.input) : event.input; collectCredentialValues is only consumed by OutboundHoldback.push in bridge.ts, which handles agent_message_chunk/agent_thought_chunk only.

## [MEDIUM] security — sdk/src/mcp/server.ts:915 — MCP read_files embeds a live cap.v3 readCapability token in tool output — contradicts the 'cap.v3 never leaves the process' invariant
- **Risk:** read_files renders `[READ_CAPABILITY ...: cap.v3....]` into the tool result text returned to the MCP host, i.e. a capability token leaves the openbuff-mcp process on every complete read. The serve-side invariant (SEC-1/NEW-4: cap.v3 never leaves the process; sanitizeOutbound redacts cap.v3 on the ACP wire) is not applied here. Additionally the issuer runId is the constant 'mcp' for every caller of the server, so tokens minted for one MCP client are structurally identical to those of any other client of the same server process — non-transferability across sessions is claimed in the comment but not achieved.
- **Fix:** Either keep the token in a structured field the host must explicitly opt into, or per-client scope the issuer identity; at minimum document the invariant exception explicitly and gate the token echo behind the mutations opt-in.
- **Evidence:** renderReadFilesItem: `const capability = item.editAnchor?.readCapability; ... [READ_CAPABILITY ...: ${capability}]`; capabilityIssuer: { projectId: sessionData.projectRoot, runId: 'mcp' } — constant across all clients of the server.

## [MEDIUM] correctness — common/src/mcp/client.ts:640 — listToolsCache permanently caches a rejected promise — one failed listTools poisons the client forever
- **Risk:** listMCPTools stores the raw promise once and never invalidates it: if the first listTools call rejects (transport blip, server restart), every subsequent caller receives the same cached rejection for the life of the process, even after the client recovers. The stored rejected promise is also an unhandled-rejection hazard if the first caller does not consume it before the next call overwrites nothing. There is no TTL/refresh, so tool lists never pick up server-side changes either.
- **Fix:** Cache with TTL or invalidate on connect failure; attach a no-op catch to the stored promise to avoid unhandled rejections; bound or evict runningClients/listToolsCache entries.
- **Evidence:** if (!listToolsCache[clientId]) { listToolsCache[clientId] = client.listTools(...args) } — no clear/refresh path anywhere in the module; runningClients is also never pruned (unbounded growth per distinct config).

## [MEDIUM] state-mutation — common/src/mcp/client.ts:700 — runningClients registry is unbounded and getMCPClient has a double-connect race
- **Risk:** getMCPClient checks `key in runningClients` synchronously, then awaits client.connect before storing. Two concurrent calls with the same config both miss the cache and each construct + connect a transport; the second write orphans the first connected client (leaked stdio child process or socket, never disconnected). Separately, runningClients grows without bound: a client-origin peer can supply many distinct MCP server configs, each spawning a real child process/connection, with no cap or eviction — resource exhaustion in a long-lived serve process.
- **Fix:** Memoize the connect promise per key so concurrent callers share one client; on failure delete the memoized entry; bound the registry (LRU or per-session scoping) and disconnect evicted clients.
- **Evidence:** if (key in runningClients) { return key } ... await client.connect(transport) ... runningClients[key] = client — no promise memoization; no cap on map size.

## [MEDIUM] correctness — sdk/src/services/acp/session-data.ts:770 — Journal-restored gate-state snapshot is type-asserted without validation — tampered journal can publish arbitrary gate phase/status
- **Risk:** Receipt lines are gated by isRedactionCleanWireEnvelope and capability lines are re-derived, but `parsed.snapshot as AcpGateStateSnapshot` is accepted with only an isPlainRecord check. A tampered or hand-crafted journal can inject phase: 'final_response_allowed' (or any string) with arbitrary status/details, which getGateStateV1 then serves as status 'passed' over the ext-v1 wire — a client-visible security signal (gate passed) forged from untrusted disk bytes. The module's own comment for capabilities explains why replayed values must not be trusted; the same reasoning is not applied to gate snapshots.
- **Fix:** Validate the snapshot with a zod schema (gate/status/phase enums, finite numbers) and fail closed on malformed lines, mirroring the capabilities handling; re-derive phase from gate/status instead of trusting the stored phase.
- **Evidence:** else branch of restoreFromJournal: `snapshot = parsed.snapshot as AcpGateStateSnapshot` with no per-field checks, contrasting with capabilityMapV1Schema.safeParse for capabilities and isRedactionCleanWireEnvelope for receipts.

## [MEDIUM] state-mutation — sdk/src/mcp/server.ts:1240 — apply_edits batch has no transaction boundary and null expectedHash means unconditional overwrite
- **Risk:** The edits loop applies each conditionalCommit sequentially with no transaction boundary: if edit 3 throws, edits 1-2 are already on disk while the client receives a single generic 'Tool apply_edits failed' with no indication of which writes landed. Additionally expectedHash: null is documented as 'create/overwrite', so an armed server overwrites an existing file unconditionally with no optimistic-concurrency check — a stale client view silently clobbers concurrent changes.
- **Fix:** Capture per-edit results (try/catch per edit, report applied/failed individually), and require an expectedHash for overwrite of existing files (fail closed on mismatch) unless an explicit force flag is provided.
- **Evidence:** for (const edit of edits) { const commit = await broker.conditionalCommit(edit.path, edit.content, null) ... } — no grouping, rollback, or per-edit error capture; thrown errors escape to the generic handler catch.

## [MEDIUM] test-coverage — sdk/src/serve/outbound.ts:700 — §12.6 outbound backpressure queue (OutboundQueue) is dead code — never wired into any transport
- **Risk:** OutboundQueue (32 MiB cap, coalescing, abort decision) is implemented and unit-tested but no production path enqueues into it: sanitizeOutboundStream writes frames straight to the socket/stdout WritableStream. The documented backpressure guarantee (stalled reader cannot grow memory unboundedly; overflow aborts the run) therefore does not exist in serveAcpOverStdio or serveAcpOverSocket, and tests of the queue do not cover any real wiring — a golden-vector blind spot exactly of the kind this audit is asked to surface.
- **Fix:** Either wire OutboundQueue into the transports (enqueue session updates, drain to the wrapped writable, act on the abort decision by cancelling the run) or remove/mark it explicitly as a later-wave seam so the §12.6 claim is not treated as implemented.
- **Evidence:** OutboundQueue is exported from outbound.ts; its referencedBy list contains only the module's own tests; serveAcpOverStdio and handleConnection wire sanitizeOutboundStream directly with no queue insertion point.

## [LOW] error-handling — sdk/src/serve/socket-listener.ts:197 — Socket server 'error' event swallows late bind failures; close() unlinks the path even if another server rebound it
- **Risk:** The 'error' handler only calls releaseLock(): a bind failure after listen() is never surfaced to the caller (no throw, no onAuthFailure, no log), so the CLI can believe serving started while nothing is listening. Separately, close() unconditionally unlinkSync(socketPath) after server.close() — if this server already crashed/errored and another (locked, legitimate) server re-created the socket, close would unlink the new owner's socket file.
- **Fix:** Propagate the error (callback or rethrow after releaseLock) and stop the server; make close() skip the unlink when the bound path no longer refers to the socket this server created (compare inode, or verify it is still a socket owned by this process).
- **Evidence:** server.on('error', () => { releaseLock() }) — no listener removal, no rethrow, no onAuthFailure/log callback; close() unlinkSync runs unconditionally after server.close() resolves.

## [LOW] error-handling — sdk/src/serve/bridge.ts:660 — Turn finally-block flush can mask the original run error or throw after cancel
- **Risk:** The turn's finally block awaits flushHoldbacks(), which awaits input.update/onSessionUpdate. If the client disconnected, those emits reject and the rejection propagates out of the finally — masking any in-flight result, converting a cancelled/ended turn into an unexpected error path, and running before cancelAllPendingReverseRequests() in the same block (later statements skipped on throw), leaving pending reverse-request timers alive.
- **Fix:** Wrap the final flush in a catch (best-effort emit) so teardown errors are logged, not thrown; preserve the original run error/stopReason semantics.
- **Evidence:** finally { stopIdleFlusher(); await flushHoldbacks(); input.signal.removeEventListener(...); cancelAllPendingReverseRequests() } — no try/catch around the awaited flush.

## [LOW] correctness — sdk/src/services/acp/acp-agent.ts:1100 — limitNdJsonLineBytes conflates chunk boundaries with line boundaries — over-count can close legitimate connections
- **Risk:** When a read chunk contains a newline, the guard resets currentLineBytes to 0 after enqueueing the whole chunk, so bytes of the NEXT line that arrived in that same chunk are first charged to the PREVIOUS line's total and then discarded. A client whose legitimate chunk straddles a line boundary while the previous line is near the 16 MiB cap gets its connection errored even though no single line exceeded the limit (false positive). No false negative (under-count) was identified, so this is availability, not security.
- **Fix:** Track the count of the current line and reset it at each newline within the chunk (residual = bytes after the last newline), rather than resetting per chunk that contains any newline.
- **Evidence:** currentLineBytes += chunkCost; if (value.includes(0x0a)) { currentLineBytes = 0 } — the pre-newline bytes of the chunk are charged to the previous line's count and then discarded.

## [LOW] dependency-hygiene — sdk/src/mcp/server.ts:1290 — MCP SDK zod-v3 internals vs hoisted zod 4 force a schema-shim cast — fragile dependency-coupling workaround
- **Risk:** The hoisted zod 4 is incompatible with the MCP SDK's bundled zod-v3-typed schemas, so the code registers a re-declared schema through a double cast. This is a latent upgrade hazard: an MCP SDK update that changes the tools/call wire shape (e.g. adds required params fields) will silently bypass the local schema, and the cast disables typechecking of the hand-maintained duplicate contract.
- **Fix:** Pin the MCP SDK to a zod-4-compatible major (or add a peer-dependency resolution/constraint test) so the shim can be removed; add a regression test that fails when the SDK's bundled zod version drifts.
- **Evidence:** CALL_TOOL_REQUEST_SCHEMA_V4 comment documents the runtime -32603 failure ('undefined is not an object (evaluating def.valueType._zod)') and the `as unknown as typeof CallToolRequestSchema` cast.

## [LOW] api-contract — sdk/src/mcp/server.ts:950 — Documented ABI break: createMcpServer return type narrowed to structural { connect, close }; serve config surface omits containment options
- **Risk:** createMcpServer now returns only { connect, close } instead of the concrete MCP SDK Server, breaking consumers that used setRequestHandler/transport/on* on the returned object. The change is intentional and documented, but it is an exported-signature break on a public surface; similarly runServe's option set (no projectRoot) is a config-surface gap relative to what createAcpAgent supports.
- **Fix:** Keep the documented narrowing but add projectRoot/allowedAdditionalDirectories to RunServeOptions (see the SEC-7 finding) so the serve config surface is complete; version the ext-v1 result schemas when shapes change.
- **Evidence:** export interface McpServer { connect(transport: unknown): Promise<void>; close(): Promise<void> } with the MIGRATION NOTE above it; RunServeOptions exposes only client/sessionData/agentId/credentialEnv/transport/logger/signal.

## [LOW] performance — sdk/src/serve/bridge.ts:155 — Per-session notification-tracking maps in the process-wide bridge grow without bound; per-frame TextEncoder allocation
- **Risk:** createServeBridge's lastGateStateJson, lastCapabilitiesJson, and lastCapabilitiesPushAt Maps are keyed by sessionId and never cleaned when sessions end; since one bridge instance serves every socket connection for the process lifetime, these grow without bound. In OutboundQueue, byteSizeOf constructs a new TextEncoder for every frame measurement (hot path on every enqueue/re-measure), adding avoidable allocation churn.
- **Fix:** Reuse a module-level TextEncoder; clear the per-session bridge maps when a session's connection closes (or store them on a per-connection object).
- **Evidence:** lastGateStateJson/lastCapabilitiesJson/lastCapabilitiesPushAt are declared at createServeBridge scope and only ever .set(); no delete or LRU. byteSizeOf: `new TextEncoder().encode(JSON.stringify(frame)).byteLength` per frame.

## Coverage receipt

### Subsystems
- sdk-acp-protocol
- sdk-serve-bridge
- sdk-serve-transports
- sdk-mcp-server
- common-mcp-client
- common-mcp-dns-pinning

### Features
- SEC-4-unix-socket-auth
- SEC-7-project-root-containment
- SEC-3-SSRF-guard-client-origin
- NEW-1-mcp-origin-registry
- NEW-3-credential-holdback
- NEW-4-sanitize-outbound-chokepoint
- NEW-6-sensitive-path-redaction
- NEW-7-dns-rebinding-pinning
- sec12_6-frame-limits-backpressure
- GV-24-replay-no-rawIO
- GV-27-holdback-no-split
- GV-28-chokepoint
- ext-v1-dispatch
- journal-replay
- approval-bridge
- ask-user-elicitation-bridge
- mcp-read-tools
- apply-edits-mutations

### Files
- sdk/src/services/acp/acp-agent.ts
- sdk/src/services/acp/extensions.ts
- sdk/src/services/acp/ext-methods.ts
- sdk/src/services/acp/session-data.ts
- sdk/src/serve/bridge.ts
- sdk/src/serve/event-bridge.ts
- sdk/src/serve/outbound.ts
- sdk/src/serve/outbound-filter.ts
- sdk/src/serve/socket-listener.ts
- sdk/src/serve/serve.ts
- sdk/src/mcp/server.ts
- common/src/mcp/dns-pinning.ts
- common/src/mcp/client.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
