import { describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import {
  chmodSync,
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
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { isReceiptShape } from '@codebuff/common/util/model-payload-recovery'

import {
  buildRuntimeAgentReceipt,
  executeSubagent,
  finalizeOwnedLibrarianClone,
  normalizeSpawnedAgentOutput,
} from '../spawn-agent-utils'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'

// `mock.module` is registry-wide across Bun's shared test workers. Snapshot
// every real export before the test-local override so sibling suites never see
// a lossy replacement of run-agent-step.
const realRunAgentStep = { ...(await import('../../../../run-agent-step')) }

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

  test('bounds the attestation-core findings on the oversize summary fallback', () => {
    const fingerprint = 'v3:' + 'f'.repeat(64)
    const rawFindings = Array.from({ length: 200 }, (_, index) => ({
      id: `F-${index}`,
      detail: 'd'.repeat(20_000),
    }))
    const normalized = normalizeSpawnedAgentOutput(
      {
        nested: {
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: fingerprint,
          coverage: 'covered',
          reviewedFiles: ['src/a.ts'],
          findings: rawFindings,
        },
      },
      'security-reviewer',
    ) as any
    expect(normalized.type).toBe('agentReceipt')
    expect(normalized.truncated).toBe(true)
    expect(normalized.verdict).toBe('LOOKS_GOOD')
    expect(normalized.snapshotFingerprint).toBe(fingerprint)
    // The raw (uncompacted) findings array used to be spread into the
    // fallback receipt verbatim — megabytes past the 256k bound.
    expect(Array.isArray(normalized.findings)).toBe(true)
    expect(normalized.findings.length).toBeLessThanOrEqual(48)
    for (const finding of normalized.findings) {
      expect(typeof finding.detail).toBe('string')
      expect(finding.detail.length).toBeLessThanOrEqual(4_000)
    }
    // The whole parent-visible receipt stays within the module's max-chars
    // bound.
    expect(JSON.stringify(normalized).length).toBeLessThanOrEqual(256_000)
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
    // collapsed node instead of hard-coding its depth. The walk keys on the
    // collapsed node's own type, NOT on `truncated: true`: the envelope ROOT
    // now carries that flag too (any clipping is reported honestly at the
    // root), so a `truncated`-keyed walk would stop at the root.
    let collapsed: any = normalized
    for (
      let i = 0;
      i < 12 && collapsed?.type !== 'truncatedNestedAgentOutput';
      i += 1
    ) {
      collapsed = collapsed?.nested
    }
    expect(collapsed?.truncated).toBe(true)
    expect(collapsed.type).toBe('truncatedNestedAgentOutput')
    // The root itself reports the clipping (so the D19 classifier sees it
    // instead of calling a clipped result `ok`) and points at the full
    // payload for recovery.
    expect(normalized.truncated).toBe(true)
    expect(typeof normalized.artifactPath).toBe('string')
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

  test('recreates the artifact directory when it is removed externally between persists', () => {
    // reliability-reviewer: oversize-artifact-dir-flag-never-reset — the
    // module-scope ensured-dir cache must not let one external removal (or a
    // raced mkdir) permanently break every later persist.
    const dir = join(osTmpdir(), 'openbuff-spawn-output')
    const payload = { findings: oversizeFindings(100) }
    // First persist ensures the directory and warms the module-scope cache.
    const first = normalizeSpawnedAgentOutput(
      payload,
      'security-reviewer',
    ) as any
    expect(typeof first.artifactPath).toBe('string')
    expect(statSync(first.artifactPath).isFile()).toBe(true)

    // External (or raced) removal of the artifact directory between calls.
    rmSync(dir, { recursive: true, force: true })

    // The next persist must end up re-running mkdir (via cache invalidation
    // on the failed write attempt) and still produce the recovery artifact
    // instead of a permanent artifactError.
    const second = normalizeSpawnedAgentOutput(
      payload,
      'security-reviewer',
    ) as any
    expect(second.artifactPersisted).toBeUndefined()
    expect(second.artifactError).toBeUndefined()
    expect(typeof second.artifactPath).toBe('string')
    expect(statSync(second.artifactPath).isFile()).toBe(true)
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

  test('adds an explicit artifactError diagnostic when persistence fails', () => {
    // Point TMPDIR at a regular FILE: mkdirSync under it fails with ENOTDIR on
    // every POSIX runner (root included). The failure must not be silent: the
    // receipt carries artifactPersisted:false + artifactError so the parent
    // knows the payload is no longer fully recoverable via read_files.
    const scratchDir = mkdtempSync(join(osTmpdir(), 'openbuff-artifact-err-'))
    const blockerFile = join(scratchDir, 'blocker')
    writeFileSync(blockerFile, 'regular file, not a directory')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = blockerFile
    try {
      const normalized = normalizeSpawnedAgentOutput(
        { findings: oversizeFindings(100) },
        'security-reviewer',
      ) as any
      expect(normalized.artifactPersisted).toBe(false)
      expect(typeof normalized.artifactError).toBe('string')
      expect(normalized.artifactError).toContain('NOT be persisted')
      expect(normalized.artifactError).toContain('not fully recoverable')
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR
      } else {
        process.env.TMPDIR = previousTmpdir
      }
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  test('does not collapse a non-reviewer oversize receipt to review-shaped value fields', () => {
    // The review-shaped fast path keeps ONLY the fixed reviewer receipt
    // fields, so it must not fire for a non-reviewer agent whose payload
    // happens to carry a requirementCoverage array — its other fields (here:
    // status + summary + answer) must stay visible in the generic truncated
    // agentReceipt fallback instead of being dropped.
    const requirementCoverage = Array.from({ length: 60 }, (_, index) => ({
      id: `R-${index}`,
      covered: true,
      evidence: ['e'.repeat(6_000)],
    }))
    const normalized = normalizeSpawnedAgentOutput(
      {
        type: 'structuredOutput',
        value: {
          status: 'completed',
          summary: 'x'.repeat(4_000),
          answer: 'y'.repeat(34_000),
          requirementCoverage,
        },
      },
      'repair-editor',
    ) as any
    expect(normalized.type).toBe('agentReceipt')
    expect(normalized.truncated).toBe(true)
    expect(normalized.agentType).toBe('repair-editor')
    expect('value' in normalized).toBe(false)
    expect(typeof normalized.summary).toBe('string')
    expect(normalized.summary.length).toBeGreaterThan(0)
    // Data is still durably recoverable via the artifact.
    expect(typeof normalized.artifactPath).toBe('string')
    const persisted = JSON.parse(readFileSync(normalized.artifactPath, 'utf8'))
    expect(persisted.value.requirementCoverage).toHaveLength(60)
    expect(persisted.value.status).toBe('completed')
    expect(persisted.value.answer).toBe('y'.repeat(34_000))
  })

  test('still uses the review-shaped fast path for reviewer-family oversize payloads', () => {
    const findings = oversizeFindings(70)
    const normalized = normalizeSpawnedAgentOutput(
      {
        type: 'structuredOutput',
        value: {
          family: 'reviewer',
          schemaVersion: 1,
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + '9'.repeat(64),
          coverage: 'covered',
          reviewedFiles: ['src/a.ts'],
          findings,
        },
      },
      'custom-specialist',
    ) as any
    // family: 'reviewer' alone routes the payload through the fixed-field
    // collapse even when agentType does not match *reviewer*.
    expect(normalized.value.verdict).toBe('LOOKS_GOOD')
    expect(typeof normalized.artifactPath).toBe('string')
  })
})

/**
 * Clipped-but-not-oversize recovery: the COMMON truncation case is a child
 * whose payload fits the 256k whole-payload budget yet still lost content to
 * leaf compaction — a 40k–250k payload, or a single `message`/`summary` leaf
 * past the 32k high-fidelity cap. That case used to return a clipped fragment
 * with NO artifactPath and no root truncation flag, so the orchestrator could
 * neither read the full output back nor tell the result had been cut (the D19
 * classifier only inspects the ROOT, so it reported `outcome: 'ok'`).
 */
describe('normalizeSpawnedAgentOutput clipped non-oversize recovery', () => {
  const clippedPayload = () => ({
    type: 'structuredOutput',
    value: { status: 'completed', message: 'm'.repeat(40_000) },
  })

  test('persists the full payload and flags truncation at the root when a leaf is clipped under the size bound', () => {
    const payload = clippedPayload()
    // Pin the regime: the serialized payload is far below the 256k bound (so
    // the historical size-gated artifact path never fired) while the
    // high-fidelity `message` leaf exceeds its 32k cap (so content IS lost).
    expect(JSON.stringify(payload).length).toBeLessThan(256_000)

    const normalized = normalizeSpawnedAgentOutput(payload, 'researcher-web') as any
    expect(normalized.truncated).toBe(true)
    expect(normalized.truncation.omittedChars).toBeGreaterThan(0)
    expect(typeof normalized.artifactPath).toBe('string')
    expect(normalized.artifact).toBe(
      'Full untruncated output persisted; read with read_files.',
    )
    expect(normalized.artifactBytes).toBeGreaterThan(256_000 - 256_000)
    // The caller's own envelope shape survives (the structured value wrapper
    // every consumer walks is untouched apart from the clipped leaf).
    expect(normalized.type).toBe('structuredOutput')
    expect(normalized.value.status).toBe('completed')
    expect(normalized.value.message.length).toBeLessThan(40_000)
    // The recovery path is real: read_files on the artifact yields the FULL
    // untruncated output.
    const persisted = JSON.parse(readFileSync(normalized.artifactPath, 'utf8'))
    expect(persisted).toEqual(payload)
  })

  test('degrades to artifact diagnostic fields (never throws) when persistence fails', () => {
    // TMPDIR pointed at a regular FILE makes mkdirSync fail with ENOTDIR on
    // every POSIX runner (root included), exercising the never-throw path.
    const scratchDir = mkdtempSync(join(osTmpdir(), 'openbuff-clipped-probe-'))
    const blockerFile = join(scratchDir, 'blocker')
    writeFileSync(blockerFile, 'regular file, not a directory')
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = blockerFile
    try {
      const normalized = normalizeSpawnedAgentOutput(
        clippedPayload(),
        'researcher-web',
      ) as any
      // The clipping is still reported honestly; only the recovery pointer
      // degrades to an explicit diagnostic.
      expect(normalized.truncated).toBe(true)
      expect(normalized.artifactPersisted).toBe(false)
      expect(typeof normalized.artifactError).toBe('string')
      expect(normalized.artifactPath).toBeUndefined()
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

  test('records truncated (not ok) for a clipped payload under the size bound, without downgrading status', () => {
    // The classifier inspects the normalized output ROOT. A sub-256k payload
    // whose `message` leaf was clipped used to carry NO root truncation flag,
    // so a clipped result settled as `outcome: 'ok'`. The root now reports
    // `truncated: true`, which must yield `outcome: 'truncated'` while the
    // completed status is preserved (truncated is not a failure).
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'researcher-web',
      agentId: 'a-clipped-sub256k',
      output: {
        type: 'structuredOutput',
        value: { status: 'completed', message: 'm'.repeat(40_000) },
      },
    })
    expect(receipt.outcome).toBe('truncated')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
    const output = receipt.output as Record<string, unknown>
    expect(output.truncated).toBe(true)
    expect(typeof output.artifactPath).toBe('string')
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

/**
 * Reviewer receipt durability across the degenerate ACK-echo retry. A reviewer
 * child that published a valid receipt and then re-called set_output with the
 * `{ message: 'Output set' }` tool ACK echoed back as a payload keeps the real
 * receipt: handleSetOutput's receipt-downgrade guard leaves agentState.output
 * untouched AND clears lastSetOutputError. The settle path must therefore hand
 * the parent the published verdict instead of downgrading the run to
 * schema_invalid, which would re-arm the gate's re-review loop. A genuine
 * set_output validation rejection must still settle schema_invalid, so the fix
 * cannot have disabled the legitimate fail-closed signal.
 */
describe('reviewer receipt survives the degenerate ACK-echo retry (end-to-end settle)', () => {
  // Real 64-hex token so the receipt also satisfies the gate-attestable shape.
  const fingerprint = 'v3:' + 'a'.repeat(64)

  test('settles a published receipt plus an echoed tool ACK with the real verdict', () => {
    const agentState = getInitialAgentState()
    agentState.agentType = 'security-reviewer'
    // Post-guard child state: the child first published this receipt, then
    // re-called set_output with the degenerate ACK echoed back as a payload, so
    // the guard kept the receipt as the published output and cleared the stale
    // set_output error the echo would otherwise have recorded.
    agentState.output = {
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: fingerprint,
      reviewedFiles: ['src/a.ts'],
      findings: [],
      coverage: 'covered',
    }
    // The precondition the receipt-downgrade guard keys on.
    expect(isReceiptShape(agentState.output)).toBe(true)

    const receipt = buildRuntimeAgentReceipt({
      agentType: 'security-reviewer',
      agentId: 'sec-ack-echo-1',
      output: agentState.output,
      agentState,
    })

    // The echo retry is only safe because handleSetOutput clears
    // lastSetOutputError on its guard-hit branch: a stale error left on the
    // child state would re-derive outcome 'schema_invalid' here, downgrade the
    // receipt to partial, and re-arm the gate's re-review loop even though a
    // complete verdict was published.
    expect(receipt.outcome).not.toBe('schema_invalid')
    const settledOutput = receipt.output as Record<string, unknown>
    expect(settledOutput.verdict).toBe('LOOKS_GOOD')
    expect(settledOutput.snapshotFingerprint).toBe(fingerprint)
  })

  test('still settles a genuine set_output validation rejection as schema_invalid', () => {
    const agentState = getInitialAgentState()
    agentState.agentType = 'code-reviewer'
    // A real rejection leaves the error on the child state and no receipt
    // behind: the fail-closed signal must be untouched by the guard.
    agentState.lastSetOutputError =
      'Output validation error: snapshotFingerprint is required'
    const rejectedOutput = {
      type: 'structuredOutput',
      value: { verdict: 'LOOKS_GOOD' },
    }
    expect(isReceiptShape(agentState.output)).toBe(false)
    expect(isReceiptShape(rejectedOutput.value)).toBe(false)

    const receipt = buildRuntimeAgentReceipt({
      agentType: 'code-reviewer',
      agentId: 'code-reviewer-rejected-1',
      output: rejectedOutput,
      agentState,
    })

    expect(receipt.outcome).toBe('schema_invalid')
  })
})

/**
 * Relaxed general-agent completion contract (buildRuntimeAgentReceiptOrThrow):
 * a non-audit general-agent that produced a real, non-empty final answer is
 * credited as completed even without an explicit task_completed call. Only a
 * genuinely answerless / step-capped run stays a retryable missing-completion
 * miss, and the audit-shard case still STRICTLY requires a write_audit_findings
 * structuralReceipt.
 */
describe('buildRuntimeAgentReceipt general-agent completion contract', () => {
  test('credits a general-agent final assistant answer without task_completed', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'general-agent',
      agentId: 'ga-answer-lastmessage',
      output: {
        type: 'lastMessage',
        value: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is my final answer.' }],
          },
        ],
      },
    })
    expect(receipt.status).toBe('completed')
    expect(receipt.outcome).toBe('ok')
    expect(
      receipt.errors.some((error) => error.message.includes('task_completed')),
    ).toBe(false)
  })

  test('credits a general-agent non-empty summary answer without task_completed', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'general-agent',
      agentId: 'ga-answer-summary',
      output: {
        type: 'structuredOutput',
        value: { summary: 'A real, non-empty final answer.' },
      },
    })
    expect(receipt.status).toBe('completed')
    expect(
      receipt.errors.some((error) => error.message.includes('task_completed')),
    ).toBe(false)
  })

  test('still flags an answerless/step-capped general-agent as a retryable miss', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'general-agent',
      agentId: 'ga-answerless',
      output: undefined,
      agentState: {
        messageHistory: [],
        output: {
          harvestedFromFallback: true,
          noHarvestedAnswer: true,
          summary: 'Step cap reached before a final answer.',
        },
      } as any,
    })
    expect(receipt.status).toBe('partial')
    expect(
      receipt.errors.some(
        (error) =>
          error.retryable === true &&
          error.message.includes('task_completed'),
      ),
    ).toBe(true)
  })

  test('does not credit an explicit empty placeholder output as a final answer', () => {
    // The `{ summary: '', partial: true }` placeholder normalizeSpawnedAgentOutput
    // emits must stay a retryable miss — the partial guard rejects it.
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'general-agent',
      agentId: 'ga-empty-placeholder',
      output: {
        summary: '',
        partial: true,
        errorMessage: 'general-agent ended without calling set_output',
      },
    })
    expect(receipt.status).toBe('partial')
    expect(
      receipt.errors.some(
        (error) =>
          error.retryable === true &&
          error.message.includes('task_completed'),
      ),
    ).toBe(true)
  })

  test('keeps the audit-shard write_audit_findings requirement strict even with a final answer', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'general-agent',
      agentId: 'ga-audit-missing',
      spawnParams: {
        sessionSlug: 'session-1',
        shardId: 'shard-1',
        snapshotId: 'v3:' + 'a'.repeat(64),
      },
      output: {
        type: 'lastMessage',
        value: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'My audit answer prose.' }],
          },
        ],
      },
    })
    expect(receipt.status).toBe('partial')
    expect(
      receipt.errors.some(
        (error) =>
          error.retryable === true &&
          error.message.includes('write_audit_findings'),
      ),
    ).toBe(true)
    // The relaxed completion contract must not have added a stray
    // task_completed miss on top of the audit requirement.
    expect(
      receipt.errors.some((error) => error.message.includes('task_completed')),
    ).toBe(false)
  })
})

