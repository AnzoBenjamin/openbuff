import { describe, expect, test } from 'bun:test'

import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'

import {
  buildRuntimeAgentReceipt,
  normalizeSpawnedAgentOutput,
} from '../spawn-agent-utils'

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

/**
 * Spawn receipt-layer hardening (R1–R3):
 * - R1: one unbacked changed-file claim must not wipe the credit of OTHER
 *   receipt-backed findings.
 * - R2: buildRuntimeAgentReceipt never throws — malformed handoffs are
 *   absorbed by happy-path guards, and any residual core failure falls back
 *   to a field-complete schema-valid failed receipt.
 * - R3: edit_transaction results that existed but parsed to zero mutation
 *   receipts get an explicit diagnostic naming the unbacked claimed paths.
 */
describe('buildRuntimeAgentReceipt spawn receipt hardening', () => {
  const appliedMutationResult = (path: string, callId: string) => {
    const receiptId = `receipt-${callId}`
    const action = {
      actionId: `action-${callId}`,
      index: 0,
      action: 'update' as const,
      path,
      beforeHash: `before-${callId}`,
      afterHash: `after-${callId}`,
    }
    return {
      kind: 'file_mutation_result' as const,
      version: 1 as const,
      operationId: `operation-${callId}`,
      outcome: 'applied' as const,
      actions: [{ ...action, outcome: 'applied' as const }],
      authorityTier: 'conditional_commit' as const,
      receiptId,
      authorityReceipt: {
        kind: 'commit_receipt' as const,
        version: 1 as const,
        receiptId,
        operationId: `operation-${callId}`,
        callId,
        authorityTier: 'conditional_commit' as const,
        status: 'committed' as const,
        actions: [{ ...action, status: 'committed' as const }],
        finalHashes: { [path]: action.afterHash },
      },
      errors: [],
      freshCapabilities: [],
    }
  }

  test('credits receipt-backed findings when output overclaims other paths (R1)', () => {
    const handoff = {
      schemaVersion: 1,
      taskId: 'task-overclaim',
      role: 'repair-editor',
      objective: 'Fix the reviewed findings.',
      findings: [
        {
          id: 'F-BACKED',
          text: 'Fix the real file.',
          files: ['src/fixed.ts'],
          snapshotFingerprint: 'v3:' + 'a'.repeat(64),
        },
        {
          id: 'F-UNBACKED',
          text: 'Only claims unbacked paths.',
          files: ['src/forged.ts'],
          snapshotFingerprint: 'v3:' + 'a'.repeat(64),
        },
      ],
      permissions: {
        readablePaths: ['src/fixed.ts'],
        writablePaths: ['src/fixed.ts'],
        allowedTools: ['edit_transaction'],
      },
    } as any

    const receipt = buildRuntimeAgentReceipt({
      agentType: 'repair-editor',
      agentId: 'repair-overclaim-credit',
      handoff,
      output: {
        type: 'structuredOutput',
        value: {
          status: 'completed',
          changedFiles: ['src/fixed.ts', 'src/forged.ts'],
          findingsAddressed: ['F-BACKED', 'F-UNBACKED'],
        },
      },
      agentState: {
        messageHistory: [
          {
            role: 'tool',
            toolName: 'edit_transaction',
            toolCallId: 'call-genuine',
            content: [
              {
                type: 'json',
                value: appliedMutationResult('src/fixed.ts', 'call-genuine'),
              },
            ],
          },
        ],
      } as any,
    })

    expect(receipt.changedFiles.map((file) => file.path)).toEqual([
      'src/fixed.ts',
    ])
    expect(receipt.findingsAddressed).toEqual(['F-BACKED'])
    expect(
      receipt.errors.some((error) => error.message.includes('src/forged.ts')),
    ).toBe(true)
  })

  test('does not throw for a handoff lacking findings (R2 happy-path hardening)', () => {
    const handoff = {
      schemaVersion: 1,
      taskId: 'task-no-findings',
      role: 'editor',
      objective: 'Do the work.',
      permissions: {
        readablePaths: [],
        writablePaths: [],
        allowedTools: [],
      },
    } as any

    const receipt = buildRuntimeAgentReceipt({
      agentType: 'custom-helper',
      agentId: 'helper-no-findings',
      handoff,
      output: {
        type: 'structuredOutput',
        value: {
          status: 'completed',
          changedFiles: [],
          findingsAddressed: ['F-MISSING'],
        },
      },
    })

    // Previously `handoff.findings.find(...)` threw a TypeError when the
    // output claimed a finding id; the hardened deref absorbs it and simply
    // does not credit the missing finding.
    expect(agentReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(receipt.findingsAddressed).toEqual([])
  })

  test('does not throw for a handoff with an invalid role (R2 happy-path hardening)', () => {
    const handoff = {
      schemaVersion: 1,
      taskId: 'task-bad-role',
      role: 'not-a-real-role',
      objective: 'Do the work.',
      findings: [],
      permissions: {
        readablePaths: [],
        writablePaths: [],
        allowedTools: [],
      },
    } as any

    const receipt = buildRuntimeAgentReceipt({
      agentType: 'custom-helper',
      agentId: 'helper-bad-role',
      handoff,
      output: {
        type: 'structuredOutput',
        value: { status: 'completed' },
      },
    })

    // The invalid role must fall through to agentType inference instead of
    // failing the strict receipt parse.
    expect(agentReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(receipt.role).toBe('specialist')
  })

  test('falls back to a field-complete failed receipt when the core build throws (R2)', () => {
    const throwingOutput = new Proxy(
      {},
      {
        get() {
          throw new Error('synthetic output traversal failure')
        },
      },
    )

    const receipt = buildRuntimeAgentReceipt({
      agentType: 'custom-helper',
      agentId: 'helper-fallback',
      output: throwingOutput,
    })

    // A strict parse here proves the fallback receipt is field-complete: a
    // missing required field would throw inside the catch and reintroduce the
    // original bug.
    const parsed = agentReceiptSchema.parse(receipt)
    expect(parsed.status).toBe('failed')
    expect(parsed.taskId).toBe('spawn-helper-fallback')
    expect(parsed.changedFiles).toEqual([])
    expect(
      parsed.errors.some(
        (error) =>
          error.retryable === false &&
          error.message.includes('Receipt build failed') &&
          error.message.includes('synthetic output traversal failure'),
      ),
    ).toBe(true)
  })

  test('diagnoses zero parseable mutation receipts despite edit_transaction results (R3)', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'repair-editor',
      agentId: 'repair-zero-attestations',
      output: {
        type: 'structuredOutput',
        value: {
          status: 'completed',
          changedFiles: ['src/unbacked.ts'],
        },
      },
      agentState: {
        messageHistory: [
          {
            role: 'tool',
            toolName: 'edit_transaction',
            toolCallId: 'call-unparseable',
            content: [{ type: 'json', value: { garbage: true } }],
          },
        ],
      } as any,
    })

    const diagnostic = receipt.errors.find((error) =>
      error.message.includes('edit_transaction'),
    )
    expect(diagnostic).toBeDefined()
    expect(diagnostic?.message).toContain('src/unbacked.ts')
    expect(diagnostic?.message).toContain(
      'none yielded a parseable mutation receipt',
    )
  })
})

