import { describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'

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
 * PR-T2 (D20) Part A: `lastMessage`-mode children often return one logical
 * answer split into dozens of token-sized assistant messages; the fragment
 * merge collapses unambiguous text-only assistant runs into one message so
 * compaction stops reporting 100+ omittedItems and clipping the answer.
 */
describe('normalizeSpawnedAgentOutput lastMessage fragment merge', () => {
  const fragments = (...texts: string[]) => ({
    type: 'lastMessage',
    value: texts.map((text) => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
    })),
  })

  test('merges multiple text-only assistant fragments into one message', () => {
    const normalized = normalizeSpawnedAgentOutput(
      fragments('Part one.', 'Part two.', 'Part three.'),
      'researcher-web',
    )
    expect(normalized).toEqual({
      type: 'lastMessage',
      value: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part one.\n\nPart two.\n\nPart three.' },
          ],
        },
      ],
    })
  })

  test('ignores extra message fields such as tags when merging', () => {
    const normalized = normalizeSpawnedAgentOutput(
      {
        type: 'lastMessage',
        value: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First' }],
            tags: ['SUBAGENT'],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Second' }],
            tags: ['SUBAGENT'],
          },
        ],
      },
      'researcher-web',
    )
    expect(normalized).toEqual({
      type: 'lastMessage',
      value: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'First\n\nSecond' }],
        },
      ],
    })
  })

  test('leaves a single-message lastMessage unchanged (no merge)', () => {
    const normalized = normalizeSpawnedAgentOutput(
      fragments('only fragment'),
      'researcher-web',
    ) as any
    expect(Array.isArray(normalized.value)).toBe(true)
    expect(normalized.value).toHaveLength(1)
    expect(normalized.value[0].content).toEqual([
      { type: 'text', text: 'only fragment' },
    ])
  })

  test('returns a mixed-role fragment list unchanged', () => {
    const input = {
      type: 'lastMessage',
      value: [
        { role: 'user', content: [{ type: 'text', text: 'question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      ],
    }
    expect(normalizeSpawnedAgentOutput(input, 'researcher-web')).toEqual(input)
  })

  test('returns a fragment list with non-text content parts unchanged', () => {
    const input = {
      type: 'lastMessage',
      value: [
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'b' },
            { type: 'image', image: 'x' },
          ],
        },
      ],
    }
    expect(normalizeSpawnedAgentOutput(input, 'researcher-web')).toEqual(input)
  })

  test('returns a lastMessage with a non-array value unchanged', () => {
    const input = { type: 'lastMessage', value: 'plain text' }
    expect(normalizeSpawnedAgentOutput(input, 'researcher-web')).toEqual(input)
  })

  test('never mutates the input', () => {
    const input = fragments('one', 'two') as Record<string, unknown>
    const snapshot = JSON.parse(JSON.stringify(input))
    normalizeSpawnedAgentOutput(input, 'researcher-web')
    expect(input).toEqual(snapshot)
  })
})

/**
 * PR-T2 (D20) Part B: when the parent-visible shape must fall back to a
 * truncated receipt, the FULL serialized child output is additionally
 * persisted to a content-addressed scratch file and referenced via additive
 * artifactPath/artifactBytes/artifact fields. Best-effort: when the tmp
 * directory is unwritable the fields are omitted entirely and the receipt
 * shape stays unchanged.
 */
