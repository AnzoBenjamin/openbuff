import { describe, expect, test } from 'bun:test'

import {
  getStructuredErrorMessages,
  getToolOutputValues,
  getCanonicalMutationResult,
  hasMultipartError,
  isTerminalToolBlock,
  TERMINAL_TOOL_LIFECYCLES,
} from '../tool-result-normalizer'

/**
 * First failing-mode / malformed-shape coverage for tool-result-normalizer
 * (shard-cli-tui test-coverage finding: no test file referenced this module).
 * The nested-`error` payload case below is also the false-positive regression
 * the envelope-only scan fix exists for: result DATA carrying its own `error`
 * field must not flip a successful tool to lifecycle 'failed'.
 */

describe('getStructuredErrorMessages / hasMultipartError', () => {
  test('detects a string `error` on an envelope record', () => {
    const output = [{ error: 'permission denied for /etc/passwd' }]

    expect(getStructuredErrorMessages(output)).toEqual([
      'permission denied for /etc/passwd',
    ])
    expect(hasMultipartError(output)).toBe(true)
  })

  test('detects an `error` object with a message and an errorMessage field', () => {
    expect(
      getStructuredErrorMessages([{ error: { message: 'index is empty' } }]),
    ).toEqual(['index is empty'])
    expect(getStructuredErrorMessages([{ errorMessage: 'provider timeout' }])).toEqual([
      'provider timeout',
    ])
    expect(hasMultipartError([{ errorMessage: 'provider timeout' }])).toBe(true)
  })

  test('malformed / partial shapes never throw or invent errors', () => {
    expect(getStructuredErrorMessages(undefined)).toEqual([])
    expect(getStructuredErrorMessages(null)).toEqual([])
    expect(getStructuredErrorMessages('raw string output')).toEqual([])
    expect(getStructuredErrorMessages(42)).toEqual([])
    expect(getStructuredErrorMessages([undefined, null, 'text'])).toEqual([])
    expect(getStructuredErrorMessages([{ error: null }, { error: 5 }])).toEqual([])
    expect(getStructuredErrorMessages([{ error: { message: '' } }])).toEqual([])
    expect(hasMultipartError({})).toBe(false)
    expect(hasMultipartError([{ error: { message: 17 } }])).toBe(false)
  })

  test('nested payload DATA error fields are NOT failures (false-positive regression)', () => {
    const output = [
      {
        kind: 'file_scan_result',
        value: {
          files: [
            {
              path: 'config.json',
              error: 'schema mismatch inside scanned file',
            },
          ],
          note: { errorMessage: 'nested note payload' },
        },
      },
    ]

    expect(getStructuredErrorMessages(output)).toEqual([])
    expect(hasMultipartError(output)).toBe(false)
  })
})

describe('getToolOutputValues', () => {
  test('unwraps `value`-shaped output parts and skips undefined parts', () => {
    expect(getToolOutputValues([{ value: 'a' }, undefined, 'b'])).toEqual([
      'a',
      'b',
    ])
  })
})

describe('getCanonicalMutationResult', () => {
  test('locates the canonical file_mutation_result by kind', () => {
    const output = [
      {
        kind: 'file_mutation_result',
        actions: [{ path: 'src/a.ts', outcome: 'applied' }],
      },
    ]
    const result = getCanonicalMutationResult(output)

    expect(result).not.toBeNull()
    expect(Array.isArray(result?.actions)).toBe(true)
  })

  test('a missing or malformed canonical mutation result yields null', () => {
    expect(getCanonicalMutationResult([{ kind: 'read_result' }])).toBeNull()
    expect(getCanonicalMutationResult(undefined)).toBeNull()
    expect(getCanonicalMutationResult([{ kind: null }])).toBeNull()
  })
})

describe('isTerminalToolBlock', () => {
  test('every declared terminal lifecycle is recognized', () => {
    for (const lifecycle of TERMINAL_TOOL_LIFECYCLES) {
      expect(
        isTerminalToolBlock({
          type: 'tool',
          toolCallId: 'call-1',
          toolName: 'read_files',
          input: {},
          lifecycle: lifecycle as never,
        } as never),
      ).toBe(true)
    }
  })

  test('running / queued blocks are not terminal', () => {
    expect(isTerminalToolBlock({ type: 'tool', lifecycle: 'running' } as never)).toBe(
      false,
    )
    expect(isTerminalToolBlock({ type: 'tool', lifecycle: 'queued' } as never)).toBe(
      false,
    )
  })
})
