/**
 * D36 (P2-T8 slice 1): spawn-settle fault-injection suite for
 * supervision/process-supervisor.ts. Real Bun child processes are used with
 * short fixtures (~ms) and short timeouts; every timed-out child is killed by
 * the supervisor itself (SIGTERM → SIGKILL grace). Cases that need a real
 * Bun.spawn skip gracefully when Bun.spawn is unavailable.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SETTLE_KILL_GRACE_MS,
  SETTLE_STDOUT_CAP_BYTES,
  spawnSettledSubagent,
  type SettleSpawnSeam,
} from '../process-supervisor'

const canSpawn =
  typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'
const fixturePath = join(import.meta.dir, '../__fixtures__/settle-child.ts')

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
