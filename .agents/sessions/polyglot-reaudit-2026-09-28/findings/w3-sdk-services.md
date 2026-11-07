# Audit findings: w3-sdk-services

- Subsystems: sdk
- Features: memory-v2, harness-enforcement, browser-tools, filesystem-authority, agent-loading, skills-loading, repository-identity, acp-session-data, change-review-bundle, model-discovery, serve-outbound-filter, task-memory-v1
- Files covered: 22
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — sdk/src/services/memory-v2/operator-service.ts:499 — [BEST] Operator allEvents hard-fails at 10k events, so compaction can never run when its own 20k threshold fires
- **Risk:** MAX_CANONICAL_EVENTS=10_000 (line 56) makes allEvents throw 'Canonical event limit exceeded' once a project passes 10k events. compact(), consolidate(), correct(), revalidate(), repair() and exportManifest() all call allEvents first. COMPACTION_EVENT_COUNT_THRESHOLD=20_000 (line 60) means the compaction warning can only be produced after compaction has already become impossible: the store grows without bound and every operator command returns 'failed/internal' for large, long-lived repos (monorepos in any language hit this first).
- **Fix:** Make the operator stream pages (cursor-resumable, like v1-migration findMigrationMarker) and fold projections incrementally instead of materializing all events; or at minimum raise the cap above the compaction threshold and have compact() select candidates from a repository-side projection (selectGCandidates/inspectForGC) without a full export. Add a test that seeds >10k events and asserts compact preview/apply succeed.
- **Evidence:** operator-service.ts: const MAX_CANONICAL_EVENTS = 10_000; const COMPACTION_EVENT_COUNT_THRESHOLD = 20_000; allEvents(): if (events.length > MAX_CANONICAL_EVENTS) throw new Error('Canonical event limit exceeded'); compact() begins with const events = await this.allEvents(request.projectId).

## [HIGH] state-mutation — sdk/src/services/task-memory-store.ts:771 — [BEST] Task-memory cross-process lock is never reclaimed; one crash permanently disables V1 memory saves
- **Risk:** acquireRecordLock only retries createFileExclusive 50x20ms and returns undefined; there is no stale-owner check. The withMemoryFileLock docstring says an old lock is reclaimed after the owner pid is proven dead, but no such code exists. A process killed inside the section (SIGKILL, OOM, laptop sleep) leaves task-memory.json.lock forever; every later saveMergedTaskMemory returns undefined and pruneStaleTaskMemoryEvidence reports write-failed, silently, across all future sessions.
- **Fix:** Port the pid-liveness + rename-verified reclaim from LocalHarnessStore (isFilesystemLockOwnerDead / reclaimStaleFilesystemLock) into acquireRecordLock using the pid already recorded in RecordLockPayload, or better, move both stores onto one shared lock primitive (and later the P6-T5 daemon lease). Add a test with a lock file owned by a dead pid.
- **Evidence:** acquireRecordLock: for (attempt < LOCK_ACQUIRE_ATTEMPTS) { try { await fs.createFileExclusive(lockPath, token) ... } catch { await sleep(LOCK_RETRY_DELAY_MS) } } return undefined. Docstring above withMemoryFileLock: 'An old same-host lock is reclaimed only after its recorded owner process is proven dead' - no implementation.

## [HIGH] security — sdk/src/services/acp/session-data.ts:354 — [BEST] ACP journal path built from unsanitized sessionId (path traversal via session/load)
- **Risk:** appendJournalLine, rewriteJournal and restoreFromJournal build `${dir}/${sessionId}.jsonl` directly. ACP session ids arrive from the client (session/load, extension methods). A sessionId like '../../.ssh/authorized_keys' or an absolute-ish value lets a client read arbitrary *.jsonl-suffixed files into memory or append/truncate files outside journalDir (rewriteJournal truncates with writeFile).
- **Fix:** Validate sessionId against a strict token regex (e.g. ^[A-Za-z0-9._-]{1,128}$, not '.'/'..') or hash it for the filename; resolve and assert the final path is inside journalDir. Add traversal tests for all three call sites.
- **Evidence:** const filePath = `${dir}/${sessionId}.jsonl`; await appendFile(filePath, ...); await writeFile(`${dir}/${sessionId}.jsonl`, contents); text = await readFile(`${dir}/${sessionId}.jsonl`, 'utf8'). No validation of sessionId anywhere in the class.

