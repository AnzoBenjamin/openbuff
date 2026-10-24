import { describe, expect, test } from 'bun:test'

import {
  extractReceiptCore,
  SetOutputComponent,
} from '../set-output'
import { summarizeSpawnResult } from '../spawn-agents'
import { getToolRendererDisposition } from '../registry'

describe('extractReceiptCore', () => {
  test('distills a reviewer receipt: verdict, message, findings, coverage', () => {
    const core = extractReceiptCore({
      data: {
        schemaVersion: 1,
        verdict: 'LOOKS_GOOD',
        snapshotFingerprint: 'v3:9f4a551b99ee04eb',
        reviewedFiles: ['a.ts', 'b.ts'],
        findings: [],
        requirementCoverage: [
          { status: 'satisfied' },
          { status: 'satisfied' },
          { status: 'missing_evidence' },
        ],
        dimensions: {},
      },
    })
    expect(core.outcome).toBe('LOOKS_GOOD')
    expect(core.outcomeKind).toBe('good')
    expect(core.reviewedFileCount).toBe(2)
    expect(core.coverage).toEqual({ satisfied: 2, total: 3 })
    expect(core.footer).toContain('schema v1')
    expect(core.footer).toContain('fp 9f4a551b99ee')
  })

  test('distills a dependency-manager receipt: partial status with message', () => {
    const core = extractReceiptCore({
      data: {
        schemaVersion: 2,
        status: 'partial',
        message: 'verification FAILED (guard exited non-zero)',
        verification: { filesChanged: [], guards: [] },
      },
    })
    expect(core.outcome).toBe('partial')
    expect(core.outcomeKind).toBe('warn')
    expect(core.message).toContain('verification FAILED')
  })

  test('accepts a stringified data payload', () => {
    const core = extractReceiptCore({
      data: JSON.stringify({ status: 'failed', summary: 'boom' }),
    })
    expect(core.outcome).toBe('failed')
    expect(core.outcomeKind).toBe('bad')
    expect(core.message).toBe('boom')
  })

  test('caps finding titles at five and labels them', () => {
    const core = extractReceiptCore({
      data: {
        status: 'success',
        findings: [
          { title: 'one' },
          { summary: 'two' },
          'three',
          { detail: 'four' },
          { message: 'five' },
          { title: 'six' },
        ],
      },
    })
    expect(core.findings).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  test('an unrecognized envelope degrades to a neutral one-liner', () => {
    const core = extractReceiptCore({ data: { anything: 'else' } })
    expect(core.outcomeKind).toBe('neutral')
    expect(core.findings).toEqual([])
  })
})

describe('summarizeSpawnResult', () => {
  test('good verdict with summary detail', () => {
    const summary = summarizeSpawnResult({
      agentType: 'reviewer-family/dependency-reviewer@2',
      output: { verdict: 'LOOKS_GOOD', summary: 'no new packages' },
    })
    expect(summary.name).toBe('dependency-reviewer')
    expect(summary.color).toBe('success')
    expect(summary.glyph).toBe('✓')
    expect(summary.detail).toBe('no new packages')
  })

  test('receipt errors dominate: error color with the message', () => {
    const summary = summarizeSpawnResult({
      agentType: 'editor',
      agentReceipt: { status: 'failed', errors: [{ message: 'edit rejected' }] },
    })
    expect(summary.color).toBe('error')
    expect(summary.glyph).toBe('✗')
    expect(summary.detail).toBe('edit rejected')
  })

  test('no result shape degrades to a neutral agent line', () => {
    expect(summarizeSpawnResult(undefined).color).toBe('muted')
    expect(summarizeSpawnResult('junk').name).toBe('agent')
  })
})

describe('set_output rendering registration', () => {
  test('set_output has a bespoke renderer (no raw-JSON fallback)', () => {
    // The audit finding: receipts fell through to the generic fallback, which
    // stringifies the whole envelope. A registered renderer closes that path.
    expect(getToolRendererDisposition('set_output')).toBe('custom')
    expect(SetOutputComponent.toolName).toBe('set_output')
  })
})
