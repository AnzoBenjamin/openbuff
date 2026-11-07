/**
 * cancel-softlock fix: parent-abort coverage for the supervised spawn path.
 *
 * Imitates the executeSubagent + injected-spawnSupervised fake-seam pattern
 * (spawn-agent-utils-output.test.ts's executeSubagent param bag and
 * spawn-process-supervision.test.ts's settled fixtures + loopAgentSteps
 * spy). Before the fix, aborting the parent signal while a supervised child
 * ran left `await spawnSupervised(request)` pending forever — nothing
 * killed the child process, so the CLI showed 'Cancelling…' indefinitely.
 * Now the parent signal is threaded into the seam (the supervisor group-
 * kills the child on abort) and the await settles as CANCELLATION — never
 * as a crash outcome.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'

import * as runAgentStep from '../../../../run-agent-step'
import { executeSubagent } from '../spawn-agent-utils'

import type { SettledSubagentResult } from '@codebuff/common/types/contracts/agent-runtime'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

const OK_RECEIPT: AgentReceipt = {
  schemaVersion: 1,
  receiptId: 'cancel-fixture-receipt',
  taskId: 'cancel-fixture-task',
  role: 'specialist',
  agentId: 'cancel-fixture-agent',
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
 * The settle a REAL supervisor produces when the parent's abort listener
 * group-killed the child: a signal death is an exit-code error, NOT a clean
 * abort — exactly the shape the cancellation classification must absorb.
 */
const KILLED_CHILD_CRASH: SettledSubagentResult = {
  outcome: 'crashed',
  crashReason: 'nonzero_exit',
  exitCode: null,
  durationMs: 5,
  stdoutBytes: 0,
  killed: true,
  stderrTail: '',
}

const settledOk = (receipt: AgentReceipt): SettledSubagentResult => ({
  outcome: 'ok',
  receipt,
  exitCode: 0,
  durationMs: 5,
  stdoutBytes: 256,
  killed: false,
  stderrTail: '',
})

