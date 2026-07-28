# Audit findings: read-and-path

- Subsystems: sdk-read-tools, agent-runtime-read-subtree, common-path-security
- Features: read-files, read-policy, read-subtree, sensitive-path-policy, project-path-containment
- Files covered: 6

## [MEDIUM] dependency-hygiene — common/src/util/sensitive-paths.ts:10 — [B] SOFTEN — .crt/.cer public certificates treated as secrets
- **Risk:** SENSITIVE_EXTENSIONS includes '.crt' and '.cer'. These are X.509 public certificates — the public half of a keypair, distributed openly (CA bundles, server certs, chain files). They contain no secret material. Blocking them stops legitimate work: reading a TLS chain to debug a handshake, inspecting a bundled CA cert, verifying a pinned cert in test fixtures. This is pure friction with no secret-protection payoff; the private material lives in .pem/.key/.p12/.pfx/.jks/.keystore, which remain blocked.
- **Fix:** Remove '.crt' and '.cer' from SENSITIVE_EXTENSIONS. Keep '.pem','.key','.p12','.pfx','.jks','.keystore' (these carry private keys). Optionally, if a repo really ships a private key with a .crt name, rely on the explicit host fileFilter rather than a blanket extension ban.
- **Evidence:** const SENSITIVE_EXTENSIONS = new Set(['.pem','.key','.p12','.pfx','.jks','.keystore','.crt','.cer']) — used at isMandatorySensitiveReadPath line 52 via SENSITIVE_EXTENSIONS.has(extension).

## [MEDIUM] correctness — common/src/util/sensitive-paths.ts:57 — [B] SOFTEN — basename.includes('kubeconfig') substring match over-blocks docs/scripts
- **Risk:** The kubeconfig guard uses a substring includes() over the basename, so any file whose name merely mentions kubeconfig is blocked: 'setup-kubeconfig.sh', 'kubeconfig-guide.md', 'generate-kubeconfig.ts', 'kubeconfig.example'. None of these contain live cluster credentials, yet the agent cannot read the setup script or the doc it needs to do the task. The friction hits exactly the files an agent is most likely to want when working on cluster tooling.
- **Fix:** Match the actual credential file, not the substring: block basename === 'kubeconfig' or basename.endsWith('.kubeconfig') (and the conventional '~/.kube/config' when seen), rather than basename.includes('kubeconfig'). Real kubeconfig files remain blocked; scripts/docs about them become readable.
- **Evidence:** return ( envFile || ... || basename.includes('kubeconfig') || basename.includes('.tfstate') )

## [LOW] correctness — common/src/util/sensitive-paths.ts:58 — [B] SOFTEN — basename.includes('.tfstate') over-matches templates/examples
- **Risk:** The tfstate guard also uses substring includes(), so 'terraform.tfstate.example', 'my.tfstate.md', or a doc named 'about-tfstate-files.md' get blocked even though they hold no real state/secrets. Legitimate templates and documentation about state files become unreadable.
- **Fix:** Anchor to the real artifacts: basename.endsWith('.tfstate') || basename.endsWith('.tfstate.backup'). This still blocks generated state and its backup while allowing example/doc files. Real .tfstate is a genuine KEEP target (it embeds resource attributes/secrets), so only the matching precision is loosened.
- **Evidence:** basename.includes('.tfstate') — substring match on the lowercased basename.

## [LOW] dependency-hygiene — common/src/util/sensitive-paths.ts:18 — [B] SOFTEN — '.yarnrc' / '.yarnrc.yml' blocked wholesale
- **Risk:** SENSITIVE_BASENAMES bans '.yarnrc' and '.yarnrc.yml' outright. Modern Yarn config (nodeLinker, plugins, packageExtensions, yarnPath) is overwhelmingly non-secret and is exactly the kind of file an agent must read to reason about dependency resolution or workspace layout. Secrets in Yarn are the exception (npmAuthToken lines), unlike '.npmrc' where _authToken is common. Blocking the whole file for a rare secret line is high friction / low value.
- **Fix:** Drop '.yarnrc' and '.yarnrc.yml' from the mandatory list (keep '.npmrc','.pypirc','.netrc','.htpasswd','auth.json','credentials'). If token leakage from Yarn config is a concern, prefer a content-aware redaction/host fileFilter over a blanket basename ban.
- **Evidence:** SENSITIVE_BASENAMES = new Set(['.htpasswd','.netrc','credentials','.npmrc','.yarnrc','.yarnrc.yml','auth.json','.pypirc','terraform.tfvars','.terraformrc'])