/**
 * Reviewer-family verdict guard (security-reviewer investigation,
 * .agents/sessions/agent-smoke-2026-10/security-reviewer-investigation.md):
 * a reviewer-family child that emits a degenerate structured object WITHOUT
 * a verdict field (e.g. just echoed params + snapshotFingerprint) used to
 * settle as outcome 'ok' and hand the parent garbage. The receipt builder
 * now classifies it as retryable schema_invalid. Advisory-family specialists
 * (family: 'advisory', no verdict) and non-reviewer agents stay outcome 'ok'.
 */
describe('buildRuntimeAgentReceipt reviewer-family verdict guard', () => {
  test('classifies a degenerate reviewer-family payload without a verdict as retryable schema_invalid', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'security-reviewer',
      agentId: 'sec-degenerate-1',
      output: {
        type: 'structuredOutput',
        value: { family: 'reviewer', snapshotFingerprint: 'x' },
      },
    })
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toEqual([
      {
        message:
          "security-reviewer receipt outcome 'schema_invalid': security-reviewer returned a reviewer-family receipt without a verdict field (degenerate structured output; automated re-review will be triggered)",
        retryable: true,
      },
    ])
  })

  test('falls back to the agentType reviewer match when the payload omits family', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'code-reviewer',
      agentId: 'code-degenerate-1',
      output: {
        type: 'structuredOutput',
        value: { snapshotFingerprint: 'x' },
      },
    })
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors).toHaveLength(1)
    expect(receipt.errors[0]?.retryable).toBe(true)
    expect(receipt.errors[0]?.message).toContain('verdict field')
  })

  test('keeps an advisory-family specialist at outcome ok despite no verdict', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'product-reviewer',
      agentId: 'advisory-1',
      output: {
        type: 'structuredOutput',
        value: { family: 'advisory', reviewedFiles: [] },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
  })

  test('keeps a valid reviewer receipt with a verdict at outcome ok', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'security-reviewer',
      agentId: 'sec-valid-1',
      output: {
        type: 'structuredOutput',
        value: {
          family: 'reviewer',
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: 'v3:' + 'a'.repeat(64),
          reviewedFiles: ['src/a.ts'],
        },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
  })

  test('leaves non-reviewer agents without a verdict untouched', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'test-writer',
      agentId: 'tw-no-verdict',
      output: {
        type: 'structuredOutput',
        value: { status: 'completed', summary: 'done' },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.errors).toEqual([])
  })
})

