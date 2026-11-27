# Shard `web-media-evals` — web, media and quality infrastructure

Snapshot: working tree at HEAD on 2026-11-12 (uncommitted B19/B20 work present; none of it touches the files cited below except `evals/buffbench/*` runner/environment files). Read-only audit. The only commands that executed code were throwaway `bun` probes written to `/tmp` and deleted afterwards. They imported repo modules and, in one case, bound a loopback listener. Nothing was written into the repository.

## Scope

Inspected (Scope A, tools):
- `common/src/tools/params/tool/{web-search,read-docs,browser-logs,render-ui,3d-assets,read-image}.ts`
- `packages/agent-runtime/src/tools/handlers/tool/{web-search,web-search-utils,read-docs,browser-logs,render-ui,3d-assets,read-image}.ts`
- `packages/agent-runtime/src/llm-api/context7-api.ts` and its test
- `packages/agent-runtime/src/tools/handlers/tool/__tests__/web-search-security.test.ts`
- `common/src/browser-actions.ts` (schema head), `common/src/tools/browser-policy.ts` (the brief's `sdk/src/browser-policy.ts` does not exist; this is the actual file), `packages/agent-runtime/src/tools/__tests__/browser-policy.test.ts`
- `sdk/src/tools/read-image.ts`, `sdk/src/tools/browser-logs.ts` (grep only, 4,266 lines), `sdk/src/impl/model-provider.ts:549-590` (vision routing)
- `common/src/constants/images.ts`, `cli/src/utils/image-handler.ts`, `cli/src/utils/clipboard-image.ts`, `cli/src/commands/image.ts`, `cli/src/commands/command-registry.ts:520-535`, `cli/src/components/{message-footer,feedback-container}.tsx`
- `agents/browser-use/browser-use.ts`, `agents/researcher/{researcher-web,researcher-docs}.ts`, `agents/base2/tool-tiers.ts`, `packages/agent-runtime/src/util/base2-tool-tiers.ts`, `agents/base2/base2.ts:515-532`
- `docs/execution/body-roadmap/researcher-web-agent-browser.md`, `docs/execution/body-roadmap/STATE.md`, `docs/agents-and-tools.md:200-225`, `common/src/mcp/dns-pinning.ts` (head, for comparison)

Inspected (Scope B, quality infrastructure):
- `evals/README.md`, `evals/package.json`, `evals/.gitignore`, `evals/buffbench/` (listing, `main*.ts`, `run-buffbench.ts` grep, `runners/codebuff.ts` grep), `evals/scripts/trigger-buffbench.ts`
- `.github/workflows/{ci,evals,buffbench,nightly-evals,nightly-e2e}.yml`
- `docs/testing.md` (headings, harness section), `agents/tool-reachability.test.ts` (head), `agents/e2e/`, `e2e-traces/`, `test/fixtures/body/`
- Root hygiene: `.gitignore`, `git ls-files` / `git check-ignore` / `git status` for every root artifact named in the brief.

Prior work consulted, not repeated: `body-capability-review-2026-11-05/findings/11-evals-release.md`, `findings/13-perception.md`, `PLAN.md` cards B30–B35; sibling shards `read-search.md` (read_image) and `extensions.md` (MCP SSRF).

Skipped: the full `sdk/src/tools/browser-logs.ts` CDP implementation and `sdk/src/tools/3d-assets.ts` (B33/B35 and 13-F2…F7 already cover them; I spot-checked that the cited defects are still there). I also skipped the `rust/` workspace and the release workflows (other shards own them). I did not run any LLM or eval, so every eval-quality claim below is a static claim.

## Feature inventory

| Feature | Entrypoint | Implementation | Tests | Maturity |
|---|---|---|---|---|
| Web search (`web_search` query mode) | `common/.../web-search.ts:8` | `web-search-utils.ts:186-215` (DuckDuckGo HTML scrape only) | `web-search-security.test.ts` (1 parse test) | partial |
| Web fetch (`web_search` url mode) | same tool, `url` param | `web-search.ts:70-145`, `fetchPublicWebUrl` `web-search-utils.ts:105-133` | `web-search-security.test.ts` (SSRF/redirect/cap) | partial (SSRF bypass, no markdown, no binary guard) |
| Library docs (`read_docs`, Context7) | `common/.../read-docs.ts` | `read-docs.ts`, `context7-api.ts` | `context7-api.test.ts` | partial |
| Web research agent | `researcher-web` (spawn only) | `agents/researcher/researcher-web.ts` | via reachability test only | partial |
| Docs research agent | `researcher-docs` (spawn only) | `agents/researcher/researcher-docs.ts` | — | partial |
| Browser automation (`browser_logs`) | `common/.../browser-logs.ts` + `browser-actions.ts` | runtime `browser-logs.ts`, SDK `sdk/src/tools/browser-logs.ts` (CDP) | `browser-use.test.ts`, `browser-policy.test.ts`, SDK browser tests | useful (B33 defects open) |
| Browser agent | `browser-use` (spawn only) | `agents/browser-use/browser-use.ts` | `browser-use.test.ts` | useful |
| Model image read (`read_image`) | `common/.../read-image.ts` | SDK `read-image.ts` | `sdk/src/__tests__/read-image.test.ts` | partial (see read-search-06) |
| User image input | `/image`, paste, drag-drop | `cli/src/utils/{image-handler,clipboard-image,pending-attachments}.ts` (Jimp compression) | CLI tests | useful |
| Vision routing for non-vision BYOK models | implicit | `sdk/src/impl/model-provider.ts:286-298,549-590` | — (not inspected) | useful |
| `render_ui` button widget | `common/.../render-ui.ts` | runtime `render-ui.ts:14` (unconditional ack), CLI `components/tools/render-ui.tsx` | `render-ui.test.tsx` | partial |
| 3D inspect/preview/edit | `common/.../3d-assets.ts` | runtime `3d-assets.ts`, SDK `3d-assets.ts` (Blender) | SDK blender tests | partial (B35) |
| BuffBench (commit reconstruction, LLM-judged) | `evals/buffbench/main*.ts` | `run-buffbench.ts`, `judge.ts`, `runners/` (incl. `external:claude/codex/opencode`) | `evals/buffbench/__tests__/` | useful, manual-only |
| Deterministic sibling evals (retention, fidelity, memory) | `bun test` under `evals/` | `evals/{compaction-*,memory-retention}` | themselves | useful |
| Public benchmarks (Terminal-Bench, SWE-bench, Aider polyglot) | — (`test:swe-bench` script points at a missing file) | — | — | absent |
| CI eval regression gate | `evals.yml`, `nightly-evals.yml`, `buffbench.yml` | — | — | unwired/broken |
| User feedback capture | `/feedback`, footer feedback button | `command-registry.ts:528-535`, `feedback-container.tsx:18,34` | — | absent (disabled) |
| Telemetry export (OTel) | — | — | — | absent |

## Findings

### web-media-evals-01 — `web_search` SSRF guard is bypassed by IPv4-mapped IPv6 literals (confirmed live)
- **Axis:** reliability (security). **Severity:** HIGH.
- **Evidence:** `packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts:43-60`. `isBlockedIpv6` only matches the dotted form `::ffff:a.b.c.d` (line 47). WHATWG `URL` normalizes `http://[::ffff:127.0.0.1]/` to hostname `[::ffff:7f00:1]`. That form falls through to the first-hextet checks, which see `0` and allow it. Probe output: `http://[::ffff:127.0.0.1]/`, `http://[::ffff:a9fe:a9fe]/` (169.254.169.254, cloud metadata), `[::7f00:1]` and `[64:ff9b::7f00:1]` all returned ALLOWED. A probe also ran `fetchPublicWebUrl` against a `Bun.serve` on 127.0.0.1 through `http://[::ffff:127.0.0.1]:<port>/`. It returned `200 INTERNAL-SECRET`, while the plain `127.0.0.1` control was refused. Redirect targets go through the same check (`:125`), so a public page can 302 to the mapped metadata address. The MCP blocklist has the same gap: `isBlockedMcpAddress('::ffff:7f00:1')` returns false (`common/src/mcp/client.ts`, used by `common/src/mcp/dns-pinning.ts:4`).
- **Impact:** A prompt-injected page or search result can make the model, through `researcher-web`, read local dev servers, admin consoles or the cloud metadata endpoint. The tool returns the body to the model.
- **Fix:** Parse with `net.BlockList` or `ipaddr.js` and unmap `::ffff:0:0/96`, `::/96` and `64:ff9b::/96` before applying the v4 rules. Share one classifier between web fetch and MCP. Add the four literals above as test vectors in `web-search-security.test.ts:14`.
- **Prior:** new. The 13-perception and 11-evals findings do not cover web egress.

### web-media-evals-02 — DNS check and connect are separate lookups (rebinding window)
- **Axis:** reliability (security). **Severity:** MEDIUM.
- **Evidence:** `web-search-utils.ts:92` calls `lookup()` to validate the host. Then `:115` calls `fetch(current)`, which resolves again. The repo already contains a pinned design for MCP: `common/src/mcp/dns-pinning.ts:183,273` (`resolvePinnedMcpAddress`, `createPinnedMcpFetch`). Web fetch does not use it.
- **Impact:** A low-TTL hostname can pass the check and then connect to a private address.
- **Fix:** Route `fetchPublicWebUrl` through a pinned-address fetch, generalizing `createPinnedMcpFetch`.
- **Prior:** new. The roadmap note `researcher-web-agent-browser.md` contract 3 says static-fetch SSRF checks should not be assumed to carry over to the browser path. It does not address this gap in the static path.

### web-media-evals-03 — Search is a single, keyless DuckDuckGo HTML scrape with no BYOK backend option
- **Axis:** completeness / reliability. **Severity:** HIGH.
- **Evidence:** `web-search-utils.ts:186-215` fetches only `https://html.duckduckgo.com/html/`, and `parseDuckDuckGoHtml` (`:217-245`) scrapes result anchors with a regex. No provider, key or config exists. `rg` finds no Brave, Tavily, Exa, Serper or Linkup key in `docs/` or the env schema, and nothing in `docs/configuration.md` or `docs/local-mode.md`. When DDG serves its bot-check page instead of results, the parse returns `[]` and the handler reports `No search results found for "<query>"` (`web-search.ts:182-191`). The model cannot tell "blocked" from "no results". STATE.md and the roadmap note record "repeated limiting/throttling" from users (`researcher-web-agent-browser.md:7`). CI still injects a `LINKUP_API_KEY` secret (`.github/workflows/evals.yml`, `ci.yml:55`) that no code reads, which is a leftover from the hosted backend.
- **Impact:** Search, the main way the model gets current information, breaks silently under rate limits. Users who would pay for a reliable backend with their own key cannot configure one. That conflicts with the product's BYOK positioning.
- **Fix:** Add a `webSearch.provider` setting covering `duckduckgo` (default), `brave`, `tavily`, `exa`, `searxng` (self-hosted) and the native search of providers that ship it (Anthropic `web_search` server tool, OpenAI `web_search`, Gemini grounding). Detect the DDG anomaly/CAPTCHA page and return a typed `blocked` error with retry advice. Remove the dead `LINKUP_API_KEY` wiring.
- **Prior:** partially anticipated by B33 addendum RWEB-2 ("cache/backoff and explicit backend controls"), which plans a *browser* backend, not search providers. RWEB-1 to RWEB-4 are still pending (`STATE.md:109`).

### web-media-evals-04 — Web fetch flattens pages to one line and decodes binaries as text
- **Axis:** usability (model-facing). **Severity:** MEDIUM.
- **Evidence:** `stripHtml` (`web-search-utils.ts:270-283`) replaces every tag with a space and collapses `\s{2,}` to one space (`:281`). Headings, lists, tables and `<pre>` code blocks all lose their line structure. Only `text/html` is stripped (`web-search.ts:104`). A PDF, image or zip response is decoded with `TextDecoder` and returned as up to 150,000 characters of mojibake (`:20,107`). There is no `offset` or paging, so content past 150k characters cannot be reached. GitHub `/tree/<branch>` URLs resolve to the `HEAD` README rather than the branch (`:352-353`), and only `README.md` is tried, so `README.rst` or a lowercase `readme.md` returns a 404 error with no fallback.
- **Impact:** Documentation pages lose the code examples that matter most for a coding agent. A binary URL can burn about 37k tokens on garbage.
- **Fix:** Convert HTML to Markdown (for example Turndown or Readability plus a Markdown serializer) and keep `<pre>` blocks. Reject or summarize non-text content types with a typed error. Add `offset`/`max_chars` paging. Use the GitHub API README endpoint, which resolves any README filename and respects the branch.
- **Prior:** new.

### web-media-evals-05 — No first-class fetch for the main agent: every URL read is a sub-agent run
- **Axis:** usability / cohesion. **Severity:** MEDIUM.
- **Evidence:** `web_search`, `read_docs` and `browser_logs` appear in no base2 tier (`packages/agent-runtime/src/util/base2-tool-tiers.ts:30-97`). Base2 reaches the web only by spawning `researcher-web`, `researcher-docs` or `browser-use` (`agents/base2/base2.ts:520-530`). `researcher-web` always seeds a decomposition message and runs `STEP_ALL` (`agents/researcher/researcher-web.ts:229-262`), even for "read this URL".
- **Impact:** A user who pastes a URL pays for a whole sub-agent run (extra prompt and model calls) instead of one tool call. The model also has to know that "fetch" is hidden inside a tool called `web_search`. Claude Code (`WebFetch`), Gemini CLI (`web_fetch`), Kiro (`web_fetch`) and OpenCode (`webfetch`) all expose fetch directly (competitors/A.md §1.1, §3.1, Kiro §; B.md §1.1).
- **Fix:** Split `url` mode into a `web_fetch` tool and put `web_fetch` (and possibly `web_search`) in the base2 core or implement tier. Keep `researcher-web` for multi-source research.
- **Prior:** new.

### web-media-evals-06 — `read_docs` reports every failure as "No documentation found", and there is no key guidance
- **Axis:** reliability / usability. **Severity:** MEDIUM.
- **Evidence:** `context7-api.ts:122-133,154,191,295,322,367` returns `null` for non-OK status (401/429/5xx), timeouts, network errors and schema mismatches. The handler turns `null` into `No documentation found for "<lib>"` (`read-docs.ts:76-85`), and the tests encode this (`context7-api.test.ts:77,89`). The key comes from a raw `process.env['CONTEXT7_API_KEY']` (`:115,274`). When it is unset, the header is literally `Bearer undefined`. `CONTEXT7_API_KEY` is declared in `packages/internal/src/env-schema.ts:16` but is not documented in `docs/`. The handler has no abort `signal` (`read-docs.ts:13-31`), so cancellation waits up to 20 s (`context7-api.ts:9,14`). `max_tokens` has a floor of 10,000 (`common/.../read-docs.ts:24-27`), so every call costs at least about 10k tokens. `researcher-docs` is told to call it "only once" (`researcher-docs.ts:36`).
- **Impact:** The model concludes a library is undocumented when the key is missing or rate limited, and the user gets no hint to set a key.
- **Fix:** Return typed errors (`auth`, `rate_limited` with Retry-After, `timeout`, `not_found`). Omit the header when no key is set. Read the key through the env DI helper and document it in `docs/environment-variables.md`. Pass the signal through. Allow smaller `max_tokens`.
- **Prior:** new.

### web-media-evals-07 — Browser read-only policy still has two divergent sources of truth
- **Axis:** cohesion / reliability. **Severity:** MEDIUM.
- **Evidence:** The shared contract `common/src/tools/browser-policy.ts:22-34,42-49` allows `design_tokens`, `scroll` and `tab`, and treats an omitted policy as allow. Its only consumer is its own test (`packages/agent-runtime/src/tools/__tests__/browser-policy.test.ts`). The runtime handler keeps a private set without `design_tokens`, `scroll` or `tab` (`packages/agent-runtime/src/tools/handlers/tool/browser-logs.ts:39-49`) and denies whenever the policy is not exactly `'allow-interactions'`, so an omitted policy is denied (`:66-68`). The agent prompt and schema promise that an omitted policy means allow-interactions (`agents/browser-use/browser-use.ts:43-47,170`).
- **Impact:** `browser-use` is told it may click, gets denied, and loops on re-spawn. Read-only scroll and design-token audits are rejected.
- **Fix:** Have the handler call `isBrowserActionAllowed`, delete the private set, and add a dispatch-level test.
- **Prior:** 13-F1 / B33. **Still present at HEAD.**

### web-media-evals-08 — `render_ui` still acknowledges a render that never happened
- **Axis:** reliability. **Severity:** LOW (the widget is a link button only).
- **Evidence:** `packages/agent-runtime/src/tools/handlers/tool/render-ui.ts:14` returns `'UI rendered.'` unconditionally. The tool is mode-neutral (`agents/base2/tool-tiers.ts:86`), and its definition costs about 390 tokens (measured: schema 906 + description 640 characters) for one button widget.
- **Impact:** Headless and SDK hosts report a render that did not occur. The token cost is large relative to the value.
- **Fix:** As B33 says: return `submitted` or `unavailable` per host. Also consider gating the tool to the interactive CLI host only.
- **Prior:** 13-F9 / B33. **Still present at HEAD.**

### web-media-evals-09 — The model's image path and the user's image path use different pipelines
- **Axis:** cohesion. **Severity:** MEDIUM.
- **Evidence:** User attachments are compressed and resized with Jimp to at most 1 MB base64 (`cli/src/utils/image-handler.ts:116-160`; `common/src/constants/images.ts:106-108`). The model's `read_image` sends "original media" up to 10 MB each and 25 MB in total, with the MIME type taken from the file extension rather than from `detectImageMediaTypeFromBytes` (`sdk/src/tools/read-image.ts:21,203-224`; `images.ts:44`). `read_image` is also bundled into the `media_3d` tier with the Blender tools (`base2-tool-tiers.ts:90-95`), so screenshot review is tied to 3D.
- **Impact:** A screenshot the user can attach without trouble can fail as a provider 400 when the model reads it (Anthropic limits each image to 5 MB). A mislabeled `.png` that is really a JPEG fails the same way.
- **Fix:** Move the Jimp `compressIfNeeded` logic into `common` or the SDK and apply it in `read_image`. Detect MIME from magic bytes. Move `read_image` into core or the `implement` tier.
- **Prior:** the raw-bytes and BMP/TIFF part is read-search-06 (sibling shard). The cross-path inconsistency, MIME sniffing and tier placement are new.

### web-media-evals-10 — The `[buffbench]` commit workflow and several eval scripts point at deleted files
- **Axis:** reliability (test infrastructure). **Severity:** HIGH.
- **Evidence:** `.github/workflows/evals.yml:97` runs `bun run-eval-set --concurrency 10 --email`. That resolves to `bun run git-evals/run-eval-set.ts` (`evals/package.json` scripts), but `evals/git-evals/` does not exist. Other dead scripts in the same file: `test:manifold`, `test:pglite`, `test:swe-bench`, `test:e2e-cat-app`, `gen-repo-eval` (`git-evals/...`), `run-single-eval`, `run-git-evals`, `setup-codebuff-repo`. None of their targets exist (verified with `ls`). The package is still named `@codebuff/evals` with description "Evaluation scripts for Codebuff". `evals/README.md` correctly documents only `main`, `main-openbuff`, `run-buffbench` and `run-buffbench-nightly`.
- **Impact:** A developer who tags a commit `[buffbench]` to get an eval gets a failed job, and nothing is measured. The `test:swe-bench` name suggests a SWE-bench integration that does not exist.
- **Fix:** Point `evals.yml` at `main-openbuff.ts` or delete it. Prune the dead scripts and rename the package.
- **Prior:** new. B32 covers CI oracles but not these eval workflows.

### web-media-evals-11 — The nightly eval targets a nonexistent agent and produces no comparable signal
- **Axis:** reliability (regression signal). **Severity:** HIGH.
- **Evidence:** `evals/buffbench/main-nightly.ts:17` runs `agents: ['base2-free']`, and `main-single-eval.ts:10` uses `base2-free-deepseek-v4`. No agent with either ID exists (`rg "id: 'base2-free" agents/` finds nothing; base2 IDs are listed at `agents/base2/*.ts:5`). `main-nightly.ts` always calls `process.exit(0)` after printing to stdout. `nightly-evals.yml:50` uploads no artifact (no `upload-artifact` in the eval workflows; only `ci.yml:317` uploads one, for flakes). Nothing compares against a baseline: `compare-runs.ts` and `scripts/compare-buffbench-runs.ts` exist, but no workflow calls them. `buffbench.yml` is `workflow_dispatch` only. The PR CI (`ci.yml`) runs unit and integration tests only.
- **Impact:** Openbuff has no automatic regression signal for prompt or tool changes. The nightly run, if it runs at all, produces per-task failures that are printed and discarded, and it reports success. For a project whose stated goal is an "efficient learning agent" (AGENTS.md), this is the largest gap in the quality loop.
- **Fix:** Use `base2`. Upload `FINAL_RESULTS.json` as an artifact. Diff it against the last green nightly with `compare-runs.ts` (after the 11-F4 repair) and fail or comment when a fixed, small, cheap subset regresses past a declared noise band. Run that subset on PRs labeled `prompt`/`tools` or on paths under `agents/**` and `common/src/tools/**`.
- **Prior:** partially B30 (typed attempt evidence, accepted) and B31 (held-out trials, pending). Neither wires CI. The `base2-free` ID is new.

### web-media-evals-12 — No public-benchmark results or harness
- **Axis:** completeness. **Severity:** MEDIUM.
- **Evidence:** `rg -i "terminal.?bench|swe.?bench|polyglot|tbench|harbor"` outside JSON and session folders finds only the dangling `test:swe-bench` script (`evals/package.json`) and unrelated "polyglot" roadmap names. BuffBench is internal (commit reconstruction scored by LLM judges, `evals/README.md` §BuffBench). It does run competitor CLIs on the same tasks (`runners/{claude,codex,opencode}.ts`; `main-hard-tasks.ts:35` uses `['base2', 'external:claude']`).
- **Impact:** There is no externally comparable number. OpenCode (51.7%), Claude Code (52.1%) and Pi publish Terminal-Bench 2.0 scores (B.md §1.8, §3.8). Aider owns the polyglot board (B.md §2.8). LLM-judge scores on self-chosen commits cannot support "best agentic CLI" claims.
- **Fix:** Add a Terminal-Bench 2.0 adapter through Harbor. It is the cheapest option because Openbuff already has a headless `--json` SDK path. Optionally add an Aider-polyglot runner, which is deterministic (unit tests, no judge). Publish results with model, cost and repeat counts per B30's manifest rules.
- **Prior:** new. B31 targets held-out *internal* trials.

### web-media-evals-13 — The learning loop has no user-feedback input and no telemetry export
- **Axis:** completeness. **Severity:** MEDIUM.
- **Evidence:** `/feedback` (aliases `bug`, `report`) only prints "Remote feedback submission is unavailable" (`cli/src/commands/command-registry.ts:528-535`). The footer feedback UI is wired but force-disabled: `feedback-container.tsx:18,34` and `feedbackAvailable = false` (`message-footer.tsx:46`, `message-block.tsx:149`). Lesson extraction is off by default, and the proposal gate does not promote (11-evals strengths section, still true: `main*.ts` never pass `extractLessons`). The only local learning signals are the memory playbook counters and `.agents/analytics/retrieval.jsonl` (`docs/testing.md:176-177`). OpenTelemetry appears only in provider test scripts (`scripts/benchmark-providers.ts` etc.). Claude Code, Codex and Gemini all export OTel (A.md comparison table, line 506).
- **Impact:** A user who rates a turn good or bad produces no data. Nothing links a user verdict to the prompt, tool or lesson that produced the turn, so the "learning agent" goal has no ground-truth input.
- **Fix:** Enable the existing feedback UI to write a local JSONL record (message ID, agent/prompt version, tool trace hash, rating, note) under `.openbuff/`. Feed that file to `lessons-extractor` as a candidate source behind B31's held-out gate. Add opt-in OTLP export for usage, cost and tool outcomes.
- **Prior:** partially B31 (candidate channel). The feedback stub and missing OTel are new.

### web-media-evals-14 — CI test matrix omits `packages/code-map`
- **Axis:** reliability (test gaps). **Severity:** MEDIUM.
- **Evidence:** The `ci.yml:166-178` unit matrix lists `.agents, agents, cli, common, evals, packages/agent-runtime, packages/indexer, packages/internal, sdk, scripts`. `packages/code-map` has 11 `*.test.ts` files and no workflow references it (`rg "code-map" .github/workflows` finds nothing). `packages/build-tools` has no tests.
- **Impact:** Code-graph and symbol-mapping regressions, which feed `query_index` and LSP-style tools, are never caught in CI.
- **Fix:** Add `packages/code-map` to the matrix and keep the empty-discovery guard (`ci.yml:283`).
- **Prior:** new. B32 covers "nonempty integration discovery" but not this matrix omission.

### web-media-evals-15 — Docs drift for `researcher-web`, and the README is silent on web and media
- **Axis:** usability (user-facing docs). **Severity:** LOW.
- **Evidence:** `docs/agents-and-tools.md:205-221` describes a simple fast path under 60 characters and a cap of three `web_search` calls. The code has no cap and always runs `STEP_ALL` (`researcher-web.ts:229-262`; prompt text "There is no hard cap on searches"). `README.md` has no mention of web search, browser automation, image input or 3D tools (`rg -i "web|search|browser|image|screenshot" README.md` finds nothing). The fetch user agent still says `Codebuff/1.0` (`web-search.ts:87`) while search says `Openbuff/1.0` (`web-search-utils.ts:199`).
- **Impact:** Users cannot discover that these features exist or what they require (Chrome, Blender, Context7 key). Contributors are misled about researcher cost.
- **Fix:** Update the docs section. Add a README "Web, browser and media" section with prerequisites. Unify the user agent.
- **Prior:** new.

### web-media-evals-16 — Root and `evals/` hygiene
- **Axis:** cohesion (repo hygiene). **Severity:** LOW.
- **Evidence:**
  - Root logs (`full.log` 1.6 MB, `success.log` 1.6 MB, `tmp.log`, `tmp-prod.log` 1.5 MB, `tmp-{fail,nightly,smoke,smoke-upper,windows}.log`) are untracked and ignored by `**.log` (`.gitignore:21`). They are local clutter only.
  - `debug/` is ignored (`.gitignore:23`).
  - `scratch-logs/` contains only `*.log`, so it is effectively ignored, but the directory itself has no rule.
  - **`.tmp/` is untracked and not ignored.** It shows in `git status` as `?? .tmp/` and holds `b19-*.py`, `b21-*` logs and fixture directories, so `git add .` or `-A` would commit it.
  - `.aws/`, `.codex/`, `web/` (one `.env.local` symlink), `e2e-traces/` and `agents/e2e-traces/` are empty directories.
  - **`cli/src/index-05.tsx` is tracked.** It is a self-described OpenTUI 0.5 smoke probe (`cli/src/index-05.tsx:2-12`) that no script, `package.json` or CI references. It ships inside `cli/src` next to the real `index.tsx`.
  - **Both `bun.lockb` (tracked, dated May) and `bun.lock` are tracked**, and the CI cache key hashes both (`ci.yml` `hashFiles('**/bun.lock*')`).
  - `evals/.gitignore:5-6` ignores generated `*-judge-*` and `*-base2-error-*` JSON (128 and 60 files on disk), but 10 `*-base2-lite-error-*.json` files are tracked anyway (for example `evals/buffbench/restrict-tool-types-base2-lite-error-ftj2.json`). The rule `buffbench/*-base2-error-*.json` does not match the `-base2-lite-error-` names.
- **Fix:** Add `/.tmp/` and `/scratch-logs/` to `.gitignore`. Move `index-05.tsx` to `cli/scripts/` or delete it. `git rm` `bun.lockb` and the 10 tracked error JSONs. Widen the ignore glob to `buffbench/*-error-*.json`. Remove the empty directories.
- **Prior:** new.

## Competitive gaps

| Capability | Best-in-class and how | Openbuff state | Priority |
|---|---|---|---|
| Direct web fetch tool | Claude Code `WebFetch`: Markdown conversion, 15-min cache, domain allow rules, refuses localhost (A.md §1.1). Gemini `web_fetch` with private-IP validation (A.md §3.1). OpenCode `webfetch` with markdown/text/html `format` (B.md §1.1) | Hidden in `web_search` `url` mode, sub-agent only, tag-stripped text, SSRF bypass (01, 04, 05) | P0 |
| Reliable or pluggable search | Gemini grounded Google Search. Codex `web_search = cached/indexed/live`. OpenCode selectable provider integration (B.md §1.1, websearch.mdx) | DuckDuckGo HTML scrape only; blocks look like empty results (03) | P0 |
| Web permission rules | Claude `WebFetch(domain:x)` allow/deny. OpenCode `webfetch`/`websearch` permission actions (B.md §1.4) | No permission or egress setting for web tools (`rg web_search sdk/src` finds nothing) | P1 |
| Browser automation | Gemini built-in Browser Agent (persistent/isolated/existing profiles). OpenCode Desktop `browser` namespace with Lighthouse and traces | `browser-use` with about 25 CDP actions, pixel diff, APNG recording, PDF: broader than most | parity+ (fix B33) |
| Image input | Claude/Gemini: paste and Read auto-downscale. Codex `-i/--image`, `view_image` | Paste/drag/`/image` with Jimp compression; `read_image` uncompressed (09) | P1 |
| PDF / notebook read | Claude Read `pages`, `.ipynb`. Gemini `read_file` PDF/audio | Not in this shard's tools (browser `pdf` renders, but cannot read a local PDF) | P2 (read-search shard) |
| Public benchmark presence | OpenCode, Claude Code and Pi on Terminal-Bench 2.0. Aider polyglot board | None (12) | P1 |
| Regression gate for prompt/tool changes | None of the references publish one, but Pi-Bolt ships byte-identical tool e2e gates (B.md §Pi-Bolt `e2e_tools.py`) | Nightly broken, no baseline diff (10, 11) | P0 |
| Feedback and telemetry | Claude, Codex, Gemini: OpenTelemetry metrics and events (A.md:506) | Feedback disabled, no OTel (13) | P1 |
| Library docs lookup | No reference CLI ships one built in (Context7 is usually an MCP add-on) | `read_docs` built in (06 defects) | strength |

## Strengths

- **Head-to-head harness against competitor CLIs.** BuffBench runs `external:claude`, `external:codex` and `external:opencode` on the same commit tasks with the same judges and deterministic final-check clamping (`evals/README.md` §Architecture and §Judging; `evals/buffbench/runners/`). None of the reference CLIs ships a harness that benchmarks its rivals.
- **Deterministic, LLM-free memory and compaction evals** (`evals/compaction-retention`, `compaction-fidelity`, `memory-retention`) run as ordinary `bun test` in CI's `evals` matrix entry (`ci.yml:173`).
- **Browser surface breadth.** `browser_logs` covers real `Input.dispatch*` events, iframe targeting, tabs, cookies, storage, network emulation, APNG recording, `pixel_diff` and `design_tokens` (`common/src/tools/params/tool/browser-logs.ts:42-74`). This is richer than Claude Code, Codex, Aider and Pi, which have no built-in browser.
- **Vision routing for BYOK.** When a message contains images and the configured model is not a vision model, the request is rerouted to a vision-capable configured model (`sdk/src/impl/model-provider.ts:286-298,549-590`). Multi-provider BYOK makes this a real usability win over single-vendor CLIs.
- **Bounded fetch internals.** Streamed body cap of 2 MB with soft truncation, manual redirect re-validation, and a combined abort and timeout signal (`web-search-utils.ts:105-180`). Fix 01 and these are a solid base.
- **`read_docs` (Context7) built in**, with ranked library selection and alternatives returned to the model (`read-docs.ts:89-127`).
- **Tool reachability guard.** `agents/tool-reachability.test.ts:48-60` fails CI when a registered tool is unusable by every agent.
- **3D/Blender tools** with hash-conditional edits (`common/.../3d-assets.ts:83-104`). No reference CLI has them (B35 defects aside).

## Roadmap mapping

| Finding | Mapping |
|---|---|
| 01 SSRF IPv6-mapped bypass | not covered |
| 02 DNS rebinding window | not covered (RWEB contract 3 only for browser path) |
| 03 Single DDG backend / blocked = empty | partially (B33 addendum RWEB-2 backend controls, browser-oriented; pending) |
| 04 Fetch flattening / binaries / paging | partially (RWEB contracts 4, 8 for browser path; static fetch not covered) |
| 05 No direct fetch tool for main agent | not covered |
| 06 read_docs error collapse / key | not covered |
| 07 Browser policy divergence | covered by B33 (13-F1), still open |
| 08 render_ui unconditional ack | covered by B33 (13-F9), still open |
| 09 Image path inconsistency | partially (B33 read admission; read-search-06) |
| 10 Dead eval workflow/scripts | not covered (B32 adjacent) |
| 11 Nightly nonexistent agent / no baseline gate | partially (B30 accepted, B31 pending; CI wiring not covered) |
| 12 No public benchmark | not covered |
| 13 No feedback capture / OTel | partially (B31 candidate channel) |
| 14 code-map missing from CI matrix | partially (B32 discovery scope) |
| 15 Docs drift / README silence | not covered |
| 16 Repo hygiene | not covered |
