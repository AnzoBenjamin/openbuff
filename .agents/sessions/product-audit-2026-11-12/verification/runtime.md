# Runtime verification — product-audit-2026-11-12

Repo state: HEAD `f5aba489d` plus a dirty working tree (probes ran against current source). Bun 1.4.4, Linux.
No repository file was modified. `git status --porcelain --ignored` was identical before and after all probes (`/tmp/verify-runtime/git-before.txt`, `git-after2.txt`).
All probe scripts, fixtures and logs are in `/tmp/verify-runtime/`. Every leftover `sleep 30x` process was killed afterwards. The SDK's own `/tmp/openbuff-job-*.{json,log}` files from these runs were left in `/tmp`.

| # | Finding | Verdict | Severity (audit → corrected) |
|---|---|---|---|
| 1 | exec-jobs-09 attached BACKGROUND jobs orphaned on exit | CONFIRMED | MEDIUM (inferred) → HIGH |
| 2 | exec-jobs-01 SYNC stdin read hangs with default timeout | CONFIRMED | HIGH → HIGH |
| 3 | cli-ux-02 startup / `--version` cost | CONFIRMED (for `--version`/`--help`; ready-to-type not re-measured) | HIGH → HIGH |
| 4 | read-search-03 trimmed read keeps `complete:true` and edit capability | CONFIRMED | MEDIUM → MEDIUM |
| 5 | language-intel-05 release tarball omits `.scm` queries | CONFIRMED | HIGH → HIGH |
| 6 | memory-context-01 `/compact` rejected by CLI | CONFIRMED | HIGH → HIGH |
| 7 | providers-sdk-01 streaming request has zero `cache_control` | CONFIRMED | HIGH → HIGH |

---

## 1. exec-jobs-09: attached BACKGROUND jobs outlive the SDK process

**Claim:** attached (non-`detach`) BACKGROUND jobs survive CLI/SDK exit as orphans.

**Probe:** `/tmp/verify-runtime/p1-bg.ts`. It calls `createDirectHostExecution({cwd:'/tmp/verify-runtime/proj'})`, then `runTerminalCommand({command:'sleep N', process_type:'BACKGROUND', timeout_seconds:-1, executionContext, terminalShell, getTerminalLaunchMetadata})`, exactly as in `sdk/README.md:153-165`. The parent ends in one of three modes: fall off the end, `process.exit(0)` (arg `exit`), or wait forever (arg `wait`) so a signal can be sent.

```
cd /home/ben/Code/CLI/openbuff
timeout 90 bun /tmp/verify-runtime/p1-bg.ts 302            # natural end of script
timeout 60 bun /tmp/verify-runtime/p1-bg.ts 303 exit       # process.exit(0)
bun /tmp/verify-runtime/p1-bg.ts 304 wait & ; kill -TERM $!  # SIGTERM
bun /tmp/verify-runtime/p1-bg.ts 305 wait & ; kill -INT  $!  # SIGINT
ps -eo pid,ppid,pgid,etime,cmd | grep 'sleep 30'
```

**Observed:**
- Result: `{"processId":2534514,"backgroundProcessStatus":"running","detached":false,"jobId":"job-1-66a3fd68",...}`.
- **Natural end:** the script printed `EXITING` and then **never exited**. It was still alive at 90 s when `timeout` sent SIGTERM (`exit=124 elapsed=90.0`). The attached job keeps the event loop alive. When SIGTERM killed the parent, the sleep survived.
- **`process.exit(0)`:** the parent exited 0 and `sleep 303` survived.
- **SIGTERM:** the parent died and `sleep 304` survived.
- **SIGINT:** the parent **ignored SIGINT** and was still alive 7 s later. It was then killed with SIGTERM, and `sleep 305` survived.
- `ps` after the runs (`/tmp/verify-runtime/p1-ps.txt` plus the follow-up check) showed every sleep reparented to init, each its own process-group leader:
```
2530810       1 2530810 sleep 301
2534514       1 2534514 sleep 302
2539749       1 2539749 sleep 303
2539833       1 2539833 sleep 304
2540048       1 2540048 sleep 305
```
- All of them were then killed with `pkill -f '^sleep 30[0-9]$'`.

