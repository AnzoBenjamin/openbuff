import { describe, expect, test } from 'bun:test'
import {
  MemoryPlaybookSchema,
  PlaybookTriggerSchema,
  computeTriggerSignature,
  computeValidationDependencyFingerprint,
  type PlaybookScope,
  type PlaybookTrigger,
} from '../memory-playbook'

const baseProvenance = {
  origin: 'user',
  recordedBy: 'test-runner',
  sourceEventIds: [],
  metadata: {},
} as const

const trigger: PlaybookTrigger = {
  tool: 'run_terminal_command',
  terminalAction: 'git-push',
  requireEvidence: [],
}
const scope: PlaybookScope = {
  repos: ['acme/repo'],
  glob: undefined,
  agentTypes: undefined,
}

const minimalPlaybook = {
  schemaVersion: 1,
  playbookId: 'pb-1',
  workspaceId: 'ws-1',
  title: 'Pin claims before git push',
  instruction: 'Pin the backing claim before pushing to a shared branch.',
  trigger,
  scope,
  status: 'candidate',
  enforcement: 'block',
  counters: {},
  provenance: baseProvenance,
  triggerSignature: computeTriggerSignature(trigger, scope),
  createdAt: 0,
  updatedAt: 0,
}

describe('MemoryPlaybookSchema', () => {
  test('accepts a minimal valid playbook and applies defaults', () => {
    const result = MemoryPlaybookSchema.parse(minimalPlaybook)
    expect(result.trigger.requireEvidence).toEqual([])
    expect(result.scope.repos).toEqual(['acme/repo'])
    expect(result.counters).toEqual({
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    })
  })

  test('rejects unknown keys (strictObject)', () => {
    const result = MemoryPlaybookSchema.safeParse({
      ...minimalPlaybook,
      unexpectedField: true,
    })
    expect(result.success).toBe(false)
  })

  test('rejects an oversized requireEvidence array (9 items)', () => {
    const requireEvidence = Array.from({ length: 9 }, () => ({
      kind: 'toolSucceeded' as const,
    }))
    const result = PlaybookTriggerSchema.safeParse({
      tool: 'run_terminal_command',
      requireEvidence,
    })
    expect(result.success).toBe(false)
  })

  test('accepts typed validation alternatives and rejects command-text substitutes', () => {
    const make = (evidence: Record<string, unknown>) =>
      PlaybookTriggerSchema.safeParse({
        tool: 'run_terminal_command',
        terminalAction: 'git-commit',
        requireEvidence: [evidence],
      })
    expect(
      make({
        kind: 'validationSucceeded',
        validationKinds: ['ci-local', 'package-checks'],
      }).success,
    ).toBe(true)
    expect(
      make({ kind: 'validationSucceeded', commandPattern: '*check:ci-local*' })
        .success,
    ).toBe(false)
    expect(
      make({ kind: 'toolSucceeded', validationKinds: ['ci-local'] }).success,
    ).toBe(false)
    expect(
      make({ kind: 'validationSucceeded', validationKinds: [] }).success,
    ).toBe(false)
  })
})

describe('computeValidationDependencyFingerprint', () => {
  test('is independent of map insertion order and changes with any input', () => {
    const baseline = computeValidationDependencyFingerprint({
      source: 'a',
      config: 'b',
      tool: 'c',
    })
    expect(
      computeValidationDependencyFingerprint({
        tool: 'c',
        config: 'b',
        source: 'a',
      }),
    ).toBe(baseline)
    expect(
      computeValidationDependencyFingerprint({
        source: 'a2',
        config: 'b',
        tool: 'c',
      }),
    ).not.toBe(baseline)
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('computeTriggerSignature', () => {
  test('is stable across key-order permutations', () => {
    const a = computeTriggerSignature(
      {
        tool: 'run_terminal_command',
        terminalAction: 'git-push',
        requireEvidence: [
          { kind: 'toolSucceeded', tool: 'run_terminal_command' },
        ],
      },
      { repos: ['acme/repo'], glob: ['src/**'], agentTypes: ['implementer'] },
    )
    const b = computeTriggerSignature(
      {
        requireEvidence: [
          { tool: 'run_terminal_command', kind: 'toolSucceeded' },
        ],
        terminalAction: 'git-push',
        tool: 'run_terminal_command',
      },
      { agentTypes: ['implementer'], glob: ['src/**'], repos: ['acme/repo'] },
    )
    expect(b).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('differs when the trigger changes', () => {
    const a = computeTriggerSignature(
      { tool: 'run_terminal_command', requireEvidence: [] },
      { repos: [] },
    )
    const b = computeTriggerSignature(
      {
        tool: 'spawn_agents',
        spawnAgentType: 'implementer',
        requireEvidence: [],
      },
      { repos: [] },
    )
    expect(b).not.toBe(a)
  })
})