/**
 * Reviewer stringified-payload coercion (live bug: compatibility-reviewer
 * set_output payloads whose `value` — or whose inner findings/
 * reviewedFiles/dimensions/requirementCoverage/schemaVersion fields —
 * arrived as JSON-encoded STRINGS were left as strings, so the payload read
 * as a verdict-less degenerate receipt, settled retryable schema_invalid,
 * and the parent re-reviewed forever despite the real verdict inside.
 */
describe('reviewer receipt stringified-payload coercion', () => {
  const reviewerFinding = {
    id: 'F-1',
    text: 'Handle the proto signature change.',
    severity: 'major',
    dimension: 'compatibility',
    evidence: ['v1 uses the old call signature', 'v2 requires the new one'],
    correction: 'Update the two call sites.',
  }
  const fingerprint = 'v3:' + 'a'.repeat(64)

  test('builds an ok receipt from a structuredOutput value that is a JSON string of the full reviewer receipt', () => {
    const fullReceipt = {
      family: 'reviewer',
      schemaVersion: 1,
      verdict: 'NON_BLOCKING',
      snapshotFingerprint: fingerprint,
      coverage: 'covered',
      reviewedFiles: ['src/proto/client.ts'],
      findings: [reviewerFinding],
      requirementCoverage: [{
        id: 'R-1',
        covered: true,
        evidence: ['covered by F-1'],
      }],
      dimensions: { compatibility: 'PASS', security: 'SKIP' },
    }
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-str-receipt-1',
      output: {
        type: 'structuredOutput',
        value: JSON.stringify(fullReceipt),
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
    expect(receipt.review?.verdict).toBe('NON_BLOCKING')
  })

  test('coerces stringified inner fields on an object value so findings become native arrays', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-inner-str-1',
      output: {
        type: 'structuredOutput',
        value: {
          family: 'reviewer',
          schemaVersion: 1,
          verdict: 'NON_BLOCKING',
          snapshotFingerprint: fingerprint,
          coverage: 'covered',
          reviewedFiles: JSON.stringify(['src/proto/client.ts']),
          findings: JSON.stringify([reviewerFinding]),
          requirementCoverage: JSON.stringify([{ id: 'R-1', covered: true }]),
          dimensions: JSON.stringify({ compatibility: 'PASS' }),
        },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.errors).toEqual([])
    const value = receipt.output as Record<string, unknown> | undefined
    const inner = value?.value as Record<string, unknown> | undefined
    expect(Array.isArray(inner?.findings)).toBe(true)
    expect((inner?.findings as unknown[])[0]).toEqual(reviewerFinding)
    expect(inner?.dimensions).toEqual({ compatibility: 'PASS' })
    expect(Array.isArray(inner?.requirementCoverage)).toBe(true)
    expect(Array.isArray(inner?.reviewedFiles)).toBe(true)
  })

  test('coerces a schemaVersion string "1" to the number 1', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-schema-str-1',
      output: {
        type: 'structuredOutput',
        value: {
          family: 'reviewer',
          schemaVersion: '1',
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint: fingerprint,
          reviewedFiles: ['src/a.ts'],
        },
      },
    })
    expect(receipt.outcome).toBe('ok')
    const value = receipt.output as Record<string, unknown> | undefined
    const inner = value?.value as Record<string, unknown> | undefined
    expect(inner?.schemaVersion).toBe(1)
  })

  test('falls through unchanged when the value string is not valid JSON (schema_invalid)', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-bad-json-1',
      output: {
        type: 'structuredOutput',
        value: 'this is not JSON at all',
      },
    })
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.status).toBe('partial')
    expect(receipt.errors[0]?.retryable).toBe(true)
  })

  test('falls through unchanged when the value string parses to an array (schema_invalid)', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-array-json-1',
      output: {
        type: 'structuredOutput',
        value: JSON.stringify([{ verdict: 'NON_BLOCKING' }]),
      },
    })
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.errors[0]?.retryable).toBe(true)
  })

  // Memoization followup: the same stringified value seen twice within one
  // settle chain must produce the same coerced receipt both times, and the
  // memo must not leak state across distinct payloads.
  test('a repeated stringified value settles identically on the second settle', () => {
    const stringifiedReceipt = JSON.stringify({
      schemaVersion: 1,
      family: 'reviewer',
      verdict: 'NON_BLOCKING',
      snapshotFingerprint: '',
      reviewedFiles: ['src/a.ts'],
      coverage: 'covered',
      dimensions: { correctness: 'pass' },
      findings: [],
      requirementCoverage: [],
    })
    const build = (agentId: string) =>
      buildRuntimeAgentReceipt({
        agentType: 'compatibility-reviewer',
        agentId,
        output: { type: 'structuredOutput', value: stringifiedReceipt },
      })
    const first = build('compat-memo-1')
    const second = build('compat-memo-2')
    expect(first.outcome).toBe('ok')
    expect(second.outcome).toBe('ok')
    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
  })

  // Receipt-riding-one-level-deeper envelope (live bug: compatibility-
  // reviewer settled schema_invalid when the receipt traveled as an object
  // whose `output` key is a JSON-encoded string of the full receipt).
  test('unwraps a structuredOutput value whose output key is a JSON string of the full reviewer receipt', () => {
    const fullReceipt = {
      family: 'reviewer',
      schemaVersion: 1,
      verdict: 'BLOCKING',
      snapshotFingerprint: fingerprint,
      coverage: 'covered',
      reviewedFiles: ['src/proto/client.ts'],
      findings: [reviewerFinding],
      requirementCoverage: [{ id: 'R-1', covered: true }],
      dimensions: { compatibility: 'PASS' },
    }
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-nested-output-1',
      output: {
        type: 'structuredOutput',
        value: { output: JSON.stringify(fullReceipt) },
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
    expect(receipt.review?.verdict).toBe('BLOCKING')
  })

  // Keyless json-part envelope (live bug pinned 2026-10-19: compatibility-
  // reviewer delivered its verdict-bearing receipt as { jsonKey: 'output',
  // value: '<JSON string of the full receipt>' } with NO `type`
  // discriminator, so every structuredOutput-specific unwrap branch missed it
  // and the settle read the degenerate {message: 'Output set'} ack instead,
  // looping schema_invalid forever).
  test('unwraps a keyless json-part envelope ({ jsonKey, value }) carrying a stringified reviewer receipt', () => {
    const fullReceipt = {
      family: 'reviewer',
      schemaVersion: 1,
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: fingerprint,
      coverage: 'covered',
      reviewedFiles: ['src/proto/client.ts'],
      findings: [reviewerFinding],
      requirementCoverage: [{ id: 'R-1', covered: true }],
      dimensions: { compatibility: 'PASS' },
    }
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-jsonkey-envelope-1',
      output: {
        jsonKey: 'output',
        value: JSON.stringify(fullReceipt),
      },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
    expect(receipt.review?.verdict).toBe('LOOKS_GOOD')
  })

  test('unwraps a keyless json-part envelope whose value is a native receipt object', () => {
    const fullReceipt = {
      family: 'reviewer',
      schemaVersion: 1,
      verdict: 'NON_BLOCKING',
      snapshotFingerprint: fingerprint,
      coverage: 'covered',
      reviewedFiles: ['src/proto/client.ts'],
    }
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-jsonkey-native-1',
      output: { jsonKey: 'output', value: fullReceipt },
    })
    expect(receipt.outcome).toBe('ok')
    expect(receipt.status).toBe('completed')
    expect(receipt.errors).toEqual([])
    expect(receipt.review?.verdict).toBe('NON_BLOCKING')
  })

  test('leaves a keyless json-part envelope with a verdict-less value untouched (schema_invalid)', () => {
    // A jsonKey envelope whose parsed/native value has NO verdict must NOT be
    // promoted to structuredOutput — the verdict guard still catches it as
    // the degenerate receipt it is.
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-jsonkey-verdictless-1',
      output: {
        jsonKey: 'output',
        value: JSON.stringify({ snapshotFingerprint: 'x', reviewedFiles: [] }),
      },
    })
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.errors[0]?.retryable).toBe(true)
  })

  test('falls through unchanged when the nested output string parses to an array (schema_invalid)', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-nested-output-array',
      output: {
        type: 'structuredOutput',
        value: { output: JSON.stringify([{ verdict: 'NON_BLOCKING' }]) },
      },
    })
    // A parsed array is not a receipt object: it falls through to the
    // unchanged object-value branch, whose verdict-less reviewer-family
    // payload still settles retryable schema_invalid.
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.errors[0]?.retryable).toBe(true)
  })

  // eslint-disable-next-line no-useless-escape
  test('keeps a schema-echo structuredOutput value settling schema_invalid', () => {
    const receipt = buildRuntimeAgentReceipt({
      agentType: 'compatibility-reviewer',
      agentId: 'compat-schema-echo-1',
      output: {
        type: 'structuredOutput',
        value: {
          properties: { verdict: { type: 'string' } },
          required: ['verdict'],
          additionalProperties: false,
        },
      },
    })
    // A schema echo has no `output` string and no verdict: it must still be
    // recognized as a verdict-less reviewer-family payload.
    expect(receipt.outcome).toBe('schema_invalid')
    expect(receipt.errors[0]?.retryable).toBe(true)
    expect(receipt.errors[0]?.message).toContain('verdict field')
  })
})

