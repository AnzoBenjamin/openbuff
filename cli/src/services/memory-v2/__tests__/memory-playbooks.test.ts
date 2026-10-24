import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeTriggerSignature,
  type MemoryPlaybook,
  type PlaybookScope,
  type PlaybookStatus,
  type PlaybookTrigger,
} from '../../../../../common/src/types/memory-playbook'

import { BunSQLiteMemoryRepository } from '../bun-sqlite-memory-repository'

const repositories: BunSQLiteMemoryRepository[] = []

function temporaryRepository(): string {
  return mkdtempSync(join(tmpdir(), 'openbuff-memory-playbooks-'))
}

async function open(root: string): Promise<BunSQLiteMemoryRepository> {
  const result = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (result.status === 'error') throw new Error(result.error.message)
  repositories.push(result.repository)
  return result.repository
}

afterEach(async () => {
  while (repositories.length > 0) await repositories.pop()?.close()
})

const WORKSPACE_ID = 'workspace-1'

/** The built-in seed rule, repeated here so the test pins its exact shape. */
const seedTrigger: PlaybookTrigger = {
  tool: 'spawn_agents',
  spawnAgentType: 'git-committer',
  requireEvidence: [
    {
      kind: 'toolSucceeded',
      tool: 'run_terminal_command',
      commandPattern: '*check:ci-local*',
      withinMs: 14_400_000,
    },
  ],
}
const seedScope: PlaybookScope = { repos: [] }

function triggerFor(tool: PlaybookTrigger['tool']): PlaybookTrigger {
  return { tool, requireEvidence: [] }
}

async function createPlaybook(
  repository: BunSQLiteMemoryRepository,
  title: string,
  trigger: PlaybookTrigger,
  status: PlaybookStatus = 'active',
  expiresAt?: number,
): Promise<MemoryPlaybook> {
  return repository.upsertPlaybookByTriggerSignature({
    workspaceId: WORKSPACE_ID,
    title,
    instruction: `Instruction for ${title}`,
    trigger,
    scope: { repos: [] },
    status,
    enforcement: 'warn',
    provenance: {
      origin: 'repository',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    ...(expiresAt === undefined ? {} : { expiresAt }),
  })
}

describe('memory playbooks (procedural memory)', () => {
  test('ensureSeedPlaybooks seeds once and is idempotent', async () => {
    const repository = await open(temporaryRepository())

    await repository.ensureSeedPlaybooks(WORKSPACE_ID)
    const first = await repository.listPlaybooks(WORKSPACE_ID)
    expect(first.length).toBe(1)
    expect(first[0]?.title).toBe('Run the repo CI check before committing')
    expect(first[0]?.status).toBe('active')
    expect(first[0]?.enforcement).toBe('warn')
    expect(first[0]?.counters.fired).toBe(0)
    expect(first[0]?.triggerSignature).toBe(
      computeTriggerSignature(seedTrigger, seedScope),
    )
    expect(first[0]?.instruction).toContain('check:ci-local')

    await repository.ensureSeedPlaybooks(WORKSPACE_ID)
    const second = await repository.listPlaybooks(WORKSPACE_ID)
    expect(second.length).toBe(1)
    expect(second[0]?.playbookId).toBe(first[0]!.playbookId)
    // A different workspace gets its own copy of the seed rule.
    expect(await repository.listPlaybooks('workspace-2')).toEqual([])
    await repository.ensureSeedPlaybooks('workspace-2')
    expect((await repository.listPlaybooks('workspace-2')).length).toBe(1)
  })

  test('upsert by trigger signature reuses the playbook id, updates the instruction, and preserves counters', async () => {
    const repository = await open(temporaryRepository())
    const first = await createPlaybook(
      repository,
      'Run checks before committing',
      triggerFor('spawn_agents'),
    )
    await repository.recordPlaybookGateOutcome(first.playbookId, 'blocked')

    const updated = await repository.upsertPlaybookByTriggerSignature({
      workspaceId: WORKSPACE_ID,
      title: 'Run checks before committing',
      instruction: 'Updated instruction: run the typecheck first.',
      trigger: triggerFor('spawn_agents'),
      scope: { repos: [] },
      status: 'active',
      enforcement: 'block',
      provenance: {
        origin: 'repository',
        recordedBy: 'test',
        sourceEventIds: [],
        metadata: {},
      },
    })

    expect(updated.playbookId).toBe(first.playbookId)
    expect(updated.instruction).toBe(
      'Updated instruction: run the typecheck first.',
    )
    expect(updated.enforcement).toBe('block')
    expect(updated.createdAt).toBe(first.createdAt)
    expect(updated.triggerSignature).toBe(first.triggerSignature)
    expect(updated.counters.fired).toBe(1)
    expect(updated.counters.blocked).toBe(1)
    expect((await repository.listPlaybooks(WORKSPACE_ID)).length).toBe(1)
  })

  test('listPlaybooks excludes retired and expired playbooks', async () => {
    const repository = await open(temporaryRepository())
    const active = await createPlaybook(
      repository,
      'Active rule',
      triggerFor('spawn_agents'),
    )
    await createPlaybook(
      repository,
      'Retired rule',
      triggerFor('run_terminal_command'),
      'retired',
    )
    await createPlaybook(
      repository,
      'Expired rule',
      triggerFor('spawn_agent_inline'),
      'active',
      Date.now() - 1_000,
    )

    const listed = await repository.listPlaybooks(WORKSPACE_ID)
    expect(listed.map(({ playbookId }) => playbookId)).toEqual([
      active.playbookId,
    ])

    await repository.setPlaybookStatus(active.playbookId, 'retired')
    expect(await repository.listPlaybooks(WORKSPACE_ID)).toEqual([])
  })

  test('recordPlaybookGateOutcome bumps fired and the matching counter', async () => {
    const repository = await open(temporaryRepository())
    const playbook = await createPlaybook(
      repository,
      'Gate rule',
      triggerFor('run_terminal_command'),
    )
    expect(playbook.counters).toEqual({
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    })

    const before = Date.now()
    await repository.recordPlaybookGateOutcome(playbook.playbookId, 'blocked')
    const [blocked] = await repository.listPlaybooks(WORKSPACE_ID)
    expect(blocked?.counters.fired).toBe(1)
    expect(blocked?.counters.blocked).toBe(1)
    expect(blocked?.counters.bypassed).toBe(0)
    expect(blocked?.counters.lastFiredAt).toBeGreaterThanOrEqual(before)
    expect(blocked?.counters.lastFalsePositiveAt).toBeUndefined()

    await repository.recordPlaybookGateOutcome(
      playbook.playbookId,
      'falsePositive',
    )
    const [flagged] = await repository.listPlaybooks(WORKSPACE_ID)
    expect(flagged?.counters.fired).toBe(2)
    expect(flagged?.counters.blocked).toBe(1)
    expect(flagged?.counters.falsePositives).toBe(1)
    expect(flagged?.counters.lastFalsePositiveAt).toBeGreaterThanOrEqual(before)
  })
})
