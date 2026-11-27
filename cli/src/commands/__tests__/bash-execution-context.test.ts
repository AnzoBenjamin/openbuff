import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'
import * as sdk from '@openbuff/sdk'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import * as projectFiles from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { cancelAllBashCommands } from '../../utils/bash-command-controller'
import * as cliEnv from '../../utils/env'
import * as turnSnapshots from '../../utils/turn-snapshots'
import { runBashCommand } from '../router'

const createHost = sdk.createConfiguredDirectHostExecution
const fixtureRoot = '/tmp/openbuff-bash-context-fixture'
const fixtureEnv = { PATH: '/usr/bin:/bin', SHELL_CONTEXT_SENTINEL: 'captured' }
const unknownCleanup: CleanupResult = {
  attemptId: 'caller-projection-fixture',
  scopeId: 'caller-projection-fixture',
  status: 'unknown',
  selectedTier: 'injected',
  observedTier: 'injected',
  satisfiesSelectedTier: false,
  trigger: 'normal-leader-exit',
  originalDeadline: { kind: 'unbounded', limitId: 'caller-projection-fixture' },
  firstStopAtMs: 0,
  killAtMs: 0,
  observeUntilMs: 0,
  signals: [],
  finalObservation: {
    sampledAtMs: 0,
    clockDomainId: 'caller-projection-fixture',
    leader: 'unknown',
    scopePresence: 'unknown',
    members: [],
    membershipComplete: false,
    identity: 'unknown',
    streams: { stdin: 'closed', stdout: 'unknown', stderr: 'unknown' },
  },
  output: {
    stdoutSeenBytes: 0,
    stderrSeenBytes: 0,
    retainedBytes: 0,
    droppedBytes: 0,
    complete: false,
  },
  cleanupAuthorityRetained: true,
  selectedLimitSatisfied: null,
  cause: 'Injected caller observation; no physical cleanup failure claimed',
}

type TerminalValue = Awaited<
  ReturnType<typeof sdk.runTerminalCommand>
>[0]['value']