/**
 * reliability-reviewer: librarian-cleanup-reports-cleaned-on-failed-rm — a
 * non-transient rm failure must surface the clone as retained (with an
 * explicit cleanup-failure marker) instead of silently reporting it cleaned;
 * an ENOENT race may still be treated as cleaned because the ownership goal
 * (the clone is already gone) already holds.
 */
describe('finalizeOwnedLibrarianClone cleanup failure reporting', () => {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as any

  const librarianParams = (owned: string) => ({
    agentType: 'librarian',
    spawnParams: { repoUrl: 'https://github.com/acme/repo' },
    messageHistory: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `The repository has been cloned to \`${owned}\`. Use it.`,
          },
        ],
      } as any,
    ],
  })

  // Unique, create-and-verify, and digits-only-suffixed (finalizeOwned-
  // LibrarianClone's ownership check requires a digits-only suffix after
  // the `/tmp/librarian-repo-` prefix): the suffix embeds this pid plus a
  // random component and a per-process counter so a stale leftover dir from
  // an aborted prior run can never collide with a fresh path here; mkdir
  // failures are retried on a fresh candidate instead of surfacing as
  // EEXIST/EACCES at setup.
  let ownedPathCounter = 0
  const ownedPath = () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      ownedPathCounter += 1
      const candidate = `/tmp/librarian-repo-${Date.now()}${process.pid}${Math.floor(Math.random() * 1_000_000)}${ownedPathCounter}`
      try {
        mkdirSync(candidate, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // Collision: retry on a fresh unique candidate.
          continue
        }
        throw error
      }
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
    throw new Error('failed to allocate a unique /tmp/librarian-repo-* path')
  }

  // Only directories owned by THIS process's pid suffix are pre-cleaned so
  // we never race a truly parallel run.
  const preCleanOwnedLeftovers = () => {
    try {
      for (const entry of readdirSync('/tmp')) {
        if (
          entry.startsWith('librarian-repo-') &&
          entry.includes(`${process.pid}`)
        ) {
          try {
            fs.rmSync(join('/tmp', entry), { recursive: true, force: true })
          } catch {
            // Best-effort cleanup only.
          }
        }
      }
    } catch {
      // Best-effort cleanup only.
    }
  }

  test('reports a non-transient rm failure as retained with an explicit cleanup-failure marker', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Root bypasses directory permission checks, so the induced EACCES
      // below cannot be reproduced; skip rather than assert the wrong thing.
      return
    }
    preCleanOwnedLeftovers()
    // ownedPath() already created (and verified) the dir with mode 0o700.
    const owned = ownedPath()
    // A write-protected child directory makes rm(cloneDir, {recursive}) fail
    // with EACCES for a non-root runner: unlinking inside it needs write
    // permission on the child directory itself.
    const protectedChild = join(owned, 'protected')
    // Create with a writable mode, write the blocker INTO it, and only then
    // flip it to 0o555 — so the induced EACCES happens at the rm step the
    // finding targets, never at test setup.
    mkdirSync(protectedChild)
    writeFileSync(join(protectedChild, 'blocker'), 'x')
    chmodSync(protectedChild, 0o555)
    try {
      const output = (await finalizeOwnedLibrarianClone({
        ...librarianParams(owned),
        output: {
          type: 'structuredOutput',
          value: { status: 'answered', cloneRetained: false },
        },
        logger,
      })) as any
      // The receipt must NOT claim the clone was cleaned up while it lives on
      // disk: keep the trusted cloneDir, mark the clone retained, and flag
      // the cleanup failure explicitly for the parent.
      expect(output.value.cloneRetained).toBe(true)
      expect(output.value.cloneDir).toBe(owned)
      expect(output.value.cloneCleanupFailed).toBe(true)
      expect(fs.existsSync(owned)).toBe(true)
    } finally {
      // Restore writability so the directory can be removed again.
      try {
        chmodSync(join(owned, 'protected'), 0o700)
      } catch {
        // Best-effort recovery.
      }
      try {
        fs.rmSync(owned, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup.
      }
    }
  })

  test('treats an already-removed clone (ENOENT race) as cleaned', async () => {
    // ownedPath() created the dir; remove it to simulate the race.
    const owned = ownedPath()
    rmSync(owned, { recursive: true, force: true })
    const output = (await finalizeOwnedLibrarianClone({
      ...librarianParams(owned),
      output: {
        type: 'structuredOutput',
        value: { status: 'answered', cloneRetained: false },
      },
      logger,
    })) as any
    expect(output.value.cloneRetained).toBe(false)
    expect(output.value.cloneDir).toBe('')
    expect(fs.existsSync(owned)).toBe(false)
  })
})