## [MEDIUM] correctness — sdk/src/tools/path-utils.ts:17 — [B] SOFTEN — absolute in-project paths rejected before containment runs
- **Risk:** isSafeProjectRelativePath() rejects every path.isAbsolute(input) up front, and read-files calls it as a hard gate in authorizeReadTarget (returns outside_project) before any containment check. But the canonical containment layer resolveProjectPath() already accepts absolute inputs and correctly resolves+contains them (it path.resolve()s absolute inputs and rejects only those that escape the root). So an absolute path that points squarely inside the project (e.g. a path an agent copied from a stack trace or a tool that emits absolute paths) is refused purely on form, not on any real boundary. This is friction: the read is safe but the surface pre-rejects it.
- **Fix:** Let containment be the authority: allow absolute inputs through isSafeProjectRelativePath (still reject NUL bytes, '..' traversal, and Windows drive/UNC ambiguity if genuinely unsupported) and rely on resolveProjectPath/resolveFilePathForFileSystemOperation to reject only paths that actually resolve outside the real project root. The security property is unchanged; the form-based rejection is removed.
- **Evidence:** if ( path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('//') ) { return false } — and read-files authorizeReadTarget: if (!isSafeProjectRelativePath(requestedPath)) return outside_project.

## [MEDIUM] performance — sdk/src/tools/read-files.ts:39 — [B] SOFTEN — MAX_RANGE_READ_BYTES = 1MB forces multiple round-trips on large-file ranges
- **Risk:** For files above the 10MB whole-file gate, ranged reads are the only way in, and each range is capped at 1MB. A reviewer wanting a 3–4MB slice of a large generated file, lockfile, or bundled artifact must issue several sequential range calls and stitch them mentally. This is a throughput tax on legitimate large-file inspection, not a security control — the file is already in-project and already passed sensitive/ignore policy.
- **Fix:** Raise MAX_RANGE_READ_BYTES to ~4MB (still well under the 10MB whole-file ceiling and any context budget), or make it a caller-tunable parameter. Keep the per-range bound so a single request can't stream an unbounded window; only the size is loosened.
- **Evidence:** export const MAX_RANGE_READ_BYTES = 1_048_576 — passed to readTextRange(fs, operationPath, startLine, endLine, MAX_RANGE_READ_BYTES) and enforced via range.data.byteLength > MAX_RANGE_READ_BYTES.

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/read-subtree.ts:27 — [B] SOFTEN — LIVE_SUBTREE_MAX_NODES = 1000 truncates large-directory scans
- **Risk:** The live subtree scan admits at most 1000 nodes, then marks the result truncated and tells the agent to 'Request a narrower subtree path.' In a monorepo or a large package dir, a single legitimate 'show me this subtree' call gets cut off and the agent must fan out into many narrower calls to see the whole tree — the exact serial round-tripping the tool exists to avoid. The cap is a resource guard, not a security boundary (sensitive/ignore/containment checks are separate and stay).
- **Fix:** Raise the default (e.g. 5000) and/or accept a maxNodes input on read_subtree so callers can opt into a larger scan when they know the directory is big. Retain the hard reservation mechanism (reserveNode) so the scan still terminates deterministically — only the ceiling moves.
- **Evidence:** const LIVE_SUBTREE_MAX_NODES = 1000 — enforced in reserveNode(): if (scan.count >= LIVE_SUBTREE_MAX_NODES) { scan.truncated = true; return false }.

