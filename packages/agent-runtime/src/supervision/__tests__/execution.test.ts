import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  executionFixture,
  value,
} from '../../../../../common/src/mcp/__tests__/execution-fixture'
import { spawnSettledSubagent } from '../process-supervisor'
import type {
  SpawnSettledSubagentParams,
  SettledSubagentResult,
} from '../process-supervisor'
import { buildDefaultSpawnSupervised } from '../supervised-spawn'

const childModulePath = new URL(
  '../__fixtures__/settle-child.ts',
  import.meta.url,
).pathname
const crashed: SettledSubagentResult = {
  outcome: 'crashed',
  crashReason: 'nonzero_exit',
  exitCode: 1,
  durationMs: 1,
  stdoutBytes: 0,
  killed: false,
  stderrTail: '',
}
const request = {
  agentType: 'fixture',
  prompt: 'probe',
  spawnParams: undefined,
  timeoutMs: 1000,
}

describe('supervised execution admission', () => {
  test('an action deadline ends a long retry backoff before another attempt', async () => {
    const fixture = executionFixture()
    let attempts = 0
    const seam = buildDefaultSpawnSupervised({}, undefined, {
      executionForRequest: () => fixture.context(),
      restart: { maxAttempts: 1, backoffMs: 5000 },
      _spawnSettledSubagent: async () => {
        attempts++
        return crashed
      },
    })
    const started = performance.now()
    try {
      await seam({ ...request, timeoutMs: 40 })
      expect(attempts).toBe(1)
      expect(performance.now() - started).toBeLessThan(2000)
    } finally {
      fixture.close()
    }
  })

  test.each([
    'supervised.source.initial',
    'supervised.source.retry',
    'supervised.self-exec.initial',
    'supervised.self-exec.retry',
  ] as const)('denied %s is typed and invokes no spawn', async (branchId) => {
    const fixture = executionFixture({
      authorizeAsync: async () => ({
        ok: false,
        reason: 'denied',
        cause: 'supervisor denied',
      }),
    })
    let launches = 0
    try {
      const result = await spawnSettledSubagent({
        childModulePath,
        branchId,
        execution: fixture.context(),
        spawn: () => {
          launches++
          throw new Error('must not spawn')
        },
      })
      expect(result.executionRefusal?.reason).toBe('denied')
      expect(launches).toBe(0)
      expect(
        fixture.events.filter((event) => event.phase === 'spawn-observed'),
      ).toHaveLength(0)
    } finally {
      fixture.close()
    }
  })

  test.each([
    'supervised.self-exec.initial',
    'supervised.self-exec.retry',
  ] as const)(
    '%s preserves the exact compiled command vector at the actual adapter seam (DI)',
    async (branchId) => {
      const fixture = executionFixture()
      const cmd = [
        '/fixture/openbuff-compiled',
        '--openbuff-supervised-child',
        '/fixture/request.json',
      ]
      let recorded: string[] | undefined
      try {
        await spawnSettledSubagent({
          childModulePath,
          cmdOverride: cmd,
          branchId,
          execution: fixture.context(),
          spawn: (request) => {
            recorded = request.cmd
            return {
              stdout: new ReadableStream({
                start(controller) {
                  controller.close()
                },
              }),
              stderr: new ReadableStream({
                start(controller) {
                  controller.close()
                },
              }),
              exited: Promise.resolve(0),
              kill: () => {},
            }
          },
        })
        expect(recorded).toEqual(cmd)
        expect(
          fixture.events.filter((event) => event.phase === 'dispatched'),
        ).toHaveLength(1)
        expect(
          fixture.events.filter((event) => event.phase === 'spawn-observed'),
        ).toHaveLength(0)
      } finally {
        fixture.close()
      }
    },
  )

  test('actual Bun observation precedes narrowed settle and strips canonical/configured credentials', async () => {
    const fixture = executionFixture()
    try {
      const result = await spawnSettledSubagent({
        childModulePath,
        args: ['env'],
        execution: fixture.context(),
        env: {
          OPENAI_API_KEY: 'reinsert-attempt',
          CUSTOM_PROVIDER_KEY: 'reinsert-attempt',
          PROJECT_VALUE: 'ordinary',
        },
      })
      expect(result.outcome).toBe('ok')
      expect(result.receipt?.requirementsAddressed).toContain('PROJECT_VALUE')
      expect(result.receipt?.requirementsAddressed).not.toContain(
        'OPENAI_API_KEY',
      )
      expect(result.receipt?.requirementsAddressed).not.toContain(
        'CUSTOM_PROVIDER_KEY',
      )
      const observed = fixture.events.filter(
        (event) => event.phase === 'spawn-observed',
      )
      expect(observed).toHaveLength(1)
      expect(observed[0].pid).toBeGreaterThan(0)
    } finally {
      fixture.close()
    }
  })

  test('retry retains the same derived action and authority stays out of wire JSON', async () => {
    const fixture = executionFixture()
    const attempts: SpawnSettledSubagentParams[] = []
    const wire: Record<string, unknown>[] = []
    const seam = buildDefaultSpawnSupervised({}, undefined, {
      executionForRequest: () => fixture.context(),
      restart: { maxAttempts: 1 },
      _scheduleRestart: async () => {},
      _spawnSettledSubagent: async (params) => {
        attempts.push(params)
        wire.push(JSON.parse(readFileSync(params.args![0], 'utf8')))
        return crashed
      },
    })
    try {
      await seam(request)
      expect(attempts).toHaveLength(2)
      expect(attempts[0].execution).toBe(attempts[1].execution)
      expect(attempts.map((attempt) => attempt.branchId)).toEqual([
        'supervised.source.initial',
        'supervised.source.retry',
      ])
      for (const payload of wire) {
        expect(payload).not.toHaveProperty('execution')
        expect(payload).not.toHaveProperty('executionForRequest')
      }
    } finally {
      fixture.close()
    }
  })

  test('typed refusal is never restarted', async () => {
    const fixture = executionFixture()
    let attempts = 0
    const seam = buildDefaultSpawnSupervised({}, undefined, {
      executionForRequest: () => fixture.context(),
      restart: { maxAttempts: 2 },
      _scheduleRestart: async () => {},
      _spawnSettledSubagent: async () => {
        attempts++
        return {
          ...crashed,
          executionRefusal: { ok: false, reason: 'denied', cause: 'refused' },
        }
      },
    })
    try {
      expect((await seam(request)).executionRefusal?.reason).toBe('denied')
      expect(attempts).toBe(1)
    } finally {
      fixture.close()
    }
  })

  test('expired shared action cannot gain a new deadline on a retry branch', async () => {
    let clock = 0
    const fixture = executionFixture({
      clock: { domainId: 'retry-clock', nowMs: () => clock },
    })
    const context = fixture.context()
    const execution = {
      ...context,
      execution: value(
        context.execution.derive({
          memoKey: 'supervised.action',
          limit: { kind: 'finite', durationMs: 10 },
        }),
      ),
    }
    clock = 11
    let launches = 0
    try {
      for (const branchId of [
        'supervised.source.retry',
        'supervised.self-exec.retry',
      ] as const) {
        const result = await spawnSettledSubagent({
          childModulePath,
          execution,
          branchId,
          spawn: () => {
            launches++
            throw new Error('must not spawn')
          },
        })
        expect(result.executionRefusal).toBeDefined()
      }
      expect(launches).toBe(0)
    } finally {
      fixture.close()
    }
  })
})
