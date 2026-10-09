/**
 * D36 (P2-T8 slice 1): spawn-settle fault-injection suite for
 * supervision/process-supervisor.ts. Real Bun child processes are used with
 * short fixtures (~ms) and short timeouts; every timed-out child is killed by
 * the supervisor itself (SIGTERM → SIGKILL grace). Cases that need a real
 * Bun.spawn skip gracefully when Bun.spawn is unavailable.
 */
import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import {
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
} from '@codebuff/common/constants/chatgpt-oauth'
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildSupervisedChildEnv,
  SETTLE_KILL_GRACE_MS,
  SETTLE_STDOUT_CAP_BYTES,
  SUPERVISED_CHILD_ENV_ALLOWLIST,
  SUPERVISED_CHILD_RUNTIME_ENV_KEYS,
  spawnSettledSubagent,
  type SettleChildProcess,
  type SettleSpawnSeam,
  type SupervisedChildEnvSeed,
} from '../process-supervisor'

const canSpawn =
  typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'
const fixturePath = join(import.meta.dir, '../__fixtures__/settle-child.ts')

/**
 * A fake child that survives every kill until the SIGKILL step (recording
 * each call), then EOFs its streams and exits by signal — mimicking a real
 * child that ignores SIGTERM. Direct `kill` and optional `killGroup` calls
 * are recorded in SEPARATE arrays; `group` absent ⇒ the seam exposes no
 * killGroup (the direct-kill fallback path).
 */
function recordingChildSeam(sinks: {
  direct: Array<'SIGTERM' | 'SIGKILL'>
  group?: Array<'SIGTERM' | 'SIGKILL'>
}): SettleSpawnSeam {
  return () => {
    let closeStdout: (() => void) | undefined
    let closeStderr: (() => void) | undefined
    let resolveExit: (code: number | null) => void = () => {}
    const record = (
      sink: Array<'SIGTERM' | 'SIGKILL'>,
      signal?: 'SIGTERM' | 'SIGKILL',
    ): void => {
      const resolved = signal ?? 'SIGTERM'
      sink.push(resolved)
      if (resolved === 'SIGKILL') {
        closeStdout?.()
        closeStderr?.()
        resolveExit(null)
      }
    }
    const child: SettleChildProcess = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          closeStdout = () => controller.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          closeStderr = () => controller.close()
        },
      }),
      exited: new Promise<number | null>((resolve) => {
        resolveExit = resolve
      }),
      kill: (signal) => record(sinks.direct, signal),
    }
    const group = sinks.group
    if (group !== undefined) {
      child.killGroup = (signal) => record(group, signal)
    }
    return child
  }
}

/**
 * A minimal `agentReceiptSchema`-valid envelope the idle-survival case writes
 * to the stub child's stdout so the clean exit settles as 'ok'. Mirrors the
 * fixture's MINIMAL_OK_RECEIPT shape (required fields + the seven arrays).
 */
const VALID_SETTLE_RECEIPT = {
  schemaVersion: 1,
  receiptId: 'idle-fixture-receipt',
  taskId: 'idle-fixture-task',
  role: 'specialist',
  agentId: 'idle-fixture-agent',
  status: 'completed',
  outcome: 'ok',
  changedFiles: [],
  requirementsAddressed: [],
  acceptanceCriteriaAddressed: [],
  findingsAddressed: [],
  evidence: [],
  assumptions: [],
  unresolved: [],
  requestedValidation: [],
  artifacts: [],
  errors: [],
}

/**
 * A fully MANUAL stub child for the idle-aware cases: the test drives stdout
 * bytes, stream EOF, and the `exited` resolution itself (nothing settles on
 * its own), and direct `kill` calls are recorded. A SIGKILL still EOFs the
 * streams and resolves the exit (mirroring a real signal death) so a kill
 * path can never hang the settle.
 */
