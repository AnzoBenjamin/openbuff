import { describe, expect, mock, test } from 'bun:test'

import {
  createTestAgentRuntimeParams,
  mockFileContext,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import { toolParams } from '@codebuff/common/tools/list'
import {
  buildFileMutationResultFromReceiptV1,
  commitReceiptV1Schema,
  fileMutationResultV1Schema,
} from '@codebuff/common/tools/results/filesystem'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getExactContentHash,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import { executeToolCall } from '../tools/tool-executor'
import { getFileProcessingValues } from '../tools/handlers/tool/write-file'

import type { ExecuteToolCallParams } from '../tools/tool-executor'
import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type {
  CommitReceiptV1,
  FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { ConfirmedPostEditAnchor } from '@codebuff/common/types/session-state'

const scope = { projectId: '/project', runId: 'publication-run' }
const path = 'bytes.txt'
const callId = 'publication-call'
const before = '\uFEFFbefore\r\nkeep😀e\u0301\n'
const replacement = 'after😀e\u0301'
const after = `\uFEFF${replacement}\r\nkeep😀e\u0301\n`
const sentAt = 1_800_000_000_000

function wholeAnchor(content: string, issuer = scope) {
  const document = captureTextDocument(content)
  const rawBasis = getRawReadBasis(
    document,
    1,
    document.maxCapabilityLine,
    'whole',
  )
  return {
    startLine: 1,
    endLine: document.maxCapabilityLine,
    contentHash: document.observationHash,
    rawBasis,
    readCapability: encodeReadCapabilityToken({
      startLine: 1,
      endLine: document.maxCapabilityLine,
      hash: document.observationHash,
      rawBasis,
      scope: { ...issuer, path },
    }),
  }
}

function clientResult(
  includeAuthority = true,
  issuer = scope,
): {
  output: CodebuffToolOutput<'replace_range'>
  mutation: FileMutationResultV1
  receipt: CommitReceiptV1
  anchor: ReturnType<typeof wholeAnchor>
} {
  const document = captureTextDocument(after)
  const anchor = wholeAnchor(after, issuer)
  const receipt = commitReceiptV1Schema.parse({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'publication-receipt',
    operationId: 'publication-operation',
    callId,
    authorityTier: 'conditional_commit',
    status: 'committed',
    workspaceRevision: 1,
    workspaceSnapshotId: 'publication-snapshot',
    actions: [
      {
        actionId: 'publication-action',
        index: 0,
        action: 'update',
        path,
        status: 'committed',
        beforeHash: getExactContentHash(before),
        afterHash: document.rawHash,
      },
    ],
    finalHashes: { [path]: document.rawHash },
  })
  const mutation = includeAuthority
    ? buildFileMutationResultFromReceiptV1(
        receipt,
        [],
        [
          {
            kind: 'whole_file',
            version: 1,
            token: anchor.readCapability,
            snapshot: {
              kind: 'file_snapshot',
              version: 1,
              canonicalPath: `${scope.projectId}/${path}`,
              contentHash: document.rawHash,
              sizeBytes: document.byteLength,
              encoding: 'utf8',
              readGeneration: 1,
            },
          },
        ],
        new Map([[0, after]]),
        new Map([[0, anchor]]),
      )
    : buildFileMutationResultFromReceiptV1(receipt)
  const output: CodebuffToolOutput<'replace_range'> = [
    { type: 'json', value: mutation },
  ]
  return { output, mutation, receipt, anchor }
}

function harness(
  client: ReturnType<typeof clientResult>,
  options: {
    fromHandleSteps?: boolean
    state?: Partial<FileProcessingState>
  } = {},
) {
  const runtime = createTestAgentRuntimeParams()
  const template: AgentTemplate = {
    ...runtime.agentTemplate,
    id: 'publication-agent',
    outputMode: 'last_message',
    toolNames: ['replace_range'],
    spawnableAgents: [],
    mcpServers: {},
  }
  const fileContext = {
    ...mockFileContext,
    projectRoot: scope.projectId,
    cwd: scope.projectId,
  }
  const chunks: Array<string | PrintModeEvent> = []
  const errors = mock(() => {})
  const state = getFileProcessingValues(options.state ?? {})
  const requestOptionalFile = mock(async () => before)
  const requestToolCall = mock(async () => ({
    output: client.output,
    canonicalReceipt: client.receipt,
  }))
  const params: ExecuteToolCallParams<'replace_range'> = {
    ...runtime,
    toolName: 'replace_range',
    input: {
      path,
      readCapability: wholeAnchor(before).readCapability,
      startLine: 1,
      endLine: 1,
      newContent: replacement,
    },
    agentContext: {},
    agentState: getInitialSessionState(fileContext).mainAgentState,
    agentStepId: 'publication-step',
    ancestorRunIds: [],
    agentTemplate: template,
    clientSessionId: 'publication-session',
    fileContext,
    fileProcessingState: state,
    fingerprintId: 'publication-fingerprint',
    fromHandleSteps: options.fromHandleSteps,
    fullResponse: '',
    localAgentTemplates: { [template.id]: template },
    logger: { ...runtime.logger, error: errors },
    previousToolCallFinished: Promise.resolve(),
    prompt: undefined,
    repoId: undefined,
    repoUrl: undefined,
    runId: scope.runId,
    signal: new AbortController().signal,
    system: 'publication test',
    tools: {},
    toolCallId: callId,
    toolCalls: [],
    toolCallsToAddToMessageHistory: [],
    toolResults: [],
    toolResultsToAddToMessageHistory: [],
    userId: 'publication-user',
    userInputId: 'publication-input',
    requestOptionalFile,
    requestToolCall,
    onCostCalculated: async () => {},
    onResponseChunk: (chunk) => chunks.push(chunk),
    clock: { now: () => sentAt },
  }
  return { params, chunks, state, requestOptionalFile, requestToolCall, errors }
}

function assertPublication(
  run: ReturnType<typeof harness>,
  expected: Array<CodebuffToolOutput<'replace_range'>[number]>,
) {
  expect(run.requestOptionalFile).toHaveBeenCalledTimes(1)
  expect(run.requestToolCall).toHaveBeenCalledTimes(1)
  expect(run.requestToolCall).toHaveBeenCalledWith({
    userInputId: 'publication-input',
    callId,
    toolName: 'replace_range',
    input: {
      type: 'file',
      path,
      content: after,
      expectedHash: captureTextDocument(before).observationHash,
      expectedRawHash: getExactContentHash(before),
    },
    signal: run.params.signal,
  })
  const results = run.chunks.filter(
    (chunk): chunk is Extract<PrintModeEvent, { type: 'tool_result' }> =>
      typeof chunk !== 'string' && chunk.type === 'tool_result',
  )
  expect(results).toHaveLength(1)
  expect(run.params.toolResults).toHaveLength(1)
  expect(run.params.toolResultsToAddToMessageHistory).toHaveLength(1)
  const recorded = run.params.toolResults[0]!
  expect(recorded).toBe(run.params.toolResultsToAddToMessageHistory[0])
  expect(results[0]!.output).toBe(recorded.content)
  expect(recorded.content).toEqual(expected)
  expect(recorded).toMatchObject({
    role: 'tool',
    toolName: 'replace_range',
    toolCallId: callId,
    sentAt,
  })
  expect(
    toolParams.replace_range.outputSchema.safeParse(recorded.content).success,
  ).toBe(true)
  expect(results[0]!.actionOutcome).toMatchObject({
    actionId: callId,
    runId: scope.runId,
    toolName: 'replace_range',
  })
  return fileMutationResultV1Schema.parse(
    recorded.content[0]?.type === 'json'
      ? recorded.content[0].value
      : undefined,
  )
}

function supplement(
  anchor: Pick<ConfirmedPostEditAnchor, 'contentHash' | 'readCapability'>,
) {
  return {
    type: 'json' as const,
    value: {
      postEditCapabilities: [
        {
          path,
          contentHash: anchor.contentHash,
          readCapability: anchor.readCapability,
        },
      ],
    },
  }
}

describe('native post-edit output publication', () => {
  for (const fromHandleSteps of [false, true]) {
    test(`retains genuine supplementary authority on the ${fromHandleSteps ? 'programmatic' : 'model'} route`, async () => {
      const client = clientResult()
      const run = harness(client, { fromHandleSteps })
      await executeToolCall(run.params)

      const primary = assertPublication(run, [
        ...client.output,
        supplement(client.anchor),
      ])
      expect(primary.actions[0]?.afterContent).toBe(after)
      expect(primary.freshCapabilities[0]?.token).toBe(
        client.anchor.readCapability,
      )
      expect(run.state.confirmedPostEditAnchorsByPath?.[path]).toMatchObject({
        ...scope,
        ...client.anchor,
      })
      expect(run.errors).not.toHaveBeenCalled()
    })
  }

  test('publishes coordinator-backed authority when the primary omits after-content', async () => {
    const client = clientResult(false)
    const run = harness(client)
    await executeToolCall(run.params)

    const anchor = run.state.confirmedPostEditAnchorsByPath?.[path]
    expect(anchor).toBeDefined()
    const decoded = decodeReadCapabilityToken(anchor!.readCapability)
    expect(typeof decoded).not.toBe('string')
    if (typeof decoded === 'string') throw new Error(decoded)
    expect(readCapabilityMatchesScope(decoded, { ...scope, path })).toBe(true)
    expect(decoded.rawBasis?.documentRawHash).toBe(getExactContentHash(after))
    const primary = assertPublication(run, [
      ...client.output,
      supplement(anchor!),
    ])
    expect(primary.outcome).toBe('applied')
    expect(primary.authorityReceipt).toEqual(client.receipt)
    expect(primary.actions[0]?.afterContent).toBeUndefined()
    expect(primary.actions[0]?.editAnchor).toBeUndefined()
    expect(primary.freshCapabilities).toEqual([])
    expect(run.errors).not.toHaveBeenCalled()
  })

  test('removes foreign primary authority and publishes the separately minted local token', async () => {
    const client = clientResult(true, { ...scope, runId: 'foreign-run' })
    expect(fileMutationResultV1Schema.safeParse(client.mutation).success).toBe(
      true,
    )
    const run = harness(client)
    await executeToolCall(run.params)

    const anchor = run.state.confirmedPostEditAnchorsByPath?.[path]
    expect(anchor?.readCapability).not.toBe(client.anchor.readCapability)
    const primary = assertPublication(run, [
      {
        type: 'json',
        value: buildFileMutationResultFromReceiptV1(client.receipt),
      },
      supplement(anchor!),
    ])
    expect(primary.actions[0]?.afterContent).toBeUndefined()
    expect(primary.actions[0]?.editAnchor).toBeUndefined()
    expect(primary.freshCapabilities).toEqual([])
    expect(JSON.stringify(run.params.toolResults)).not.toContain(
      client.anchor.readCapability,
    )
    expect(run.errors).not.toHaveBeenCalled()
  })

  test('publishes sanitized valid output after malformed primary metadata is reconciled', async () => {
    const client = clientResult()
    client.mutation.actions[0]!.afterContent = after.replace('\r\n', '\n')
    expect(fileMutationResultV1Schema.safeParse(client.mutation).success).toBe(
      false,
    )
    const run = harness(client)
    await executeToolCall(run.params)

    // Client reconciliation adds a provisional malformed-result error. The
    // coordinator forwards it and grants a local token from exact prepared
    // bytes. Final normalization returns valid canonical output, so publishing
    // only on !valid leaks the provisional error.
    const anchor = run.state.confirmedPostEditAnchorsByPath?.[path]
    expect(anchor).toBeDefined()
    const primary = assertPublication(run, [
      {
        type: 'json',
        value: buildFileMutationResultFromReceiptV1(client.receipt),
      },
      supplement(anchor!),
    ])
    expect(primary.outcome).toBe('applied')
    expect(primary.authorityReceipt).toEqual(client.receipt)
    expect(primary.errors).toEqual([])
    expect(primary.actions[0]?.afterContent).toBeUndefined()
    expect(primary.actions[0]?.editAnchor).toBeUndefined()
    expect(primary.freshCapabilities).toEqual([])
    expect(anchor?.rawBasis?.documentRawHash).toBe(getExactContentHash(after))
    expect(run.errors).not.toHaveBeenCalled()
  })

  test('discards malformed client additive claims before granting genuine coordinator authority', async () => {
    const client = clientResult(false)
    client.output = [
      client.output[0]!,
      {
        type: 'json',
        value: { postEditCapabilities: [{ path, readCapability: 'forged' }] },
      },
    ] as unknown as CodebuffToolOutput<'replace_range'>
    const run = harness(client)
    await executeToolCall(run.params)

    const anchor = run.state.confirmedPostEditAnchorsByPath?.[path]
    expect(anchor).toBeDefined()
    assertPublication(run, [client.output[0]!, supplement(anchor!)])
    expect(JSON.stringify(run.params.toolResults)).not.toContain('forged')
    expect(run.errors).not.toHaveBeenCalled()
  })

  for (const corruption of ['empty token', 'malformed hash'] as const) {
    test(`fails closed for a coordinator supplement with ${corruption}`, async () => {
      const client = clientResult(false)
      const anchors: Record<string, ConfirmedPostEditAnchor> = {}
      const minted: ConfirmedPostEditAnchor[] = []
      // Fault injection at the owned state boundary preserves the real native
      // handler and coordinator. Corrupt only after the local anchor is minted,
      // so final normalization must sanitize the actual additive output.
      Object.defineProperty(anchors, path, {
        configurable: true,
        set(anchor: ConfirmedPostEditAnchor) {
          minted.push(structuredClone(anchor))
          if (corruption === 'empty token') anchor.readCapability = ''
          else anchor.contentHash = 'malformed'
          Object.defineProperty(anchors, path, {
            value: anchor,
            writable: true,
            enumerable: true,
            configurable: true,
          })
        },
      })
      const run = harness(client, {
        state: { confirmedPostEditAnchorsByPath: anchors },
      })
      await executeToolCall(run.params)

      expect(minted).toHaveLength(1)
      expect(minted[0]?.readCapability).toMatch(/^cap\.v4\./)
      expect(minted[0]?.rawBasis?.documentRawHash).toBe(
        getExactContentHash(after),
      )
      const primary = assertPublication(run, client.output)
      expect(primary.outcome).toBe('applied')
      expect(primary.authorityReceipt).toEqual(client.receipt)
      expect(primary.freshCapabilities).toEqual([])
      expect(run.errors).toHaveBeenCalledTimes(1)
    })
  }
})
