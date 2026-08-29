import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { jobRegistry } from '@codebuff/common/util/job-registry'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { OpenbuffClient } from '../client'
import * as databaseModule from '../impl/database'
import { applyListJobsDigestGate } from '../run'
import { __clearJobsForTest } from '../tools/background-jobs'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { ListJobsViewRow } from '@codebuff/common/util/list-jobs-view'

const makeRow = (
  overrides: Partial<ListJobsViewRow> = {},
): ListJobsViewRow => ({
  jobId: 'job-1',
  kind: 'process',
  command: 'bun dev',
  status: 'running',
  startedAt: 1_000,
  pending: 'none',
  gap: false,
  ...overrides,
})

const digestOutput = (
  rows: ListJobsViewRow[],
  truncatedCount?: number,
): ToolResultOutput[] => [
  {
    type: 'json',
    value: {
      jobs: rows,
      ...(truncatedCount !== undefined ? { truncatedCount } : {}),
      note: 'No action required unless you need this output.',
    },
  },
]

describe('applyListJobsDigestGate', () => {
  it('returns the full digest on the first call of a turn (null fingerprint)', () => {
    const output = digestOutput([makeRow()])
    const result = applyListJobsDigestGate(null, output)
    expect(result.output).toBe(output)
    expect(result.nextFingerprint).not.toBeNull()
  })

  it('suppresses an unchanged repeat digest and omits the jobs key', () => {
    const rows = [makeRow()]
    const first = applyListJobsDigestGate(null, digestOutput(rows))
    const second = applyListJobsDigestGate(
      first.nextFingerprint,
      digestOutput(rows),
    )
    expect(second.output).toHaveLength(1)
    const entry = second.output[0]
    expect(entry.type).toBe('json')
    if (entry.type === 'json') {
      const value = entry.value as Record<string, unknown>
      expect(value.unchanged).toBe(true)
      expect(typeof value.note).toBe('string')
      // Never emit `jobs: []` — an empty array would read as "no jobs exist".
      expect('jobs' in value).toBe(false)
    }
    expect(second.nextFingerprint).toBe(first.nextFingerprint)
  })

  it('returns the full digest again when the fingerprint changes', () => {
    const first = applyListJobsDigestGate(null, digestOutput([makeRow()]))
    const changedOutput = digestOutput([makeRow({ status: 'completed' })])
    const second = applyListJobsDigestGate(first.nextFingerprint, changedOutput)
    expect(second.output).toBe(changedOutput)
    expect(second.nextFingerprint).not.toBe(first.nextFingerprint)
  })

  it('treats tail/startedAt churn as unchanged (fingerprint ignores them)', () => {
    const first = applyListJobsDigestGate(null, digestOutput([makeRow()]))
    // Same jobId/status/pending/gap/completedAt, but a fresh tail + startedAt.
    const chattier = digestOutput([
      makeRow({ startedAt: 9_999, tail: ['a', 'b'] }),
    ])
    const second = applyListJobsDigestGate(first.nextFingerprint, chattier)
    const value = second.output[0]
    expect(value.type === 'json' && (value.value as any).unchanged).toBe(true)
  })

  it('busts the gate when only truncatedCount changes (identical rows)', () => {
    const rows = [makeRow()]
    const first = applyListJobsDigestGate(null, digestOutput(rows, 3))
    // Same selected rows, different truncatedCount: must re-emit in full so
    // the new truncation count reaches the model.
    const changedTruncation = digestOutput(rows, 5)
    const second = applyListJobsDigestGate(
      first.nextFingerprint,
      changedTruncation,
    )
    expect(second.output).toBe(changedTruncation)
    expect(second.nextFingerprint).not.toBe(first.nextFingerprint)
  })

  it('treats an omitted truncatedCount as 0', () => {
    const rows = [makeRow()]
    const first = applyListJobsDigestGate(null, digestOutput(rows, 0))
    const second = applyListJobsDigestGate(
      first.nextFingerprint,
      digestOutput(rows),
    )
    const value = second.output[0]
    expect(value.type === 'json' && (value.value as any).unchanged).toBe(true)
  })

  it('passes through non-digest output without updating the gate', () => {
    const errorOutput: ToolResultOutput[] = [
      { type: 'json', value: { errorMessage: 'boom' } },
    ]
    const result = applyListJobsDigestGate('some-fingerprint', errorOutput)
    expect(result.output).toBe(errorOutput)
    expect(result.nextFingerprint).toBe('some-fingerprint')
  })
})