## [HIGH] security — sdk/src/tools/browser-logs.ts:2130 — [LANG][BEST] Browser can navigate to file:// and read local secrets, bypassing read-policy; P5-T7 egress/sandbox still open
- **Risk:** normalizeBrowserUrl passes any scheme through (`/^[a-z][a-z0-9+.-]*:/`), so navigate/start/tab create accept file:///home/u/.ssh/id_rsa, file:///...project/.env, chrome://, view-source:. snapshot/evaluate then return document text to the model, bypassing isMandatorySensitiveReadPath entirely. Chrome runs unsandboxed from egress: any page JS or `evaluate` can exfiltrate. On Linux root/CI chromeSandboxArgs also disables Chrome's own sandbox.
- **Fix:** Short term: allowlist http/https/about:blank (and data: only if needed); reject file:, chrome*, devtools:, view-source:, javascript:. Enforce with Fetch.enable request interception so redirects and in-page navigations are also checked. P5-T7 mechanism: keep TS+shim but put Chrome inside the OS sandbox (bwrap/landlock on Linux, sandbox-exec on macOS, AppContainer on Windows) with no filesystem view beyond a tmp profile, and enforce egress via a local allowlisting proxy (--proxy-server + --proxy-bypass-list='<-loopback>') rather than Chrome flags alone; --host-resolver-rules is a useful second layer. This is best-possible; a WASM/remote browser is not.
- **Evidence:** normalizeBrowserUrl: if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed. action.type 'start'|'navigate' -> Page.navigate { url }. snapshotScript returns document.body.innerText.slice(0,12000). PLAN.md:130 '[ ] P5-T7 Browser tool runs inside the shim with an egress allowlist.'

## [HIGH] security — sdk/src/services/harness-enforcement.ts:171 — [POLY][BEST] High-impact command classifier is anchored at ^ and TS/JS-centric; trivial prefixes and non-JS ecosystems bypass approvals
- **Risk:** Every rule is ^-anchored on the whole normalized command, so `cd api && git push origin main`, `FOO=1 git push`, `sudo rm -rf x`, `bash -c 'cargo publish'`, `(git push)` are unclassified and skip approval. Ecosystem gaps: migrations miss `python manage.py migrate`, `rake/bin/rails db:migrate`, `mix ecto.migrate`, `diesel migration run`, `sqlx migrate run`, `goose up`, `dotnet ef database update`, `php artisan migrate`; releases miss `twine upload`, `gem push`, `poetry publish`, `mvn deploy`, `gradle publish`, `dotnet nuget push`, `go`-module tagging via `gh release`; arbitrary-code misses `bash -c`, `sh -c`, `pwsh -c`, `php -r`, `lua -e`, `Rscript -e`, `npx/pnpm dlx/bunx/uvx/pipx run` (remote code); dependency-install misses `python -m pip install`, `gem install`, `conda/mamba install`, `brew install`, `apt(-get) install`.
- **Fix:** Tokenize with a shell parser (e.g. shell-quote or a small POSIX lexer) and classify EVERY simple command in lists/pipelines/subshells after stripping env assignments, sudo/env/exec/command wrappers and `-c` payloads (recursively). Move the per-ecosystem verb tables into data (shared with inspect_environment ecosystem detection) and add table-driven tests per language.
- **Evidence:** const push = command.match(/^git\s+push(?:\s+(.+))?$/i); migration regex only prisma|knex|sequelize|rails db:migrate|alembic|flyway|liquibase; arbitrary-code: /^(?:(?:node|bun|deno)\s+(?:-e|--eval)|python(?:3)?\s+-c|ruby\s+-e|perl\s+-e)\b/.

