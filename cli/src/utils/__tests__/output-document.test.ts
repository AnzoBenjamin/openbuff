import { expect, test } from 'bun:test'
import { createJsonDocument, createTextDocument } from '../output-document'
import { collectOutputEntries, documentForTool } from '../output-catalog'

test('find and ranged reads reach line 9800 without copying the full log on navigation', () => {
  const text = Array.from({ length: 100_000 }, (_, index) =>
    index === 9799 ? 'failure E_UNIQUE' : `log ${index + 1}`,
  ).join('\n')
  const document = createTextDocument({
    id: 'large',
    title: 'Large log',
    kind: 'log',
    text,
  })
  expect(document.lineCount).toBe(100_000)
  const match = document.find('E_UNIQUE', { line: 0, character: 0 }, 1)
  expect(match).toEqual({ line: 9799, character: 8 })
  expect(document.range(match!.line, 3)).toEqual([
    'failure E_UNIQUE',
    'log 9801',
    'log 9802',
  ])
  expect(document.find('E_UNIQUE', { line: 99999, character: 0 }, -1)).toEqual(
    match,
  )
  expect(document.range(99999, 20)).toHaveLength(1)
})

test('find uses visible offsets in ANSI-colored and CRLF logs while copy retains source bytes', () => {
  const source = '\u001b[31mFAILURE\u001b[0m one\r\nFAILURE two'
  const document = createTextDocument({ id: 'colored-find', title: 'Colored log', kind: 'log', text: source })
  expect(document.find('FAILURE', { line: 0, character: 0 }, 1)).toEqual({ line: 0, character: 0 })
  expect(document.find('FAILURE', { line: 0, character: 1 }, 1)).toEqual({ line: 1, character: 0 })
  expect(document.find('one\nFAILURE', { line: 0, character: 0 }, 1)).toEqual({ line: 0, character: 8 })
  expect(document.copyLine(0)).toBe('\u001b[31mFAILURE\u001b[0m one')
})

test('repeated headings retain unique locations and ignore headings inside fenced code', () => {
  const document = createTextDocument({
    id: 'markdown',
    title: 'Repeated headings',
    kind: 'markdown',
    text: '# Repeat\n```\n# Code\n```\n# Repeat',
  })
  expect(document.landmarks.map((item) => item.line)).toEqual([0, 4])
  expect(new Set(document.landmarks.map((item) => item.id)).size).toBe(2)
})

test('JSON exposes result 251 and exact multiline scalar copy, and terminates circular references', () => {
  const records = Array.from({ length: 300 }, (_, index) => ({
    path: `src/file${index + 1}.ts`,
    value: index === 250 ? 'exact\nscalar' : 'ok',
  }))
  const document = createJsonDocument('search', 'Search', records)
  const match = document.find('file251.ts', { line: 0, character: 0 }, 1)
  expect(match).not.toBeNull()
  const scalar = document.find('exact\\nscalar', match!, 1)!
  expect(document.copyLine(scalar.line)).toBe('exact\nscalar')
  const cycle: Record<string, unknown> = { retained: 'yes' }
  cycle.self = cycle
  expect(createJsonDocument('cycle', 'Cycle', cycle).text).toContain(
    '[shared or circular reference]',
  )
})

test('catalog includes collapsed nested and offscreen retained output without executing providers or rereading files', () => {
  const entries = collectOutputEntries([
    {
      id: 'm1',
      variant: 'ai',
      content: '',
      timestamp: '',
      blocks: [
        {
          type: 'agent',
          agentId: 'a1',
          agentName: 'Reviewer',
          agentType: 'reviewer',
          status: 'complete',
          content: '',
          isCollapsed: true,
          blocks: [
            {
              type: 'tool',
              toolCallId: 't1',
              toolName: 'read_files',
              input: {},
              isCollapsed: true,
              outputRaw: [
                { type: 'json', value: { captured: 'historical data' } },
              ],
            },
          ],
        },
      ],
    },
  ])
  expect(entries.map((entry) => entry.id)).toEqual(['tool:t1'])
  expect(entries[0].read().text).toContain('historical data')
})

test('limited producer logs disclose availability and preserve captured exit evidence', () => {
  const block = {
    type: 'tool' as const,
    toolCallId: 't1',
    toolName: 'run_terminal_command' as const,
    input: { command: 'test' },
    lifecycle: 'succeeded' as const,
    outputRaw: [
      {
        type: 'json',
        value: {
          stdout: 'failure',
          exitCode: 1,
          logPersisted: true,
          logFile: '/tmp/captured.log',
        },
      },
    ],
  }
  const document = documentForTool(block)
  expect(document.availability).toBe('limited')
  expect(document.notice).toContain('exit 1')
  expect(document.notice).toContain('/tmp/captured.log')
  expect(document.line(0)).toBe('failure')
  expect(documentForTool(block)).toBe(document)
})

test('Setext headings, matching fence closures and section copying preserve retained Markdown source', () => {
  const document = createTextDocument({
    id: 'sections',
    title: 'Sections',
    kind: 'markdown',
    text: 'Title\n=====\nbody\n~~~~\n# code\n```\n# still code\n~~~~\n## Child\nchild body\n# Next\nnext body',
  })
  expect(document.landmarks.map((item) => item.label)).toEqual([
    'Title',
    'Child',
    'Next',
  ])
  expect(document.copySection?.(document.landmarks[0].id)).toBe(
    'Title\n=====\nbody\n~~~~\n# code\n```\n# still code\n~~~~\n## Child\nchild body',
  )
  expect(document.section?.(document.landmarks[1].id)).toEqual({
    start: 8,
    count: 2,
  })
})

test('long scalars and million-item array tails have lazy reader detail routes', () => {
  const scalar = 'x'.repeat(9000) + '\nSCALAR_TAIL'
  const document = createJsonDocument('scalar-detail', 'Scalar', { scalar })
  const line = document.find('long value', { line: 0, character: 0 }, 1)!.line
  const detail = document.detail!(line)!
  expect(detail.text).toBe(scalar)
  expect(detail.find('SCALAR_TAIL', { line: 0, character: 0 }, 1)).toEqual({
    line: 1,
    character: 0,
  })
  const values = new Array(1_000_000)
  values[999999] = 'ARRAY_TAIL'
  const array = createJsonDocument('array-detail', 'Large array', values)
  const ranges = array.detail!(0)!
  expect(ranges.rowCount).toBe(1000)
  const tail = ranges.detail!(999)!
  expect(tail.text).toContain('ARRAY_TAIL')
  expect(tail.title).toContain('999000…999999')
})
