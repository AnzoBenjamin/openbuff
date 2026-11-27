# N04 (web parts) — Typed web_search and read_docs failures (receipt)

**Status:** implemented. This covers the web parts of N04 only: the DuckDuckGo blocked page and read_docs/Context7. The other N04 items (memory short-circuit, LSP, kill_job, failover warning, compaction) belong to other owners.

Findings: web-media-evals-03 (blocked page indistinguishable from "no results"), web-media-evals-06 (every Context7 failure becomes "No documentation found", `Bearer undefined`).

## Changed files
- `packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts`: new `WebSearchFailure` type (`status: 'blocked' | 'error'`, `reason`, `nextStep`, `httpStatus?`, `retryAfterSeconds?`) and `isDuckDuckGoBlockedPage` (anomaly-modal, anomaly.js, "bots use DuckDuckGo too", challenge-form, captcha, "unusual traffic"). `executeWebSearch` returns `blocked` for HTTP 429/403 (with Retry-After). It also returns `blocked` for an empty parse when the page is HTTP 202 or matches the markers. A page that has results is never flagged. It takes an optional `egress` seam.
- `packages/agent-runtime/src/tools/handlers/tool/web-search.ts`: error output now carries `status`, `reason`, `nextStep` and `retryAfterSeconds`. A genuine empty results page returns `status: 'no_results'` and keeps the old message.
- `common/src/tools/params/tool/web-search.ts`: optional `status`/`reason`/`nextStep`/`retryAfterSeconds` on the error branch of the output schema.
- `packages/agent-runtime/src/llm-api/context7-api.ts`: new `searchLibrariesOutcome` and a typed `Context7Failure` (`auth_required`, `rate_limited` with `retryAfterSeconds`, `timeout`, `cancelled`, `network_error`, `unavailable`, `invalid_response`, `not_found`). Each failure has a reason and a next step naming `CONTEXT7_API_KEY` where relevant. `fetchContext7LibraryDocumentation` returns `{ ok: true, … } | Context7Failure` instead of `null`. `searchLibraries` keeps its null-on-failure contract as a wrapper. The `Authorization` header is omitted when no key is set (blank counts as unset), so `Bearer undefined` is never sent. The key comes from `readContext7ApiKey(env)` or the explicit `context7ApiKey` param. That param is deliberately not named `apiKey`, so the runtime's provider key, which every handler receives as `apiKey`, cannot reach Context7. An optional `signal` is combined with the 10 s timeout.
- `packages/agent-runtime/src/tools/handlers/tool/read-docs.ts`: passes the handler `signal` through. On failure it returns `status`, `reason`, `nextStep`, `httpStatus` and `retryAfterSeconds`. Only `not_found` uses the "No documentation found" wording.
- `common/src/tools/params/tool/read-docs.ts`: optional `errorMessage`/`status`/`reason`/`nextStep`/`httpStatus`/`retryAfterSeconds` in the output schema.
- `packages/agent-runtime/src/llm-api/__tests__/context7-api.test.ts`: the null assertions for `fetchContext7LibraryDocumentation` are replaced by typed statuses, and 7 new negative cases were added.
- `docs/environment-variables.md`: documents `CONTEXT7_API_KEY` and the `auth_required`/`rate_limited` behavior.

## Tests added
- `packages/agent-runtime/src/tools/handlers/tool/__tests__/web-search.test.ts` (new, 7 tests, through `handleWebSearch`).
- `packages/agent-runtime/src/tools/handlers/tool/__tests__/read-docs.test.ts` (new, 4 tests, through `handleReadDocs`).
- 7 new cases in `context7-api.test.ts`.

## Acceptance (web clauses of N04)
| Clause | Result | Test |
|---|---|---|
| DuckDuckGo bot/blocked page returns `blocked`, with reason and next step | met | web-search.test.ts: anomaly page on HTTP 202 and on HTTP 200; HTTP 429 with Retry-After 30 gives `retryAfterSeconds: 30` |
| Blocked is distinct from no results | met | "a real empty results page stays no_results"; "results pages are returned normally" |
| Context7 with no key gives `auth_required` and no `Bearer undefined` | met (see note) | read-docs.test.ts "no key + 401…"; context7-api.test.ts "no key: sends no Authorization header…", "blank CONTEXT7_API_KEY counts as unset" |
| Other failures distinct from "no documentation" | met | `rate_limited` (429 + Retry-After), `unavailable` (500/503), `timeout`, `network_error`, `invalid_response`, `cancelled` (caller signal), `not_found` (empty search or no content) |
| Provider key never leaks to Context7 | met | read-docs.test.ts "the runtime provider apiKey is never sent to Context7" |

Note on `auth_required`: with no key, the request is sent anonymously instead of being refused up front, because Context7 also serves unauthenticated requests at a lower rate limit. Refusing up front would break `read_docs` for users who have no key today. When Context7 answers 401/403, the result is `auth_required` with "CONTEXT7_API_KEY is not set" and a "Set CONTEXT7_API_KEY…" next step. A no-key 429 suggests setting the key for a higher limit. If the reviewer wants a hard `auth_required` with no request when the key is unset, that is a one-line change in `searchLibrariesOutcome`.

## Commands run
- `cd packages/agent-runtime && bun test src/tools/handlers/tool/__tests__/web-search.test.ts src/tools/handlers/tool/__tests__/read-docs.test.ts`: 11 pass, 0 fail.
- `cd packages/agent-runtime && bun test src/llm-api/__tests__/context7-api.test.ts`: 21 pass, 0 fail.
- Combined web set (5 files): 47 pass, 0 fail. `tsc --noEmit` for agent-runtime and common: 0 errors.
- Live DuckDuckGo search through the pinned path returned 5 results (no false `blocked`).

## Not done / follow-ups
- The `max_tokens` floor of 10,000 in `read_docs` (web-media-evals-06) was not changed, because it is not in N04's scope text.
- The key is read with `readContext7ApiKey(process.env)` at call time. agent-runtime has no env DI snapshot for tool handlers yet. The `context7ApiKey` param is the injection seam.
- Search backends (Brave/Tavily/etc., web-media-evals-03 fix) and removing the dead `LINKUP_API_KEY` CI secret are later roadmap items.
- Edits outside "web" ownership: `common/src/tools/params/tool/web-search.ts` and `read-docs.ts` (additive optional output-schema fields), `docs/environment-variables.md` (one line), `common/knowledge.md` (one line).
