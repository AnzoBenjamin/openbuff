# Audit findings: spawn-result-delivery-and-arg-transport

- Subsystems: agent-runtime-spawn-settle, agent-runtime-supervision, agent-runtime-tool-dispatch, agent-runtime-tool-result-formatting, agent-runtime-programmatic-step
- Features: normalizeSpawnedAgentOutput, boundAgentOutputForParent, compactAgentOutputValue, summarizeNestedAgentOutput, mergeLastMessageFragments, buildRuntimeAgentReceiptOrThrow-D19-outcome, persistOversizeArtifact-artifactPath, supervised-settle-outcome, parseStringifiedToolInput, coerceInputScalarsBySchema-D21
- Files covered: 4
- Snapshot: workspace.v1.8429.a44a19f5

## [HIGH] correctness — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — compactAgentOutputValue truncates structuredOutput.value.message at 32k with NO truncation marker on `value`, so the D19 outcome stays `ok`
- **Risk:** Root cause of the reported symptom: a subagent's structuredOutput.value is silently replaced by a head/tail fragment while the receipt reports outcome 'ok' and status 'completed', so the orchestrator cannot tell truncation from a complete answer and has no artifact pointer for the sub-256k case. Silent data loss classified as success.
- **Fix:** Compute truncation from the ACTUAL compaction any time compactAgentOutputValue reports omittedChars/omittedItems>0 (thread the counter out of boundAgentOutputForParent and stamp an unavoidable marker onto the returned value), and make the D19 derivation read a value-nested truncation too. Any structurally truthful fix must also stop depending on the reviewer-family gate at :1285-1293.
- **Evidence:** normalizeSpawnedAgentOutput (:1391) is the single normalization entry; EVERY terminal branch funnels into boundAgentOutputForParent (:1474,:1507,:1553,:1572,:1583,:1588) and the structuredOutput-with-object-value branch is :1566-1582 (compactReviewerOutput(record.value) then boundAgentOutputForParent). boundAgentOutputForParent (:1203) calls compactAgentOutputValue(value,0,undefined,truncation) at :1208 and attaches the visible marker ONLY when the TOP-LEVEL compacted object is a non-array object with omittedItems>0||omittedChars>0 (:1209-1221) -- the marker is spread onto the ENVELOPE ROOT, never onto `value`. compactAgentOutputValue (:883) truncates every string leaf via truncateReviewerText (:890-899). The exact cap that fires for the reported symptom is PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS=32_000 (:676, selected at :892-894) because 'message' is in HIGH_FIDELITY_STRING_FIELDS (:677-697, 'message' at :679); all other fields fall to PARENT_AGENT_OUTPUT_STRING_CHARS=4_000 (:668, used at :894). Arrays are cut to PARENT_AGENT_OUTPUT_ARRAY_ITEMS=48 (:698,:912) unless the field is in CONTROL_PLANE_ARRAY_FIELDS (:702-716); depth>=7 collapses to summarizeNestedAgentOutput (:902-905) which clips each surviving string to 1_000 chars (:1031) and returns type 'truncatedNestedAgentOutput' (:1049). truncateReviewerText (:718-723) emits '<prefix>...[truncated]...<suffix>'. CRITICAL GAP: the D19 'truncated' classifier reads ONLY the normalized output's ROOT (normalizedOutputRecord?.truncated===true, or normalizedOutputRecord.truncation.omittedItems/omittedChars > 0) at :2412-2417, while boundAgentOutputForParent's object-value branches (:1270-1315 reviewer-family collapse and :1572-1581 pass-through) return an object whose `value` was already leaf-truncated and whose root-level `truncation` marker exists only if the REVIEWER-family payload branch (:1288-1314) matched. For a NON-reviewer child (e.g. general-agent, basher) the returns at :1583-1586 and :1588 return rawCompacted with the marker, but any nesting that produces a value-level record only (e.g. the :1566-1582 branch returning {...record, value: compacted} where record itself carries no truncation field) leaves truncated leaves with no top-level marker -> outcome resolves 'ok' at :2534.

## [MEDIUM] error-handling — packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts — D19 outcome 'truncated' is deliberately excluded from status downgrade, so even a correctly-flagged truncated delivery reports status 'completed'
- **Risk:** Even the intended truncation signal is status-neutral: the parent sees status 'completed' and must itself inspect outcome==='truncated'. Combined with F1 (marker sometimes absent entirely) a fragmented payload presents as fully ok/completed.
- **Fix:** Either downgrade status to 'partial' on outcome==='truncated', or guarantee the parent-visible payload always carries an explicit machine-readable truncation marker plus a reachable artifactPath.
- **Evidence:** envelopeUnderminesCompletion = outcome!=='ok' && outcome!=='truncated' && !mutationsComplete && params.status===undefined (:2540-2544). The comment at :2535-2539 states 'truncated stays visible via the outcome field without downgrading -- reviewer receipts legitimately complete while truncated in transit'. resolvedStatus therefore falls through to params.status ?? foundOutputStatus ?? 'completed' (:2553-2555) and the receipt parses with status 'completed' at :2638-2645.

