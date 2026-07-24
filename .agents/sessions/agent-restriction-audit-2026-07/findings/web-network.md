# Audit findings: web-network

- Subsystems: agent-runtime-web-search, researcher-agents, terminal-command-policy-network
- Features: web-search-tool, url-fetch, ssrf-guard, researcher-web, researcher-docs
- Files covered: 6

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:5 — [B] MAX_WEB_FETCH_BYTES = 512 KB truncates real documentation pages
- **Risk:** The 512,000-byte hard cap on the raw response body is applied before HTML is stripped. Many legitimate public docs pages (MDN references, API references, single-page framework docs, GitHub rendered files) ship well over 512 KB of raw HTML, so the agent silently loses the tail of the page or (when content-length is declared) gets a hard error. This is friction against the tool's core value: fetching real documentation. It is NOT an SSRF control — SSRF is enforced separately by assertSafePublicWebUrl.
- **Fix:** Soften: raise MAX_WEB_FETCH_BYTES to roughly 2 MB (2_000_000). This keeps a sane memory bound while covering the large majority of real docs pages. The streaming reader already caps memory incrementally, so a larger ceiling does not change the worst-case buffering shape materially.
- **Evidence:** web-search-utils.ts:5 `export const MAX_WEB_FETCH_BYTES = 512_000`; consumed as the default in readResponseTextWithLimit (line ~113) and by both the search and URL-fetch branches of web-search.ts.

## [MEDIUM] performance — packages/agent-runtime/src/tools/handlers/tool/web-search.ts:19 — [B] MAX_FETCH_LENGTH = 50 KB truncates stripped page text too aggressively
- **Risk:** After HTML stripping, the returned content is truncated to 50,000 characters with a '[Content truncated]' marker. For a large API reference or long tutorial, 50 KB of plain text is easily exceeded, so the agent loses the second half of a page it explicitly asked to read. This compounds with the 512 KB raw cap: a big page can be cut twice. Pure output-shaping limit, no security role.
- **Fix:** Soften: raise MAX_FETCH_LENGTH to ~150_000–200_000 characters. This still bounds the model context contribution but lets typical long docs pages return whole. Optionally make it proportional to the raw byte cap chosen above.
- **Evidence:** web-search.ts:19 `const MAX_FETCH_LENGTH = 50_000`; applied at line ~101 `content.length > MAX_FETCH_LENGTH ? content.slice(0, MAX_FETCH_LENGTH) + '...[Content truncated ...]'`.

## [LOW] correctness — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:113 — [B] Declared content-length over the cap causes a hard error instead of truncation
- **Risk:** readResponseTextWithLimit throws `Response exceeds N byte limit` whenever the server declares a content-length larger than maxBytes, but a server that omits content-length streams and is gracefully truncated instead. This is an inconsistent, over-strict outcome: two equivalent large pages behave differently based solely on whether the origin sent a content-length header, and a well-behaved large docs host (which sets content-length) is the one that fails outright. Real value lost with no security benefit — the stream is already capped byte-by-byte below.
- **Fix:** Soften: on declared-length-over-limit, do not throw. Fall through to the streaming reader and let it truncate to maxBytes with truncated=true, matching the no-content-length path. Only the streamed cap is needed to bound memory.
- **Evidence:** web-search-utils.ts:~113 `if (Number.isFinite(declaredLength) && declaredLength > maxBytes) { await params.response.body?.cancel(); throw new Error('Response exceeds ...') }` versus the streaming branch below that sets `truncated = true` gracefully.

## [LOW] performance — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:3 — [C/B] WEBSEARCH_TIMEOUT_MS = 30 s is acceptable; keep, minor bump optional
- **Risk:** A 30-second overall timeout covers both DuckDuckGo search and single-page fetch. It is generally adequate; slow origins occasionally exceed it but rarely. Aggressively lowering would hurt; there is no strong case to raise it either since a hung fetch shouldn't stall an agent step indefinitely.
- **Fix:** Keep at 30 s. If deep-research flows report timeouts against slow-but-legitimate hosts, a modest bump to 45 s for the URL-fetch branch (not search) is the minimal relaxation. No change required otherwise.
- **Evidence:** web-search-utils.ts:3 `export const WEBSEARCH_TIMEOUT_MS = 30_000`; used as default AbortSignal.timeout in executeWebSearch and combined via AbortSignal.any in web-search.ts URL and search branches.

## [LOW] api-contract — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:6 — [C] MAX_WEB_FETCH_REDIRECTS = 5 — keep
- **Risk:** Manual redirect handling caps at 5 hops and re-validates every hop through assertSafePublicWebUrl (this is a real SSRF defense against redirect-to-internal, verified by the 'revalidates redirect destinations' test). Five hops is enough for normal canonicalization/shortener chains.
- **Fix:** Keep. The per-hop revalidation is essential SSRF protection and must not be relaxed. If legitimate multi-hop chains ever fail, 8–10 is a safe ceiling, but no evidence this is hit today.
- **Evidence:** web-search-utils.ts:6 `MAX_WEB_FETCH_REDIRECTS = 5`; fetchPublicWebUrl loops with `redirect: 'manual'` and calls `assertSafePublicWebUrl(new URL(location, current).href)` each hop; test 'revalidates redirect destinations' confirms 127.0.0.1 redirect is rejected after 1 fetch.