function createFixtureHost(options: sdk.ConfiguredDirectHostExecutionOptions) {
  return createHost({
    ...options,
    hostConfiguration: {
      environment: fixtureEnv,
      platform: process.platform,
      invocationCwd: fixtureRoot,
      projectRoot: fixtureRoot,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
}

describe('user shell execution context', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    spyOn(process, 'cwd').mockReturnValue(fixtureRoot)
    spyOn(projectFiles, 'getProjectRoot').mockReturnValue(fixtureRoot)
    spyOn(cliEnv, 'getSystemProcessEnv').mockReturnValue(fixtureEnv)
    spyOn(turnSnapshots, 'capturePreDispatchSnapshot').mockResolvedValue({
      status: 'skipped',
      reason: 'test',
    })
    spyOn(sdk, 'createConfiguredDirectHostExecution').mockImplementation(
      createFixtureHost,
    )
  })

  afterEach(() => {
    cancelAllBashCommands()
    mock.restore()
  })

  for (const ghost of [false, true]) {
    describe(ghost ? 'ghost' : 'direct', () => {
      beforeEach(() => useChatStore.getState().setIsChainInProgress(ghost))

      test('passes a captured user context and retains actual target output', async () => {
        const terminal = spyOn(sdk, 'runTerminalCommand').mockResolvedValue([
          {
            type: 'json',
            value: {
              command: 'fixture-command',
              stdout: 'out',
              stderr: 'err',
              exitCode: 7,
            },
          },
        ])
        await runBashCommand('fixture-command')
        const options = terminal.mock.calls[0]![0]
        expect(options.executionContext?.mode).toBe('user')
        expect(options.executionContext?.projectRoot).toBe(fixtureRoot)
        expect(sdk.createConfiguredDirectHostExecution).toHaveBeenCalledWith(expect.objectContaining({ limit: { kind: 'unbounded' } }))
        expect(options.env).toEqual(fixtureEnv)
        expect(options.timeout_seconds).toBeUndefined()
        expect(options.executionContext?.signal?.aborted).toBe(true)
        expect(
          useChatStore.getState().pendingBashMessages.at(-1),
        ).toMatchObject({
          stdout: 'out',
          stderr: 'err',
          exitCode: 7,
          isRunning: false,
        })
      })

      test('forwards the captured host timeout policy even for user shell commands', async () => {
        spyOn(sdk, 'createConfiguredDirectHostExecution').mockImplementation(
          async (options) => {
            const host = await createFixtureHost(options)
            if (!host.ok) return host
            return {
              ...host,
              value: {
                ...host.value,
                hostServices: {
                  ...host.value.hostServices,
                  terminalTimeoutPolicy: { maxSeconds: 7 },
                },
              },
            }
          },
        )
        const terminal = spyOn(sdk, 'runTerminalCommand').mockResolvedValue([
          { type: 'json', value: { command: 'fixture-command', exitCode: 0 } },
        ])
        await runBashCommand('fixture-command')
        expect(terminal.mock.calls[0]![0].timeoutPolicy).toEqual({
          maxSeconds: 7,
        })
        expect(terminal.mock.calls[0]![0].timeout_seconds).toBeUndefined()
        expect(terminal.mock.calls[0]![0].executionContext?.mode).toBe('user')
      })

      const failures: Array<{
        name: string
        value: TerminalValue
        message: string
      }> = [
        {
          name: 'unavailable',
          value: {
            command: 'fixture-command',
            errorMessage: 'Backend unavailable',
          },
          message: 'Backend unavailable',
        },
        {
          name: 'refusal without errorMessage',
          value: {
            command: 'fixture-command',
            executionRefusal: {
              ok: false,
              reason: 'denied',
              cause: 'Execution denied',
            },
          },
          message: 'Execution denied',
        },
        {
          name: 'missing target status',
          value: { command: 'fixture-command', stdout: 'partial' },
          message: 'no target exit status',
        },
        {
          name: 'error mislabeled exit zero',
          value: {
            command: 'fixture-command',
            exitCode: 0,
            errorMessage: 'Output incomplete',
          },
          message: 'Output incomplete',
        },
      ]
      test.each(failures)(
        'reports $name as failure',
        async ({ value, message }) => {
          spyOn(sdk, 'runTerminalCommand').mockResolvedValue([
            { type: 'json', value },
          ])
          await runBashCommand('fixture-command')
          const pending = useChatStore.getState().pendingBashMessages.at(-1)!
          expect(pending.exitCode).toBe(1)
          expect(pending.stderr).toContain(message)
          expect(pending.isRunning).toBe(false)
          if ('stdout' in value) expect(pending.stdout).toBe(value.stdout ?? '')
          if (!ghost) {
            const block = useChatStore.getState().messages.at(-1)!.blocks![0]
            expect('output' in block && block.output).toContain(message)
          }
        },
      )

      test.each([
        {
          kind: 'rejection',
          targetExitCode: 0,
          message: 'Cleanup join rejected',
        },
        {
          kind: 'rejection',
          targetExitCode: 7,
          message: 'Cleanup join rejected',
        },
        {
          kind: 'unknown',
          targetExitCode: 0,
          message: 'Shell command process cleanup remains unconfirmed',
        },
        {
          kind: 'unknown',
          targetExitCode: 7,
          message: 'Shell command process cleanup remains unconfirmed',
        },
      ])(
        'returned streams survive $kind cleanup after target exit $targetExitCode',
        async ({ kind, targetExitCode, message }) => {
          spyOn(sdk, 'createConfiguredDirectHostExecution').mockImplementation(
            async (options) => {
              const host = await createFixtureHost(options)
              if (!host.ok) return host
              return {
                ...host,
                value: {
                  ...host.value,
                  close: async () => {
                    await host.value.close()
                    if (kind === 'rejection') throw new Error(message)
                    return [unknownCleanup]
                  },
                },
              }
            },
          )
          spyOn(sdk, 'runTerminalCommand').mockResolvedValue([
            {
              type: 'json',
              value: {
                command: 'fixture-command',
                stdout: 'retained-out',
                stderr: 'retained-err',
                exitCode: targetExitCode,
              },
            },
          ])
          await runBashCommand('fixture-command')
          const pending = useChatStore.getState().pendingBashMessages.at(-1)!
          expect(pending.stdout).toBe('retained-out')
          expect(pending.stderr).toContain('retained-err')
          expect(pending.stderr).toContain(message)
          expect(pending.exitCode).toBe(targetExitCode || 1)
          expect(pending.isRunning).toBe(false)
          expect(cancelAllBashCommands()).toBe(0)
          if (!ghost) {
            const block = useChatStore.getState().messages.at(-1)!.blocks![0]
            const output = 'output' in block ? String(block.output) : ''
            expect(output).toContain('retained-out')
            expect(output).toContain('retained-err')
            expect(output).toContain(message)
          }
        },
      )

      test('retains partial streams when target execution reports an error', async () => {
        spyOn(sdk, 'runTerminalCommand').mockResolvedValue([
          {
            type: 'json',
            value: {
              command: 'fixture-command',
              stdout: 'partial-out',
              stderr: 'partial-err',
              errorMessage: 'Command cancelled',
            },
          },
        ])
        await runBashCommand('fixture-command')
        expect(
          useChatStore.getState().pendingBashMessages.at(-1),
        ).toMatchObject({
          stdout: 'partial-out',
          stderr: 'partial-err\nCommand cancelled',
          exitCode: 1,
        })
      })

      test('reports unavailable project context without dispatching', async () => {
        spyOn(projectFiles, 'getProjectRoot').mockImplementation(() => {
          throw new Error('Project root not set')
        })
        const terminal = spyOn(sdk, 'runTerminalCommand')
        await runBashCommand('fixture-command')
        expect(terminal).not.toHaveBeenCalled()
        expect(
          useChatStore.getState().pendingBashMessages.at(-1),
        ).toMatchObject({
          exitCode: 1,
          stderr: 'Project root not set',
          isRunning: false,
        })
        expect(cancelAllBashCommands()).toBe(0)
      })

      test('does not dispatch after cancellation during the snapshot barrier', async () => {
        let release!: () => void
        const barrier = new Promise<void>((resolve) => {
          release = resolve
        })
        spyOn(turnSnapshots, 'capturePreDispatchSnapshot').mockImplementation(
          async () => {
            await barrier
            return { status: 'skipped', reason: 'test' }
          },
        )
        const terminal = spyOn(sdk, 'runTerminalCommand')
        const command = runBashCommand('fixture-command')
        expect(cancelAllBashCommands()).toBe(1)
        release()
        await command
        expect(terminal).not.toHaveBeenCalled()
        expect(
          useChatStore.getState().pendingBashMessages.at(-1),
        ).toMatchObject({
          exitCode: 1,
          isRunning: false,
        })
      })
    })
  }
})