function controllableChildSeam(): {
  seam: SettleSpawnSeam
  emitStdout: (text: string) => void
  closeStreams: () => void
  resolveExit: (code: number | null) => void
  directKills: Array<'SIGTERM' | 'SIGKILL'>
} {
  const directKills: Array<'SIGTERM' | 'SIGKILL'> = []
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stderrController!: ReadableStreamDefaultController<Uint8Array>
  let resolveExitFn: (code: number | null) => void = () => {}
  let stdoutClosed = false
  let stderrClosed = false
  const closeStreams = (): void => {
    if (!stdoutClosed) {
      stdoutClosed = true
      stdoutController.close()
    }
    if (!stderrClosed) {
      stderrClosed = true
      stderrController.close()
    }
  }
  const seam: SettleSpawnSeam = () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        stderrController = controller
      },
    }),
    exited: new Promise<number | null>((resolve) => {
      resolveExitFn = resolve
    }),
    kill: (signal) => {
      const resolved = signal ?? 'SIGTERM'
      directKills.push(resolved)
      if (resolved === 'SIGKILL') {
        closeStreams()
        resolveExitFn(null)
      }
    },
  })
  return {
    seam,
    emitStdout: (text) =>
      stdoutController.enqueue(new TextEncoder().encode(text)),
    closeStreams,
    resolveExit: (code) => resolveExitFn(code),
    directKills,
  }
}

