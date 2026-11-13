import {
  preparedRangeMutationSchema,
  replaceRangeParams,
} from '@codebuff/common/tools/params/tool/replace-range'
import { clientToolCallSchema } from '@codebuff/common/tools/list'
import {
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'
import {
  captureTextDocument,
  getRawLineSpan,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'

import { handleReplaceRange } from '../tools/handlers/tool/replace-range'
import { mockFileContext } from './test-utils'
import { confirmedMutationOutput } from './read-files-edit-state-fixtures'

import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const path = 'src/occurrence.ts'
const runId = 'replace-range-handler-occurrence-run'

// "repeat();" appears on lines 1, 3 and 5. The capability below authorizes
// only lines 2-6, so the in-range occurrences are lines 3 and 5.
const diskLines = [
  'repeat();',
  'const alpha = 1',
  'repeat();',
  'const beta = 2',
  'repeat();',
  'const gamma = 3',
]
const diskContent = `${diskLines.join('\n')}\n`
const capabilityStartLine = 2
const capabilityEndLine = 6
const capabilityContent = diskLines
  .slice(capabilityStartLine - 1, capabilityEndLine)
  .join('\n')

function createFileProcessingState(): FileProcessingState {
  return {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
    failedEditRequiresReadByPath: {},
    consecutiveStrReplaceFailuresByPath: {},
  }
}

function capabilityToken(): string {
  return encodeReadCapabilityToken({
    startLine: capabilityStartLine,
    endLine: capabilityEndLine,
    hash: getContentHash(capabilityContent),
    scope: { projectId: mockFileContext.projectRoot, path, runId },
    rawBasis: getRawReadBasis(
      captureTextDocument(diskContent),
      capabilityStartLine,
      capabilityEndLine,
      'lines',
    ),
  })
}

/**
 * Build the handler-visible input exactly as the stream parser does: through
 * `replaceRangeParams.inputSchema`, whose transform adds the derived
 * `capability*` fields the handler reads.
 */
function handlerInput(overrides: Record<string, unknown>) {
  return replaceRangeParams.inputSchema.parse({
    path,
    readCapability: capabilityToken(),
    ...overrides,
  })
}

async function invokeHandler(params: {
  toolCallId: string
  input: ReturnType<typeof handlerInput> | Record<string, unknown>
  currentContent: string | null
  capturedInputs: Array<Record<string, unknown>>
  fileProcessingState?: FileProcessingState
  requestOptionalFileCalls?: { count: number }
  confirmedAfterContent?: string
}) {
  const fileProcessingState =
    params.fileProcessingState ?? createFileProcessingState()
  return handleReplaceRange({
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: params.toolCallId,
      toolName: 'replace_range',
      input: params.input,
    },
    fileContext: mockFileContext,
    runId,
    fileProcessingState,
    logger,
    requestOptionalFile: async () => {
      if (params.requestOptionalFileCalls) {
        params.requestOptionalFileCalls.count += 1
      }
      return params.currentContent
    },
    requestClientToolCall: async (clientToolCall: {
      input: Record<string, unknown>
    }) => {
      params.capturedInputs.push(clientToolCall.input)
      if (params.confirmedAfterContent !== undefined) {
        return confirmedMutationOutput(
          clientToolCall,
          { [path]: params.confirmedAfterContent },
          {
            projectId: mockFileContext.projectRoot,
            runId,
          },
        )
      }
      return []
    },
    // The handler param type is intentionally wide; the neighbouring handler
    // tests use the same cast to bypass it.
  } as any)
}

describe('handleReplaceRange occurrence resolution', () => {
  it('forwards the exact prepared content of the requested occurrence with both preimages', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []

    await invokeHandler({
      toolCallId: 'forward-resolved-occurrence',
      input: handlerInput({
        occurrence: { match: 'repeat();', occurrence: 2 },
        newContent: 'repeat(2);',
      }),
      currentContent: diskContent,
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(1)
    const capturedInput = capturedInputs[0] ?? {}
    // Line 1 lies outside the observed 2-6 window. Only the second contained
    // occurrence, at line 5, changes in the prepared exact file.
    expect(capturedInput).toEqual({
      type: 'file',
      path,
      content:
        'repeat();\nconst alpha = 1\nrepeat();\nconst beta = 2\nrepeat(2);\nconst gamma = 3\n',
      expectedHash: captureTextDocument(diskContent).observationHash,
      expectedRawHash: getExactContentHash(diskContent),
    })
    expect(Object.keys(capturedInput).sort()).toEqual([
      'content',
      'expectedHash',
      'expectedRawHash',
      'path',
      'type',
    ])
    // The SDK wire accepts the strict internal variant. The provider surface
    // still describes the caller's capability and range selection.
    expect(preparedRangeMutationSchema.safeParse(capturedInput).success).toBe(
      true,
    )
    expect(
      clientToolCallSchema.safeParse({
        toolCallId: 'forward-resolved-occurrence',
        toolName: 'replace_range',
        input: capturedInput,
      }).success,
    ).toBe(true)
    expect(
      replaceRangeParams.providerInputSchema.safeParse(capturedInput).success,
    ).toBe(false)
  })

  it('prepares the exact content of a contained multi-line occurrence', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []
    const multiLineMatch = 'const beta = 2\nrepeat();'

    await invokeHandler({
      toolCallId: 'forward-multiline-occurrence',
      input: handlerInput({
        occurrence: { match: multiLineMatch, occurrence: 1 },
        newContent: 'const beta = 20\nrepeat(1);',
      }),
      currentContent: diskContent,
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(1)
    expect(capturedInputs[0]).toEqual({
      type: 'file',
      path,
      content:
        'repeat();\nconst alpha = 1\nrepeat();\nconst beta = 20\nrepeat(1);\nconst gamma = 3\n',
      expectedHash: captureTextDocument(diskContent).observationHash,
      expectedRawHash: getExactContentHash(diskContent),
    })
  })

  it('prepares a relocated occurrence once after an insertion above the observed span', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []
    const currentContent = `const inserted = 0\n${diskContent}`
    const input = handlerInput({
      occurrence: { match: 'repeat();', occurrence: 2 },
      newContent: 'repeat(2);',
    })

    await invokeHandler({
      toolCallId: 'forward-relocated-occurrence',
      input,
      currentContent,
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(1)
    expect(currentContent.split('\n')[5]).toBe('repeat();')
    expect(capturedInputs[0]).toEqual({
      type: 'file',
      path,
      content:
        'const inserted = 0\nrepeat();\nconst alpha = 1\nrepeat();\nconst beta = 2\nrepeat(2);\nconst gamma = 3\n',
      expectedHash: captureTextDocument(currentContent).observationHash,
      expectedRawHash: getExactContentHash(currentContent),
    })
    expect(
      preparedRangeMutationSchema.safeParse(capturedInputs[0]).success,
    ).toBe(true)
  })

  it('prepares BOM, mixed-EOL and Unicode bytes and retains confirmed exact after-authority', async () => {
    const before =
      '\uFEFFhead 😀\r\nrepeat();\nkeep \uFEFFx\r\nrepeat();\nlast \rtail 😀'
    const after =
      '\uFEFFhead 😀\r\nrepeat();\nkeep \uFEFFx\r\nreplacement 😎\nextra\nlast \rtail 😀'
    const document = captureTextDocument(before)
    const span = getRawLineSpan(document, 2, 4)
    const token = encodeReadCapabilityToken({
      startLine: 2,
      endLine: 4,
      hash: getContentHash(
        document.observation.slice(
          span.startObservationOffset,
          span.endObservationOffset,
        ),
      ),
      scope: { projectId: mockFileContext.projectRoot, path, runId },
      rawBasis: getRawReadBasis(document, 2, 4, 'lines'),
    })
    const state = createFileProcessingState()
    state.strictReadBeforeEdit = true
    const capturedInputs: Array<Record<string, unknown>> = []
    const result = await invokeHandler({
      toolCallId: 'forward-confirmed-mixed-occurrence',
      input: handlerInput({
        readCapability: token,
        occurrence: { match: 'repeat();', occurrence: 2 },
        newContent: 'replacement 😎\nextra',
      }),
      currentContent: before,
      capturedInputs,
      fileProcessingState: state,
      confirmedAfterContent: after,
    })

    expect(capturedInputs).toEqual([
      {
        type: 'file',
        path,
        content: after,
        expectedHash: document.observationHash,
        expectedRawHash: document.rawHash,
      },
    ])
    expect(result.output[0]).toMatchObject({
      type: 'json',
      value: { outcome: 'applied' },
    })
    expect(state.rawReadAuthorizationHashesByPath?.[path]).toBe(
      getExactContentHash(after),
    )
    expect(
      state.confirmedPostEditAnchorsByPath?.[path]?.rawBasis,
    ).toMatchObject({
      scope: 'whole',
      rawHash: getExactContentHash(after),
    })
  })

  it('does not invoke the client when the authenticated raw span is stale', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []
    const result = await invokeHandler({
      toolCallId: 'stale-before-prepared-handoff',
      input: handlerInput({ newContent: 'replacement' }),
      currentContent: diskContent.replace('const gamma = 3', 'const gamma = 4'),
      capturedInputs,
    })
    expect(capturedInputs).toHaveLength(0)
    expect(result.output[0]).toMatchObject({
      type: 'json',
      value: {
        errorCode: 'fresh_read_required',
        errorMessage: expect.stringContaining(
          'raw bytes and line boundaries were not found',
        ),
      },
    })
  })

  it('does not invoke the client when raw relocation has identical candidates', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []
    const result = await invokeHandler({
      toolCallId: 'ambiguous-before-prepared-handoff',
      input: handlerInput({ newContent: 'replacement' }),
      currentContent: `${diskContent}${capabilityContent}\n`,
      capturedInputs,
    })
    expect(capturedInputs).toHaveLength(0)
    expect(result.output[0]).toMatchObject({
      type: 'json',
      value: {
        errorCode: 'fresh_read_required',
        errorMessage: expect.stringContaining('2 identical candidate spans'),
      },
    })
  })

  it('returns occurrence_not_found without calling the client when the count is short', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []

    const result = await invokeHandler({
      toolCallId: 'occurrence-not-found',
      input: handlerInput({
        occurrence: { match: 'repeat();', occurrence: 5 },
        newContent: 'repeat(5);',
      }),
      currentContent: diskContent,
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(0)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorCode?: string
        errorMessage?: string
      }
      expect(value.errorCode).toBe('occurrence_not_found')
      expect(String(value.errorMessage)).toContain('found 2 occurrence(s)')
      expect(String(value.errorMessage)).toContain(
        'occurrence 5 does not exist',
      )
      expect(String(value.errorMessage)).toContain(
        `${capabilityStartLine}-${capabilityEndLine}`,
      )
      expect(String(value.errorMessage)).not.toContain('undefined')
    }
  })

  it('returns occurrence_not_found with found:0 when the match is only outside the capability window', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []

    const result = await invokeHandler({
      toolCallId: 'occurrence-outside-window',
      // Line 1 is the only "outside-only();" and lies outside capability 2-6.
      input: handlerInput({
        occurrence: { match: 'outside-only();', occurrence: 1 },
        newContent: 'outside-only(1);',
      }),
      currentContent:
        [
          'outside-only();',
          'const alpha = 1',
          'repeat();',
          'const beta = 2',
          'repeat();',
          'const gamma = 3',
        ].join('\n') + '\n',
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(0)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorCode?: string
        errorMessage?: string
      }
      expect(value.errorCode).toBe('occurrence_not_found')
      expect(String(value.errorMessage)).toContain('found 0 occurrence(s)')
      expect(String(value.errorMessage)).toContain(
        'occurrence 1 does not exist',
      )
    }
  })

  it('returns fresh_read_required without calling the client when content is unavailable', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []

    const result = await invokeHandler({
      toolCallId: 'occurrence-content-unavailable',
      input: handlerInput({
        occurrence: { match: 'repeat();', occurrence: 1 },
        newContent: 'repeat(1);',
      }),
      currentContent: null,
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(0)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorCode?: string
        errorMessage?: string
      }
      expect(value.errorCode).toBe('fresh_read_required')
      expect(String(value.errorMessage)).toContain(
        'a lossless current source is unavailable',
      )
    }
  })

  it('rejects unauthenticated occurrence calls with fresh_read_required before resolution under strict mode', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []
    const requestOptionalFileCalls = { count: 0 }
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    // Legacy/pre-schema shape without a bound capability: must fail the strict
    // gate before occurrence resolution (and without reading content when no
    // whole-file auth is stored).
    const result = await invokeHandler({
      toolCallId: 'occurrence-unauth-strict',
      input: {
        path,
        occurrence: { match: 'repeat();', occurrence: 1 },
        newContent: 'repeat(1);',
        // Transform normally fills these; include them so recovery messaging
        // stays concrete without a bound raw capability token.
        capabilityStartLine,
        capabilityEndLine,
      },
      currentContent: diskContent,
      capturedInputs,
      fileProcessingState,
      requestOptionalFileCalls,
    })

    expect(capturedInputs).toHaveLength(0)
    expect(requestOptionalFileCalls.count).toBe(0)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as {
        errorCode?: string
        errorMessage?: string
      }
      expect(value.errorCode).toBe('fresh_read_required')
      expect(String(value.errorMessage)).toContain('strict read-before-edit')
      // The strict gate ran before occurrence resolution, so neither
      // occurrence-resolution failure message can appear. (The fixture path
      // itself contains "occurrence", so assert on the messages, not the word.)
      expect(String(value.errorMessage)).not.toContain('does not exist')
      expect(String(value.errorMessage)).not.toContain(
        'could not read current content',
      )
    }
  })

  it('still defaults a non-occurrence call to the capability bounds', async () => {
    const capturedInputs: Array<Record<string, unknown>> = []

    await invokeHandler({
      toolCallId: 'non-occurrence-defaults',
      input: handlerInput({ newContent: 'replacement' }),
      currentContent: diskContent,
      capturedInputs,
    })

    expect(capturedInputs).toHaveLength(1)
    expect(capturedInputs[0]).toEqual({
      type: 'file',
      path,
      content: 'repeat();\nreplacement\n',
      expectedHash: captureTextDocument(diskContent).observationHash,
      expectedRawHash: getExactContentHash(diskContent),
    })
  })
})
