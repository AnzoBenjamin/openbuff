import { describe, expect, test } from 'bun:test'

import { toolDisplayOutput } from '../tool-display-output'
import { summarizeStructuredPreview } from '../structured-preview'

describe('human tool display projection', () => {
  test('decodes serialized MCP text into grouped data without flattening arrays', () => {
    const display = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      content: [
        {
          type: 'text',
          text: '{"message":"Located the export","matches":[{"filePath":"a.ts"}]}',
        },
      ],
    })
    expect(display.value).toEqual({
      message: 'Located the export',
      matches: [{ filePath: 'a.ts' }],
    })
    expect(display.text).toBe('')
    expect(display.preview).toBe('Located the export')
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: [{ type: 'text', text: '[["a.ts"],["b.ts"]]' }],
      }).value,
    ).toEqual([['a.ts'], ['b.ts']])
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: [{ type: 'text', text: '[]' }],
      }).preview,
    ).toBe('No results returned')
  })

  test('omits redundant serialized structuredContent while retaining distinct evidence and prose', () => {
    const result = { matches: [{ filePath: 'a.ts', line: 2 }] }
    const duplicate = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      structuredContent: result,
      content: [
        { type: 'text', text: '{"matches":[{"line":2,"filePath":"a.ts"}]}' },
        { type: 'text', text: 'Search finished.' },
        { type: 'resource_link', name: 'Guide', uri: 'file:///guide.md' },
      ],
    })
    expect(duplicate.value).toBe(result)
    expect(duplicate.text).toBe('Search finished.\n\nGuide · file:///guide.md')
    const distinct = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      structuredContent: result,
      content: [{ type: 'text', text: '{"warnings":["Index is stale"]}' }],
    })
    expect(distinct.value).toEqual({
      result,
      additionalResults: { warnings: ['Index is stale'] },
    })
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: [{ type: 'text', text: '{unfinished' }],
      }).text,
    ).toBe('{unfinished')
  })

  test('keeps separate serialized parts and bounds parsing/deduplication work', () => {
    const display = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      content: [
        { type: 'text', text: '{"first":1}' },
        { type: 'text', text: '["second"]' },
      ],
    })
    expect(display.value).toEqual([{ first: 1 }, ['second']])
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: [{ type: 'text', text: `{"value":"${'x'.repeat(500_000)}"}` }],
      }).text,
    ).toContain('Text too large to format · Inspect')
    const wide = Array.from({ length: 5_000 }, (_, index) => index)
    const uncertain = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      structuredContent: wide,
      content: [{ type: 'text', text: JSON.stringify(wide) }],
    })
    expect(uncertain.value).toEqual({ result: wide, additionalResults: wide })
  })

  test('preserves bare collection shape and distinguishes captured emptiness', () => {
    const rows = [{ path: 'a.ts' }]
    expect(toolDisplayOutput(rows).value).toBe(rows)
    expect(toolDisplayOutput([])).toEqual({ value: [] })
    expect(summarizeStructuredPreview(toolDisplayOutput([]).value)).toBe(
      'No results returned',
    )
    expect(toolDisplayOutput(undefined)).toEqual({})
    expect(toolDisplayOutput(null)).toEqual({ value: null })
  })

  test('unwraps actual JSON transport parts without changing captured results', () => {
    const value = { version: 1, message: 'Located the export' }
    expect(toolDisplayOutput([{ type: 'json', value }])).toEqual({ value })
    expect(summarizeStructuredPreview(value)).toBe('Located the export')
    expect(summarizeStructuredPreview({ filePath: 'src/a.ts' })).toBe(
      'file path: src/a.ts',
    )
  })

  test('finds explicit summaries after a preview cap without evaluating getters', () => {
    let reads = 0
    const value = {
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`field${index}`, index]),
      ),
      get summary() {
        reads++
        return 'Do not evaluate'
      },
      message: 'Relevant files found',
    }
    expect(summarizeStructuredPreview(value)).toBe('Relevant files found')
    expect(reads).toBe(0)
  })

  test('presents MCP text and structured data without transport fields', () => {
    const value = {
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      content: [{ type: 'text', text: '## Search results\nFound the export.' }],
      structuredContent: { files: ['a.ts'] },
      _meta: { debug: 'protocol-only' },
    }
    expect(toolDisplayOutput([{ type: 'json', value }])).toEqual({
      text: '## Search results\nFound the export.',
      value: { files: ['a.ts'] },
      preview: 'files: a.ts',
    })
    expect(value._meta.debug).toBe('protocol-only')
    expect(
      toolDisplayOutput({ ...value, schemaVersion: 2 }).value,
    ).toHaveProperty('_meta')
  })

  test('retains resource identity and media availability without displaying bytes', () => {
    const display = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      content: [
        { type: 'text', text: 'Relevant notes found\nDetails follow' },
        { type: 'resource_link', name: 'Guide', uri: 'file:///guide.md' },
        {
          type: 'resource',
          resource: { uri: 'file:///notes.md', text: 'Read these notes' },
        },
        { type: 'image', mimeType: 'image/png', data: 'BASE64BYTES' },
      ],
    })
    expect(display.text).toContain('Guide · file:///guide.md')
    expect(display.text).toContain('Read these notes')
    expect(display.text).toContain('Image attached (image/png)')
    expect(display.text).not.toContain('BASE64BYTES')
    expect(display.preview).toBe('Relevant notes found')
  })

  test('bounds MCP text/part previews with an explicit inspection hint', () => {
    const display = toolDisplayOutput({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
      content: [{ type: 'text', text: 'x'.repeat(100_000) }],
    })
    expect(display.text!.length).toBeLessThan(8_100)
    expect(display.text).toContain('Preview limited · Inspect')
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: Array.from({ length: 31 }, () => ({
          type: 'text',
          text: 'part',
        })),
      }).text,
    ).toContain('Preview limited · Inspect')
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: [],
      }).text,
    ).toBe('No content returned')
  })

  test('keeps malformed serialized results readable and strips MCP terminal controls', () => {
    expect(toolDisplayOutput(undefined, '{unfinished')).toEqual({
      text: '{unfinished',
    })
    expect(
      toolDisplayOutput({
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        content: [{ type: 'text', text: '\u001b[31mReady\u001b[0m\u0000' }],
      }).text,
    ).toBe('Ready')
  })
})