**Verdict:** CONFIRMED at the SDK level. Every exit path tested (`process.exit`, SIGTERM, and SIGTERM after a SIGINT was ignored) leaves an orphaned, ownerless process group. Two additional defects:
- (a) An SDK host that starts an attached background job cannot exit naturally.
- (b) SIGINT does not terminate the host process.

The CLI TUI exit path was not driven directly. It ends via `process.exit` and the signal handlers in `cli/src/utils/renderer-cleanup.ts`, which the `exit` and SIGTERM cases model.

**Corrected severity:** HIGH. This is no longer an inference. Every quit orphans dev servers and watchers, and they keep holding ports.

## 2. exec-jobs-01: SYNC stdin read with default timeout hangs

**Claim:** with the default `timeout_seconds: -1`, a SYNC command that reads stdin hangs forever.

**Probe:** `/tmp/verify-runtime/p2-stdin.ts` uses the same direct host and runs `runTerminalCommand({command:'read x; echo got $x', process_type:'SYNC', timeout_seconds:<arg or -1>})`. `-1` is the value `sdk/src/run.ts:3450` fills when the field is omitted.
```
timeout -s KILL 20 bun /tmp/verify-runtime/p2-stdin.ts      # default -1
timeout -s KILL 20 bun /tmp/verify-runtime/p2-stdin.ts 3    # control
```

**Observed:**
- **Default (-1):** `ec=137 elapsed=20s`. Only `START timeout_seconds= -1` was printed, with no result. `ps` at 19 s showed `bash -c read x; echo got $x` still blocked under the bun parent. After the outer SIGKILL, the bash child also exited because its stdin pipe closed, so nothing was orphaned.
- **Control (3 s):** returned after 3,041 ms with `timedOut:true`, `executionRefusal.reason:"deadline-exhausted"` and `processCleanup.status:"complete"` (posix-owned-group tier).

**Verdict:** CONFIRMED. The command blocks until an outer deadline or kill. No idle-output detection exists, and stdin is an open pipe that never gets EOF.

**Corrected severity:** HIGH, unchanged.

## 3. cli-ux-02: startup time

**Claim:** about 0.83 s for `--version`, 830 ms for `--help` (binary), and about 2 s to ready-to-type.

**Probe:** `/tmp/verify-runtime/p3-time.sh` times 5 runs with `date +%s%N` and reports the median. All runs used cwd `/tmp/verify-runtime/proj`, and no rebuild was done.
```
bun /home/ben/Code/CLI/openbuff/cli/src/index.tsx --version | --help
/home/ben/Code/CLI/openbuff/cli/bin/openbuff --version | --help
bun -e 0   # baseline
```

**Observed:**
| Target | Runs (ms) | Median |
|---|---|---|
| source `--version` | 1128 1045 1024 994 1022 | **1024 ms** |
| source `--help` | 1033 1031 1099 1033 1028 | **1033 ms** |
| `cli/bin/openbuff --version` | 1002 842 825 842 827 | **842 ms** |
| `cli/bin/openbuff --help` | 836 834 827 902 817 | **834 ms** |
| `bun -e 0` baseline | 8 7 7 9 7 | 7 ms |

- `cli/bin/openbuff` mtime is `2026-11-10 21:44:19 +0300`, which predates HEAD, so the binary is stale.
- `--version` stdout is `Using environment: dev` followed by `1.0.0`. The env banner leaks into `--version` output (related to cli-ux-14).
- `cli/src/index.tsx` has 49 top-level `import` lines.

**Verdict:** CONFIRMED for `--version`/`--help`. Current source is slower than the binary: about 1.0 s against 0.84 s, versus a 7 ms bun baseline, so about 1 s is import cost. Ready-to-type (about 2 s) and RSS were not re-measured here.

**Corrected severity:** HIGH, unchanged.

## 4. read-search-03: trimmed read keeps `complete:true` and the edit capability

