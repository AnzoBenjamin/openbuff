# RWEB-0: pinned toolchain and real local feasibility

The preferred managed backend is feasible on this Linux x64 host. The exact published `agent-browser` **0.41.2** distribution passes its npm SHA-512 integrity and SHA-1 checks. Its native binary SHA-256 is `c4351f3802ffa5254d8c69f20a52e2fcf56925c6016fcf4203db25a07d811379`. The native CLI and Node launcher return the same version and matching core guide. The published launcher requires **Node >=24**; the tested host uses Node `v26.1.0`. This published requirement supersedes the earlier upstream-main planning observation for toolchain selection.

[toolchain.json](toolchain.json) binds all 45 package files and the matching guide. The package was extracted into a private `/tmp` development directory and the selected native executable received the upstream postinstall's executable-mode activation. No global package installation or Openbuff dependency change occurred. Existing Google Chrome **157.0.8103.38** supplies the tested browser; [mcp-inspection.json](mcp-inspection.json) binds its executable and 245 asset files. Other operating systems and browser engines remain unverified.

The actual stdio MCP server initializes and paginates its **29 core tools**. [mcp-catalog.json](mcp-catalog.json) preserves the observed schemas. Direct document reads, rendered DOM reads, fresh accessibility references, navigation, tabs and screenshots have typed tools; no general shell bridge is needed for these observed operations.

The [successful real fixture](attempts/20261106T223317Z-ba7cba52/result.json) records seven controls through the actual MCP/native/Chrome processes:

- HTTP 429 is an MCP error, and an already-known document remains readable.
- A static document read omits the JavaScript-generated article; the rendered read observes its exact excerpt, content hash, final URL and untruncated result.
- A fresh link reference navigates to the second chapter, followed by a new snapshot and document read.
- The delivered screenshot contains real PNG bytes, **1280 × 633**, with a recorded hash.
- Two simultaneous private sessions remain separate; closing one leaves the other usable.
- A persistent Chrome profile combined with the domain allowlist is explicitly refused.
- Normal closure and a verified fallback settle the probe's resources; no owned process remains.

The failed attempts are retained. They establish three adapter constraints: short private socket paths are necessary on this host; persistent profiles cannot be combined with the upstream domain allowlist; and a rejected profile configuration can leave a native daemon whose ordinary `close` repeats the same refusal. The successful probe uses a Linux process handle to signal only that exact daemon after verifying its executable and private environment. This is a development fixture observation, not an Openbuff cleanup or descendant-enforcement guarantee.

The core HTTP 429 result reports status but drops `Retry-After`. RWEB-1/2 must preserve response metadata at the managed read boundary or provide a separately verified upstream capability; they cannot invent a cooldown from absent headers. The host adapter must also own session/namespace, artifact paths, profile selection and cleanup, and prevent caller overrides such as sibling-wide `close all`. Compact interactive snapshots remain navigation observations; article evidence comes from document/rendered reads.

RWEB-0 can supply the locked candidate and adapter design to B19/B20/B28. Integrated `researcher-web`, SDK/headless/CLI/ACP delivery, cache/backoff, permission/egress enforcement and actual researcher acceptance remain RWEB-1…4 and B33 work. No live search-limit cause, live research-quality gain, provider call or B33 implementation acceptance is claimed.
