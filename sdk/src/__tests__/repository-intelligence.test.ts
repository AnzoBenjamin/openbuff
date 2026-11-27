import { describe, expect, spyOn, test } from 'bun:test'
import { IndexManager } from '@codebuff/indexer'
import { createNodeFileSystem } from '../tools/node-filesystem'
import {
  RepositoryIntelligenceService,
  createVirtualRepositoryIntelligenceSource,
  createRepositoryIntelligenceSource,
} from '../services/repository-intelligence'
import {
  MemoryPlaybookSchema,
  computeTriggerSignature,
} from '@codebuff/common/types/memory-playbook'
import { ProjectIdSchema } from '@codebuff/common/types/memory-v2'
import type { MemoryRepositoryV2 } from '../services/memory-v2/types'

const actor = { runId: 'root', rootRunId: 'root', agentId: 'editor-instance' }
const request = {
  actor,
  agentType: 'editor',
  userInputId: 'current-input',
  query: 'Edit src/editor.ts',
}

describe('bounded repository context compilation', () => {
  test('saved discovery arriving after 1.5 seconds reaches the actor within its packet deadline', async () => {
    let ready = false
    const manager = {
      ensureBuilt() {},
      async waitUntilReady(timeout: number) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(timeout, 1_650)),
        )
        ready = timeout >= 1_650
        return ready
      },
      getSnapshot: () =>
        ready
          ? {
              files: {
                'src/editor.ts': { hash: 'saved-source', symbols: ['editor'] },
              },
            }
          : undefined,
      query: () => ({
        ready,
        status: { stale: true },
        snapshot: { snapshotId: 'saved-generation' },
        results: [],
      }),
    }
    const instance = spyOn(IndexManager, 'getInstance').mockReturnValue(
      manager as unknown as IndexManager,
    )
    try {
      const service = new RepositoryIntelligenceService({
        cwd: '/virtual',
        fs: createNodeFileSystem(),
        source: createRepositoryIntelligenceSource('/virtual', {
          enabled: true,
          cacheDir: '.codebuff-index',
          exclude: [],
          semantic: { enabled: false },
        }),
      })
      const packet = await service.prepare({
        ...request,
        deadlineMs: Date.now() + 3_000,
      })
      expect(packet.briefing).toContain('src/editor.ts')
      expect(packet.briefing).toContain('saved-generation')
      expect(packet.freshness).toBe('unverified')
      expect(packet.reasons).toEqual([])
    } finally {
      instance.mockRestore()
    }
  })

  test('virtual SDK files expose exact paths and validation recipes without local discovery', async () => {
    const source = createVirtualRepositoryIntelligenceSource({
      'src/editor.ts': 'export function updateEditor() {}',
      'package.json': '{"scripts":{"typecheck":"tsc --noEmit"}}',
    })
    expect(source.locality).toBe('virtual')
    const output = await source.query({
      query: 'typecheck package.json src/editor.ts',
      focusPaths: ['src/editor.ts'],
      agentType: 'editor',
      limit: 4,
    })
    expect(output.freshness).toBe('current')
    expect(
      output.candidates.find((item) => item.path === 'package.json')?.snippets,
    ).toEqual(['typecheck: tsc --noEmit'])
    expect(output.candidates[0]?.path).toBe('src/editor.ts')
  })
  test('a stalled discovery source ends with an explicit coverage gap', async () => {
    const service = new RepositoryIntelligenceService({
      cwd: '/virtual',
      fs: createNodeFileSystem(),
      source: { query: () => new Promise(() => {}) },
    })
    const before = Date.now()
    const packet = await service.prepare({
      ...request,
      deadlineMs: Date.now() + 30,
    })
    expect(Date.now() - before).toBeLessThan(1000)
    expect(packet.freshness).toBe('degraded')
    expect(packet.reasons).toContain('source-query-failed')
  })
  test('a failed procedure read retains the last known applicable rules', async () => {
    const projectId = ProjectIdSchema.parse('project-context-policy')
    const trigger = {
      tool: 'run_terminal_command' as const,
      terminalAction: 'git-commit' as const,
      requireEvidence: [],
    }
    const scope = { repos: [projectId], agentTypes: ['editor'] }
    const rule = MemoryPlaybookSchema.parse({
      schemaVersion: 1,
      playbookId: 'rule',
      workspaceId: projectId,
      title: 'Delivery procedure',
      instruction: 'Review the owned changes before committing.',
      trigger,
      scope,
      status: 'verified',
      enforcement: 'warn',
      counters: {},
      triggerSignature: computeTriggerSignature(trigger, scope),
      provenance: {
        origin: 'user',
        recordedBy: 'test',
        sourceEventIds: [],
        metadata: {},
      },
      createdAt: 1,
      updatedAt: 1,
    })
    let fail = false
    const repository = {
      listPlaybooks: async () => {
        if (fail) throw new Error('read unavailable')
        return [rule]
      },
    } as unknown as MemoryRepositoryV2
    const service = new RepositoryIntelligenceService({
      cwd: '/virtual',
      fs: createNodeFileSystem(),
      memory: { projectId, repository, authority: 'shadow-v2', capture: 'off' },
    })
    expect((await service.prepare(request)).playbooks).toHaveLength(1)
    fail = true
    const degraded = await service.prepare(request)
    expect(degraded.playbooks).toHaveLength(1)
    expect(degraded.reasons).toContain('procedure-load-failed')
    expect(
      (await service.prepare({ ...request, agentType: 'committer' })).playbooks,
    ).toHaveLength(0)
  })
})
