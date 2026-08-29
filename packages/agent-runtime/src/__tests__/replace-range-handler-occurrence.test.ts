import { replaceRangeParams } from '@codebuff/common/tools/params/tool/replace-range'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { handleReplaceRange } from '../tools/handlers/tool/replace-range'
import { mockFileContext } from './test-utils'

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
      return []
    },
    // The handler param type is intentionally wide; the neighbouring handler
    // tests use the same cast to bypass it.
  } as any)
}

describe('handleReplaceRange occurrence resolution', () => {
  it('forwards absolute lines of the requested occurrence in a provider-shaped payload', async () => {
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
    // Second in-range occurrence is absolute line 5 (line 1 is outside the
    // authorized 2-6 window, so it is not counted).
    expect(capturedInput.startLine).toBe(5)
    expect(capturedInput.endLine).toBe(5)
    expect(capturedInput.newContent).toBe('repeat(2);')
    expect(Object.keys(capturedInput).sort()).toEqual([
      'endLine',
      'newContent',
      'path',
      'readCapability',
      'startLine',
    ])
    // Regression: the payload used to carry the derived capability* keys and
    // the already-resolved `occurrence`, which both strict schemas rejected
    // with `Unrecognized keys`. Assert both re-validation boundaries the
    // payload actually crosses: clientToolCallSchema.parse in sdk/src/run.ts
    // uses providerInputSchema, and the SDK applicator re-parses inputSchema.
    expect(
      replaceRangeParams.providerInputSchema.safeParse(capturedInput).success,
    ).toBe(true)
    expect(
      replaceRangeParams.inputSchema.safeParse(capturedInput).success,
    ).toBe(true)
  })

  it('forwards a multi-line occurrence match with endLine > startLine', async () => {
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
    expect(capturedInputs[0]?.startLine).toBe(4)
    expect(capturedInputs[0]?.endLine).toBe(5)
    expect(Number(capturedInputs[0]?.endLine)).toBeGreaterThan(
      Number(capturedInputs[0]?.startLine),
    )
    expect(capturedInputs[0]?.newContent).toBe('const beta = 20\nrepeat(1);')
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
        'could not read current content',
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
        // stays concrete without a bound cap.v3 token.
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
    expect(capturedInputs[0]?.startLine).toBe(capabilityStartLine)
    expect(capturedInputs[0]?.endLine).toBe(capabilityEndLine)
    expect(capturedInputs[0]?.newContent).toBe('replacement')
  })
})