## [MEDIUM] api-contract — packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts — artifactPath exists but only for the >256k oversize path; the common 32k-256k fragmentation has no artifact and no recovery pointer
- **Risk:** PR-T2's artifactPath claim holds only past 256_000 chars. Below that threshold compactAgentOutputValue has already clipped every leaf at 32k/4k and NO artifact is persisted, so the exact reported symptom has no artifact pointer and no recovery path; the orchestrator keeps a lossy fragment it cannot detect.
- **Fix:** Persist the artifact whenever compactAgentOutputValue actually clipped something (omittedChars>0), not only above 256k, and stamp artifactPath + truncation onto the parent-visible value in every clipped case.
- **Evidence:** The parent-visible spawn result is constructed at spawn-agents.ts:1206-1217 as `output: jsonToolResult(reports.map(...))`, where each report is {agentId, agentName, agentType, output: receipt.output, agentReceipt: receipt, creditsUsed} (:752-759 background, :1062/:1101 foreground). So the orchestrator sees receipt.output (the NORMALIZED output) plus the full agentReceipt. The oversize path persists the FULL untruncated payload via persistOversizeArtifact(spawn-agent-utils.ts:1258) and spreads artifactFields (artifactPath/artifactBytes/artifact, :1259-1269); 'artifactPath' is in HIGH_FIDELITY_STRING_FIELDS (:696) so it is never clipped. However artifactPath is attached ONLY inside the `serialized.length > PARENT_AGENT_OUTPUT_MAX_CHARS` (256_000) branch (:1238 early-returns `compacted` with no artifact when under the cap; :1258 only runs above it). The non-reviewer fallback summary at :1326-1328 embeds serialized.slice(0,48_000)+slice(-8_000) and DOES carry artifactFields -- i.e. artifact delivery works only on the oversize path.

## [MEDIUM] correctness — packages/agent-runtime/src/supervision/process-supervisor.ts — Supervised settle uses a strict '>' on the stdout cap, so a capture filled exactly to the 8MiB boundary classifies 'ok'; an envelope cut mid-line classifies 'schema_invalid' rather than 'truncated'
- **Risk:** A subagent emitting a very large structured result can settle 'ok' with a silently ceiling-limited capture; the one outcome that tells the parent 'payload lost to size, not a bug' is never emitted, and a genuinely cut envelope instead looks like a retryable schema bug.
- **Fix:** Classify 'truncated' when totalBytes >= SETTLE_STDOUT_CAP_BYTES, and when a trailing segment was dropped with bytes present (or totalBytes at/over cap) mark the settle 'truncated' rather than schema_invalid.
- **Evidence:** SETTLE_STDOUT_CAP_BYTES = 8*1024*1024 (:86; stderr cap 64KiB per the :30 docblock). captureStream (:257-281) keeps at most capBytes and counts the rest while always draining. At settle the 'truncated' classification is a STRICT greater-than: `if (stdoutCapture.totalBytes > SETTLE_STDOUT_CAP_BYTES)` -> 'truncated' (:501-503), else 'ok' (:504). A child whose stdout is EXACTLY capBytes classifies 'ok'. Additionally :451-453 drops a non-newline-terminated trailing segment ('This is also what keeps a cap-cut tail from being parsed as a complete line'), so a cap-cut envelope yields either an EARLIER stale/partial JSON line as lastLine or, when none is found with bytes present, 'schema_invalid' (:469-474) -- never 'truncated'.