## [LOW] security — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:63 — [C] SSRF host/IP blocking (localhost, metadata, private/link-local/reserved ranges) — KEEP
- **Risk:** isBlockedWebAddress + assertSafePublicWebUrl block loopback, RFC1918, CGNAT (100.64/10), link-local (169.254), cloud metadata (169.254.169.254 and named metadata hosts), IPv6 ULA/link-local/mapped, TEST-NET and multicast, plus http-auth credentials and non-http(s) schemes, and resolves DNS to catch rebinding. This is the core SSRF guard and is explicitly out of scope for relaxation.
- **Fix:** Keep entirely. No relaxation. The default-deny in isBlockedWebAddress (returns true for anything that isn't a parseable public IPv4/IPv6) is correct fail-closed behavior.
- **Evidence:** web-search-utils.ts:63 `isBlockedWebAddress`, :74 `assertSafePublicWebUrl` (protocol check, credentials check, BLOCKED_HOSTNAMES + .localhost/.local/.internal suffix check, isIP branch, async lookup + blocked-address scan). Covered by web-search-security.test.ts 'blocks loopback...' and 'rejects unsafe URL forms'.

## [LOW] security — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:90 — [C] .local / .internal / .localhost suffix + credential + non-HTTP(S) blocks — keep
- **Risk:** These reject non-public TLD suffixes (mDNS .local, private .internal, .localhost), URLs carrying user:password credentials, and any non-http(s) scheme (file:, gopher:, etc.). None of these correspond to legitimate public documentation hosts; .local/.internal are reserved for private networks and credential-in-URL fetches are an exfil/SSRF vector.
- **Fix:** Keep. The only conceivable friction is a real API that requires HTTP basic auth embedded in the URL, but that is not a documentation-browsing use case and embedding secrets in a fetched URL is undesirable regardless. No relaxation.
- **Evidence:** web-search-utils.ts:~90 suffix checks `hostname.endsWith('.localhost'|'.local'|'.internal')`; :~83 `parsed.username || parsed.password` credential reject; :~79 protocol reject. Tests assert 'file:///etc/passwd' -> 'HTTP(S)' and 'user:secret@8.8.8.8' -> 'credentials'.

## [LOW] security — agents/researcher/researcher-web.ts:96 — [C] researcher-web lexical SSRF pre-check (isSsrfUrl) — keep as defense-in-depth
- **Risk:** researcher-web performs its own lexical SSRF check on any URL extracted from the prompt (PRIVATE_HOST_BLOCKLIST, isPrivateIpv4/Ipv6) and falls back to query mode instead of URL mode when unsafe. It cannot do async DNS (serialized generator), so it is intentionally a lexical layer in front of the backend's authoritative DNS-aware guard. There is no domain allowlist here — sourceDomains is only an optional `site:` query hint, not a restriction — so no legitimate public host is blocked.
- **Fix:** Keep. This is redundant-but-correct defense in depth and blocks nothing public. No allowlist to relax. Note only.
- **Evidence:** researcher-web.ts:96 comment 'SSRF guard (C1.8)'; PRIVATE_HOST_BLOCKLIST set (~line 104), isPrivateIpv4/isPrivateIpv6, isSsrfUrl (~line 150); URL chosen as `rawUrl && !isSsrfUrl(rawUrl) ? rawUrl : undefined`. sourceDomains used only via `site:${domain}` in withControls.

## [LOW] api-contract — agents/researcher/researcher-docs.ts:27 — [C] researcher-docs has no domain allowlist / scheme block of its own
- **Risk:** researcher-docs only declares toolNames ['read_docs'] and imposes no allowlist or scheme restriction itself; egress safety is delegated to the read_docs backend (Context7). Nothing here over-blocks legitimate documentation.
- **Fix:** Keep. No restriction surface to relax in this file. Note only for coverage completeness.
- **Evidence:** researcher-docs.ts full file: `toolNames: ['read_docs']`, no fetch/allowlist logic; instructions only govern how the single read_docs call is used.

## [LOW] security — sdk/src/tools/terminal-command-policy.ts:729 — [C] Read-only network-mutation ban (curl -d/-X POST, wget -O) — KEEP (owned by terminal-policy shard)
- **Risk:** In read-only mode the policy rejects `curl` with -X POST/PUT/PATCH/DELETE or -d/--data/-T/--upload-file and `wget -O/--output-document`, with message 'network mutation is not allowed in read-only mode'. This blocks state-changing/exfil network calls and file-writing downloads while read-only. It correctly does not block plain read GETs. Detailed treatment belongs to the terminal-policy shard.
- **Fix:** Keep. Consistent with read-only semantics; blocking write/mutation verbs and -O file writes is appropriate. Defer any nuance (e.g. allowing curl -o /dev/stdout style reads) to the terminal-policy shard. Note only.
- **Evidence:** terminal-command-policy.ts:729 regex `/^(?:git\s+clone|curl\b...(?:-X (POST|PUT|PATCH|DELETE)|-d|--data|-T|--upload-file)|wget\b...(-O|--output-document))/i` paired with :730 message 'network mutation is not allowed in read-only mode'.

## Coverage receipt

### Subsystems
- agent-runtime-web-search
- researcher-agents
- terminal-command-policy-network

### Features
- web-search-tool
- url-fetch
- ssrf-guard
- researcher-web
- researcher-docs

### Files
- packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/web-search.ts
- agents/researcher/researcher-web.ts
- agents/researcher/researcher-docs.ts
- packages/agent-runtime/src/tools/handlers/tool/__tests__/web-search-security.test.ts
- sdk/src/tools/terminal-command-policy.ts
