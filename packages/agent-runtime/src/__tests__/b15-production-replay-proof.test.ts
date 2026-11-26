import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestAgentRuntimeDeps } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { beforeAll, expect, spyOn, test } from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { runProgrammaticStep } from '../run-programmatic-step'
import { captureValueSha256 } from '../util/recorded-replay-prefix'
import { createRunJournal } from '../util/run-journal'

import type {
  AgentTemplate,
  HandleStepsYieldValue,
} from '@codebuff/common/types/agent-template'
import type { JournalEventRow } from '@codebuff/common/types/contracts/agent-runtime'
import type { AssistantMessage } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

type ExplicitInput = {
  toolResult: ToolResultOutput[]
  stepsComplete: boolean
  hitStepCap: boolean
  nResponses?: string[]
}
type IteratorInput = ExplicitInput & {
  agentState: { messageHistory: AssistantMessage[] }
}

const input = Object.freeze({
  prompt: 'B15: sample the owned clock and random source',
  params: Object.freeze({ channel: 'proof' }),
})
const config = Object.freeze({ candidateCount: 2 })
const runId = 'b15-production-replay-proof-run'
const agentId = 'b15-proof-actor'
const templateId = 'b15-production-replay-proof'
const stepText = 'Sample two distinct candidates.\n'
const allThinking = '<think>Collect one more observation.</think>'
const allText = 'The full model group has finished.\n'
const candidates = Object.freeze(['candidate β', 'candidate A\r\n'])

// This statically known recipe is the only code the witness executes. The
// runtime materializes these same serialized bytes. No imports, host I/O,
// mutable module variables, or other live agent state are used by the recipe.
function* recipe({
  prompt,
  params,
  config,
}: typeof input & { config: { candidateCount: number } }): Generator<
  HandleStepsYieldValue,
  unknown,
  IteratorInput
> {
  const sample = {
    toolName: 'b15_fixture_sample',
    input: { prompt, channel: params.channel },
    includeToolCall: false,
  }
  const first = (yield sample).toolResult
  const second = (yield sample).toolResult
  const step = yield 'STEP'
  const modelText = step.agentState.messageHistory
    .findLast((message) => message.role === 'assistant')
    ?.content.find((part) => part.type === 'text')?.text
  const all = yield 'STEP_ALL'
  const groupText = all.agentState.messageHistory
    .findLast((message) => message.role === 'assistant')
    ?.content.find((part) => part.type === 'text')?.text
  const { nResponses } = yield {
    type: 'GENERATE_N',
    n:
      modelText === 'Sample two distinct candidates.\n' &&
      groupText === 'The full model group has finished.\n'
        ? config.candidateCount
        : 1,
  }
  return { first, second, modelText, groupText, nResponses }
}

const source = recipe.toString()
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// Version 1 of programmatic-replay-observation.ts's explicit-input contract.
const contractSha256 =
  '66e40ad60d42ed1d88ceb24494b87d94b114c4a5de8f62bcad5d875b6dafa7b5'