## [LOW] performance — sdk/src/tools/read-files.ts:38 — [B] SOFTEN — READ_SNAPSHOT_CONCURRENCY = 8 throttles large read batches
- **Risk:** Both path authorization and snapshot reads run at a fixed concurrency of 8. For a batch of dozens of files (common when an agent pulls a whole feature's worth of sources at once), reads serialize into waves of 8. This is a mild latency tax; it protects against fd/memory pressure but is conservative for typical SSD-backed local reads.
- **Fix:** Raise to ~16, or derive from available parallelism / make it configurable. Low urgency — this is comfort friction, not a blocker, and the current value is safe.
- **Evidence:** export const READ_SNAPSHOT_CONCURRENCY = 8 — used in mapWithConcurrency for both authorizeReadTarget and readCanonicalSnapshot fan-out.

## [LOW] correctness — sdk/src/tools/read-files.ts:240 — [B] SOFTEN — UTF-16 and non-UTF-8 text reads hard-refused
- **Risk:** decodeText() refuses UTF-16 (BOM check) with UNSUPPORTED_ENCODING and rejects any non-strict-UTF-8 bytes via TextDecoder({fatal:true}). UTF-16 files are common on Windows (PowerShell output, some editors) and Latin-1/CP-1252 source files still exist. These are legitimate in-project text files an agent may need to read; refusing them is a capability gap with no security value (a secret in a UTF-16 file is not protected by refusing all callers — it's just unreadable to everyone).
- **Fix:** Add a fallback decode path: honor the UTF-16LE/BE BOM and decode it; for non-fatal UTF-8 failures, attempt a lenient decode (or latin1) and flag the file as re-encoded rather than erroring outright. Keep the binary (NUL-byte) refusal — that one is correct.
- **Evidence:** if ((bytes[0]===0xff && bytes[1]===0xfe) || (bytes[0]===0xfe && bytes[1]===0xff)) return unsupported_encoding ... new TextDecoder('utf-8',{fatal:true}).decode(bytes) → catch → unsupported_encoding.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/read-subtree.ts:300 — [B] SOFTEN — read_subtree hard-blocks gitignored paths, inconsistent with read_files
- **Risk:** In buildLiveNode, a gitignored path (isFileIgnored) is returned as a 'blocked' FilesystemError (with an isAgentSessionArtifactPath exception). But read-files deliberately treats ignore as 'a discovery preference, not an authorization boundary' and allows explicit reads of ignored files. So an agent can read a specific ignored file with read_files but cannot see it via read_subtree — two read surfaces disagree on the same file. Ignored build outputs (dist/, generated/) are sometimes exactly what needs inspecting.
- **Fix:** Align the two surfaces: in read_subtree, omit ignored paths from broad auto-listing but do not hard-error an explicitly requested ignored path — or downgrade the ignore result from 'blocked' to an informational/skipped status so explicit inspection stays possible. Keep the mandatory-sensitive and containment checks as the real boundaries.
- **Evidence:** if (normalizedRelativePath && !isAgentSessionArtifactPath(normalizedRelativePath) && (await isFileIgnored({filePath, projectRoot, fs: liveFs}))) return { ok:false, error: subtreeError('blocked', 'Path is ignored by the authorized filesystem policy: ...', false) } — vs read-files.ts comment: 'Ignore files are a discovery preference, not an authorization boundary.'

## [LOW] security — common/src/util/sensitive-paths.ts:47 — [C] KEEP — .env / .env.* denial (templates excluded)
- **Risk:** Blocks '.env' and '.env.*' while excluding '.env.example/.sample/.template' via isEnvTemplatePath. .env files are the single most common home for live application secrets (DB URLs, API keys). Reading them yields real credentials.
- **Fix:** No change. This is a true secret-protection control and correctly whitelists templates so agents can still read example env files. Retain.
- **Evidence:** const envFile = (basename === '.env' || basename.startsWith('.env.')) && !isEnvTemplatePath(portable); return ( envFile || ... )

## [LOW] security — common/src/util/sensitive-paths.ts:54 — [C] KEEP — private-key and credential-file denials (id_rsa, .pem/.key/.p12/.pfx/.jks/.keystore, _credentials, real .tfstate, .htpasswd/.netrc/.npmrc/.pypirc/auth.json/credentials)
- **Risk:** These match files that hold live private keys and credentials: SSH private keys (id_rsa/ed25519/dsa/ecdsa, .pub excluded), PKCS/JKS keystores, netrc/htpasswd/pypirc/npmrc auth tokens, AWS-style 'credentials', and Terraform state (which embeds resource secrets). Reading any of them exposes real secret material.
- **Fix:** No change to intent — retain these denials. (The precision fixes noted separately for kubeconfig/.tfstate/.yarnrc/.crt/.cer only tighten matching; the core private-key/credential coverage stays.)
- **Evidence:** /^id_(rsa|ed25519|dsa|ecdsa)/.test(basename) && !basename.endsWith('.pub') || basename.endsWith('_credentials') ... SENSITIVE_BASENAMES + SENSITIVE_EXTENSIONS private-key entries.

## [LOW] security — common/src/util/project-path-containment.ts:101 — [C] KEEP — resolveProjectPath containment (traversal, sibling-prefix, symlink escape)
- **Risk:** resolveProjectPath rejects '..' traversal, absolute-outside paths, sibling-prefix escapes (e.g. '/repo-evil' vs root '/repo' via path.relative semantics), and symlink dereferences whose realpath lands outside the real project root, while still allowing in-project symlinks that stay inside the repo. This is the actual outside-project boundary and it is precise (it does NOT reject in-project symlinks or files whose names start with '..', e.g. '..config').
- **Fix:** No change. This is high-value, correctly-scoped containment; removing or loosening it would allow reads outside the project. Retain. (Note it already permits legitimate in-project symlinks and sibling-name edge cases, so it is not over-strict.)
- **Evidence:** relativeLexical === '..' || relativeLexical.startsWith('..' + path.sep) || path.isAbsolute(relativeLexical) || relativeLexical.split(path.sep).includes('..') → null; and symlink check: realRelative === '..' || realRelative.startsWith('..'+sep) || path.isAbsolute(realRelative) → null.

## [LOW] performance — sdk/src/tools/read-files.ts:41 — [C] KEEP — MAX_FILE_BYTES = 10MB whole-file ceiling (with range fallback)
- **Risk:** Files over 10MB cannot be read whole; the tool returns too_large with a 'read an exact bounded range instead' recovery and range reads still work. 10MB of text is far beyond any reasonable context window, so a whole-file read of a larger file would either blow the context or be truncated anyway. The ceiling is a genuine resource/context guard and it degrades gracefully (ranges remain available).
- **Fix:** No change. The ceiling is generous and has a clean range-based escape hatch, so it is not meaningful friction. Retain. (If anything, pair this with the MAX_RANGE_READ_BYTES bump above so the range fallback is less chatty.)
- **Evidence:** const MAX_FILE_BYTES = 10 * 1024 * 1024; if (sizeBytes > MAX_FILE_BYTES) { ... return too_large '... exceeds 10MB limit. Read an exact bounded range instead.' } with recovery: 'read_smaller_range'.

## [LOW] security — sdk/src/tools/read-policy.ts:11 — [C] KEEP — isReadPathBlocked composition (mandatory-sensitive OR host fileFilter)
- **Risk:** isReadPathBlocked composes the mandatory sensitive-path policy with the host-supplied fileFilter over both raw and lowercased aliases, and read-files' authorizeReadTarget applies the same alias check against both the requested and canonical relative paths. This is the correct fail-closed composition point for secret protection and host policy; the alias/case handling closes casing-bypass gaps.
- **Fix:** No change. This is the enforcement seam that makes the KEEP denials effective and lets hosts add their own blocks. Retain.
- **Evidence:** return aliases.some(isMandatorySensitiveReadPath) || Boolean(fileFilter && aliases.some(alias => fileFilter(alias).status === 'blocked')) — mirrored in read-files authorizeReadTarget with uniquePolicyAliases(resolved.relativePath, canonicalRelative).

## Coverage receipt

### Subsystems
- sdk-read-tools
- agent-runtime-read-subtree
- common-path-security

### Features
- read-files
- read-policy
- read-subtree
- sensitive-path-policy
- project-path-containment

### Files
- sdk/src/tools/read-policy.ts
- sdk/src/tools/read-files.ts
- sdk/src/tools/path-utils.ts
- common/src/util/sensitive-paths.ts
- common/src/util/project-path-containment.ts
- packages/agent-runtime/src/tools/handlers/tool/read-subtree.ts
