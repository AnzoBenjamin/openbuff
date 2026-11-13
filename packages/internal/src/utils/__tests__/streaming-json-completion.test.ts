import { describe, expect, test } from 'bun:test'
import { isParsableJson } from '@ai-sdk/provider-utils'

import { StreamingJsonCompletion } from '../streaming-json-completion'

describe('StreamingJsonCompletion', () => {
  test('matches JSON parsing at every fragment boundary', () => {
    const samples = [
      '',
      '  ',
      '{}',
      ' [ { "a": [1, 2, 3] } ] ',
      '{"text":"escaped \\\" } ] { \\\\ end", "nested": [true, null]}',
      '{"broken": [}',
      '{"a":',
      '{"a": 1} trailing',
      'true',
      'null',
      '123.5',
      '"a\\\"b"',
      '\ufeff{}',
    ]
    for (const sample of samples) {
      for (const size of [1, 2, 5, 31]) {
        const gate = new StreamingJsonCompletion()
        let accumulated = ''
        for (let i = 0; i < sample.length; i += size) {
          const fragment = sample.slice(i, i + size)
          accumulated += fragment
          expect(gate.isParsable(accumulated, fragment)).toBe(
            isParsableJson(accumulated),
          )
        }
        expect(gate.isParsable(accumulated, '')).toBe(
          isParsableJson(accumulated),
        )
      }
    }
  })

  test('exposes zero unmatched container depth for scalar and complete input', () => {
    // Scalar streams never enter container mode; a completed object drops
    // back to depth 0 once it canonicalizes in parse mode.
    for (const sample of ['plain text', 'true', 'null', '123.5', '{}']) {
      const gate = new StreamingJsonCompletion()
      expect(gate.unmatchedContainerDepth).toBe(0)
      for (let i = 0; i < sample.length; i++) {
        gate.isParsable(sample.slice(0, i + 1), sample[i])
      }
      expect(gate.unmatchedContainerDepth).toBe(0)
    }
  })

  test('exposes the unmatched container depth of a truncated argument stream', () => {
    // An incomplete argument stream (blocked from canonicalizing because
    // isParsableJson keeps returning false) is still inside its outermost
    // container: the depth counts the open `{`/`[` and drives callers that
    // route continuation suffixes to the call the text can belong to.
    const gate = new StreamingJsonCompletion(() => false)
    expect(gate.unmatchedContainerDepth).toBe(0)
    gate.isParsable('', '{"a": [')
    expect(gate.unmatchedContainerDepth).toBe(2)
    gate.isParsable('{"a": [', ' {"replacements":')
    expect(gate.unmatchedContainerDepth).toBe(3)
    gate.isParsable('{"a": [ {"replacements": []}', ']}')
    expect(gate.unmatchedContainerDepth).toBe(1)
  })

  test('exposes the unmatched container depth of a truncated second value via unmatchedDepthAfterClose', () => {
    // The never-latched counter keeps tracking `{`/`[` nesting after the
    // up-front mode latch has canonicalized the FIRST serialized value, so a
    // merged argument body `{...} {...}` whose second value is still open is
    // still distinguishable from an ambiguous target (reliability finding
    // streaming-json-completion-mode-latch-drops-container-tracking-across-fragments).
    const gate = new StreamingJsonCompletion(() => false)
    gate.isParsable('', '{"a": 1}')
    // First value closed: the standard counter and the latched counter both
    // drop to 0, and mode latches to 'parse'.
    expect(gate.unmatchedContainerDepth).toBe(0)
    expect(gate.unmatchedDepthAfterClose).toBe(0)

    gate.isParsable('{"a": 1}', ' {"replacements":')
    // The SECOND serialized value is unclosed: the never-latched counter
    // catches it even though the standard counter is latched at 0.
    expect(gate.unmatchedContainerDepth).toBe(0)
    expect(gate.unmatchedDepthAfterClose).toBe(1)
  })

  test('matched braces of a second value keep both counters consistent', () => {
    const gate = new StreamingJsonCompletion(() => false)
    gate.isParsable('', '{"a": 1} {"b": 2}')
    expect(gate.unmatchedContainerDepth).toBe(0)
    expect(gate.unmatchedDepthAfterClose).toBe(0)
  })

  test('only invokes the parser once for a fragmented large object', () => {
    let parseCalls = 0
    const gate = new StreamingJsonCompletion((input) => {
      parseCalls++
      return isParsableJson(input)
    })
    const input = JSON.stringify({ content: 'a'.repeat(128 * 1024) })
    let accumulated = ''
    for (let i = 0; i < input.length; i += 64) {
      const fragment = input.slice(i, i + 64)
      accumulated += fragment
      expect(gate.isParsable(accumulated, fragment)).toBe(
        i + 64 >= input.length,
      )
    }
    expect(parseCalls).toBe(1)
  })
})
