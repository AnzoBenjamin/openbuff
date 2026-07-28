# Unified Background Jobs — Lessons & Security Findings

## Security review (BLOCKING) — ownership must be enforced, not just present
The security-reviewer flagged the M4 tool migration as BLOCKING. Root cause: when I deleted the authorize/foreign/recover gate + pending-background-jobs Map, I assumed `jobRegistry.assertOwned` enforced ownership — but nothing on the process-job path (check_job/kill_job/read_logs/list_jobs) actually calls it. `assertOwned` was dead code for shell jobs. Result: any reachable jobId (predictable `job-N-hex`, or leaked via end_turn/list_jobs) allowed cross-session log reads and process-group kills.

**Lesson:** deleting a gate without wiring the replacement enforcer into every operation is a regression, not a simplification. Ownership must be *checked at the point of action* (esp. the mutating kill path), with the owner derived from **trusted run/session state — never from model/tool input**.

Fix plan (see SECURITY findings SEC-1..SEC-6):
1. run.ts computes a trusted owner from sessionState (clientSessionId=run clientSessionId/promptId, rootRunId=sessionState.mainAgentState.runId ?? agentId) and injects it into checkJob/killJob/readLogs/listJobs/runTerminalCommand. Never read `owner` from model input (it was even feeding approval binding via terminalInput.owner.rootRunId — model-controlled).
2. sdk tools call jobRegistry.assertOwned(jobId, trustedOwner); foreign → generic not_found. kill_job gates terminateProcessTree on ownership.
3. getBackgroundJob restampOwner comes only from trusted owner.
4. Recovered-pid liveness binding before kill (SEC-3); orphaned-file sweep fail-closed (SEC-4); recovered-metadata authenticity (SEC-5) deferred if scope grows; list_jobs always scoped + check_job logFile redacted for non-owners (SEC-6).

## Design lesson — dual-key ids are a trap
The M3 agent adapter briefly had two ids per job (core `job-N-hex` vs adapter `bg-agent-<coreId>`), causing consumer/adapter mismatches. Fixed by single-keying: the adapter creates the registry job with the final `bg-agent-` id directly (via an optional explicit jobId on core create). One job, one id, everywhere.

## Test-authoring lesson
Parallel editor (impl) + test-writer (tests) against a *sketched* contract causes drift (job.id vs jobId, chunk vs chunkType/data, matched as boolean vs the matched event, snapshot/wait returning undefined). Write tests against the REAL module, or author impl+tests together.