describe('spawnSettledSubagent', () => {
  it.skipIf(!canSpawn)(
    'happy path: settles a healthy child as ok with a validated receipt',
    async () => {
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['ok'],
        timeoutMs: 10_000,
      })
      expect(result.outcome).toBe('ok')
      expect(result.crashReason).toBeUndefined()
      expect(result.exitCode).toBe(0)
      expect(result.receipt?.outcome).toBe('ok')
      expect(result.receipt?.status).toBe('completed')
      expect(result.receipt?.taskId).toBe('settle-fixture-task')
      expect(result.durationMs).toBeGreaterThan(0)
      expect(result.killed).toBe(false)
    },
  )

  it.skipIf(!canSpawn)(
    'no-output: silent exit 0 settles as missing_output',
    async () => {
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['no-output'],
        timeoutMs: 10_000,
      })
      expect(result.outcome).toBe('missing_output')
      expect(result.receipt).toBeUndefined()
      expect(result.exitCode).toBe(0)
    },
  )

  it.skipIf(!canSpawn)(
    'invalid JSON line settles as schema_invalid',
    async () => {
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['invalid'],
        timeoutMs: 10_000,
      })
      expect(result.outcome).toBe('schema_invalid')
      expect(result.receipt).toBeUndefined()
      expect(result.exitCode).toBe(0)
    },
  )

  it.skipIf(!canSpawn)(
    'valid JSON that fails the receipt schema settles as schema_invalid with a diagnostic',
    async () => {
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['bad-schema'],
        timeoutMs: 10_000,
      })
      expect(result.outcome).toBe('schema_invalid')
      expect(result.receipt).toBeUndefined()
      expect(typeof result.schemaError).toBe('string')
      expect(result.schemaError?.length ?? 0).toBeGreaterThan(0)
    },
  )

  it.skipIf(!canSpawn)(
    'stdout past the 8 MiB cap settles as truncated with the validated envelope retained',
    async () => {
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['truncated'],
        timeoutMs: 20_000,
      })
      expect(result.outcome).toBe('truncated')
      expect(result.exitCode).toBe(0)
      expect(result.receipt?.taskId).toBe('settle-fixture-task')
      expect(result.stdoutBytes).toBeGreaterThan(SETTLE_STDOUT_CAP_BYTES)
    },
  )

  it.skipIf(!canSpawn)('crash: non-zero exit settles as crashed', async () => {
    const result = await spawnSettledSubagent({
      childModulePath: fixturePath,
      args: ['crash'],
      timeoutMs: 10_000,
    })
    expect(result.outcome).toBe('crashed')
    expect(result.crashReason).toBe('nonzero_exit')
    expect(result.exitCode).toBe(1)
    expect(result.receipt).toBeUndefined()
  })

  it.skipIf(!canSpawn)(
    'timeout: kills the child and settles as crashed with reason timeout well before the grace window ends',
    async () => {
      const timeoutMs = 250
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['slow', '5000'],
        timeoutMs,
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('timeout')
      expect(result.killed).toBe(true)
      // The child was actually killed: the settle finished inside the
      // SIGTERM→SIGKILL grace window instead of waiting out the 5s sleep.
      expect(result.durationMs).toBeLessThan(timeoutMs + SETTLE_KILL_GRACE_MS)
      expect(result.durationMs).toBeGreaterThanOrEqual(200)
    },
  )

  it(
    'timeout: kills the WHOLE process group (SIGTERM → SIGKILL) when the seam provides killGroup',
    async () => {
      const directKills: Array<'SIGTERM' | 'SIGKILL'> = []
      const groupKills: Array<'SIGTERM' | 'SIGKILL'> = []
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        timeoutMs: 50,
        spawn: recordingChildSeam({ direct: directKills, group: groupKills }),
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('timeout')
      expect(result.killed).toBe(true)
      // Group kill first so shell grandchildren die too: SIGTERM, then the
      // escalation SIGKILL, both to the group — and NEVER the direct kill.
      expect(groupKills).toEqual(['SIGTERM', 'SIGKILL'])
      expect(directKills).toEqual([])
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'timeout: reaps REAL shell grandchildren via the process-group kill (P2-T8 audit gap)',
    async () => {
      // Real-process proof of the group kill: the fixture spawns a genuine
      // `sh -c 'sleep 30'` grandchild (pid recorded to a file, NO setsid/
      // nohup so it stays in the fixture child's process group), the
      // supervisor times out, and the grandchild must be DEAD once the
      // settle completes — because the default seam spawned the child
      // detached as a group leader and the SIGTERM→SIGKILL escalation goes
      // to the WHOLE group via a negative-pid kill.
      const sandbox = mkdtempSync(join(tmpdir(), 'settle-grandchild-'))
      const pidFile = join(sandbox, 'grandchild-pid')
      let grandchildPid: number | undefined
      try {
        const settlePromise = spawnSettledSubagent({
          childModulePath: fixturePath,
          args: ['grandchild', pidFile, '30'],
          // PATH so the shell can resolve `sleep`; forwarded verbatim like
          // any explicit allowlist the caller passes.
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          // The settle timeout must stay LONGER than fixture startup (bun
          // boot + shell fork + pid-file write): if the group kill landed
          // first, the pid file would never be written and the poll below
          // would race the kill instead of observing the recorded pid.
          timeoutMs: 2_000,
        })
        // Wait for the fixture to record the grandchild pid (the shell
        // writes it right after forking `sleep`; poll instead of racing).
        // The bounded window (150 × 20ms = 3s) outlasts the 2s settle
        // timeout so a pid written just before the kill is still observed —
        // the pid file persists on disk after the group teardown.
        for (let i = 0; i < 150 && grandchildPid === undefined; i++) {
          try {
            const parsed = Number((await Bun.file(pidFile).text()).trim())
            if (Number.isInteger(parsed) && parsed > 0) grandchildPid = parsed
          } catch {
            // Pid file not written yet.
          }
          if (grandchildPid === undefined) await Bun.sleep(20)
        }
        expect(grandchildPid).toBeGreaterThan(0)

        const result = await settlePromise
        expect(result.outcome).toBe('crashed')
        expect(result.crashReason).toBe('timeout')
        expect(result.killed).toBe(true)
        expect(result.durationMs).toBeLessThan(2_000 + SETTLE_KILL_GRACE_MS)

        // The grandchild is reaped after the settle: poll /proc for ~3s max
        // (SIGTERM should end it immediately; the grace window covers a
        // slow SIGTERM handler before the supervisor's SIGKILL escalation).
        const deadline = Date.now() + 3_000
        let alive = true
        while (Date.now() < deadline) {
          alive = existsSync(`/proc/${grandchildPid}`)
          if (!alive) break
          await Bun.sleep(50)
        }
        expect(alive).toBe(false)
      } finally {
        // Cleanup even on failure: best-effort direct kill of the recorded
        // grandchild (no-op when the group kill already reaped it), then
        // remove the sandbox holding the pid file.
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, 'SIGKILL')
          } catch {
            // Already reaped by the group kill.
          }
        }
        rmSync(sandbox, { recursive: true, force: true })
      }
    },
  )

  it(
    'timeout: falls back to the direct-pid kill (SIGTERM → SIGKILL) when the seam has no killGroup',
    async () => {
      const directKills: Array<'SIGTERM' | 'SIGKILL'> = []
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        timeoutMs: 50,
        spawn: recordingChildSeam({ direct: directKills }),
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('timeout')
      expect(result.killed).toBe(true)
      // Injected seams without killGroup keep the pre-existing behavior:
      // SIGTERM then SIGKILL against the direct child pid.
      expect(directKills).toEqual(['SIGTERM', 'SIGKILL'])
    },
  )

  // ── Behavior A: idle-aware deadline (idleTimeoutMs / maxLifetimeMs /
  // onActivity) ─────────────────────────────────────────────────────────

  it('idle window resets on injected activity and survives past idleTimeoutMs', async () => {
    // Injected activity source: each fired listener resets the idle window.
    const ls = new Set<() => void>()
    const emit = () => ls.forEach((f) => f())
    const onActivity = (f: () => void) => {
      ls.add(f)
      return () => {
        ls.delete(f)
      }
    }
    const child = controllableChildSeam()
    const receiptLine = `${JSON.stringify(VALID_SETTLE_RECEIPT)}\n`

    const settlePromise = spawnSettledSubagent({
      childModulePath: fixturePath,
      idleTimeoutMs: 50,
      onActivity,
      spawn: child.seam,
    })

    // Fire activity every ~30ms so total elapsed crosses the raw 50ms idle
    // window (4 pings ≈ 120ms); each reset keeps the child alive.
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(30)
      emit()
    }
    // Resolve the clean exit shortly after the final ping — well within one
    // idle window — so 'ok' is driven by the exit, not a race with the timer.
    await Bun.sleep(10)
    child.emitStdout(receiptLine)
    child.closeStreams()
    child.resolveExit(0)

    const result = await settlePromise
    // Activity kept it alive past the 50ms window: a clean 'ok', never killed.
    expect(result.outcome).toBe('ok')
    expect(result.crashReason).toBeUndefined()
    expect(result.killed).toBe(false)
    expect(result.receipt?.taskId).toBe('idle-fixture-task')
    expect(child.directKills).toEqual([])
  })

  it('idle window with no activity kills at idleTimeoutMs', async () => {
    const directKills: Array<'SIGTERM' | 'SIGKILL'> = []
    const result = await spawnSettledSubagent({
      childModulePath: fixturePath,
      idleTimeoutMs: 50,
      // No onActivity and a child that neither exits nor emits: the ONLY thing
      // that can settle it is the idle deadline kill.
      spawn: recordingChildSeam({ direct: directKills }),
    })
    expect(result.outcome).toBe('crashed')
    expect(result.crashReason).toBe('timeout')
    expect(result.killed).toBe(true)
    // SIGTERM first (then the SIGKILL escalation the recorder uses to settle).
    expect(directKills).toContain('SIGTERM')
  })

  it('maxLifetimeMs caps a continuously-active child', async () => {
    const ls = new Set<() => void>()
    const emit = () => ls.forEach((f) => f())
    const onActivity = (f: () => void) => {
      ls.add(f)
      return () => {
        ls.delete(f)
      }
    }
    const directKills: Array<'SIGTERM' | 'SIGKILL'> = []
    // Fire activity every ~30ms (< the 50ms idle window) across the whole
    // run, so the idle timer never fires — only the absolute cap can kill it.
    const ticker = setInterval(emit, 30)
    try {
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        idleTimeoutMs: 50,
        maxLifetimeMs: 120,
        onActivity,
        spawn: recordingChildSeam({ direct: directKills }),
      })
      // Continuous activity resets the idle window but NOT the absolute cap:
      // the child is still killed (~120ms) with crashReason timeout.
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('timeout')
      expect(result.killed).toBe(true)
      expect(directKills).toContain('SIGTERM')
    } finally {
      clearInterval(ticker)
    }
  })

  it('omitting idleTimeoutMs/onActivity preserves the legacy single wall-clock timer', async () => {
    const directKills: Array<'SIGTERM' | 'SIGKILL'> = []
    const result = await spawnSettledSubagent({
      childModulePath: fixturePath,
      // Only the legacy wall-clock timeoutMs — no idle params at all.
      timeoutMs: 50,
      spawn: recordingChildSeam({ direct: directKills }),
    })
    // Byte-identical-baseline guard: unchanged crashed/timeout + SIGTERM→
    // SIGKILL direct-pid kill.
    expect(result.outcome).toBe('crashed')
    expect(result.crashReason).toBe('timeout')
    expect(result.killed).toBe(true)
    expect(directKills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it(
    'P2-T8d SELF-EXEC: cmdOverride is used VERBATIM and args are ignored',
    async () => {
      const received: string[][] = []
      const spawn: SettleSpawnSeam = (request) => {
        received.push(request.cmd)
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          exited: Promise.resolve(0),
          kill: () => {},
        }
      }
      const override = [
        '/opt/openbuff/openbuff',
        '--supervised-child',
        '/tmp/request.json',
      ]
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['ignored'],
        cmdOverride: override,
        spawn,
      })
      // Empty stdout + exit 0 settles missing_output (transport lives
      // elsewhere); the assertion is the COMMAND the seam received.
      expect(result.outcome).toBe('missing_output')
      expect(received).toEqual([override])
    },
  )

  it(
    'P2-T8d SELF-EXEC: without cmdOverride the default bun-source cmd is byte-identical',
    async () => {
      const received: string[][] = []
      const spawn: SettleSpawnSeam = (request) => {
        received.push(request.cmd)
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          exited: Promise.resolve(0),
          kill: () => {},
        }
      }
      await spawnSettledSubagent({
        childModulePath: fixturePath,
        args: ['ok'],
        spawn,
      })
      expect(received).toEqual([[process.execPath, 'run', fixturePath, 'ok']])
    },
  )

  it('spawn failure (ENOENT via injected seam) settles as crashed spawn_failed', async () => {
    const spawn: SettleSpawnSeam = () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    const result = await spawnSettledSubagent({
      childModulePath: fixturePath,
      spawn,
    })
    expect(result.outcome).toBe('crashed')
    expect(result.crashReason).toBe('spawn_failed')
    expect(result.exitCode).toBeNull()
    expect(result.receipt).toBeUndefined()
  })

  it(
    'internal error: a stream error kills the child instead of orphaning it',
    async () => {
      const kills: Array<'SIGTERM' | 'SIGKILL'> = []
      const spawn: SettleSpawnSeam = () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('stdout stream blew up'))
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        // The child never exits on its own — only the supervisor's kill
        // settles it, proving the internal-error path reaps the child.
        exited: new Promise<number | null>(() => {}),
        kill: (signal) => {
          kills.push(signal ?? 'SIGTERM')
        },
      })
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        spawn,
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('internal_error')
      // The child was actually killed (never orphaned) and reported as such.
      expect(result.killed).toBe(true)
      expect(kills).toEqual(['SIGKILL'])
    },
  )

  it(
    'internal error: a rejected exited promise kills the child instead of orphaning it',
    async () => {
      const kills: Array<'SIGTERM' | 'SIGKILL'> = []
      const spawn: SettleSpawnSeam = () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        exited: Promise.reject(new Error('exited promise failed')),
        kill: (signal) => {
          kills.push(signal ?? 'SIGTERM')
        },
      })
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        spawn,
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toBe('internal_error')
      expect(result.killed).toBe(true)
      expect(kills).toEqual(['SIGKILL'])
    },
  )

  it(
    'stdout bytes with NO newline-terminated line settle as schema_invalid — never ok, never missing_output',
    async () => {
      // Security contract: only EMPTY stdout maps to missing_output. A child
      // that wrote bytes that never form the contracted single
      // newline-terminated JSON envelope produced garbage, and garbage
      // stdout must never settle ok (or masquerade as a silent child).
      const spawn: SettleSpawnSeam = () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'child-entry: not json garbage without a trailing newline',
              ),
            )
            controller.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      })
      const result = await spawnSettledSubagent({
        childModulePath: fixturePath,
        spawn,
      })
      expect(result.outcome).toBe('schema_invalid')
      expect(result.receipt).toBeUndefined()
      expect(result.exitCode).toBe(0)
      expect(result.stdoutBytes).toBeGreaterThan(0)
    },
  )

  it.skipIf(!canSpawn)(
    'env allowlist: the child sees ONLY the injected keys, never ambient env',
    async () => {
      // The child runtime auto-loads `.env` from its CWD, which would leak
      // repo env keys past the spawn allowlist — so the child runs from an
      // EMPTY sandbox dir, proving the allowlist is the only env source.
      const sandboxCwd = mkdtempSync(join(tmpdir(), 'settle-env-sandbox-'))
      try {
        const result = await spawnSettledSubagent({
          childModulePath: fixturePath,
          args: ['env'],
          env: { PROBE_ALPHA: '1', PROBE_BETA: '2' },
          timeoutMs: 10_000,
          cwd: sandboxCwd,
        })
        expect(result.outcome).toBe('ok')
        // 'PATH' is ambient in every dev environment and was NOT injected, so
        // its absence proves the ambient env was never forwarded.
        expect(result.receipt?.requirementsAddressed).toEqual([
          'PROBE_ALPHA',
          'PROBE_BETA',
        ])
      } finally {
        rmSync(sandboxCwd, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!canSpawn)(
    'env allowlist: seeded runtime passthrough keys reach a real child',
    async () => {
      const sandboxCwd = mkdtempSync(join(tmpdir(), 'settle-env-sandbox-'))
      try {
        const result = await spawnSettledSubagent({
          childModulePath: fixturePath,
          args: ['env'],
          env: buildSupervisedChildEnv({
            openbuffApiKey: 'sk-openbuff-test',
            passthroughEnv: {
              OPENBUFF_PROVIDER_CONFIG: '/tmp/openbuff-provider.json',
              HTTPS_PROXY: 'http://proxy.test:8443',
              no_proxy: 'localhost,.test',
              TMPDIR: sandboxCwd,
              LANG: 'en_US.UTF-8',
              CODEBUFF_RG_PATH: '/opt/openbuff/vendor/rg',
            },
          }),
          timeoutMs: 10_000,
          cwd: sandboxCwd,
        })
        expect(result.outcome).toBe('ok')
        expect(result.receipt?.requirementsAddressed).toEqual([
          'CODEBUFF_RG_PATH',
          'HTTPS_PROXY',
          'LANG',
          'OPENBUFF_API_KEY',
          'OPENBUFF_PROVIDER_CONFIG',
          'TMPDIR',
          'no_proxy',
        ])
      } finally {
        rmSync(sandboxCwd, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!canSpawn)(
    'two concurrent spawns settle independently',
    async () => {
      const [okResult, crashResult] = await Promise.all([
        spawnSettledSubagent({
          childModulePath: fixturePath,
          args: ['ok'],
          timeoutMs: 10_000,
        }),
        spawnSettledSubagent({
          childModulePath: fixturePath,
          args: ['crash'],
          timeoutMs: 10_000,
        }),
      ])
      expect(okResult.outcome).toBe('ok')
      expect(okResult.receipt?.taskId).toBe('settle-fixture-task')
      expect(crashResult.outcome).toBe('crashed')
      expect(crashResult.exitCode).toBe(1)
    },
  )
})

// P2-T8 adoption slice: buildSupervisedChildEnv — the child env allowlist
// builder. Asserts the EXACT key set: seeded credential keys present under
// their canonical env names, every unseeded key absent, and NO ambient keys
// ever forwarded (PATH/HOME appear only when explicitly seeded).
describe('buildSupervisedChildEnv env allowlist (P2-T8)', () => {
  it('emits exactly the allowlisted keys that carry a seeded value', () => {
    const env = buildSupervisedChildEnv({
      openbuffApiKey: 'sk-openbuff-test',
      byokOpenrouterApiKey: 'sk-or-v1-test',
      chatGptOauthToken: 'chatgpt-token-test',
      nodeEnv: 'test',
      path: '/usr/bin:/bin',
      home: '/home/test',
      passthroughEnv: {
        OPENBUFF_PROVIDER_CONFIG: '/tmp/openbuff-provider.json',
        HTTP_PROXY: 'http://proxy.test:8080',
        http_proxy: 'http://proxy.test:8080',
        HTTPS_PROXY: 'http://proxy.test:8443',
        https_proxy: 'http://proxy.test:8443',
        NO_PROXY: 'localhost,.test',
        no_proxy: 'localhost,.test',
        TMPDIR: '/tmp/child',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        CODEBUFF_RG_PATH: '/opt/openbuff/vendor/rg',
      },
    })
    // Default JS sort (UTF-16 code units): uppercase keys sort before
    // lowercase ones; 'HOME' < 'HTTPS_PROXY' ('O' < 'T'); 'LC_ALL' <
    // 'LC_CTYPE' ('A' < 'C'); 'NODE_ENV' < 'NO_PROXY' ('D' < '_').
    expect(Object.keys(env).sort()).toEqual([
      BYOK_OPENROUTER_ENV_VAR,
      CHATGPT_OAUTH_TOKEN_ENV_VAR,
      'CODEBUFF_RG_PATH',
      'HOME',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'NODE_ENV',
      'NO_PROXY',
      'OPENBUFF_API_KEY',
      'OPENBUFF_PROVIDER_CONFIG',
      'PATH',
      'TMPDIR',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ])
    expect(env['OPENBUFF_API_KEY']).toBe('sk-openbuff-test')
    expect(env[BYOK_OPENROUTER_ENV_VAR]).toBe('sk-or-v1-test')
    expect(env[CHATGPT_OAUTH_TOKEN_ENV_VAR]).toBe('chatgpt-token-test')
    expect(env['NODE_ENV']).toBe('test')
    expect(env['OPENBUFF_PROVIDER_CONFIG']).toBe('/tmp/openbuff-provider.json')
    expect(env['HTTP_PROXY']).toBe('http://proxy.test:8080')
    expect(env['http_proxy']).toBe('http://proxy.test:8080')
    expect(env['HTTPS_PROXY']).toBe('http://proxy.test:8443')
    expect(env['https_proxy']).toBe('http://proxy.test:8443')
    expect(env['NO_PROXY']).toBe('localhost,.test')
    expect(env['no_proxy']).toBe('localhost,.test')
    expect(env['TMPDIR']).toBe('/tmp/child')
    expect(env['LANG']).toBe('en_US.UTF-8')
    expect(env['LC_ALL']).toBe('en_US.UTF-8')
    expect(env['LC_CTYPE']).toBe('en_US.UTF-8')
    expect(env['CODEBUFF_RG_PATH']).toBe('/opt/openbuff/vendor/rg')
  })

  it('falls back OPENBUFF_API_KEY → CODEBUFF_API_KEY for the legacy key', () => {
    const env = buildSupervisedChildEnv({ codebuffApiKey: 'sk-legacy' })
    expect(Object.keys(env)).toEqual(['OPENBUFF_API_KEY'])
    expect(env['OPENBUFF_API_KEY']).toBe('sk-legacy')
  })

  it('forwards the openbuff ChatGPT OAuth spelling under its own key', () => {
    const env = buildSupervisedChildEnv({
      openbuffChatGptOauthToken: 'token-openbuff',
    })
    expect(env[OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR]).toBe('token-openbuff')
  })

  it('omits every key that has no seed and forwards NO ambient keys', () => {
    const env = buildSupervisedChildEnv({})
    expect(env).toEqual({})
    expect('PATH' in env).toBe(false)
    expect('HOME' in env).toBe(false)
    expect('NODE_ENV' in env).toBe(false)
  })

  it('PATH/HOME are forwarded ONLY when explicitly seeded (native-tool opt-in)', () => {
    const without = buildSupervisedChildEnv({ openbuffApiKey: 'k' })
    expect('PATH' in without).toBe(false)
    expect('HOME' in without).toBe(false)
    const withNative = buildSupervisedChildEnv({
      openbuffApiKey: 'k',
      path: '/usr/bin',
      home: '/home/test',
    })
    expect(withNative['PATH']).toBe('/usr/bin')
    expect(withNative['HOME']).toBe('/home/test')
  })

  it('runtime passthrough keys are forwarded ONLY when seeded', () => {
    const env = buildSupervisedChildEnv({ openbuffApiKey: 'k' })
    for (const key of SUPERVISED_CHILD_RUNTIME_ENV_KEYS) {
      expect(key in env).toBe(false)
    }
  })

  it('ignores passthrough keys outside the closed runtime universe', () => {
    const passthrough: SupervisedChildEnvSeed['passthroughEnv'] = {
      HTTP_PROXY: 'http://proxy:1',
    }
    // Simulate ambient keys slipping into the seed object at runtime (the
    // static type already prevents this; the builder must also ignore them —
    // notably credential-named keys).
    const withAmbient = Object.assign({}, passthrough, {
      AMBIENT_NOT_IN_UNIVERSE: 'leak',
      OPENAI_API_KEY: 'secret',
    })
    const env = buildSupervisedChildEnv({ passthroughEnv: withAmbient })
    expect(Object.keys(env)).toEqual(['HTTP_PROXY'])
    expect('AMBIENT_NOT_IN_UNIVERSE' in env).toBe(false)
    expect('OPENAI_API_KEY' in env).toBe(false)
  })

  it('SUPERVISED_CHILD_ENV_ALLOWLIST is the closed key universe', () => {
    // Default JS sort (UTF-16 code units): uppercase keys sort before
    // lowercase ones; 'HOME' < 'HTTPS_PROXY' ('O' < 'T'); 'LC_ALL' <
    // 'LC_CTYPE' ('A' < 'C'); 'NODE_ENV' < 'NO_PROXY' ('D' < '_').
    expect([...SUPERVISED_CHILD_ENV_ALLOWLIST].sort()).toEqual([
      BYOK_OPENROUTER_ENV_VAR,
      CHATGPT_OAUTH_TOKEN_ENV_VAR,
      'CODEBUFF_RG_PATH',
      'HOME',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'NODE_ENV',
      'NO_PROXY',
      'OPENBUFF_API_KEY',
      OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
      'OPENBUFF_PROVIDER_CONFIG',
      'PATH',
      'TMPDIR',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ])
  })
})