/**
 * Recursive scan for explicitly-undefined-valued keys — the exact shape that
 * used to kill agentReceiptSchema.parse inside buildRuntimeAgentReceipt.
 */
function hasUndefinedValuedKey(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) => hasUndefinedValuedKey(item, depth + 1))
  }
  return Object.values(value as Record<string, unknown>).some(
    (nested) =>
      nested === undefined || hasUndefinedValuedKey(nested, depth + 1),
  )
}

/**
 * Gate attestation-loop fixes on `buildRuntimeAgentReceipt`:
 * - models/runtimes can emit explicitly-undefined keys inside structured
 *   output; the receipt build used to THROW at agentReceiptSchema.parse,
 *   killing the inline spawn before its terminal receipt, so the gate saw
 *   zero structured entries.
 * - the compact reviewer attestation core must be attached as the receipt's
 *   `review` field so the gate's walker can attest even when the bulky
 *   structured result payload was truncated in transit.
 */
describe('buildRuntimeAgentReceipt output durability', () => {
  test('does not throw on an explicitly-undefined key inside structured output', () => {
    const reviewLike = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'v3:' + 'c'.repeat(64),
      coverage: 'covered',
      reviewedFiles: ['src/a.ts'],
    }
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'security-reviewer',
      agentId: 'sec-undefined-1',
      output: {
        type: 'structuredOutput',
        value: { ...reviewLike, findings: undefined },
      },
    })
    const output = receipt.output as Record<string, unknown> | undefined
    // No explicitly-undefined-valued key survived: the JSON round-trip drops
    // undefined keys, so a round-trip deep-equal to the direct value proves
    // the receipt output carried none.
    expect(hasUndefinedValuedKey(output)).toBe(false)
    expect(JSON.parse(JSON.stringify(output))).toEqual(output)
  })

  test('attaches the compact review core to the receipt for the gate walker', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'security-reviewer',
      agentId: 'sec-review-1',
      output: {
        type: 'structuredOutput',
        value: {
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          findings: [],
          coverage: 'covered',
          snapshotFingerprint: 'v3:' + 'a'.repeat(64),
          reviewedFiles: ['packages/agent-runtime/src/util/token-counter.ts'],
        },
      },
    })
    expect(receipt.review).toEqual({
      verdict: 'NON_BLOCKING',
      snapshotFingerprint: 'v3:' + 'a'.repeat(64),
      reviewedFiles: ['packages/agent-runtime/src/util/token-counter.ts'],
      coverage: 'covered',
    })
  })
})
