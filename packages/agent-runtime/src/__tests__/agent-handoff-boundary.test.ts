import { describe, expect, test } from 'bun:test'

import {
  buildSpawnParamsWithHandoff,
  validateVersionedAgentHandoff,
} from '../tools/handlers/tool/spawn-agent-utils'

describe('versioned shipped-agent handoff boundary', () => {
  test('rejects repair-editor without a complete v1 handoff', () => {
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'repair-editor',
        handoff: {},
      }),
      // M2-T2: {} is an UNVERSIONED handoff (schemaVersion absent), so it
      // fails closed with the envelope error before any field-level check.
    ).toThrow(/handoffs must be complete schemaVersion 1 envelopes/)
  })

  test('accepts repair-editor with task, findings, and permissions', () => {
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'repair-editor',
        handoff: {
          schemaVersion: 1,
          taskId: 'T1',
          role: 'repair-editor',
          objective: 'Fix finding',
          requirements: [
            { id: 'R1', text: 'Fix finding RF-1', required: true },
          ],
          acceptanceCriteria: [
            {
              id: 'A1',
              behavior: 'RF-1 is repaired.',
              verification: 'Targeted validation and fresh review pass.',
            },
          ],
          context: [],
          nonGoals: [],
          findings: [
            {
              id: 'RF-1',
              text: 'Fix the bug.',
              files: ['src/a.ts'],
              snapshotFingerprint: 'v3:test',
            },
          ],
          permissions: {
            readablePaths: [],
            writablePaths: [],
            allowedTools: [],
          },
        },
      }),
    ).not.toThrow()
  })

  test('keeps custom and legacy agents compatible', () => {
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'custom-agent',
        handoff: undefined,
      }),
    ).not.toThrow()
  })

  test('requires the common envelope fields for any versioned handoff', () => {
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'thinker',
        handoff: { schemaVersion: 1, taskId: 'T1' },
      }),
    ).toThrow(/requires taskId, role, and objective/)
  })

  // M2-T2: unversioned/legacy handoffs are a clean validation error, never a
  // TypeError. These shapes used to slip past the validator's early return and
  // die inside deriveSpawnTemplateCapabilities with "Cannot read properties
  // of undefined (reading 'allowedTools')".
  test('rejects an unversioned legacy handoff with a clean validation error', () => {
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'thinker',
        handoff: { context: 'legacy free-form text' },
      }),
    ).toThrow(/handoffs must be complete schemaVersion 1 envelopes/)
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'thinker',
        handoff: { summary: 'legacy' },
      }),
    ).toThrow(/handoffs must be complete schemaVersion 1 envelopes/)
  })

  test('rejects a future schemaVersion with the v1 envelope error', () => {
    expect(() =>
      validateVersionedAgentHandoff({
        agentType: 'thinker',
        handoff: { schemaVersion: 2, taskId: 'T1' },
      }),
    ).toThrow(/schemaVersion 1 requires taskId, role, and objective/)
  })

  test('bounds oversized handoff strings before child context transfer', () => {
    const result = buildSpawnParamsWithHandoff({
      agentType: 'thinker',
      handoff: { summary: 'x'.repeat(20_000) },
    })
    expect(JSON.stringify(result).length).toBeLessThan(5_000)
    expect(JSON.stringify(result)).toContain('truncated handoff')
  })
})
