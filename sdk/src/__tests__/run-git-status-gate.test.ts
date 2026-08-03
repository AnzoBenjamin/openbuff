import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { OpenbuffClient } from '../client'
import * as databaseModule from '../impl/database'
import { applyGitStatusGate } from '../run'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

// Built-in git_status tool result shape (sdk/src/tools/git-status.ts):
// { branch?, status, diff?, truncated? }. `status` is always present on a real
// observation; diff/branch/truncated are optional.
type GitStatusValue = {
  branch?: string
  status: string
  diff?: string
  truncated?: true
}

const makeValue = (overrides: Partial<GitStatusValue> = {}): GitStatusValue => ({
  branch: 'main',
  status: ' M src/a.ts',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+line\n',
  ...overrides,
})

const gitStatusOutput = (
  overrides: Partial<GitStatusValue> = {},
): ToolResultOutput[] => [
  {
    type: 'json',
    value: makeValue(overrides),
  },
]

describe('applyGitStatusGate', () => {
  it('returns the full observation on the first call of a turn (null fingerprint)', () => {
    const output = gitStatusOutput()
    const result = applyGitStatusGate(null, output)
    expect(result.output).toBe(output)
    expect(result.nextFingerprint).not.toBeNull()
  })

  it('suppresses an unchanged repeat observation and omits the git fields', () => {
    const first = applyGitStatusGate(null, gitStatusOutput())
    const second = applyGitStatusGate(first.nextFingerprint, gitStatusOutput())
    expect(second.output).toHaveLength(1)
    const entry = second.output[0]
    expect(entry.type).toBe('json')
    if (entry.type === 'json') {
      const value = entry.value as Record<string, unknown>
      expect(value.unchanged).toBe(true)
      expect(typeof value.note).toBe('string')
      // Never emit `status: ''` etc. — an empty status would read as a clean
      // tree, which is false. The git fields are omitted entirely.
      expect('status' in value).toBe(false)
      expect('diff' in value).toBe(false)
      expect('branch' in value).toBe(false)
      expect('truncated' in value).toBe(false)
    }
    expect(second.nextFingerprint).toBe(first.nextFingerprint)
  })

  it('busts the gate when only status changes', () => {
    const first = applyGitStatusGate(null, gitStatusOutput())
    const changedOutput = gitStatusOutput({ status: ' M src/b.ts\n' })
    const second = applyGitStatusGate(first.nextFingerprint, changedOutput)
    expect(second.output).toBe(changedOutput)
    expect(second.nextFingerprint).not.toBe(first.nextFingerprint)
  })

  it('busts the gate when only diff changes', () => {
    const first = applyGitStatusGate(null, gitStatusOutput())
    const changedOutput = gitStatusOutput({ diff: 'diff --git c\n+other\n' })
    const second = applyGitStatusGate(first.nextFingerprint, changedOutput)
    expect(second.output).toBe(changedOutput)
    expect(second.nextFingerprint).not.toBe(first.nextFingerprint)
  })

  it('busts the gate when only the branch changes (a commit lands)', () => {
    const first = applyGitStatusGate(null, gitStatusOutput())
    // Dirty status/diff stay fixed, but a commit moved the branch head. This
    // MUST bust the gate or the model would keep acting on a stale branch.
    const changedOutput = gitStatusOutput({ branch: 'main...origin/main [ahead 1]' })
    const second = applyGitStatusGate(first.nextFingerprint, changedOutput)
    expect(second.output).toBe(changedOutput)
    expect(second.nextFingerprint).not.toBe(first.nextFingerprint)
  })

  it('gates a diff-less observation (include_diff not set) and suppresses an identical repeat', () => {
    const noDiff = gitStatusOutput({ diff: undefined })
    const first = applyGitStatusGate(null, noDiff)
    expect(first.output).toBe(noDiff)
    expect(first.nextFingerprint).not.toBeNull()
    const second = applyGitStatusGate(first.nextFingerprint, gitStatusOutput({ diff: undefined }))
    const entry = second.output[0]
    expect(entry.type === 'json' && (entry.value as any).unchanged).toBe(true)
  })

  it('passes through a malformed/non-git-shaped output without updating the gate', () => {
    const errorOutput: ToolResultOutput[] = [
      { type: 'json', value: { errorMessage: 'boom' } },
    ]
    const result = applyGitStatusGate('some-fingerprint', errorOutput)
    expect(result.output).toBe(errorOutput)
    expect(result.nextFingerprint).toBe('some-fingerprint')
  })

  it('passes through multi-part output without updating the gate', () => {
    const multiOutput: ToolResultOutput[] = [
      { type: 'json', value: makeValue() },
      { type: 'json', value: makeValue() },
    ]
    const result = applyGitStatusGate('fp', multiOutput)
    expect(result.output).toBe(multiOutput)
    expect(result.nextFingerprint).toBe('fp')
  })

  it('hashes equal field VALUES equally regardless of object-literal identity/key order', () => {
    // Guards the no-JSON.stringify requirement: the fingerprint must depend
    // only on the four field values, not object identity or key order.
    const a = applyGitStatusGate(null, gitStatusOutput())
    const reordered: ToolResultOutput[] = [
      {
        type: 'json',
        value: {
          diff: 'diff --git a/src/a.ts b/src/a.ts\n+line\n',
          status: ' M src/a.ts',
          branch: 'main',
        },
      },
    ]
    const b = applyGitStatusGate(null, reordered)
    expect(a.nextFingerprint).toBe(b.nextFingerprint)
    // And an identical-value second observation suppresses.
    const suppressed = applyGitStatusGate(a.nextFingerprint, reordered)
    const entry = suppressed.output[0]
    expect(entry.type === 'json' && (entry.value as any).unchanged).toBe(true)
  })
})