## [HIGH] error-handling — packages/agent-runtime/src/tools/tool-executor.ts — Inbound argument stringification is only repaired for schema-declared array/object fields; repairBareStringFieldObject's allowlist omits spawn_agents/spawn_agent_inline, so a stringified `agents` payload fails as 'expected object, received string'
- **Risk:** Explains the second reported symptom: tool-call arguments arriving stringified (agents: "[{...}]") are rejected with 'expected object, received string'. Recovery depends on the field's declared type, and the flat-string fallback allowlist does not include the delegation tools, so the harness cannot repair its own mangled spawn arguments.
- **Fix:** Add the delegation tools' container fields to the bare-string/repair surface and assert (test) that a stringified `agents` array is unserialized before validation; also surface the truncation-vs-stringification distinction in the error text.
- **Evidence:** Two repair seams exist. (a) parseStringifiedToolInput (:973-1035) loops up to 3 JSON.parse attempts on a purely STRING input (:993-996) and, on failure, tries repairBareStringFieldObject (:1020). Its bareStringFieldRepairAllowlist (:922-935) covers code_search/find_files/find_files_matching_content/glob/list_directory/lookup_agent_info/read_files/read_subtree/skill/web_search -- spawn_agents and spawn_agent_inline are ABSENT, so the single-field-bare-string repair cannot fix an `agents` payload. (b) coerceInputScalarsBySchema (:1267) with the D21 slice-1 branch at :1358-1387: it only unserializes when the field's DECLARED schema type is 'array'/'object' (:1370-1386) via unserializeStringifiedJsonFieldValue (:1259-1265, JSON.parse or undefined). If the schema declares `agents` as an array, the D21 path SHOULD repair it -- meaning a payload that still reaches validation as a string must have escaped BOTH seams (e.g. the input was already an object whose `agents` string failed JSON.parse, or exited the 3-iteration loop at :993 with processedParameters.input still a string -> stringInputError at :2454-2463).

## [LOW] state-mutation — packages/agent-runtime/src/tools/tool-executor.ts — run-programmatic-step / stream-parser do not re-serialize tool arguments; the exposure is the 3-iteration bounded parse that can bail out with input still a string
- **Risk:** The parse loop is capped at 3 iterations (:993) and `break`s out of the loop on the first failure (:1027); a doubly/triply-encoded payload survives as a string and is rejected at :2454-2463. This is the concrete mechanism by which the harness's own arguments stay stringified.
- **Fix:** On residual-string input, attempt one last structural repair (e.g. wrap the allowlist repair to the delegation tools) and log the tool+field so the upstream serializer can be identified.
- **Evidence:** for (let i = 0; i < 3 && typeof parsed === 'string'; i++) (:993); on error the loop records truncation evidence and `break`s (:1016-1028). After the loop, `if (typeof processedParameters.input === 'string') return stringInputError(...)` (:2454-2463) -- the call is rejected rather than reconsidered. No JSON.stringify of arguments occurs anywhere on the inbound path I read; the mangling is upstream/provider-side and shows up here as an unparseable string.

## [MEDIUM] test-coverage — packages/agent-runtime/src/tools/handlers/tool/__tests__/spawn-agent-utils-output.test.ts — Test surface pins normalization shapes but not the leak: no test asserts that a leaf-truncated structuredOutput.value forces outcome 'truncated' or carries artifactPath
- **Risk:** spawn-agent-utils-output.test.ts exercises ~20 normalizeSpawnedAgentOutput shapes (missing/undefined/error/structuredOutput variants at :46,:56,:65,:76,:87,:118,:144,:183,:217,:235,:265 and pass-through cases :284,:301,:306,:312) but none combines an over-32k `message` leaf with a receipt build to assert outcome==='truncated' AND artifactPath present. So F1/F3 can regress silently.
- **Fix:** Add a receipt-level test: a 100k-char structuredOutput value.message yields outcome 'truncated', status 'partial' (or an explicit marker), and a populated artifactPath whose contents round-trip the original text.
- **Evidence:** Searched the suite's call sites: every normalizeSpawnedAgentOutput assertion is a shape/idempotence check; no case drives buildRuntimeAgentReceipt over a compacted payload to inspect the derived outcome. spawn-agent-inline-nesting.test.ts:587-664 likewise asserts normalization shapes only.

## Coverage receipt

### Subsystems
- agent-runtime-spawn-settle
- agent-runtime-supervision
- agent-runtime-tool-dispatch
- agent-runtime-tool-result-formatting
- agent-runtime-programmatic-step

### Features
- normalizeSpawnedAgentOutput
- boundAgentOutputForParent
- compactAgentOutputValue
- summarizeNestedAgentOutput
- mergeLastMessageFragments
- buildRuntimeAgentReceiptOrThrow-D19-outcome
- persistOversizeArtifact-artifactPath
- supervised-settle-outcome
- parseStringifiedToolInput
- coerceInputScalarsBySchema-D21

### Files
- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts
- packages/agent-runtime/src/supervision/process-supervisor.ts
- packages/agent-runtime/src/tools/tool-executor.ts

### Domains
- correctness
- error-handling
- api-contract
- state-mutation
- test-coverage
