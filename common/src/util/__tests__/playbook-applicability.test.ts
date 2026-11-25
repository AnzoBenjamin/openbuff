import { describe, expect, test } from 'bun:test'

import { MemoryPlaybookSchema } from '../../types/memory-playbook'
import { isPlaybookApplicable } from '../playbook-applicability'

import type { MemoryPlaybook, PlaybookScope } from '../../types/memory-playbook'

const rule = (
  scope: PlaybookScope,
  status: MemoryPlaybook['status'] = 'active',
): MemoryPlaybook =>
  MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId: 'pb-scope',
    workspaceId: 'ws-1',
    title: 'Scoped commit procedure',
    instruction: 'Validate before committing.',
    trigger: {
      tool: 'run_terminal_command',
      terminalAction: 'git-commit',
      requireEvidence: [],
    },
    scope,
    status,
    enforcement: 'warn',
    counters: {},
    provenance: {
      origin: 'user',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: 'sig-scope',
    createdAt: 0,
    updatedAt: 0,
  })

describe('isPlaybookApplicable', () => {
  test('uses the acting role rather than a child target and preserves global procedures', () => {
    const context = {
      repoIds: ['repo-A'],
      actorAgentType: 'editor',
      affectedPaths: ['cli/file.ts'],
    }
    expect(
      isPlaybookApplicable(
        rule({ repos: [], agentTypes: ['git-committer'] }),
        context,
      ),
    ).toBe(false)
    expect(isPlaybookApplicable(rule({ repos: [] }), context)).toBe(true)
  })

  test('requires known repository and role matches, including aliases and qualification', () => {
    const procedure = rule({ repos: ['repo-A'], agentTypes: ['git-committer'] })
    expect(
      isPlaybookApplicable(procedure, {
        repoIds: ['repo-B'],
        actorAgentType: 'git-committer',
      }),
    ).toBe(false)
    expect(
      isPlaybookApplicable(procedure, {
        repoIds: ['repo-A'],
        actorAgentType: 'codebuff/git_committer@1.0.0',
      }),
    ).toBe(true)
    expect(
      isPlaybookApplicable(
        rule({ repos: [], agentTypes: ['acme/git-committer@2'] }),
        { actorAgentType: 'codebuff/git-committer@2' },
      ),
    ).toBe(false)
  })

  test('matches recursive and segment globs and retains unknown path scope', () => {
    const procedure = rule({
      repos: [],
      glob: ['cli/**/*.ts', 'agents/reviewer?.md'],
    })
    expect(
      isPlaybookApplicable(procedure, { affectedPaths: ['cli/file.ts'] }),
    ).toBe(true)
    expect(
      isPlaybookApplicable(procedure, { affectedPaths: ['./cli/src/file.ts'] }),
    ).toBe(true)
    expect(
      isPlaybookApplicable(procedure, {
        affectedPaths: ['agents/reviewer1.md'],
      }),
    ).toBe(true)
    expect(
      isPlaybookApplicable(procedure, { affectedPaths: ['sdk/file.ts'] }),
    ).toBe(false)
    expect(isPlaybookApplicable(procedure, {})).toBe(true)
    expect(isPlaybookApplicable(procedure, { affectedPaths: [] })).toBe(true)
  })

  test('active and verified stay effective while retired, candidate and expired do not', () => {
    expect(isPlaybookApplicable(rule({ repos: [] }, 'active'))).toBe(true)
    expect(isPlaybookApplicable(rule({ repos: [] }, 'verified'))).toBe(true)
    expect(isPlaybookApplicable(rule({ repos: [] }, 'candidate'))).toBe(false)
    expect(isPlaybookApplicable(rule({ repos: [] }, 'retired'))).toBe(false)
    expect(
      isPlaybookApplicable(
        { ...rule({ repos: [] }), expiresAt: 100 },
        { nowMs: 100 },
      ),
    ).toBe(false)
  })
})
