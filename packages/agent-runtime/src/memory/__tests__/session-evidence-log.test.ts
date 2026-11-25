import { describe, expect, test } from 'bun:test'

import { computeValidationDependencyFingerprint } from '@codebuff/common/types/memory-playbook'
import {
  createSessionEvidenceLog,
  recordSessionEvidence,
  recordSessionValidationEvidence,
  validationEvidenceMatches,
} from '../session-evidence-log'

import type {
  ValidationEvidenceContext,
  ValidationReceipt,
} from '@codebuff/common/types/memory-playbook'

const dependencies = {
  'source:src/file.ts': 'source-v1',
  'config:package.json': 'config-v1',
  'lock:bun.lock': 'lock-v1',
  'tool:bun': '1.4.4',
}
const receipt: ValidationReceipt = {
  receiptId: 'validation-1',
  workspaceId: 'ws-1',
  rootRunId: 'root-1',
  checkKind: 'ci-local',
  command: 'bun run check:ci-local',
  cwd: '/repo',
  exitCode: 0,
  completedAt: 1_000,
  producer: { runId: 'validator-child', agentId: 'basher' },
  dependencyHashes: dependencies,
  dependencyFingerprint: computeValidationDependencyFingerprint(dependencies),
}
const context = (
  overrides: Partial<ValidationEvidenceContext> = {},
): ValidationEvidenceContext => ({
  workspaceId: 'ws-1',
  rootRunId: 'root-1',
  receipts: [receipt],
  currentDependencyHashes: { ...dependencies },
  ...overrides,
})
const query = {
  validationKinds: ['ci-local', 'package-checks'],
  withinMs: 500,
  nowMs: 1_500,
}

describe('validationEvidenceMatches', () => {
  test('does not turn an echo or a session-ledger claim into a validation receipt', () => {
    const log = createSessionEvidenceLog()
    recordSessionEvidence(log, {
      toolName: 'run_terminal_command',
      commandText: 'echo check:ci-local',
      atMs: 1_000,
    })
    recordSessionValidationEvidence(log, receipt)
    expect(log.entries).toHaveLength(2)
    expect(log.entries[1]?.kind).toBe('validationSucceeded')
    expect(validationEvidenceMatches(undefined, query)).toBe(false)
    expect(validationEvidenceMatches(context({ receipts: [] }), query)).toBe(
      false,
    )
  })

  test('reuses child-produced validation within the same root task, including accepted alternatives', () => {
    expect(validationEvidenceMatches(context(), query)).toBe(true)
    expect(
      validationEvidenceMatches(
        context({ receipts: [{ ...receipt, checkKind: 'package-checks' }] }),
        query,
      ),
    ).toBe(true)
    expect(
      validationEvidenceMatches(
        context({ receipts: [{ ...receipt, checkKind: 'test' }] }),
        query,
      ),
    ).toBe(false)
    expect(
      validationEvidenceMatches(context({ rootRunId: 'another-task' }), query),
    ).toBe(false)
    expect(
      validationEvidenceMatches(
        context({ workspaceId: 'another-repo' }),
        query,
      ),
    ).toBe(false)
  })

  test('invalidates source, config, lockfile and tool-version changes but ignores unrelated inputs', () => {
    for (const key of Object.keys(dependencies)) {
      expect(
        validationEvidenceMatches(
          context({
            currentDependencyHashes: { ...dependencies, [key]: 'changed' },
          }),
          query,
        ),
      ).toBe(false)
    }
    expect(
      validationEvidenceMatches(
        context({
          currentDependencyHashes: { ...dependencies, unrelated: 'changed' },
        }),
        query,
      ),
    ).toBe(true)
    expect(
      validationEvidenceMatches(
        context({ currentDependencyHashes: {} }),
        query,
      ),
    ).toBe(false)
  })

  test('rejects stale, future, failed, empty and internally inconsistent receipts', () => {
    expect(
      validationEvidenceMatches(context(), { ...query, nowMs: 1_501 }),
    ).toBe(false)
    expect(validationEvidenceMatches(context(), { ...query, nowMs: 999 })).toBe(
      false,
    )
    expect(
      validationEvidenceMatches(
        context({
          receipts: [
            { ...receipt, exitCode: 1 } as unknown as ValidationReceipt,
          ],
        }),
        query,
      ),
    ).toBe(false)
    expect(
      validationEvidenceMatches(
        context({ receipts: [{ ...receipt, dependencyHashes: {} }] }),
        query,
      ),
    ).toBe(false)
    expect(
      validationEvidenceMatches(
        context({
          receipts: [
            {
              ...receipt,
              dependencyFingerprint: computeValidationDependencyFingerprint({
                other: 'input',
              }),
            },
          ],
        }),
        query,
      ),
    ).toBe(false)
  })
})