## [MEDIUM] security — sdk/src/serve/outbound-filter.ts:30 — [BEST] Outbound redactor only knows OpenRouter/Anthropic/OpenAI; BYOK for any other provider leaks
- **Risk:** ENV_KEY_PAIR_RE covers three env names and PROVIDER_SECRET_RE only sk- shapes. Keys for Gemini (AIza...), Groq (gsk_), xAI (xai-), Mistral, DeepSeek, Together, Fireworks, custom openai-compatible apiKeyEnv, GitHub tokens (ghp_/github_pat_), AWS AKIA/ASIA, Bearer headers and PEM private keys pass through, although operator-service.ts already has patterns for several of these. 'KEY: value' and quoted forms are also missed.
- **Fix:** Share one redaction module (common) used by both operator-service export and serve; add generic `[A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*value`, AIza[0-9A-Za-z_-]{35}, gsk_, xai-, ghp_/github_pat_, AKIA/ASIA, Bearer, PEM blocks; also redact the literal values of every configured provider apiKeyEnv read at startup. Keep patterns linear and extend outbound-filter.test.ts.
- **Evidence:** const ENV_KEY_PAIR_RE = /(OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)=\S+/g; const PROVIDER_SECRET_RE = /sk-or-v1-...|sk-ant-...|sk-[A-Za-z0-9]{20,}/g. operator-service.ts defines GITHUB_TOKEN, AWS_ACCESS_ID, BEARER_TOKEN, PRIVATE_KEY_PEM separately.

## [MEDIUM] correctness — sdk/src/tools/get-change-review-bundle.ts:133 — [POLY] Porcelain parsing breaks on quoted/non-ASCII/space paths, silently dropping files from review and snapshot identity
- **Risk:** `git status --porcelain` (without -z) C-quotes paths with non-ASCII bytes, quotes, or control chars when core.quotePath is on (the default): e.g. "src/\303\251t\303\251.py". line.slice(3) keeps the quotes and octal escapes, so fs.existsSync fails in buildSnapshotId and the file's bytes are never hashed, and files[] shows mangled names that never match ownership/validation records. The committed-diff fallback regex /^diff --git a\/.+ b\/(.+)$/ has the same issue and mis-splits paths containing ' b/'. Users with non-English filenames (common in CJK, European repos) get incomplete review evidence.
- **Fix:** Use `git status --porcelain=v1 -z -uall` and `git diff --name-only -z HEAD~1 HEAD` and split on NUL (handling the rename source/destination pair); or pass `-c core.quotePath=false` at minimum. Add a test with a non-ASCII and a space-containing untracked file.
- **Evidence:** runGit(['status', '--porcelain', '-uall']) ... .map((line) => line.slice(3).split(' -> ').at(-1)?.trim()); buildSnapshotId: if (!fs.existsSync(absolute) || ...) continue.

## [MEDIUM] performance — sdk/src/tools/get-change-review-bundle.ts:36 — [POLY][BEST] Review bundle has no generated/lockfile awareness and buffers unbounded diffs and file bytes
- **Risk:** No classification of lockfiles (Cargo.lock, go.sum, poetry.lock, uv.lock, Gemfile.lock, composer.lock, packages.lock.json, pnpm-lock.yaml, Package.resolved, mix.lock, pubspec.lock) or generated files (*.pb.go, *_pb2.py, vendor/, target/, build/). Lockfile churn consumes the 80k-char presentation budget ahead of source diffs, and reviewers get no signal that a file is generated. Separately, buildSnapshotId runs `git diff --binary HEAD` whose full stdout runGit accumulates as one string, then readFileSync's every changed file whole (untracked binaries, datasets, model weights) - unbounded memory.
- **Fix:** Reuse classifyMemoryArtifactPath (already used by memory-v2) or a shared generated/lockfile policy to tag files and order/truncate lockfile hunks last (summarize as 'lockfile: N lines changed'). Hash the diff by streaming git stdout into the hash and hash files via streamed reads with a size ceiling; honor .gitattributes linguist-generated.
- **Evidence:** getChangeReviewBundle: gitStatus({ include_diff: true, max_chars: params.max_chars ?? 80_000 }); buildSnapshotId: hash.update(fullDiff.stdout); hash.update(fs.readFileSync(absolute)). git-status.ts runGit: stdout += chunk.toString('utf8') with no cap.

## [MEDIUM] api-contract — sdk/src/services/repository-identity.ts:36 — [POLY] Workspace identity requires Git; non-git or non-Git-VCS workspaces cannot use review bundles or the harness store
- **Risk:** resolveWorkspaceIdentity throws when `git rev-parse` fails, so get_change_review_bundle, workspace-journal, mutation broker and inspect_workspace fail for plain directories, Mercurial/Sapling/Jujutsu/Perforce/Fossil checkouts, and fresh `cargo new --vcs none` projects. canonicalRoot = dirname(gitCommonDir) is also wrong for submodules (.git/modules/<name>) and --separate-git-dir layouts. Monorepo packages all share one repositoryId, which is fine, but there is no sub-project identity.
- **Fix:** Fall back to a filesystem identity (hash of canonical realpath + a persisted .openbuff/workspace-id) when git is unavailable, returning vcs: 'none'|'git'|'jj'|'hg'; derive canonicalRoot from `git rev-parse --show-superproject-working-tree`/--show-toplevel rather than dirname(commonDir). Make review bundle degrade to file-hash snapshots without git.
- **Evidence:** if (root.exitCode !== 0 || commonDir.exitCode !== 0) { throw new Error(... 'Unable to resolve Git repository identity.') } ... canonicalRoot: path.dirname(gitCommonDir).