async function record(root: string) {
  const deps = createTestAgentRuntimeDeps()
  const hostReplies: ToolResultOutput[][] = []
  const calls = { tool: 0, step: 0, generateN: 0, start: 0, network: 0 }
  const template: AgentTemplate = {
    id: templateId,
    displayName: 'B15 production replay proof',
    executionSource: 'bundled',
    model: 'claude-3-5-sonnet-20241022',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    programmaticToolNames: ['b15_fixture_sample'],
    spawnableAgents: [],
    systemPrompt: 'B15 local proof',
    instructionsPrompt: '',
    stepPrompt: '',
    programmaticConfig: config,
    handleSteps: source,
  }
  const fileContext = {
    ...deps.fileContext,
    projectRoot: root,
    cwd: root,
    customToolDefinitions: {
      b15_fixture_sample: {
        description: 'Return an owned clock and random sample',
        endsAgentStep: false,
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            channel: { type: 'string' },
          },
          required: ['prompt', 'channel'],
          additionalProperties: false,
        },
      },
    },
  }
  const forbidden = () => {
    calls.network++
    throw new Error('Network is forbidden in the B15 proof')
  }
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbidden(), { preconnect: forbidden }),
  )
  const path = join(root, 'run.sqlite')
  try {
    const journal = createRunJournal({ path, captureProgrammaticReplay: true })
    try {
      const params: Parameters<typeof loopAgentSteps>[0] = {
        ...deps,
        ...input,
        spawnParams: input.params,
        ancestorRunIds: [],
        clientSessionId: 'b15-proof-session',
        fingerprintId: 'b15-proof-fingerprint',
        userId: undefined,
        userInputId: 'b15-proof-input',
        repoUrl: undefined,
        repoId: undefined,
        agentType: templateId,
        agentTemplate: template,
        localAgentTemplates: { [templateId]: template },
        agentState: {
          ...getInitialSessionState(fileContext).mainAgentState,
          agentId,
        },
        fileContext,
        signal: AbortSignal.timeout(5_000),
        journalReader: journal,
        journalWriter: journal,
        fetch: Object.assign(async () => forbidden(), {
          preconnect: forbidden,
        }),
        startAgentRun: async () => {
          assert.equal(++calls.start, 1)
          return runId
        },
        requestToolCall: async ({ toolName, input: args }) => {
          assert.equal(toolName, 'b15_fixture_sample')
          assert.deepEqual(args, { prompt: input.prompt, ...input.params })
          assert(++calls.tool <= 2, 'Unexpected repeat host request')
          const output: ToolResultOutput[] = [
            {
              type: 'json',
              value: {
                sample: calls.tool,
                epochMs: Date.now(),
                randomU32: crypto.getRandomValues(new Uint32Array(1))[0]!,
              },
            },
          ]
          hostReplies.push(output)
          return { output }
        },
        promptAiSdkStream: async function* () {
          const text = [stepText, allThinking, allText][calls.step++]
          assert(text !== undefined, 'Unexpected repeated model request')
          yield { type: 'text', text }
          return promptSuccess(`b15-proof-step-${calls.step}`)
        },
        promptAiSdk: async ({ n }) => {
          assert.equal(++calls.generateN, 1)
          assert.equal(n, config.candidateCount)
          return promptSuccess(JSON.stringify(candidates))
        },
        promptAiSdkStructured: async () => {
          throw new Error('Unexpected structured model request')
        },
      }
      const result = await loopAgentSteps(params)
      assert.equal(result.agentState.runId, runId)
      assert.deepEqual(result.agentState.runOutcome, {
        termination: 'completed',
      })
      await journal.forceFlush()
      const recorded = journal.events(runId)
      // Even with this complete observed tape, product re-entry has no permission.
      await expect(
        loopAgentSteps({ ...params, resumeInterruptedTurn: true }),
      ).rejects.toMatchObject({
        code: 'replay_unavailable',
        reason: 'prefix_unverified',
        runId,
      })
      assert.deepEqual(journal.events(runId), recorded)
    } finally {
      await journal.close()
    }
    const reopened = createRunJournal({ path })
    try {
      return { rows: reopened.events(runId), calls, hostReplies }
    } finally {
      await reopened.close()
    }
  } finally {
    fetchSpy.mockRestore()
  }
}

type Identity = { ordinal: number; occurrence: number; requestSha256: string }
type Observation = {
  basis: Record<string, unknown>
  yield: Identity & { value: HandleStepsYieldValue }
  next_input: Identity & {
    value: ExplicitInput & { undefinedKeys: string[] }
    valueSha256: string
  }
  generator_return: {
    observedYields: number
    value: unknown
    valueSha256: string
  }
}