// These integration tests stub `callMainPrompt` wholesale on purpose: the
// model-visible suppression payload is asserted at the `requestToolCall`
// seam — the actual injection point where tool results reach the model — so
// the mock is the right assertion surface, not missing end-to-end coverage.
describe('list_jobs per-turn change-gating (run integration)', () => {
  afterEach(() => {
    mock.restore()
    __clearJobsForTest()
  })

  const mockDatabase = () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
  }

  type CallMainPromptParams = Parameters<
    typeof mainPromptModule.callMainPrompt
  >[0]

  const seedRunningJob = (
    clientSessionId: string,
    command = 'bun dev',
  ): string => {
    const job = jobRegistry.create({
      kind: 'process',
      label: command,
      owner: {
        clientSessionId,
        rootRunId: 'main-agent',
        parentRunId: 'main-agent',
        parentAgentId: 'main-agent',
      },
    })
    jobRegistry.start(job.jobId)
    return job.jobId
  }

  const makeClient = () =>
    new OpenbuffClient({
      apiKey: 'test-key',
      cwd: '/repo',
      handleEvent: () => {},
    })

  it('suppresses the second unchanged list_jobs call within one run', async () => {
    mockDatabase()

    const results: ToolResultOutput[][] = []
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: CallMainPromptParams) => {
        const { requestToolCall, sendAction, promptId } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        seedRunningJob(promptId)

        results.push(
          (
            await requestToolCall({
              userInputId: promptId,
              toolName: 'list_jobs',
              input: {},
            })
          ).output,
        )
        results.push(
          (
            await requestToolCall({
              userInputId: promptId,
              toolName: 'list_jobs',
              input: {},
            })
          ).output,
        )

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })
        return {
          sessionState,
          output: { type: 'lastMessage' as const, value: [] },
        }
      },
    )

    await makeClient().run({ agent: 'base2', prompt: 'hi' })

    const first = results[0]?.[0]
    const second = results[1]?.[0]
    expect(first?.type).toBe('json')
    if (first?.type === 'json') {
      expect(Array.isArray((first.value as any).jobs)).toBe(true)
    }
    expect(second?.type).toBe('json')
    if (second?.type === 'json') {
      const value = second.value as Record<string, unknown>
      expect(value.unchanged).toBe(true)
      expect('jobs' in value).toBe(false)
    }
  })

  it('re-returns the full digest when a row changes between calls', async () => {
    mockDatabase()

    const results: ToolResultOutput[][] = []
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: CallMainPromptParams) => {
        const { requestToolCall, sendAction, promptId } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        const jobId = seedRunningJob(promptId)

        results.push(
          (
            await requestToolCall({
              userInputId: promptId,
              toolName: 'list_jobs',
              input: {},
            })
          ).output,
        )

        // Change the fingerprint: complete the job (status + completedAt change).
        jobRegistry.emit(jobId, {
          type: 'lifecycle',
          state: 'completed',
          exitCode: 0,
        })

        results.push(
          (
            await requestToolCall({
              userInputId: promptId,
              toolName: 'list_jobs',
              input: {},
            })
          ).output,
        )

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })
        return {
          sessionState,
          output: { type: 'lastMessage' as const, value: [] },
        }
      },
    )

    await makeClient().run({ agent: 'base2', prompt: 'hi' })

    const second = results[1]?.[0]
    expect(second?.type).toBe('json')
    if (second?.type === 'json') {
      const value = second.value as Record<string, unknown>
      expect(Array.isArray(value.jobs)).toBe(true)
      expect(value.unchanged).toBeUndefined()
    }
  })

  it('resets the gate per run: first call of a new run is full even after an identical prior run', async () => {
    mockDatabase()

    const runResults: ToolResultOutput[][][] = []
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: CallMainPromptParams) => {
        const { requestToolCall, sendAction, promptId } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        seedRunningJob(promptId)

        const outputs: ToolResultOutput[][] = []
        outputs.push(
          (
            await requestToolCall({
              userInputId: promptId,
              toolName: 'list_jobs',
              input: {},
            })
          ).output,
        )
        outputs.push(
          (
            await requestToolCall({
              userInputId: promptId,
              toolName: 'list_jobs',
              input: {},
            })
          ).output,
        )
        runResults.push(outputs)

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })
        return {
          sessionState,
          output: { type: 'lastMessage' as const, value: [] },
        }
      },
    )

    // Two independent runs; each gets its own promptId/clientSessionId, but
    // the key point is the per-turn closure state resets between run() calls.
    await makeClient().run({ agent: 'base2', prompt: 'first' })
    await makeClient().run({ agent: 'base2', prompt: 'second' })

    // First call of the second run must be a full digest (gate was reset),
    // even though the previous run also produced a digest.
    const secondRunFirst = runResults[1]?.[0]?.[0]
    expect(secondRunFirst?.type).toBe('json')
    if (secondRunFirst?.type === 'json') {
      const value = secondRunFirst.value as Record<string, unknown>
      expect(Array.isArray(value.jobs)).toBe(true)
      expect(value.unchanged).toBeUndefined()
    }
  })
})
