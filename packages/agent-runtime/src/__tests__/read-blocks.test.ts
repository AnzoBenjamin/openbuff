import {
  decodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { MAX_READ_BLOCK_BYTES } from '@codebuff/common/tools/params/tool/read-blocks'

import { handleReadBlocks } from '../tools/handlers/tool/read-blocks'
import { mockFileContext } from './test-utils'

import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const runId = 'read-blocks-test-run'

const defaultTestHandlerAuthority = {
  fileContext: mockFileContext,
  runId,
}

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

type ReadBlocksSelector =
  | { kind: 'window'; path: string; windowSize?: number; window?: number }
  | {
      kind: 'around'
      path: string
      match: string
      occurrence?: number
      contextLines?: number
    }
  | { kind: 'symbol'; path: string; name: string; occurrence?: number }

function buildInput(selectors: ReadBlocksSelector[]) {
  const windows: Array<{ path: string; windowSize?: number; window?: number }> =
    []
  const around: Array<{
    path: string
    match: string
    occurrence?: number
    contextLines?: number
  }> = []
  const symbols: Array<{ path: string; name: string; occurrence?: number }> = []
  for (const selector of selectors) {
    if (selector.kind === 'window') {
      const { kind: _kind, ...window } = selector
      windows.push(window)
    } else if (selector.kind === 'around') {
      const { kind: _kind, ...block } = selector
      around.push(block)
    } else {
      const { kind: _kind, ...symbol } = selector
      symbols.push(symbol)
    }
  }
  return {
    ...(windows.length > 0 ? { windows } : {}),
    ...(around.length > 0 ? { around } : {}),
    ...(symbols.length > 0 ? { symbols } : {}),
  }
}

type ReadBlocksResultItem = {
  selector: string
  requestIndex: number
  path: string
  status: string
  content?: string
  sourceContent?: string
  startLine?: number
  endLine?: number
  totalLines?: number
  complete?: boolean
  windowSize?: number
  windowCount?: number
  window?: number
  match?: string
  occurrence?: number
  totalOccurrences?: number
  symbol?: string
  kind?: string
  editAnchor?: {
    startLine: number
    endLine: number
    contentHash: string
    readCapability: string
  }
  error?: { code: string; message: string; retryable: boolean; recovery?: string }
}

type ReadBlocksResultValue = {
  kind: string
  version: number
  status: string
  summary: {
    requested: number
    ok: number
    partial: number
    failed: number
    uniquePaths: number
  }
  results: ReadBlocksResultItem[]
}

async function runReadBlocks(params: {
  selectors: ReadBlocksSelector[]
  contents: Record<string, string | null>
  fileProcessingState?: FileProcessingState
}) {
  const fileProcessingState =
    params.fileProcessingState ?? createFileProcessingState()
  const result = await handleReadBlocks({
    ...defaultTestHandlerAuthority,
    previousToolCallFinished: Promise.resolve(),
    toolCall: {
      toolCallId: 'read-blocks-test',
      toolName: 'read_blocks',
      input: buildInput(params.selectors),
    },
    fileProcessingState,
    requestOptionalFile: async ({ filePath }: { filePath: string }) =>
      params.contents[filePath] ?? null,
    logger,
  } as never)

  expect(result.output[0]?.type).toBe('json')
  if (result.output[0]?.type !== 'json') {
    throw new Error('read_blocks returned a non-json output')
  }
  return result.output[0].value as unknown as ReadBlocksResultValue
}

describe('handleReadBlocks', () => {
  const windowFile = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')

  it('returns a complete window with correct bounds and a decodable cap.v3 editAnchor', async () => {
    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/win.ts', windowSize: 3, window: 2 },
      ],
      contents: { 'src/win.ts': windowFile },
    })

    expect(value.status).toBe('ok')
    expect(value.summary).toEqual({
      requested: 1,
      ok: 1,
      partial: 0,
      failed: 0,
      uniquePaths: 1,
    })
    const item = value.results[0]!
    expect(item).toMatchObject({
      selector: 'window',
      requestIndex: 0,
      path: 'src/win.ts',
      status: 'ok',
      startLine: 4,
      endLine: 6,
      totalLines: 7,
      complete: true,
      windowSize: 3,
      windowCount: 3,
      window: 2,
    })
    expect(item.content).toBe('l4\nl5\nl6')
    expect(item.sourceContent).toBe('l4\nl5\nl6')

    const editAnchor = item.editAnchor
    expect(editAnchor).toBeDefined()
    expect(editAnchor).toMatchObject({ startLine: 4, endLine: 6 })
    expect(editAnchor!.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/)

    const decoded = decodeReadCapabilityToken(editAnchor!.readCapability)
    expect(typeof decoded).not.toBe('string')
    if (typeof decoded !== 'string') {
      expect(decoded.startLine).toBe(4)
      expect(decoded.endLine).toBe(6)
      expect(decoded.hash).toBe(editAnchor!.contentHash)
      expect(decoded.hash).toMatch(/^sha256:/)
    }
  })

  it('omitting window returns the manifest plus the first window', async () => {
    const value = await runReadBlocks({
      selectors: [{ kind: 'window', path: 'src/win.ts', windowSize: 3 }],
      contents: { 'src/win.ts': windowFile },
    })

    const item = value.results[0]!
    expect(item).toMatchObject({
      selector: 'window',
      status: 'ok',
      startLine: 1,
      endLine: 3,
      totalLines: 7,
      windowSize: 3,
      windowCount: 3,
      window: 1,
    })
    expect(item.content).toBe('l1\nl2\nl3')
    expect(item.editAnchor).toBeDefined()
  })

  it('returns an invalid_request error without an editAnchor when the window is out of range', async () => {
    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/win.ts', windowSize: 3, window: 4 },
      ],
      contents: { 'src/win.ts': windowFile },
    })

    expect(value.status).toBe('error')
    expect(value.summary).toMatchObject({ ok: 0, failed: 1 })
    const item = value.results[0]!
    expect(item.status).toBe('error')
    expect(item.error?.code).toBe('invalid_request')
    expect(item.error?.message).toContain('out of range')
    expect(item.editAnchor).toBeUndefined()
  })

  const aroundFile = [
    'const a = 1',
    'const b = 2',
    'const marker = true',
    'const c = 3',
    'const d = 4',
  ].join('\n')

  it('anchors an around block on an exact literal match with clamped context and a minted editAnchor', async () => {
    const value = await runReadBlocks({
      selectors: [
        {
          kind: 'around',
          path: 'src/around.ts',
          match: 'const marker = true',
          contextLines: 1,
        },
      ],
      contents: { 'src/around.ts': aroundFile },
    })

    const item = value.results[0]!
    expect(item).toMatchObject({
      selector: 'around',
      requestIndex: 0,
      status: 'ok',
      startLine: 2,
      endLine: 4,
      totalLines: 5,
      complete: true,
      match: 'const marker = true',
      occurrence: 1,
      totalOccurrences: 1,
    })
    expect(item.content).toContain('const marker = true')
    expect(item.content).toBe('const b = 2\nconst marker = true\nconst c = 3')
    expect(item.editAnchor).toMatchObject({ startLine: 2, endLine: 4 })
  })

  it('clamps around context at the start of the file', async () => {
    const value = await runReadBlocks({
      selectors: [
        {
          kind: 'around',
          path: 'src/around.ts',
          match: 'const a = 1',
          contextLines: 5,
        },
      ],
      contents: { 'src/around.ts': aroundFile },
    })

    const item = value.results[0]!
    expect(item).toMatchObject({
      status: 'ok',
      startLine: 1,
      endLine: 5,
      complete: true,
    })
    expect(item.content).toBe(aroundFile)
  })

  it('anchors on the second occurrence when occurrence: 2 is requested', async () => {
    const repeated = [
      'start',
      'target();',
      'middle',
      'target();',
      'end',
    ].join('\n')
    const value = await runReadBlocks({
      selectors: [
        {
          kind: 'around',
          path: 'src/repeated.ts',
          match: 'target();',
          occurrence: 2,
          contextLines: 0,
        },
      ],
      contents: { 'src/repeated.ts': repeated },
    })

    const item = value.results[0]!
    expect(item).toMatchObject({
      status: 'ok',
      startLine: 4,
      endLine: 4,
      occurrence: 2,
      totalOccurrences: 2,
    })
    expect(item.content).toBe('target();')
    expect(item.editAnchor).toMatchObject({ startLine: 4, endLine: 4 })
  })

  it('returns no_match without a capability for a non-existent occurrence', async () => {
    const value = await runReadBlocks({
      selectors: [
        {
          kind: 'around',
          path: 'src/around.ts',
          match: 'const marker = true',
          occurrence: 2,
        },
      ],
      contents: { 'src/around.ts': aroundFile },
    })

    const item = value.results[0]!
    expect(item.status).toBe('error')
    expect(item.error?.code).toBe('no_match')
    expect(item.error?.message).toContain('occurrence 2 does not exist')
    expect(item.editAnchor).toBeUndefined()
  })

  const duplicateSymbolFile = [
    'export function dup() {',
    '  return 1',
    '}',
    '',
    'export function dup() {',
    '  return 2',
    '}',
  ].join('\n')

  it('selects same-named top-level symbols by occurrence distinctly', async () => {
    const first = await runReadBlocks({
      selectors: [{ kind: 'symbol', path: 'src/dup.ts', name: 'dup' }],
      contents: { 'src/dup.ts': duplicateSymbolFile },
    })
    const second = await runReadBlocks({
      selectors: [
        { kind: 'symbol', path: 'src/dup.ts', name: 'dup', occurrence: 2 },
      ],
      contents: { 'src/dup.ts': duplicateSymbolFile },
    })

    const firstItem = first.results[0]!
    const secondItem = second.results[0]!
    expect(firstItem).toMatchObject({
      selector: 'symbol',
      status: 'ok',
      symbol: 'dup',
      occurrence: 1,
      complete: true,
    })
    expect(secondItem).toMatchObject({
      selector: 'symbol',
      status: 'ok',
      symbol: 'dup',
      occurrence: 2,
      complete: true,
    })
    expect(firstItem.content).toContain('return 1')
    expect(firstItem.content).not.toContain('return 2')
    expect(secondItem.content).toContain('return 2')
    expect(secondItem.content).not.toContain('return 1')
    expect(firstItem.startLine).toBeLessThan(secondItem.startLine!)
  })

  it('returns no_match for an unknown symbol', async () => {
    const value = await runReadBlocks({
      selectors: [{ kind: 'symbol', path: 'src/dup.ts', name: 'missing' }],
      contents: { 'src/dup.ts': duplicateSymbolFile },
    })

    const item = value.results[0]!
    expect(item.status).toBe('error')
    expect(item.error?.code).toBe('no_match')
    expect(item.error?.message).toContain('"missing"')
    expect(item.editAnchor).toBeUndefined()
  })

  it('exposes an editAnchor on a parser-proven symbol slice', async () => {
    const value = await runReadBlocks({
      selectors: [{ kind: 'symbol', path: 'src/dup.ts', name: 'dup' }],
      contents: { 'src/dup.ts': duplicateSymbolFile },
    })

    const item = value.results[0]!
    expect(item.status).toBe('ok')
    expect(item.kind).toBeDefined()
    expect(item.editAnchor).toBeDefined()
    expect(item.editAnchor).toMatchObject({
      startLine: item.startLine!,
      endLine: item.endLine!,
    })
    expect(item.editAnchor!.readCapability).toMatch(/^cap\.v3\./)
    const decoded = decodeReadCapabilityToken(item.editAnchor!.readCapability)
    expect(typeof decoded).not.toBe('string')
    if (typeof decoded !== 'string') {
      expect(decoded.startLine).toBe(item.startLine!)
      expect(decoded.endLine).toBe(item.endLine!)
    }
  })

  it('combines window + around + symbol selectors with contiguous requestIndex and a matching summary', async () => {
    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/batch.ts', windowSize: 2, window: 1 },
        { kind: 'around', path: 'src/batch.ts', match: 'marker' },
        { kind: 'symbol', path: 'src/batch.ts', name: 'run' },
      ],
      contents: {
        'src/batch.ts': [
          'const marker = 1',
          'export function run() {',
          '  return marker',
          '}',
        ].join('\n'),
      },
    })

    expect(value.status).toBe('ok')
    expect(value.summary).toEqual({
      requested: 3,
      ok: 3,
      partial: 0,
      failed: 0,
      uniquePaths: 1,
    })
    expect(value.results.map((item) => item.requestIndex)).toEqual([0, 1, 2])
    expect(value.results.map((item) => item.selector)).toEqual([
      'window',
      'around',
      'symbol',
    ])
    for (const item of value.results) {
      expect(item.status).toBe('ok')
      expect(item.path).toBe('src/batch.ts')
    }
  })

  it('counts mixed ok and failed items in the summary', async () => {
    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/batch.ts', windowSize: 2, window: 1 },
        { kind: 'around', path: 'src/batch.ts', match: 'absent-literal' },
      ],
      contents: { 'src/batch.ts': 'const marker = 1\nconst other = 2\n' },
    })

    expect(value.status).toBe('partial')
    expect(value.summary).toEqual({
      requested: 2,
      ok: 1,
      partial: 0,
      failed: 1,
      uniquePaths: 1,
    })
    expect(value.results[0]!.status).toBe('ok')
    expect(value.results[1]!.status).toBe('error')
    expect(value.results[1]!.error?.code).toBe('no_match')
  })

  it('short-circuits the whole batch to error items for an unsafe path', async () => {
    let ioCalls = 0
    const fileProcessingState = createFileProcessingState()
    const result = await handleReadBlocks({
      ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'read-blocks-unsafe',
        toolName: 'read_blocks',
        input: buildInput([
          { kind: 'window', path: 'src/safe.ts', windowSize: 2 },
          { kind: 'around', path: '../outside.ts', match: 'x' },
          { kind: 'symbol', path: 'src/safe.ts', name: 'run' },
        ]),
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestOptionalFile: async () => {
        ioCalls += 1
        return 'const x = 1\n'
      },
      logger,
    } as never)

    expect(ioCalls).toBe(0)
    expect(result.output[0]?.type).toBe('json')
    if (result.output[0]?.type === 'json') {
      const value = result.output[0].value as unknown as ReadBlocksResultValue
      expect(value.status).toBe('error')
      expect(value.summary).toEqual({
        requested: 3,
        ok: 0,
        partial: 0,
        failed: 3,
        uniquePaths: 2,
      })
      expect(value.results.map((item) => item.requestIndex)).toEqual([0, 1, 2])
      // The unsafe selector reports outside_project; the other selectors in
      // the batch are reported as skipped via invalid_request.
      expect(value.results[1]).toMatchObject({
        path: '../outside.ts',
        status: 'error',
        error: { code: 'outside_project' },
      })
      expect(value.results[1]!.error?.message).toContain(
        'path traversal blocked',
      )
      expect(value.results[0]!.error?.code).toBe('invalid_request')
      expect(value.results[2]!.error?.code).toBe('invalid_request')
    }
  })

  it('clears the failed-edit gate after a successful scoped block read', async () => {
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.failedEditRequiresReadByPath['src/gated.ts'] = true
    fileProcessingState.promisesByPath['src/gated.ts'] = [
      Promise.resolve({
        tool: 'str_replace' as const,
        path: 'src/gated.ts',
        toolCallId: 'failed-edit',
        error: 'previous failed edit',
      }),
    ]

    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/gated.ts', windowSize: 2, window: 1 },
      ],
      contents: { 'src/gated.ts': 'const a = 1\nconst b = 2\n' },
      fileProcessingState,
    })

    expect(value.results[0]!.status).toBe('ok')
    expect(
      fileProcessingState.failedEditRequiresReadByPath['src/gated.ts'],
    ).toBeUndefined()
    expect(fileProcessingState.promisesByPath['src/gated.ts']).toBeUndefined()
  })
})