/**
 * reliability-reviewer: cancel-rethrow-skips-librarian-clone-cleanup — when
 * a librarian subagent already owns a /tmp clone and the PARENT signal is
 * aborted, the in-process catch path must still finalize the owned clone and
 * register the abandoned child runId in the parent's childRunIds chain before
 * rethrowing, instead of leaking the clone and orphaning the runId.
 */
describe('executeSubagent cancellation cleanup', () => {
  const librarianTemplate = {
    id: 'librarian',
    displayName: 'Librarian',
    toolNames: [],
    spawnableAgents: [],
    mcpServers: {},
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
    includeMessageHistory: false,
    inheritParentSystemPrompt: false,
    outputMode: 'last_message',
    inputSchema: {},
  } as unknown as AgentTemplate

  test('finalizes the owned librarian clone and registers the abandoned runId before rethrowing', async () => {
    // Clone path must satisfy finalizeOwnedLibrarianClone's ownership check:
    // `/tmp/librarian-<repoName>-<digits>` with a github repoUrl of the same
    // repoName.
    const owned = `/tmp/librarian-repo-${Date.now()}1`
    mkdirSync(owned, { recursive: true, mode: 0o700 })

    // Loop mocked so it throws while the parent signal is aborted — exactly
    // the in-process catch/rethrow branch the finding targets.
    mock.module('../../../../run-agent-step', () => ({
      ...realRunAgentStep,
      loopAgentSteps: async () => {
        throw new Error('parent aborted during step')
      },
    }))

    const finishEvents: Array<Record<string, unknown>> = []
    const parentAgentState = {
      ...getInitialAgentState(),
      agentId: 'parent-1',
      runId: 'parent-run-1',
    }
    const childAgentState = {
      ...getInitialAgentState(),
      agentId: 'librarian-1',
      runId: 'child-run-abandoned-1',
      messageHistory: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: `The repository has been cloned to \`${owned}\`. Use it.`,
            },
          ],
        },
      ] as any,
    }

    try {
      const abortError = new Error('parent aborted during step')
      await expect(
        executeSubagent({
          ...createTestAgentRuntimeParams(),
          agentTemplate: librarianTemplate,
          parentAgentState,
          agentState: childAgentState,
          onResponseChunk: (chunk: unknown) => {
            if (typeof chunk === 'object' && chunk !== null) {
              finishEvents.push(chunk as Record<string, unknown>)
            }
          },
          isOnlyChild: false,
          ancestorRunIds: [],
          prompt: 'do research',
          spawnParams: { repoUrl: 'https://github.com/acme/repo' },
          spawnToolCallId: 'call-cancel-1',
          spawnIndex: 0,
          localAgentTemplates: {},
          logger: {
            debug() {},
            info() {},
            warn() {},
            error() {},
          } as any,
          userId: undefined,
          userInputId: 'u',
          fingerprintId: 'fingerprint-cancel-1',
          clientSessionId: 'test-session',
          fileContext: {
            files: {},
            systemPromptAdditionalInfo: undefined,
          } as any,
          signal: AbortSignal.abort(new Error('abort reason')),
          system: '',
          tools: {},
        } as any),
      ).rejects.toThrow('parent aborted during step')

      // The abandoned child runId must still be registered in the parent's
      // childRunIds chain (the journal/step-boundary spawn-intent machinery
      // keys on it).
      expect(parentAgentState.childRunIds).toContain('child-run-abandoned-1')

      // The clone must be cleaned up (not leaked) by the catch path.
      expect(fs.existsSync(owned)).toBe(false)

      // The finish event must be emitted before the rethrow (subagent_start
      // plus a subagent_finish carrying the error).
      expect(
        finishEvents.some(
          (event) =>
            event.type === 'subagent_finish' &&
            'error' in event &&
            String(event.error).includes('parent aborted during step'),
        ),
      ).toBe(true)
    } finally {
      mock.restore()
      try {
        fs.rmSync(owned, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup only.
      }
    }
  })
})