**Claim:** after context trimming, a read result loses its content but keeps `complete:true` and its `editAnchor`/readCapability.

**Probe:** `/tmp/verify-runtime/p4-trim.ts`.
- The fixture is `/tmp/verify-runtime/proj/src/big.ts` (400 lines, about 23 KB).
- It calls the real `getFilesStructured` (`sdk/src/tools/read-files.ts:1051`) with the production `createNodeFileSystem()` (`sdk/src/tools/node-filesystem.ts:52`), `capabilityIssuer: {projectId, runId}`, a whole-file path and a range 10-20.
- It wraps the result as `[{type:'json', value}]` and passes it through the real `simplifyToolResultContent({toolName:'read_files'})` (`packages/agent-runtime/src/util/simplify-tool-results.ts:294`). That is the function the over-budget loop calls at `packages/agent-runtime/src/util/messages.ts:766-790`.
- Finally it decodes each token with `decodeReadCapabilityToken` and validates the trimmed result with `readFilesResultV1Schema`.

```
cd /home/ben/Code/CLI/openbuff && bun /tmp/verify-runtime/p4-trim.ts
```

**Observed** (`/tmp/verify-runtime/p4-trim.log`):
- **Whole-file item:**
  - Before: `complete:true`, content of 23,380 chars, editAnchor 1-401 with `scope:"whole"`.
  - After: `complete:true`, `status:"ok"`, `contentOmittedForLength:true`, no content, and the **same editAnchor** (1-401, whole).
- **Range item:**
  - Before: `complete:true`, editAnchor 10-20 with `scope:"lines"`.
  - After: `complete:true` and the same editAnchor.
- `readCapability token unchanged per item: [true, true]`. Both tokens decode with `hashMatches:true`.
- The trimmed result passes `readFilesResultV1Schema` (`success:true`). The schema itself allows `contentOmittedForLength` together with `complete:true` and `editAnchor` (`common/src/tools/results/filesystem.ts:619-650`).
- Side findings:
  - The range item keeps `sourceContent`, the full slice, so trimming a range saves only the decorated header.
  - The file item keeps the host-channel `rawSourceContent` (23 KB). The trimmed payload shrank only from 55,289 to 27,940 chars. I did not verify whether `rawSourceContent` is stripped before model rendering.

**Verdict:** CONFIRMED. The model keeps a valid whole-file cap.v4 authority for content it no longer sees, and no recovery hint is given.

**Corrected severity:** MEDIUM, unchanged. Not exercised end to end through an actual `write_file`.

## 5. language-intel-05: release tarball omits tree-sitter `.scm` queries

**Claim:** release tarballs and the npm wrapper ship no tree-sitter query files.

**Probe:** read the packaging lists, then reproduce the workflow's tar step into `/tmp` using the existing `cli/bin` contents.
- `cli/scripts/build-binary.ts:659-675` copies `packages/code-map/src/tree-sitter-queries/*.scm` into `cli/bin/tree-sitter-queries/`. 14 files are present now.
- `.github/workflows/cli-release-build.yml:457-468` (matrix) and `:642-649` (win32): `FILES=("$BINARY_FILE")`, plus `tree-sitter*.wasm`, plus `tree-sitter-manifest.json` (plus `libopentui.dylib rg` on legacy macOS), then `tar -czf ... -C cli/bin "${FILES[@]}"`. There is no `tree-sitter-queries`. The smoke steps at `:408-409` and `:605-606` copy only wasm and the manifest.
- `cli/release/package.json` `files` lists only `index.js`, `http.js`, `postinstall.js` and `README.md`. `cli/release/index.js` `getManagedSiblingNames` (around lines 52-68) moves only `tree-sitter*.wasm`, the manifest, `libopentui.dylib` and `rg`.
- `packages/code-map/src/languages.ts:45-50` says queries are never imported or embedded. `resolveQueryPath` (`:264-310`) probes module, src, `dirname(execPath)/tree-sitter-queries` and cwd, then falls through silently.
- Embedded check: the Python query line `name: (identifier) @identifier)` and the string `(class_definition` each occur 0 times in `cli/bin/openbuff`.
```
cd cli/bin && FILES=(openbuff); for w in tree-sitter*.wasm; do FILES+=("$w"); done; FILES+=(tree-sitter-manifest.json)
tar -czf /tmp/verify-runtime/p5/openbuff-linux-x64.tar.gz "${FILES[@]}"; tar -tzf ... | grep -c .scm
```