describe('handleReadBlocks whole-file authority and block budget', () => {
  // Whole-file grants only happen when strict read-before-edit is enabled.
  function createStrictFileProcessingState(): FileProcessingState {
    return { ...createFileProcessingState(), strictReadBeforeEdit: true }
  }

  const threeLineFile = 'l1\nl2\nl3'

  it('grants sticky whole-file authorization when a window covers the whole file', async () => {
    const fileProcessingState = createStrictFileProcessingState()

    await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/full.ts', windowSize: 10, window: 1 },
      ],
      contents: { 'src/full.ts': threeLineFile },
      fileProcessingState,
    })

    expect(fileProcessingState.readAuthorizationsByPath?.['src/full.ts']).toBe(
      true,
    )
    expect(
      fileProcessingState.readAuthorizationHashesByPath?.['src/full.ts'],
    ).toBe(getContentHash(threeLineFile))
  })

  it('does not grant whole-file authorization for a sub-file window but still mints a scoped editAnchor', async () => {
    const fileProcessingState = createStrictFileProcessingState()
    const sevenLineFile = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')

    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/sub.ts', windowSize: 3, window: 2 },
      ],
      contents: { 'src/sub.ts': sevenLineFile },
      fileProcessingState,
    })

    expect(fileProcessingState.readAuthorizationsByPath?.['src/sub.ts']).toBe(
      undefined,
    )
    expect(
      fileProcessingState.readAuthorizationHashesByPath?.['src/sub.ts'],
    ).toBeUndefined()
    const item = value.results[0]!
    expect(item.editAnchor).toMatchObject({ startLine: 4, endLine: 6 })
  })

  it('grants whole-file authorization when an around block spans the whole file', async () => {
    const fileProcessingState = createStrictFileProcessingState()

    await runReadBlocks({
      selectors: [
        {
          kind: 'around',
          path: 'src/around-full.ts',
          match: 'l2',
          contextLines: 10,
        },
      ],
      contents: { 'src/around-full.ts': threeLineFile },
      fileProcessingState,
    })

    expect(
      fileProcessingState.readAuthorizationsByPath?.['src/around-full.ts'],
    ).toBe(true)
    expect(
      fileProcessingState.readAuthorizationHashesByPath?.[
        'src/around-full.ts'
      ],
    ).toBe(getContentHash(threeLineFile))
  })

  it('clears context_compacted when a whole-file-covering window grants authority', async () => {
    const fileProcessingState = createStrictFileProcessingState()
    fileProcessingState.editRereadRequirementsByPath = {
      'src/compact.ts': {
        reason: 'context_compacted',
        sourceTool: 'context compaction',
      },
    }
    fileProcessingState.failedEditRequiresReadByPath['src/compact.ts'] = true

    await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/compact.ts', windowSize: 10, window: 1 },
      ],
      contents: { 'src/compact.ts': threeLineFile },
      fileProcessingState,
    })

    expect(
      fileProcessingState.editRereadRequirementsByPath['src/compact.ts'],
    ).toBeUndefined()
  })

  it('preserves context_compacted when a sub-file window does not grant whole-file authority', async () => {
    const fileProcessingState = createStrictFileProcessingState()
    fileProcessingState.editRereadRequirementsByPath = {
      'src/compact-sub.ts': {
        reason: 'context_compacted',
        sourceTool: 'context compaction',
      },
    }
    fileProcessingState.failedEditRequiresReadByPath['src/compact-sub.ts'] =
      true
    const sevenLineFile = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')

    await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/compact-sub.ts', windowSize: 3, window: 1 },
      ],
      contents: { 'src/compact-sub.ts': sevenLineFile },
      fileProcessingState,
    })

    expect(
      fileProcessingState.editRereadRequirementsByPath['src/compact-sub.ts']
        ?.reason,
    ).toBe('context_compacted')
    expect(
      fileProcessingState.promisesByPath['src/compact-sub.ts'],
    ).toBeUndefined()
  })

  it('returns too_large with no editAnchor and no grant for an over-budget block', async () => {
    const fileProcessingState = createStrictFileProcessingState()
    fileProcessingState.failedEditRequiresReadByPath['src/big.ts'] = true
    // A handful of lines whose single window exceeds the byte budget.
    const overBudgetFile = Array.from(
      { length: 5 },
      () => 'x'.repeat(Math.ceil(MAX_READ_BLOCK_BYTES / 4)),
    ).join('\n')

    const value = await runReadBlocks({
      selectors: [
        { kind: 'window', path: 'src/big.ts', windowSize: 10, window: 1 },
      ],
      contents: { 'src/big.ts': overBudgetFile },
      fileProcessingState,
    })

    const item = value.results[0]!
    expect(item.status).toBe('error')
    expect(item.error?.code).toBe('too_large')
    expect(item.error?.recovery).toBe('read_smaller_range')
    expect(item.editAnchor).toBeUndefined()
    expect(value.summary.failed).toBe(1)
    expect(fileProcessingState.readAuthorizationsByPath?.['src/big.ts']).toBe(
      undefined,
    )
    // An over-budget block must not clear the failed-edit gate.
    expect(fileProcessingState.failedEditRequiresReadByPath['src/big.ts']).toBe(
      true,
    )
  })
})
