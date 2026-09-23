import { describe, expect, test } from 'bun:test'

import { normalizeSpawnedAgentOutput } from '../spawn-agent-utils'

/**
 * Direct coverage for the M0-T3 sub-agent output durability contract on
 * `normalizeSpawnedAgentOutput`: a child that ended without set_output (or
 * with an empty/blank value) must surface an explicit partial diagnostic
 * marker instead of an undefined/null/empty value, and a run-level error
 * output must keep its errorMessage while gaining an explicit `partial: true`.
 */
describe('normalizeSpawnedAgentOutput missing-output durability', () => {
  test('maps missing/blank final output to an explicit partial diagnostic marker', () => {
    for (const missing of [undefined, null, '', '   ']) {
      const normalized = normalizeSpawnedAgentOutput(missing, 'test-writer')
      expect(normalized).toEqual({
        summary: '',
        partial: true,
        errorMessage: 'test-writer ended without calling set_output',
      })
    }
  })

  test('uses a generic agent label when agentType is not provided', () => {
    const normalized = normalizeSpawnedAgentOutput(undefined)
    expect(normalized.partial).toBe(true)
    expect(normalized.summary).toBe('')
    expect(normalized.errorMessage).toBe(
      'subagent ended without calling set_output',
    )
  })

  test('keeps the errorMessage for a run-level error output and marks it partial', () => {
    const normalized = normalizeSpawnedAgentOutput(
      { type: 'error', message: 'child crashed before producing output' },
      'test-writer',
    )
    expect(normalized).toEqual({
      errorMessage: 'child crashed before producing output',
      partial: true,
    })
  })

  test('keeps the fallback errorMessage for an empty run-level error message', () => {
    const normalized = normalizeSpawnedAgentOutput(
      { type: 'error', message: '   ' },
      'test-writer',
    )
    expect(normalized).toEqual({
      errorMessage: 'Subagent failed before producing output',
      partial: true,
    })
  })

  test('leaves real structured output untouched (no partial marker)', () => {
    const normalized = normalizeSpawnedAgentOutput(
      { type: 'structuredOutput', value: { status: 'completed' } },
      'test-writer',
    )
    expect(normalized.partial).toBeUndefined()
    expect(normalized.value).toEqual({ status: 'completed' })
  })

  // Gate-crash fix: the lossy fallbacks must never destroy the reviewer
  // attestation core — without it the gate's walker finds zero structured
  // entries and parks the run on "did not return the required structured
  // snapshot attestation" despite a complete review.
  test('preserves the attestation core through the oversize summary fallback', () => {
    const fingerprint = 'v3:' + 'b'.repeat(64)
    const big = 'x'.repeat(33_000)
    const payload: Record<string, string> = {}
    for (const field of [
      'text',
      'message',
      'summary',
      'answer',
      'report',
      'digest',
      'stdout',
      'stderr',
    ]) {
      payload[field] = big
    }
    // The review is nested one level below the surface so the oversize
    // fallback's verdict-shaped fast path does NOT apply — this is the
    // destructive `{ type: 'agentReceipt', summary }` branch.
    const normalized = normalizeSpawnedAgentOutput(
      {
        nested: {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: fingerprint,
          coverage: 'covered',
          reviewedFiles: ['src/a.ts'],
          ...payload,
        },
      },
      'security-reviewer',
    ) as any
    expect(normalized.type).toBe('agentReceipt')
    expect(normalized.truncated).toBe(true)
    expect(normalized.verdict).toBe('LOOKS_GOOD')
    expect(normalized.snapshotFingerprint).toBe(fingerprint)
    expect(normalized.reviewedFiles).toEqual(['src/a.ts'])
  })

  test('preserves the attestation core through the depth-collapse fallback', () => {
    let deep: any = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'v3:' + 'a'.repeat(64),
      coverage: 'covered',
      reviewedFiles: ['src/a.ts'],
    }
    for (let i = 0; i < 9; i += 1) deep = { nested: deep }
    const normalized = normalizeSpawnedAgentOutput(
      deep,
      'security-reviewer',
    ) as any
    // The depth-7 collapse fires seven `nested` wrappers down; walk to the
    // collapsed node instead of hard-coding its depth.
    let collapsed: any = normalized
    for (let i = 0; i < 12 && collapsed?.truncated !== true; i += 1) {
      collapsed = collapsed?.nested
    }
    expect(collapsed?.truncated).toBe(true)
    expect(collapsed.type).toBe('truncatedNestedAgentOutput')
    expect(collapsed.verdict).toBe('LOOKS_GOOD')
    expect(collapsed.snapshotFingerprint).toBe('v3:' + 'a'.repeat(64))
    expect(collapsed.reviewedFiles).toEqual(['src/a.ts'])
  })
})
