import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { executionFixture } from '../../common/src/mcp/__tests__/execution-fixture'
import { createDirectHostExecution } from '../../sdk/src/host-execution'
import { captureEvaluationCommand, prepareEvaluationCommand } from './execution'

describe('supplemental evaluator execution', () => {
  test('missing runtime PID cannot return a successful evaluator capture', async () => {
    const fixture = executionFixture()
    try {
      await expect(
        captureEvaluationCommand('/fixture/missing-pid', [], {
          branchId: 'supplemental.evaluator.no-pid',
          execution: {
            ...fixture.context(),
            spawn: () => {
              const child = new EventEmitter() as ReturnType<typeof spawn>
              child.kill = () => {
                child.emit('close', 0)
                return true
              }
              queueMicrotask(() => child.emit('spawn'))
              return child
            },
          },
        }),
      ).rejects.toThrow('no valid runtime PID')
      expect(
        fixture.events.some((event) => event.phase === 'spawn-observed'),
      ).toBe(false)
    } finally {
      fixture.close()
    }
  })
  test('native.unavailable preserves explicit profile refusal before any target dispatch', async () => {
    const events: import('../../common/src/types/contracts/execution-context').LaunchEvent[] =
      []
    const profile = {
      policy: 'full-access',
      preferredBackend: 'native-exec',
      required: ['exact-env'],
      allowBackendFallback: false,
    } as const
    const captured = createDirectHostExecution({
      cwd: process.cwd(),
      profile,
      record: (event) => events.push(event),
      hostConfiguration: {
        environment: {},
        platform: 'linux',
        invocationCwd: process.cwd(),
        projectRoot: process.cwd(),
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'none' },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) throw new Error(captured.cause)
    const context = captured.value.executionContext
    const prepared = context.execution.prepareTarget({
      target: {
        executable: '/fixture/native-unavailable',
        argv: [],
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        allowedPaths: [process.cwd()],
        mode: 'assistant',
        processType: 'SYNC',
        profile,
        family: 'native-role',
        branchId: 'native.unavailable',
        adapterOptions: { runtime: 'node' },
      },
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.cause)
    const admitted = await prepared.value.admit()
    expect(admitted.ok).toBe(false)
    expect(events.filter((event) => event.phase === 'dispatched')).toHaveLength(
      0,
    )
    const refused = events.find((event) => event.phase === 'no-launch')
    expect(refused?.facts.profile.selected).toBeNull()
    expect(refused?.facts.profile.active).toBeNull()
    expect(refused?.facts.profile.requested.policy).toBe('full-access')
  })
  test('denial and cancellation after admission launch no child', async () => {
    const fixture = executionFixture({
      authorizeAsync: async () => ({
        ok: false,
        reason: 'denied',
        cause: 'evaluator denied',
      }),
    })
    let launches = 0
    try {
      await expect(
        prepareEvaluationCommand('git', ['status'], {
          execution: {
            ...fixture.context(),
            spawn: () => {
              launches++
              throw new Error('unexpected launch')
            },
          },
          branchId: 'supplemental.evaluator.test-denial',
        }),
      ).rejects.toThrow('evaluator denied')
      expect(launches).toBe(0)
    } finally {
      fixture.close()
    }
    const admittedFixture = executionFixture()
    const controller = new AbortController()
    try {
      const dispatch = await prepareEvaluationCommand('git', ['status'], {
        execution: {
          ...admittedFixture.context(controller.signal),
          spawn: () => {
            launches++
            throw new Error('unexpected launch')
          },
        },
        branchId: 'supplemental.evaluator.test-cancel',
      })
      controller.abort()
      expect(dispatch).toThrow()
      expect(launches).toBe(0)
    } finally {
      admittedFixture.close()
    }
  })

  test('captures shell bytes and options before delayed approval; one permit dispatches once', async () => {
    let approve: (() => void) | undefined
    const fixture = executionFixture({
      authorizeAsync: async () => {
        await new Promise<void>((resolve) => {
          approve = resolve
        })
        return { ok: true, basis: 'explicit-policy', decisionId: 'delayed' }
      },
    })
    const seen: unknown[] = []
    const options = {
      shell: true,
      env: { PROJECT_VALUE: 'before', OPENAI_API_KEY: 'overlay-secret' },
      detached: false,
      execution: {
        ...fixture.context(),
        spawn: (
          command: string,
          args: readonly string[] | undefined,
          input: unknown,
        ) => {
          seen.push([command, args, input])
          return {} as ReturnType<typeof spawn>
        },
      },
      branchId: 'supplemental.evaluator.test-capture',
    }
    try {
      const pending = prepareEvaluationCommand(
        'printf "%s" "$PROJECT_VALUE"',
        [],
        options,
      )
      options.env.PROJECT_VALUE = 'after'
      options.detached = true
      approve?.()
      const dispatch = await pending
      // Deliberately malformed child tests dispatch failure and one-shot permit.
      expect(dispatch).toThrow()
      expect(dispatch).toThrow()
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject([
        '/bin/sh',
        ['-c', 'printf "%s" "$PROJECT_VALUE"'],
        { detached: false, env: { PROJECT_VALUE: 'before' }, shell: false },
      ])
      expect((seen[0] as any[])[2].env).not.toHaveProperty('OPENAI_API_KEY')
    } finally {
      fixture.close()
    }
  })

  test('real evaluator child uses exact scrubbed env and bounded file capture', async () => {
    const fixture = executionFixture()
    try {
      const result = await captureEvaluationCommand(
        process.execPath,
        [
          '--no-env-file',
          '-e',
          'process.stdout.write(JSON.stringify({value:process.env.PROJECT_VALUE,canonical:!!process.env.OPENAI_API_KEY,configured:!!process.env.CUSTOM_PROVIDER_KEY}));process.stderr.write("fixture-stderr")',
        ],
        {
          execution: fixture.context(),
          env: { PROJECT_VALUE: 'evaluator-value' },
          branchId: 'supplemental.evaluator.test-real',
        },
      )
      expect(JSON.parse(result.stdout)).toEqual({
        value: 'evaluator-value',
        canonical: false,
        configured: false,
      })
      expect(result.stderr).toBe('fixture-stderr')
      expect(
        fixture.events.filter((event) => event.phase === 'spawn-observed'),
      ).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })
})