const makeTemplate = (id: string): AgentTemplate => {
  return {
    id,
    displayName: `Mock ${id}`,
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as unknown as AgentTemplate['inputSchema']['prompt'],
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: [],
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  }
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as any

const makeParentState = () =>
  ({
    ...getInitialAgentState(),
    agentId: 'cancel-parent-1',
    runId: 'cancel-parent-run-1',
  }) as AgentState

const makeChildState = () =>
  ({
    ...getInitialAgentState(),
    agentId: 'cancel-child-1',
    agentType: 'thinker',
    runId: 'cancel-child-run-1',
    messageHistory: [],
  }) as AgentState

function buildExecuteParams(overrides: Record<string, unknown> = {}) {
  return {
    ...createTestAgentRuntimeParams(),
    agentState: makeChildState(),
    agentTemplate: makeTemplate('thinker'),
    parentAgentState: makeParentState(),
    ancestorRunIds: [],
    prompt: 'long supervised work',
    spawnParams: undefined,
    spawnToolCallId: 'cancel-call-1',
    spawnIndex: 0,
    processSupervision: true,
    userInputId: 'test-input',
    fingerprintId: 'test-fingerprint',
    clientSessionId: 'test-session',
    userId: undefined,
    parentSystemPrompt: '',
    onResponseChunk: () => {},
    localAgentTemplates: {},
    logger: noopLogger,
    fileContext: { files: {}, systemPromptAdditionalInfo: undefined },
    system: '',
    tools: {},
    ...overrides,
  } as any
}

describe('supervised spawn parent-abort cancellation (cancel-softlock fix)', () => {
  let loopSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    loopSpy.mockRestore()
  })

  const expectLoopUntouched = () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      },
    )
  }

  test(
    'parent abort during a supervised child kills the child group and the await settles as cancelled',
    async () => {
      expectLoopUntouched()
      const controller = new AbortController()
      const finishEvents: Array<Record<string, unknown>> = []
      const parentAgentState = makeParentState()
      let seamOptionsSignal: AbortSignal | undefined
      let killObserved = false

      // Fake seam mimicking the real supervisor: it receives the threaded
      // parent signal as its SECOND argument and — like the supervisor's
      // abort listener — group-kills the child on abort, settling the killed
      // child as an exit-code crash (never a clean abort). Without a parent
      // abort it NEVER settles: only the abort can end this await, which is
      // exactly the softlock this fix removes.
      const fakeSeam = (
        _request: SupervisedSpawnRequest,
        options?: { signal?: AbortSignal },
      ): Promise<SettledSubagentResult> => {
        seamOptionsSignal = options?.signal
        return new Promise<SettledSubagentResult>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              killObserved = true
              resolve(KILLED_CHILD_CRASH)
            },
            { once: true },
          )
        })
      }

      const execution = executeSubagent(
        buildExecuteParams({
          parentAgentState,
          spawnSupervised: fakeSeam,
          signal: controller.signal,
          onResponseChunk: (chunk: unknown) => {
            if (typeof chunk === 'object' && chunk !== null) {
              finishEvents.push(chunk as Record<string, unknown>)
            }
          },
        }),
      )

      // The child is running (the await is pending) when the user terminates
      // the run.
      await Bun.sleep(10)
      // The parent signal was threaded into the seam (the supervisor's kill
      // channel).
      expect(seamOptionsSignal).toBe(controller.signal)
      controller.abort()

      // The await settles as CANCELLED — executeSubagent rethrows the
      // cancellation error exactly like the in-process abort path; it must
      // NOT resolve with a crash envelope (the settle chain would otherwise
      // record outcome 'crashed' for a cancelled run).
      await expect(execution).rejects.toThrow('Subagent thinker was cancelled')
      // The (fake) supervisor kill actually fired.
      expect(killObserved).toBe(true)
      expect(loopSpy).not.toHaveBeenCalled()

      // The finish event fired before the rethrow (no started-but-never-
      // finished subagent) and the abandoned child runId was registered for
      // the journal/step-boundary machinery.
      const finish = finishEvents.find(
        (event) => event.type === 'subagent_finish',
      )
      expect(finish).toBeDefined()
      expect(String(finish?.error)).toContain('was cancelled')
      expect(parentAgentState.childRunIds).toContain('cancel-child-run-1')
    },
  )

  test(
    'an already-aborted parent signal throws cancellation before any child is spawned',
    async () => {
      expectLoopUntouched()
      const controller = new AbortController()
      controller.abort()
      const finishEvents: Array<Record<string, unknown>> = []
      const parentAgentState = makeParentState()
      let seamCalled = false
      await expect(
        executeSubagent(
          buildExecuteParams({
            parentAgentState,
            signal: controller.signal,
            spawnSupervised: async () => {
              seamCalled = true
              return settledOk(OK_RECEIPT)
            },
            onResponseChunk: (chunk: unknown) => {
              if (typeof chunk === 'object' && chunk !== null) {
                finishEvents.push(chunk as Record<string, unknown>)
              }
            },
          }),
        ),
      ).rejects.toThrow('Subagent thinker was cancelled')
      // No child was ever spawned for the already-cancelled run.
      expect(seamCalled).toBe(false)
      // The prologue guard's contract holds: the finish event fires BEFORE
      // the rethrow, and the (never-started) child runId is registered
      // defensively — parity with the in-process abort path.
      expect(
        finishEvents.some((event) => event.type === 'subagent_finish'),
      ).toBe(true)
      expect(parentAgentState.childRunIds).toContain('cancel-child-run-1')
    },
  )

  test(
    'a signal that never aborts keeps the byte-identical ok settle (no false cancellation)',
    async () => {
      expectLoopUntouched()
      const controller = new AbortController()
      let seenSignal: AbortSignal | undefined
      const result = await executeSubagent(
        buildExecuteParams({
          signal: controller.signal,
          spawnSupervised: async (
            _request: SupervisedSpawnRequest,
            options?: { signal?: AbortSignal },
          ) => {
            seenSignal = options?.signal
            return settledOk(OK_RECEIPT)
          },
        }),
      )
      // The signal rides the seam's second argument even on the happy path.
      expect(seenSignal).toBe(controller.signal)
      // The happy path is unchanged: the receipt rides supervisedReceipt and
      // the parent-visible output is the structured completion.
      expect(result.supervisedReceipt).toEqual(OK_RECEIPT)
      expect(result.output).toEqual({
        type: 'structuredOutput',
        value: { message: 'Supervised subagent thinker completed.' },
      })
      // A late abort after a normal settle must not retroactively cancel.
      controller.abort()
    },
  )

  test(
    'a signal-absent caller keeps the legacy crash-envelope settle (byte-identical older callers)',
    async () => {
      expectLoopUntouched()
      const result = await executeSubagent(
        buildExecuteParams({
          signal: undefined,
          spawnSupervised: async () => ({
            outcome: 'crashed' as const,
            crashReason: 'nonzero_exit' as const,
            exitCode: 1,
            durationMs: 5,
            stdoutBytes: 0,
            killed: false,
            stderrTail: 'child died on its own',
          }),
        }),
      )
      // Byte-identical legacy behavior: a crash settle maps to the crash
      // envelope the settle chain classifies as outcome 'crashed' — no
      // cancellation classification without a parent signal.
      const output = result.output as { type: string; message: string }
      expect(output.type).toBe('error')
      expect(output.message).toContain('Subagent thinker crashed:')
      expect(output.message).toContain('child died on its own')
      expect('supervisedReceipt' in result).toBe(false)
    },
  )

  test(
    'a killed-child crash settle racing the parent abort classifies as cancellation, never outcome crashed',
    async () => {
      expectLoopUntouched()
      const controller = new AbortController()
      // The seam settles the killed-child crash WHILE aborting the parent
      // signal in the same synchronous turn: the settle lands after the
      // abort, so the cancellation classification (not the transport
      // outcome) must decide — the settle chain must never see this as
      // outcome 'crashed'.
      await expect(
        executeSubagent(
          buildExecuteParams({
            signal: controller.signal,
            spawnSupervised: () => {
              const settled = Promise.resolve(KILLED_CHILD_CRASH)
              controller.abort()
              return settled
            },
          }),
        ),
      ).rejects.toThrow('Subagent thinker was cancelled')
    },
  )
})