// Offline witness only. It does not accept a caller-supplied recipe, pass an
// open journal to the iterator, or call a runtime, provider, or host callback.
function reconstruct(rows: JournalEventRow[]) {
  assert.deepEqual(
    rows.map((row) => row.seq),
    rows.map((_row, index) => index),
    'SQLite sequence gap',
  )
  const trace = rows.filter(({ eventType }) => eventType !== 'step_boundary')
  let cursor = 0
  const take = <T>(eventType: JournalEventRow['eventType']) => {
    const row = trace[cursor++]
    assert.equal(row?.eventType, eventType, `Trace gap: expected ${eventType}`)
    return { ...row!, payload: row!.payload as T }
  }
  const observation = <K extends keyof Observation>(kind: K) => {
    const row = take<Observation[K] & { kind: K; replayPermitted: false }>(
      'programmatic_observation',
    )
    assert.equal(row.payload.kind, kind, `Observation gap: expected ${kind}`)
    assert.equal(row.payload.replayPermitted, false)
    return row
  }
  const {
    artifact,
    runtime,
    version,
    templateId: recordedTemplate,
    agentId: recordedAgent,
    configurationSha256,
    inputSha256,
    contractSha256: recordedContract,
  } = observation('basis').payload
  assert.deepEqual(
    artifact,
    {
      kind: 'serialized_handle_steps',
      sourceSha256: sha256(source),
      byteLength: Buffer.byteLength(source),
    },
    'Recipe basis changed',
  )
  assert.deepEqual(runtime, {
    componentSha256: sha256(runProgrammaticStep.toString()),
    engine: `bun/${Bun.version}`,
    platform: process.platform,
    arch: process.arch,
  })
  assert.equal(version, 1)
  assert.equal(recordedContract, contractSha256)
  assert.equal(recordedAgent, agentId)
  assert.equal(recordedTemplate, templateId)
  assert.equal(configurationSha256, captureValueSha256(config))
  assert.equal(inputSha256, captureValueSha256(input))

  const iterator = recipe({ ...input, config })
  const occurrences = new Map<string, number>()
  const witnessed: Array<
    Identity & { yield: HandleStepsYieldValue; reply: ExplicitInput }
  > = []
  let next = iterator.next()
  const messageHistory: AssistantMessage[] = []
  while (!next.done) {
    const ordinal = witnessed.length
    const request = next.value
    const yielded = observation('yield')
    const requestSha256 = captureValueSha256(request)
    const occurrence = occurrences.get(requestSha256) ?? 0
    const identity = { ordinal, occurrence, requestSha256 }
    const { value, kind, replayPermitted, ...recordedIdentity } =
      yielded.payload
    assert.deepEqual(value, request, `Yield divergence at ordinal ${ordinal}`)
    assert.deepEqual(recordedIdentity, identity)
    occurrences.set(requestSha256, occurrence + 1)

    let toolResult: ToolResultOutput[] = []
    let candidateReply: string[] | undefined
    if (request === 'STEP' || request === 'STEP_ALL') {
      const count = request === 'STEP_ALL' ? 2 : 1
      for (let index = 0; index < count; index++) {
        const call = take<{ n: null }>('llm_request')
        const reply = take<{ fullResponse: string }>('llm_response')
        assert.equal(call.payload.n, null)
        assert(call.correlation)
        assert.equal(reply.correlation, call.correlation)
        assert.equal(call.stepNumber, yielded.stepNumber + index)
        assert.equal(reply.stepNumber, call.stepNumber)
        // The tape deliberately excludes agentState. Rebuild only the
        // model-text projection used by this closed fixture.
        messageHistory.push({
          role: 'assistant',
          content: [{ type: 'text', text: reply.payload.fullResponse }],
        })
      }
    } else if (typeof request === 'object' && 'toolName' in request) {
      const call = take<{
        attemptId: string
        toolName: string
        basis: unknown
        input: unknown
      }>('tool_call')
      const reply = take<{
        attemptId: string
        toolName: string
        outcome: string
        basis: unknown
        result: ToolResultOutput[]
      }>('tool_result')
      assert(call.correlation && call.payload.attemptId)
      assert.equal(reply.correlation, call.correlation)
      assert.equal(reply.payload.attemptId, call.payload.attemptId)
      assert.equal(call.payload.toolName, request.toolName)
      assert.equal(reply.payload.toolName, request.toolName)
      assert.deepEqual(call.payload.input, request.input)
      assert.equal(reply.payload.outcome, 'succeeded')
      assert.deepEqual(reply.payload.basis, call.payload.basis)
      assert.equal(call.stepNumber, yielded.stepNumber)
      assert.equal(reply.stepNumber, call.stepNumber)
      toolResult = reply.payload.result
    } else {
      assert(typeof request === 'object' && request.type === 'GENERATE_N')
      const call = take<{
        n: number
        source: string
        replayPermitted: boolean
        input: unknown
      }>('llm_request')
      const reply = take<{
        n: number
        source: string
        replayPermitted: boolean
        fullResponse: string
        nResponses: string[]
      }>('llm_response')
      assert(call.correlation)
      assert.equal(reply.correlation, call.correlation)
      assert.equal(call.stepNumber, yielded.stepNumber)
      assert.equal(reply.stepNumber, call.stepNumber)
      assert.equal(call.payload.source, 'generate_n')
      assert.equal(reply.payload.source, 'generate_n')
      assert.equal(call.payload.replayPermitted, false)
      assert.equal(reply.payload.replayPermitted, false)
      assert.equal(call.payload.n, request.n)
      assert.equal(reply.payload.n, request.n)
      assert(call.payload.input)
      assert.deepEqual(
        reply.payload.nResponses,
        JSON.parse(reply.payload.fullResponse),
      )
      candidateReply = reply.payload.nResponses
    }

    const {
      kind: inputKind,
      replayPermitted: inputPermission,
      value: offered,
      valueSha256,
      ...replyIdentity
    } = observation('next_input').payload
    assert.deepEqual(replyIdentity, identity)
    assert.equal(valueSha256, captureValueSha256(offered))
    const { undefinedKeys, ...explicit } = offered
    assert.deepEqual(explicit.toolResult, toolResult)
    if (
      typeof request === 'object' &&
      'type' in request &&
      request.type === 'GENERATE_N'
    ) {
      assert.deepEqual(undefinedKeys, [])
      assert.deepEqual(explicit.nResponses, candidateReply)
      assert(
        Array.isArray(explicit.nResponses) &&
          explicit.nResponses.length === request.n &&
          explicit.nResponses.every((item) => typeof item === 'string'),
      )
    } else {
      assert.deepEqual(undefinedKeys, ['nResponses'])
      assert(!Object.hasOwn(explicit, 'nResponses'))
    }
    const reply = { ...explicit, nResponses: explicit.nResponses }
    witnessed.push({ ...identity, yield: request, reply })
    next = iterator.next({ ...reply, agentState: { messageHistory } })
  }
  const terminal = observation('generator_return').payload
  assert.equal(terminal.observedYields, witnessed.length)
  assert.deepEqual(terminal.value, { kind: 'value', value: next.value })
  assert.equal(terminal.valueSha256, captureValueSha256(terminal.value))
  assert.equal(cursor, trace.length, 'Extra unexplained evidence after return')
  return { witnessed, output: next.value, replayPermitted: false }
}