/**
 * reliability-reviewer: sweep-cap-no-forward-progress — consecutive persists
 * (each of which runs a best-effort TTL sweep capped at
 * OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES stat'ed entries) must make forward
 * progress on a shared artifact directory holding more stale entries than the
 * per-call cap: after a bounded number of consecutive persists, every stale
 * artifact must have been swept instead of being perpetually skipped beyond
 * the cap.
 */
describe('oversize artifact sweep forward progress', () => {
  test('consecutive persists sweep the whole stale backlog beyond the per-call cap', () => {
    const dir = join(osTmpdir(), 'openbuff-spawn-output')
    mkdirSync(dir, { recursive: true })
    // Pre-clean the shared scratch dir so stale-backlog counting is exact.
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

    const staleBacklogCount = 120
    const staleNames = Array.from(
      { length: staleBacklogCount },
      (_, index) => `stale-backlog-${index}.json`,
    )
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
    for (const name of staleNames) {
      const path = join(dir, name)
      writeFileSync(path, '{}')
      utimesSync(path, twentyFiveHoursAgo, twentyFiveHoursAgo)
    }

    // Run the bound number of sweeps needed to cover the backlog under the
    // per-call cap (ceil(120 / 50) = 3), changing persisted payload content
    // each round so every round really persists a NEW artifact and so the
    // rotation cursor must advance to reach the remaining stale entries.
    for (let round = 0; round < 3; round += 1) {
      const normalized = normalizeSpawnedAgentOutput(
        {
          findings: [
            ...Array.from({ length: 100 }, (_, index) =>
              // Pad each finding above the oversize bound (well past the
              // 256k-total persisted payload threshold) so every round really
              // persists an artifact, keeping round-unique content.
              `round-${round}-finding-${index}`.padEnd(4_000, 'p'),
            ),
          ],
        },
        'security-reviewer',
      ) as any
      expect(typeof normalized.artifactPath).toBe('string')
    }

    // Every stale backlog artifact must have been swept after the bounded
    // number of consecutive persists — no permanently-shadowed over-retention.
    const survivors = readdirSync(dir).filter((entry) =>
      entry.startsWith('stale-backlog-'),
    )
    expect(survivors).toEqual([])
  })
})