describe('normalizeSpawnedAgentOutput oversize artifact persistence', () => {
  const oversizeFindings = (count: number) =>
    Array.from({ length: count }, () => 'f'.repeat(4_000))

  test('persists the full oversize output to a content-addressed artifact file', () => {
    const findings = oversizeFindings(100)
    const normalized = normalizeSpawnedAgentOutput(
      { findings },
      'security-reviewer',
    ) as any
    expect(normalized.type).toBe('agentReceipt')
    expect(normalized.truncated).toBe(true)
    expect(typeof normalized.artifactPath).toBe('string')
    expect(normalized.artifact).toBe(
      'Full untruncated output persisted; read with read_files.',
    )
    expect(normalized.artifactBytes).toBeGreaterThan(256_000)
    // The persisted artifact round-trips: for this payload compaction is
    // lossless (control-plane arrays are preserved and each 4000-char string
    // sits exactly at the per-string cap), so the file holds the full output.
    const persisted = JSON.parse(readFileSync(normalized.artifactPath, 'utf8'))
    expect(persisted).toEqual({ findings })
  })

  test('persists the artifact with owner-only 0o600 permissions', () => {
    // Unique payload so this test mints a FRESH artifact file: writeFileSync's
    // mode option only applies at file creation (an open-with-truncate on an
    // existing file keeps its old permissions), so asserting on a reused
    // content-addressed path could read a stale pre-hardening artifact.
    const findings = [
      ...oversizeFindings(100),
      `perms-probe-${Date.now()}-${Math.random()}`,
    ]
    const normalized = normalizeSpawnedAgentOutput(
      { findings },
      'security-reviewer',
    ) as any
    expect(typeof normalized.artifactPath).toBe('string')
    // Owner-only read/write regardless of the process umask: the artifact
    // holds the FULL untruncated child output in a shared tmp directory.
    const mode = statSync(normalized.artifactPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('sweeps artifacts older than the 24h retention TTL on persist', () => {
    const dir = join(osTmpdir(), 'openbuff-spawn-output')
    mkdirSync(dir, { recursive: true })
    // Pre-clean the shared scratch dir so the probe sits within the first 50
    // entries the capped sweep inspects (artifacts from earlier runs would
    // otherwise push the probe past the sweep window and make this test
    // order-dependent).
    try {
      for (const entry of readdirSync(dir)) {
        try {
          rmSync(join(dir, entry), { force: true })
        } catch {
          // Best-effort cleanup only.
        }
      }
    } catch {
      // Best-effort cleanup only.
    }
    // An artifact written 25h ago (past the 24h TTL) must be deleted by the
    // next persist's best-effort TTL sweep.
    const stalePath = join(dir, 'stale-artifact-probe.json')
    writeFileSync(stalePath, '{}')
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(stalePath, twentyFiveHoursAgo, twentyFiveHoursAgo)

    const normalized = normalizeSpawnedAgentOutput(
      { findings: oversizeFindings(100) },
      'security-reviewer',
    ) as any
    expect(typeof normalized.artifactPath).toBe('string')
    expect(statSync(normalized.artifactPath).isFile()).toBe(true)
    // The stale artifact was swept; the fresh one survives.
    expect(() => statSync(stalePath)).toThrow()
  })

  test('content-addresses the artifact deterministically', () => {
    const findings = oversizeFindings(100)
    const first = normalizeSpawnedAgentOutput(
      { findings },
      'security-reviewer',
    ) as any
    const second = normalizeSpawnedAgentOutput(
      { findings },
      'security-reviewer',
    ) as any
    expect(first.artifactPath).toBe(second.artifactPath)
  })

  test('adds artifact fields to the reviewer verdict-shaped fast path when it truncates', () => {
    const findings = oversizeFindings(70)
    const normalized = normalizeSpawnedAgentOutput(
      {
        schemaVersion: 1,
        verdict: 'LOOKS_GOOD',
        snapshotFingerprint: 'v3:' + 'e'.repeat(64),
        coverage: 'covered',
        reviewedFiles: ['src/a.ts'],
        findings,
      },
      'security-reviewer',
    ) as any
    // The verdict-shaped fast path replaced the bulky payload with the trimmed
    // shape; the artifact pointer still travels at the top level.
    expect(normalized.value.verdict).toBe('LOOKS_GOOD')
    expect(typeof normalized.artifactPath).toBe('string')
    expect(normalized.artifact).toBe(
      'Full untruncated output persisted; read with read_files.',
    )
    expect(normalized.artifactBytes).toBeGreaterThan(256_000)
  })

  test('leaves the non-oversize path free of artifact fields', () => {
    const normalized = normalizeSpawnedAgentOutput(
      { status: 'completed', summary: 'done' },
      'researcher-web',
    ) as any
    expect('artifactPath' in normalized).toBe(false)
    expect('artifactBytes' in normalized).toBe(false)
    expect('artifact' in normalized).toBe(false)
  })

  test('omits the artifact fields entirely when tmp persistence fails', () => {
    // Point TMPDIR at a regular FILE: mkdirSync under it fails with ENOTDIR on
    // every POSIX runner (root included), exercising the never-throw path.
    const scratchDir = mkdtempSync(join(osTmpdir(), 'openbuff-artifact-probe-'))
    const blockerFile = join(scratchDir, 'blocker')
    writeFileSync(blockerFile, 'regular file, not a directory')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = blockerFile
    try {
      const normalized = normalizeSpawnedAgentOutput(
        { findings: oversizeFindings(100) },
        'security-reviewer',
      ) as any
      expect(normalized.type).toBe('agentReceipt')
      expect(normalized.truncated).toBe(true)
      expect(normalized.artifactPath).toBeUndefined()
      expect(normalized.artifactBytes).toBeUndefined()
      expect(normalized.artifact).toBeUndefined()
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR
      } else {
        process.env.TMPDIR = previousTmpdir
      }
      rmSync(scratchDir, { recursive: true, force: true })
    }
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

/**
 * D19/PR-T1: typed handoff `outcome` on the runtime spawn receipt, derived
 * inside `buildRuntimeAgentReceiptOrThrow` from runtime evidence with
 * precedence crashed > missing_output > schema_invalid > truncated > ok, plus
 * the fail-closed D24 downgrade: a non-ok outcome (except `truncated`) must
 * never resolve to `completed` unless runtime-attested mutations are the
 * completion authority (RF-2), with exactly one diagnostic error appended.
 */
describe('buildRuntimeAgentReceipt typed handoff outcome', () => {
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

  test('downgrades a missing child output to partial with outcome missing_output (D24 regression)', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a1',
      output: undefined,
    })
    // Previously this resolved to 'completed' with zero errors — the D24
    // fail-open this test pins shut.
    expect(receipt.status).toBe('partial')
    expect(receipt.outcome).toBe('missing_output')
    expect(receipt.errors).toEqual([
      {
        message:
          "researcher-web receipt outcome 'missing_output': researcher-web ended without calling set_output",
        retryable: true,
      },
    ])
    expect(receipt.output).toEqual({
      summary: '',
      partial: true,
      errorMessage: 'researcher-web ended without calling set_output',
    })
  })

  test('records schema_invalid from a stale lastSetOutputError and downgrades to partial', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a-schema-invalid',
      output: { type: 'structuredOutput', value: { answer: 'x' } },
      agentState: {
        messageHistory: [],
        lastSetOutputError: 'Missing required fields: status',
      } as any,
    })
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toEqual([
      {
        message:
          "researcher-web receipt outcome 'schema_invalid': Missing required fields: status",
        retryable: true,
      },
    ])
  })

  test('keeps a truncated reviewer receipt at its resolved status (no downgrade)', () => {
    const fingerprint = 'v3:' + 'd'.repeat(64)
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
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'security-reviewer',
      agentId: 'a-truncated',
      output: {
        nested: {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          status: 'completed',
          snapshotFingerprint: fingerprint,
          coverage: 'covered',
          reviewedFiles: ['src/a.ts'],
          ...payload,
        },
      },
    })
    // `truncated` records the outcome without downgrading: a completing
    // reviewer receipt keeps its resolved status.
    expect(receipt.outcome).toBe('truncated')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
  })

  test('marks a degrade-envelope crash as crashed and partial with a non-retryable error', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'thinker',
      agentId: 'a-crash-envelope',
      output: { type: 'error', message: 'Subagent thinker crashed: boom' },
    })
    expect(receipt.outcome).toBe('crashed')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toEqual([
      {
        message: "thinker receipt outcome 'crashed': Subagent thinker crashed: boom",
        retryable: false,
      },
    ])
  })

  test('records crashed for a params.error run without duplicating the crash error', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'thinker',
      agentId: 'a-crash-error',
      output: undefined,
      error: new Error('boom'),
    })
    expect(receipt.outcome).toBe('crashed')
    expect(receipt.status).toBe('failed')
    // Exactly one crash error: the params.error entry, no duplicate downgrade
    // diagnostic appended on top of it.
    expect(receipt.errors).toEqual([{ message: 'boom', retryable: false }])
  })

  test('keeps outcome ok with completed status for a normal structured output', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a-ok',
      output: {
        type: 'structuredOutput',
        value: { status: 'completed', summary: 'done' },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
  })

  test('mutation authority keeps a mutation agent completed despite missing_output', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'editor',
      agentId: 'a-editor-missing-output',
      output: undefined,
      agentState: {
        messageHistory: [
          {
            role: 'tool',
            toolName: 'edit_transaction',
            toolCallId: 'call-applied',
            content: [
              {
                type: 'json',
                value: appliedMutationResult('src/edited.ts', 'call-applied'),
              },
            ],
          },
        ],
      } as any,
    })
    // RF-2: runtime-attested mutations stay the completion authority, so the
    // receipt is completed while still recording the missing child output.
    expect(receipt.status).toBe('completed')
    expect(receipt.outcome).toBe('missing_output')
    expect(receipt.errors).toEqual([])
    expect(receipt.changedFiles.map((file) => file.path)).toEqual([
      'src/edited.ts',
    ])
  })

  test('a child self-declared completed status does not rescue a schema_invalid run', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a-self-declared',
      output: { nested: { status: 'completed' } },
      agentState: {
        messageHistory: [],
        lastSetOutputError: 'Missing required fields: answer',
      } as any,
    })
    // findReceiptStatus would credit the nested self-declared 'completed'; the
    // outcome-derived downgrade must override it.
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toEqual([
      {
        message:
          "researcher-web receipt outcome 'schema_invalid': Missing required fields: answer",
        retryable: true,
      },
    ])
  })

  test('agentReceiptSchema accepts outcome and legacy receipts without it', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a-schema-field',
      output: {
        type: 'structuredOutput',
        value: { status: 'completed', summary: 'done' },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(agentReceiptSchema.parse({ ...receipt, outcome: 'ok' }).outcome).toBe(
      'ok',
    )
    // Legacy receipts without the additive field keep parsing under .strict().
    const legacy: Record<string, unknown> = { ...receipt }
    delete legacy.outcome
    expect(agentReceiptSchema.parse(legacy).outcome).toBeUndefined()
  })

  // PR-T1 supervised-outcome threading: the supervised error envelope's
  // structured `supervisedOutcome` field is honored by the outcome derivation
  // so a non-crash supervised settle keeps its PR-T1 classification instead of
  // collapsing into a non-retryable 'crashed'.
  test('honors supervisedOutcome missing_output as retryable, not crashed', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'thinker',
      agentId: 'a-sup-missing',
      output: {
        type: 'error',
        message:
          'Subagent thinker crashed: supervised child produced no receipt (missing_output)',
        supervisedOutcome: 'missing_output',
      },
    } as any)
    // Previously this collapsed into outcome 'crashed' with retryable:false,
    // bypassing the PR-T1 precedence.
    expect(receipt.outcome).toBe('missing_output')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toEqual([
      {
        message:
          "thinker receipt outcome 'missing_output': thinker ended without calling set_output",
        retryable: true,
      },
    ])
  })

  test('honors supervisedOutcome schema_invalid as retryable with the settle detail', () => {
    const settleMessage =
      'Subagent thinker crashed: supervised receipt failed agentReceiptSchema (schema_invalid): stderr tail'
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'thinker',
      agentId: 'a-sup-schema',
      output: {
        type: 'error',
        message: settleMessage,
        supervisedOutcome: 'schema_invalid',
      },
    } as any)
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.status).toBe('partial')
    // No lastSetOutputError exists on the supervised path, so the diagnostic
    // falls back to the crash-envelope message that carries the settle detail.
    expect(receipt.errors).toEqual([
      {
        message: `thinker receipt outcome 'schema_invalid': ${settleMessage}`,
        retryable: true,
      },
    ])
  })

  test('honors supervisedOutcome truncated without downgrading the status', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a-sup-truncated',
      output: {
        type: 'error',
        message:
          "Subagent researcher-web crashed: supervised receipt exceeded the supervisor's 8 MiB stdout capture cap (truncated)",
        supervisedOutcome: 'truncated',
      },
    } as any)
    // `truncated` records the outcome without the D24 downgrade and without
    // appending a diagnostic error.
    expect(receipt.outcome).toBe('truncated')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
  })

  test('a genuine params.error crash still wins over a supervisedOutcome field', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'thinker',
      agentId: 'a-sup-crash-wins',
      output: {
        type: 'error',
        message: 'Subagent thinker crashed: supervised settle',
        supervisedOutcome: 'missing_output',
      },
      error: new Error('genuine crash'),
    } as any)
    // The risk guard: the crash path is unchanged when params.error exists.
    expect(receipt.outcome).toBe('crashed')
    expect(receipt.status).toBe('failed')
    expect(receipt.errors).toEqual([{ message: 'genuine crash', retryable: false }])
  })

  test('downgrades a round-tripped empty-output placeholder to partial with outcome missing_output', () => {
    // A null child output normalized parent-side (or across the supervision
    // bridge) arrives as the empty placeholder; previously its outcome read
    // 'ok' and the final fallback resolved 'completed' — completed-with-null.
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'file-picker',
      agentId: 'fp-empty-placeholder',
      output: {
        summary: '',
        partial: true,
        errorMessage: 'file-picker ended without calling set_output',
      },
    })
    expect(receipt.outcome).toBe('missing_output')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toEqual([
      {
        message:
          "file-picker receipt outcome 'missing_output': file-picker ended without calling set_output",
        retryable: true,
      },
    ])
  })

  test('downgrades a blank lastMessage settle to partial with outcome missing_output', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'file-picker',
      agentId: 'fp-blank-last-message',
      output: {
        type: 'lastMessage',
        value: [{ role: 'assistant', content: [{ type: 'text', text: '   ' }] }],
      },
    })
    expect(receipt.outcome).toBe('missing_output')
    expect(receipt.status).toBe('partial')
    expect(
      receipt.errors.some(
        (error) =>
          error.retryable === true && error.message.includes('set_output'),
      ),
    ).toBe(true)
  })

  test('keeps a real set_output value from being downgraded by an empty output envelope', () => {
    // The empty-output guard keys on the child state having no set_output
    // value and no harvested answer; a state-backed output is authoritative.
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'file-picker',
      agentId: 'fp-real-output',
      output: {
        summary: '',
        partial: true,
        errorMessage: 'stale envelope',
      },
      agentState: {
        messageHistory: [],
        output: { summary: 'real answer' },
      } as any,
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
  })
})