// These integration tests stub `callMainPrompt` wholesale on purpose: the
// model-visible suppression payload is asserted at the `requestToolCall`
// seam — the actual injection point where tool results reach the model — so
// the mock is the right assertion surface, not missing end-to-end coverage.
// A git_status override produces the built-in observation shape
// ({branch?, status, diff?, truncated?}) that the gate recognizes.
describe('git_status per-turn change-gating (run integration)', () => {
  afterEach(() => {
    mock.restore()
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

  const makeClient = (gitStatusImpl: () => ToolResultOutput[]) =>
    new OpenbuffClient({
      apiKey: 'test-key',
      cwd: '/repo',
      handleEvent: () => {},
      overrideTools: {
        git_status: async () => gitStatusImpl(),
      },
    })

  it('suppresses the second unchanged git_status call within one run', async () => {
    mockDatabase()

    const results: ToolResultOutput[][] = []
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: CallMainPromptParams) => {
        const { requestToolCall, sendAction, promptId } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        results.push(
          (await requestToolCall({
            userInputId: promptId,
            toolName: 'git_status',
            input: {},
          })).output,
        )
        results.push(
          (await requestToolCall({
            userInputId: promptId,
            toolName: 'git_status',
            input: {},
          })).output,
        )

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })
        return { sessionState, output: { type: 'lastMessage' as const, value: [] } }
      },
    )

    await makeClient(() => gitStatusOutput()).run({ agent: 'base2', prompt: 'hi' })

    const first = results[0]?.[0]
    const second = results[1]?.[0]
    expect(first?.type).toBe('json')
    if (first?.type === 'json') {
      expect(typeof (first.value as any).status).toBe('string')
      expect((first.value as any).unchanged).toBeUndefined()
    }
    expect(second?.type).toBe('json')
    if (second?.type === 'json') {
      const value = second.value as Record<string, unknown>
      expect(value.unchanged).toBe(true)
      expect('status' in value).toBe(false)
      expect('diff' in value).toBe(false)
      expect('branch' in value).toBe(false)
      expect('truncated' in value).toBe(false)
    }
  })

  it('re-returns the full observation when the worktree changes between calls', async () => {
    mockDatabase()

    let observation = gitStatusOutput()
    const results: ToolResultOutput[][] = []
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: CallMainPromptParams) => {
        const { requestToolCall, sendAction, promptId } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        results.push(
          (await requestToolCall({
            userInputId: promptId,
            toolName: 'git_status',
            input: {},
          })).output,
        )

        // Change the worktree between observations.
        observation = gitStatusOutput({ status: ' M src/b.ts\n' })

        results.push(
          (await requestToolCall({
            userInputId: promptId,
            toolName: 'git_status',
            input: {},
          })).output,
        )

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })
        return { sessionState, output: { type: 'lastMessage' as const, value: [] } }
      },
    )

    await makeClient(() => observation).run({ agent: 'base2', prompt: 'hi' })

    const second = results[1]?.[0]
    expect(second?.type).toBe('json')
    if (second?.type === 'json') {
      const value = second.value as Record<string, unknown>
      expect(typeof value.status).toBe('string')
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

        const outputs: ToolResultOutput[][] = []
        outputs.push(
          (await requestToolCall({
            userInputId: promptId,
            toolName: 'git_status',
            input: {},
          })).output,
        )
        outputs.push(
          (await requestToolCall({
            userInputId: promptId,
            toolName: 'git_status',
            input: {},
          })).output,
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
        return { sessionState, output: { type: 'lastMessage' as const, value: [] } }
      },
    )

    // Two independent runs; the per-turn closure state must reset between
    // run() calls so the first observation of a new run is always full.
    await makeClient(() => gitStatusOutput()).run({ agent: 'base2', prompt: 'first' })
    await makeClient(() => gitStatusOutput()).run({ agent: 'base2', prompt: 'second' })

    const secondRunFirst = runResults[1]?.[0]?.[0]
    expect(secondRunFirst?.type).toBe('json')
    if (secondRunFirst?.type === 'json') {
      const value = secondRunFirst.value as Record<string, unknown>
      expect(typeof value.status).toBe('string')
      expect(value.unchanged).toBeUndefined()
    }
  })
})
