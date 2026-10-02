/**
 * P2-T8 adoption slice: parent-side default seam for flag-gated process
 * supervision.
 *
 * `buildDefaultSpawnSupervised` returns the `spawnSupervised` seam wired to
 * `spawnSettledSubagent` (process-supervisor.ts) + the child entrypoint
 * (child-entry.ts):
 *  - the JSON-serialized `SupervisedSpawnRequest` is persisted to a 0o600
 *    file INSIDE the 0700 mkdtemp sandbox dir (never the shared tmpdir
 *    root); its path is the child's only argv (stdin is 'ignore' in the
 *    supervisor);
 *  - the child env is EXACTLY `buildSupervisedChildEnv(seed)` — ambient env
 *    keys are never forwarded; the seed is supplied by the caller (the SDK
 *    impl seam, the only place ambient `process.env` may be read for this
 *    feature);
 *  - the child cwd is a fresh EMPTY temp dir so the child runtime cannot
 *    auto-load a repo `.env` on top of the allowlist;
 *  - the request file and the sandbox dir are removed after settle.
 *
 * DEFAULTS: `timeoutMs` defaults to the supervisor's 10-minute deadline
 * (SETTLE_DEFAULT_TIMEOUT_MS) — supervised spawns gain a wall-clock deadline
 * in-process spawns do not have; callers override via the request's
 * `timeoutMs`. NOTE: on timeout the supervisor tears down the child's WHOLE
 * process group (the default seam spawns the child as a group leader via
 * `detached: true`, and SIGTERM/SIGKILL go to the group by negative-pid
 * kill), so shell grandchildren die too; only custom seams without a
 * `killGroup` fall back to the direct-pid kill.
 *
 * LIMITED AGENT CLASS (this slice): the parent→child RPC bridge for the
 * non-serializable callback deps (promptAiSdkStream, sendAction,
 * requestToolCall, ...) has not landed, so a real supervised attempt returns
 * the structured 'unsupported-deps' failed receipt (see child-entry.ts)
 * instead of half-running. The flag gate still routes and settles honestly.
 *
 * The supervisor module itself is loaded LAZILY: the static import above is
 * TYPE-ONLY (erased at compile time, so it never evaluates the module), and
 * the only runtime load path is the dynamic import inside the returned seam
 * — the flag-off hot path never touches the supervisor module (nor the
 * common schema imports it pulls in).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  SettledSubagentResult,
  SupervisedChildEnvSeed,
  SupervisedSpawnRequest,
} from './process-supervisor'

/** The seam `SubagentContextParams.spawnSupervised` expects. */
export type SpawnSupervisedFn = (
  request: SupervisedSpawnRequest,
) => Promise<SettledSubagentResult>

/**
 * Builds the default supervised-spawn seam. `seed` is the env allowlist
 * source — pass the explicitly-resolved credential values (never a wholesale
 * ambient env copy).
 */
export function buildDefaultSpawnSupervised(
  seed: SupervisedChildEnvSeed = {},
): SpawnSupervisedFn {
  return async (request) => {
    // Lazy on purpose: the supervisor module (Bun.spawn, the receipt schema
    // imports it pulls, and the env allowlist builder included) is evaluated
    // only when the flag is actually on — this dynamic import is the
    // module's ONLY runtime load path from here.
    const { spawnSettledSubagent, buildSupervisedChildEnv } = await import(
      './process-supervisor'
    )
    // Empty sandbox cwd: the child runtime auto-loads `.env` from its cwd,
    // which would leak repo env keys past the spawn allowlist.
    const sandboxCwd = mkdtempSync(join(tmpdir(), 'openbuff-supervised-cwd-'))
    // The request file carries the user prompt, the child systemPrompt, and
    // child agent state, so it is written INSIDE the 0700 mkdtemp sandbox
    // (never the shared tmpdir root) with mode 0o600 — only the owning user
    // can read it for the spawn's duration.
    const requestPath = join(sandboxCwd, 'openbuff-supervised-request.json')
    try {
      writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 })
      return await spawnSettledSubagent({
        childModulePath: join(
          dirname(fileURLToPath(import.meta.url)),
          'child-entry.ts',
        ),
        args: [requestPath],
        env: buildSupervisedChildEnv(seed),
        cwd: sandboxCwd,
        timeoutMs: request.timeoutMs,
      })
    } finally {
      // The request file lives inside the sandbox, so the recursive sandbox
      // removal cleans up both.
      rmSync(sandboxCwd, { recursive: true, force: true })
    }
  }
}