## [MEDIUM] api-contract — sdk/src/agents/load-agents.ts:64 — [POLY][LANG] Agents can only be authored as executable TS/JS modules; P9-T1 agent.yaml still open
- **Risk:** agentFileExtensions = .ts/.tsx/.js/.mjs/.cjs and loading is dynamic import(). A Python/Go/Rust user must write TS to define an agent, and project agents are arbitrary code execution (hence includeProjectAgents defaults false, which means repo-shipped agents are ignored by default). Skills (SKILL.md) are already language-neutral, so agents are the outlier. Planned mechanism (declarative agent.yaml validated against dynamic-agent-template schema, P9-T1) is the right one; confirm.
- **Fix:** Implement P9-T1: accept agent.yaml/.yml/.json in the same walk, parse (YAML 1.2 safe schema, no custom tags), validate with the existing DynamicAgentTemplate zod schema, and allow declarative project agents WITHOUT includeProjectAgents because they are data, not code. Programmatic handleSteps stays TS-only or delegates to P9-T2 hook executables over JSON-RPC stdio.
- **Evidence:** const agentFileExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']); return import(`${pathToFileURL(fullPath).href}${urlVersion}`); PLAN.md:185 '[ ] P9-T1 Declarative agent.yaml/JSON agents'.

## [MEDIUM] security — sdk/src/skills/load-skills.ts:238 — [BEST] Project skills load from untrusted repos by default while project agents require opt-in
- **Risk:** includeProjectSkills defaults to true, so any cloned repo's .agents/skills and .claude/skills SKILL.md content is injected into the model's available-skills context without a trust decision. Skills are prompt instructions (they can direct terminal commands), so this is a prompt-injection channel; trust posture is inconsistent with loadLocalAgents' includeProjectAgents=false. Also no size cap on SKILL.md content and statSync follows symlinks out of the repo.
- **Fix:** Gate project skills on the same workspace-trust decision as project agents (or at least mark them origin:'project' and surface to the user on first load); cap file size; lstat and refuse symlinks escaping the skills root.
- **Evidence:** const { ..., includeProjectSkills = true, ... } = options; content = fs.readFileSync(skillFilePath, 'utf8') with no size limit; load-agents.ts: includeProjectAgents = false.

## [MEDIUM] performance — sdk/src/services/local-harness-store.ts:226 — [BEST] Harness store lock busy-waits with Atomics.wait on the main thread for up to 5s
- **Risk:** withFilesystemLock is fully synchronous and spins with Atomics.wait(10ms) up to LOCK_TIMEOUT_MS=5000 while another process holds the lock, freezing the event loop (TUI rendering, ACP serve socket, CDP pipe reads, abort signals) under multi-process contention. writeJsonAtomic also never fsyncs file or directory, so a crash after rename can leave an empty/partial record that listWithDiagnostics then quarantines as corrupt.
- **Fix:** Provide an async lock path (setTimeout backoff) for callers on the main thread, or move lease ownership to the P6-T5 daemon; fsync the temp file before rename and the directory after.
- **Evidence:** Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MS); const LOCK_TIMEOUT_MS = 5_000; writeJsonAtomic: fs.writeFileSync(tempPath, ...); fs.renameSync(tempPath, filePath) with no fsync.