let capture: Awaited<ReturnType<typeof record>>
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-b15-production-proof-'))
  try {
    capture = await record(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const initialRequests = { tool: 2, step: 3, generateN: 1, start: 1, network: 0 }

test('B15 proof: reconstructs the production iterator prefix without repeating requests', () => {
  const { rows, hostReplies, calls } = capture
  const proof = reconstruct(rows)
  expect(proof.replayPermitted).toBe(false)
  expect(
    proof.witnessed.map(({ ordinal, occurrence, yield: request }) => [
      ordinal,
      occurrence,
      request,
    ]),
  ).toEqual([
    [
      0,
      0,
      {
        toolName: 'b15_fixture_sample',
        input: { prompt: input.prompt, ...input.params },
        includeToolCall: false,
      },
    ],
    [
      1,
      1,
      {
        toolName: 'b15_fixture_sample',
        input: { prompt: input.prompt, ...input.params },
        includeToolCall: false,
      },
    ],
    [2, 0, 'STEP'],
    [3, 0, 'STEP_ALL'],
    [4, 0, { type: 'GENERATE_N', n: 2 }],
  ])
  expect(proof.witnessed.map(({ reply }) => reply)).toEqual([
    {
      toolResult: hostReplies[0],
      stepsComplete: false,
      hitStepCap: false,
      nResponses: undefined,
    },
    {
      toolResult: hostReplies[1],
      stepsComplete: false,
      hitStepCap: false,
      nResponses: undefined,
    },
    {
      toolResult: [],
      stepsComplete: true,
      hitStepCap: false,
      nResponses: undefined,
    },
    {
      toolResult: [],
      stepsComplete: true,
      hitStepCap: false,
      nResponses: undefined,
    },
    {
      toolResult: [],
      stepsComplete: false,
      hitStepCap: false,
      nResponses: [...candidates],
    },
  ])
  expect(proof.output).toEqual({
    first: hostReplies[0],
    second: hostReplies[1],
    modelText: stepText,
    groupText: allText,
    nResponses: candidates,
  })
  expect(calls).toEqual(initialRequests)
})

test('B15 proof: refuses a divergent yield before offering the next reply', () => {
  const rows = capture.rows.map((row) =>
    row.eventType === 'llm_response'
      ? { ...row, payload: { fullResponse: 'Choose only one candidate.' } }
      : row,
  )
  // This altered STEP text changes what the same recipe actually yields.
  expect(() => reconstruct(rows)).toThrow('Yield divergence at ordinal 4')
  expect(capture.calls).toEqual(initialRequests)
})

test('B15 proof: refuses a missing iterator reply even if its tool result is retained', () => {
  const rows = capture.rows.map((row) => {
    const payload = row.payload as { kind?: string; ordinal?: number }
    return row.eventType === 'programmatic_observation' &&
      payload.kind === 'next_input' &&
      payload.ordinal === 1
      ? { ...row, eventType: 'step_boundary' as const, payload: {} }
      : row
  })
  expect(() => reconstruct(rows)).toThrow(
    'Observation gap: expected next_input',
  )
  expect(capture.calls).toEqual(initialRequests)
})

test('B15 proof: refuses a candidate request without a retained model reply', () => {
  const rows = capture.rows.map((row) =>
    row.eventType === 'llm_response' &&
    (row.payload as { source?: string }).source === 'generate_n'
      ? { ...row, eventType: 'step_boundary' as const, payload: {} }
      : row,
  )
  expect(() => reconstruct(rows)).toThrow('Trace gap: expected llm_response')
  expect(capture.calls).toEqual(initialRequests)
})

test('B15 proof: refuses a changed recipe basis before reconstructing', () => {
  const rows = capture.rows.map((row) => {
    const payload = row.payload as { kind?: string }
    return row.eventType === 'programmatic_observation' &&
      payload.kind === 'basis'
      ? {
          ...row,
          payload: {
            ...payload,
            artifact: {
              kind: 'serialized_handle_steps',
              sourceSha256: sha256('other code'),
              byteLength: Buffer.byteLength(source),
            },
          },
        }
      : row
  })
  expect(() => reconstruct(rows)).toThrow('Recipe basis changed')
  expect(capture.calls).toEqual(initialRequests)
})
