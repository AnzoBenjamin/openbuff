import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { OwnedProcessScope } from '@codebuff/common/types/contracts/process-scope'
import { withEvaluationEnvironment } from '../evaluation-environment'
import { captureEvaluationCommand } from '../execution'
import { executionFixture } from '../../../common/src/mcp/__tests__/execution-fixture'

test('trusted evaluation applies explicit removals to the captured environment', async () => {
  const inherited = Object.freeze({
    PROJECT_VALUE: 'captured',
    REMOVE_ME: 'inherited',
  })
  const supplied = Object.freeze({
    PROJECT_VALUE: 'override',
    REMOVE_ME: undefined,
  })
  const observed = await withEvaluationEnvironment(
    'trusted_task',
    supplied,
    async (env) => env,
    inherited,
  )

  expect(observed).toEqual({ PROJECT_VALUE: 'override' })
  expect(inherited.REMOVE_ME).toBe('inherited')
  expect(supplied.REMOVE_ME).toBeUndefined()
})

test('key-free evaluation removes undefined overrides and cleans up its isolated home', async () => {
  let ownedHome = ''
  await withEvaluationEnvironment(
    'key_free_environment',
    {
      PROJECT_VALUE: 'explicit',
      PATH: undefined,
      OPENAI_API_KEY: undefined,
    },
    async (env) => {
      ownedHome = env.HOME!
      expect(existsSync(ownedHome)).toBe(true)
      expect(env.PROJECT_VALUE).toBe('explicit')
      expect(env).not.toHaveProperty('PATH')
      expect(env).not.toHaveProperty('OPENAI_API_KEY')
      expect(env).not.toHaveProperty('CUSTOM_PROVIDER_KEY')
      expect(
        Object.values(env).every((value) => typeof value === 'string'),
      ).toBe(true)
    },
    {
      OPENAI_API_KEY: 'host-sentinel',
      CUSTOM_PROVIDER_KEY: 'configured-sentinel',
    },
  )

  expect(ownedHome).not.toBe('')
  expect(existsSync(ownedHome)).toBe(false)
})

test('key-free evaluation refuses a defined supplied credential before invoking the task', async () => {
  let invoked = false
  await expect(
    withEvaluationEnvironment(
      'key_free_environment',
      { OPENAI_API_KEY: 'supplied-sentinel' },
      async () => {
        invoked = true
      },
    ),
  ).rejects.toThrow('explicitly supplied credentials')
  expect(invoked).toBe(false)
})

test('a copied cleanup summary cannot retain a key-free root', async () => {
  let ownedHome = ''
  const copied = Object.assign(new Error('copied cleanup'), {
    processCleanup: {
      scopeId: 'unregistered-copy',
      cleanupAuthorityRetained: true,
    },
  })
  await expect(
    withEvaluationEnvironment('key_free_environment', {}, async (env) => {
      ownedHome = env.HOME!
      throw copied
    }),
  ).rejects.toThrow('copied cleanup')
  expect(existsSync(ownedHome)).toBe(false)
})

test('authenticated cleanup failure retains the owned home through later recovery despite drained output', async () => {
  const fixture = executionFixture()
  const injectedChild = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  })
  const child = injectedChild as unknown as ChildProcess
  let ownedHome = ''
  let scope: OwnedProcessScope | undefined
  try {
    const error = await withEvaluationEnvironment(
      'key_free_environment',
      {},
      async (env) => {
        ownedHome = env.HOME!
        return captureEvaluationCommand('/fixture/injected-direct-child', [], {
          // This trusted fake verifies root retention at the direct-child tier;
          // it cannot certify any real PID/group cleanup.
          detached: false,
          env,
          branchId: 'supplemental.evaluator.environment-retention',
          execution: {
            ...fixture.context(),
            spawn: () => {
              queueMicrotask(() => {
                child.emit('spawn')
                injectedChild.stdout.end('final bytes')
                injectedChild.stderr.end()
                child.emit('error', new Error('injected task failure'))
              })
              return child
            },
          },
          onProcessScope: (owned) => {
            scope = owned
          },
        })
      },
    ).catch((caught) => caught)
    expect(error.message).toBe('injected task failure')
    expect(error.stdout).toBe('final bytes')
    expect(error.processCleanup.status).toBe('failed')
    expect(error.processCleanup.selectedTier).toBe('direct-child')
    expect(error.processCleanup.output.complete).toBe(true)
    expect(error.processCleanup.cleanupAuthorityRetained).toBe(true)
    expect(existsSync(ownedHome)).toBe(true)
    const original = error.processCleanup
    injectedChild.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    const recovered = await scope!.retryCleanup(true)
    expect(recovered.status).toBe('complete')
    expect(original.status).toBe('failed')
    expect(existsSync(ownedHome)).toBe(false)
  } finally {
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    if (scope?.currentCleanup()?.cleanupAuthorityRetained)
      await scope.retryCleanup(true)
    fixture.close()
  }
})

test('a resolved failure result retains only the scopes launched with its actual HOME', async () => {
  const fixture = executionFixture()
  const injectedChild = Object.assign(new EventEmitter(), {
    pid: 124,
    exitCode: null as number | null,
    signalCode: null,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  })
  const child = injectedChild as unknown as ChildProcess
  let ownedHome = ''
  let scope: OwnedProcessScope | undefined
  try {
    const result = await withEvaluationEnvironment(
      'key_free_environment',
      {},
      async (env) => {
        ownedHome = env.HOME!
        const error = await captureEvaluationCommand(
          '/fixture/resolved-retained-scope',
          [],
          {
            detached: false,
            env,
            branchId: 'supplemental.evaluator.environment-returned-failure',
            execution: {
              ...fixture.context(),
              spawn: () => {
                queueMicrotask(() => {
                  child.emit('spawn')
                  injectedChild.stdout.end('complete output')
                  injectedChild.stderr.end()
                  child.emit(
                    'error',
                    new Error('fixture failure returned as data'),
                  )
                })
                return child
              },
            },
            onProcessScope: (owned) => {
              scope = owned
            },
          },
        ).catch((caught) => caught)
        // Final-check and runner wrappers intentionally return an outcome value.
        return { outcome: 'failed', error: error.message }
      },
    )
    expect(result.outcome).toBe('failed')
    expect(existsSync(ownedHome)).toBe(true)
    injectedChild.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await scope!.retryCleanup(true)
    expect(existsSync(ownedHome)).toBe(false)
  } finally {
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    if (scope?.currentCleanup()?.cleanupAuthorityRetained)
      await scope.retryCleanup(true)
    fixture.close()
  }
})