## [MEDIUM] correctness — sdk/src/services/memory-v2/coordinator.ts:413 — [POLY] Chunk ids from symbols strip all non-ASCII, collapsing Unicode identifiers into colliding ids; facets lowercase paths
- **Risk:** normalizeChunkHint sanitizes symbol names with /[^A-Za-z0-9._:-]/g -> '_', so identifiers in Rust/Go/Swift/Kotlin/Python/Java that use non-ASCII letters (e.g. Japanese, Greek, accented names) become '____:12'; two distinct symbols at the same line in different captures, or overloaded names, get equal chunkIds and dedupe/verify against each other. operator-service selectorFacet lowercases paths, merging Foo.go and foo.go on case-sensitive filesystems during consolidation.
- **Fix:** Keep Unicode letters (\p{L}\p{N} with the u flag) or encode the symbol (hash suffix) in the chunkId; stop lowercasing paths in selectorFacet unless the workspace filesystem is case-insensitive. For P8-T8 FTS5, use the unicode61 tokenizer with remove_diacritics plus a trigram index (or tokenchars for '_') so non-ASCII and snake/camel identifiers match lexically.
- **Evidence:** const sanitized = rawSymbol.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 64); selectorFacet: `file:${selector.path.replaceAll('\\', '/').toLowerCase()}`.

## [LOW] state-mutation — sdk/src/model-discovery.ts:399 — [BEST] Model discovery cache is a non-atomic read-modify-write with unbounded raw payloads
- **Risk:** writeModelDiscoveryCache reads, mutates and writeFileSync's the shared ~/.config/openbuff cache without temp+rename or lock; two openbuff processes refreshing different providers lose one update, and a crash mid-write leaves a truncated file (silently treated as empty). Every model's full `raw` JSON is persisted (OpenRouter lists hundreds of models), and the file is written with default umask rather than 0o600.
- **Fix:** Write via temp file + rename with mode 0o600, re-read under a short lock, and drop or bound `raw`.
- **Evidence:** const cache = readModelDiscoveryCache(); cache[result.providerId] = result; fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n'); DiscoveredModel.raw: item.

## [LOW] api-contract — .agents/sessions/polyglot-roadmap-v2/PLAN.md:187 — [LANG] Confirm P9-T2 hooks over JSON stdio and P6-T5 Rust daemon leases; specify protocol and migrate ad-hoc locks
- **Risk:** Stdio JSON executables inside the sandbox are the best polyglot mechanism (any language, no toolchain requirement); WASI components would exclude most ecosystem tooling and should only be an optional hermetic tier. Risk is under-specification: without a versioned JSON-RPC 2.0 envelope, timeouts, exit-code semantics and a JSON Schema per hook event, hook authors in other languages will diverge. Separately, three independent lock implementations exist today (LocalHarnessStore dir locks, task-memory file locks, in-process FilesystemAuthority locks) that P6-T5 leases should replace.
- **Fix:** Define hooks as JSON-RPC 2.0 over stdio with a published JSON Schema per event, protocolVersion negotiation, per-hook timeout, and structured receipts (as PLAN notes). Make P6-T5 own leases with fencing tokens and turn LocalHarnessStore/task-memory locking into daemon clients with the current fs locks as fallback.
- **Evidence:** PLAN.md:187 P9-T2 'running executables over a JSON stdin/stdout contract inside the sandbox'; PLAN.md:138 P6-T5 'owns leases with fencing tokens'; local-harness-store.ts withFilesystemLock and task-memory-store.ts acquireRecordLock are separate implementations.

## Coverage receipt

### Subsystems
- sdk

### Features
- memory-v2
- harness-enforcement
- browser-tools
- filesystem-authority
- agent-loading
- skills-loading
- repository-identity
- acp-session-data
- change-review-bundle
- model-discovery
- serve-outbound-filter
- task-memory-v1

### Files
- sdk/src/services/memory-v2/coordinator.ts
- sdk/src/services/memory-v2/operator-service.ts
- sdk/src/services/memory-v2/v1-migration.ts
- sdk/src/services/harness-enforcement.ts
- sdk/src/services/local-harness-store.ts
- sdk/src/services/task-memory-store.ts
- sdk/src/services/repository-identity.ts
- sdk/src/services/acp/session-data.ts
- sdk/src/tools/browser-logs.ts
- sdk/src/tools/cdp-pipe-transport.ts
- sdk/src/tools/filesystem-authority.ts
- sdk/src/tools/read-policy.ts
- sdk/src/tools/mutation-capabilities.ts
- sdk/src/tools/git-status.ts
- sdk/src/tools/get-change-review-bundle.ts
- sdk/src/agents/load-agents.ts
- sdk/src/skills/load-skills.ts
- sdk/src/model-discovery.ts
- sdk/src/impl/agent-runtime.ts
- sdk/src/serve/outbound-filter.ts
- common/src/util/sensitive-paths.ts
- .agents/sessions/polyglot-roadmap-v2/PLAN.md

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