**Observed:** the reproduced tarball has 18 entries (the binary, 16 wasm files and the manifest). It contains **0** `.scm` files (`/tmp/verify-runtime/p5/tar-list.txt`). Locally, `~/.config/openbuff/tree-sitter-queries/` (14 files, dir mtime `2026-11-10 19:05`) masks the gap.

**Verdict:** CONFIRMED.

**Corrected severity:** HIGH, unchanged.

## 6. memory-context-01: `/compact` rejected by the CLI

**Claim:** typing `/compact` in the CLI is answered with "Command not found" and never reaches the agent.

**Probe:** `/tmp/verify-runtime/p6-compact.ts` calls the real `routeUserPrompt` (`cli/src/commands/router.ts:290`) with a DI `RouterParams` harness copied from `cli/src/commands/__tests__/prompt-dispatch.test.ts`, which captures `sendMessage`, `addToQueue` and `setMessages`. It also calls `findCommand('compact')`.
```
cd /home/ben/Code/CLI/openbuff/cli && bun /tmp/verify-runtime/p6-compact.ts
```

**Observed** (`/tmp/verify-runtime/p6-compact.log`):
```
findCommand(compact): null
/compact                        -> sentToAgent:[]  queued:[]  "Command not found: \"/compact\""
/compact keep the API notes     -> sentToAgent:[]  queued:[]  "Command not found: ..."
/compact (isStreaming:true)     -> sentToAgent:[]  queued:[]  "Command not found: \"/compact\""
compact                         -> sentToAgent:["compact"]
```
The recovery strings that tell users to run `/compact` still exist at `packages/agent-runtime/src/run-agent-step.ts:3363` and `cli/src/utils/sdk-event-handlers.ts:1984`. The runtime handler is at `run-agent-step.ts:1187-1215`.

**Verdict:** CONFIRMED. Only the undocumented bare word `compact` reaches the runtime.

**Corrected severity:** HIGH, unchanged.

## 7. providers-sdk-01: streaming agent request carries zero `cache_control`

**Claim:** the streaming agent-loop request never carries `cache_control` markers.

**Probe:** `/tmp/verify-runtime/p7-cache.ts`.
- It starts a fake Anthropic Messages SSE server (`Bun.serve` on 127.0.0.1) and writes `/tmp/verify-runtime/p7/provider.json` with an `anthropic-compatible` provider that points at the fake server. The config is loaded via `OPENBUFF_PROVIDER_CONFIG`.
- It calls the real `promptAiSdkStream` with `includeCacheControl:true`, a long system prompt and 5 messages, including two of about 12 KB.
- Control: it calls `convertCbToModelMessages({messages, includeCacheControl:true})` directly.
- The captured request body is saved at `/tmp/verify-runtime/p7/request-body.json`.
```
cd /home/ben/Code/CLI/openbuff/sdk && bun /tmp/verify-runtime/p7-cache.ts
```

**Observed** (`/tmp/verify-runtime/p7-cache.log`):
```
chunks text,finish
requests 1 [ "http://127.0.0.1:40489/v1/messages" ]
anthropic request: cache_control occurrences = 0 | cacheControl occurrences = 0 | anthropic-beta header = null | body bytes = 35243
control convertCbToModelMessages(includeCacheControl:true) anchors = 3
```
The gate is still at `sdk/src/impl/llm.ts:1412-1413` (`includeCacheControl: isChatGptOAuth && compatibility.stripCacheControl === false`). The non-streaming paths at `:2220` and `:2384` use `compatibility.stripCacheControl === false`.

**Verdict:** CONFIRMED. The converter would place 3 anchors, but the streaming request sends none.

**Corrected severity:** HIGH, unchanged.
