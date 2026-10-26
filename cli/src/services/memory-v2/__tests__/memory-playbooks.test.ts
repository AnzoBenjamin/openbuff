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
import type {
  PlaybookStoreContract,
} from '../../../../../common/src/types/contracts/playbook-store'

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

/** The first built-in seed rule, repeated here so the test pins its exact shape. */
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

/** The second built-in seed rule: CI evidence before a direct git push. */
const seed2Trigger: PlaybookTrigger = {
  tool: 'run_terminal_command',
  terminalAction: 'git-push',
  requireEvidence: [
    {
      kind: 'toolSucceeded',
      tool: 'run_terminal_command',
      commandPattern: '*check:ci-local*',
      withinMs: 14_400_000,
    },
  ],
}
const seed2Scope: PlaybookScope = { repos: [] }

const SEED_1_SIGNATURE = computeTriggerSignature(seedTrigger, seedScope)
const SEED_2_SIGNATURE = computeTriggerSignature(seed2Trigger, seed2Scope)

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
  test('ensureSeedPlaybooks seeds both rules once and is idempotent', async () => {
    const repository = await open(temporaryRepository())

    await repository.ensureSeedPlaybooks(WORKSPACE_ID)
    const first = await repository.listPlaybooks(WORKSPACE_ID)
    expect(first.length).toBe(2)
    const seed1 = first.find(
      (playbook) => playbook.triggerSignature === SEED_1_SIGNATURE,
    )
    const seed2 = first.find(
      (playbook) => playbook.triggerSignature === SEED_2_SIGNATURE,
    )
    expect(seed1?.title).toBe('Run the repo CI check before committing')
    expect(seed1?.status).toBe('active')
    expect(seed1?.enforcement).toBe('warn')
    expect(seed1?.instruction).toContain('check:ci-local')
    expect(seed1?.counters).toEqual({
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    })
    expect(seed2?.title).toBe('Run the repo CI check before pushing directly')
    expect(seed2?.status).toBe('active')
    expect(seed2?.enforcement).toBe('warn')
    expect(seed2?.instruction).toContain('check:ci-local')
    expect(seed2?.counters).toEqual({
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    })

    await repository.ensureSeedPlaybooks(WORKSPACE_ID)
    const second = await repository.listPlaybooks(WORKSPACE_ID)
    expect(second.length).toBe(2)
    expect(second.map(({ playbookId }) => playbookId)).toEqual(
      first.map(({ playbookId }) => playbookId),
    )
    // A different workspace gets its own copies of both seed rules.
    expect(await repository.listPlaybooks('workspace-2')).toEqual([])
    await repository.ensureSeedPlaybooks('workspace-2')
    const otherWorkspace = await repository.listPlaybooks('workspace-2')
    expect(otherWorkspace.length).toBe(2)
    expect(otherWorkspace.map(({ playbookId }) => playbookId)).not.toEqual(
      first.map(({ playbookId }) => playbookId),
    )
  })

  test('ensureSeedPlaybooks never refreshes an existing seed row', async () => {
    const repository = await open(temporaryRepository())
    // A pre-existing row carrying seed 1's exact trigger+scope but custom
    // contents: the per-seed existence check must skip it, never clobber it.
    const custom = await repository.upsertPlaybookByTriggerSignature({
      workspaceId: WORKSPACE_ID,
      title: 'Custom pre-existing title',
      instruction: 'Custom pre-existing instruction.',
      trigger: seedTrigger,
      scope: seedScope,
      status: 'active',
      enforcement: 'warn',
      provenance: {
        origin: 'repository',
        recordedBy: 'test',
        sourceEventIds: [],
        metadata: {},
      },
    })

    await repository.ensureSeedPlaybooks(WORKSPACE_ID)

    const listed = await repository.listPlaybooks(WORKSPACE_ID)
    expect(listed.length).toBe(2)
    const kept = listed.find(
      (playbook) => playbook.playbookId === custom.playbookId,
    )
    expect(kept?.title).toBe('Custom pre-existing title')
    expect(kept?.instruction).toBe('Custom pre-existing instruction.')
    expect(kept?.updatedAt).toBe(custom.updatedAt)
    const added = listed.find(
      (playbook) => playbook.playbookId !== custom.playbookId,
    )
    expect(added?.triggerSignature).toBe(SEED_2_SIGNATURE)
    expect(added?.title).toBe('Run the repo CI check before pushing directly')
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

  test('listAllPlaybooks returns every row regardless of status or expiry', async () => {
    const repository = await open(temporaryRepository())
    const active = await createPlaybook(
      repository,
      'Active rule',
      triggerFor('spawn_agents'),
    )
    const retired = await createPlaybook(
      repository,
      'Retired rule',
      triggerFor('run_terminal_command'),
      'retired',
    )
    const expired = await createPlaybook(
      repository,
      'Expired rule',
      triggerFor('spawn_agent_inline'),
      'active',
      Date.now() - 1_000,
    )

    const all = await repository.listAllPlaybooks(WORKSPACE_ID)
    // ORDER BY created_at, playbook_id: the three upserts can land in the same
    // millisecond, so the expected order mirrors the SQL tie-break exactly.
    const expected = [active, retired, expired].sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        (left.playbookId < right.playbookId
          ? -1
          : left.playbookId > right.playbookId
            ? 1
            : 0),
    )
    expect(all.map(({ playbookId }) => playbookId)).toEqual(
      expected.map(({ playbookId }) => playbookId),
    )
    expect(all.map(({ status }) => status)).toEqual(
      expected.map(({ status }) => status),
    )
    // Contrast with the gate-facing read, which stays filtered.
    expect(await repository.listPlaybooks(WORKSPACE_ID)).toHaveLength(1)

    const otherWorkspace = await repository.upsertPlaybookByTriggerSignature({
      workspaceId: 'workspace-2',
      title: 'Other workspace rule',
      instruction: 'Instruction for Other workspace rule',
      trigger: triggerFor('spawn_agents'),
      scope: { repos: [] },
      status: 'active',
      enforcement: 'warn',
      provenance: {
        origin: 'repository',
        recordedBy: 'test',
        sourceEventIds: [],
        metadata: {},
      },
    })
    expect(await repository.listAllPlaybooks(WORKSPACE_ID)).toHaveLength(3)
    expect(
      (await repository.listAllPlaybooks('workspace-2')).map(
        ({ playbookId }) => playbookId,
      ),
    ).toEqual([otherWorkspace.playbookId])
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

  test('recordPlaybookGateOutcome with a warned outcome bumps only fired and lastFiredAt', async () => {
    const repository = await open(temporaryRepository())
    const playbook = await createPlaybook(
      repository,
      'Warn-only rule',
      triggerFor('run_terminal_command'),
    )

    const before = Date.now()
    await repository.recordPlaybookGateOutcome(playbook.playbookId, 'warned')
    const [warned] = await repository.listPlaybooks(WORKSPACE_ID)
    expect(warned?.counters.fired).toBe(1)
    expect(warned?.counters.blocked).toBe(0)
    expect(warned?.counters.bypassed).toBe(0)
    expect(warned?.counters.compliedAfterBlock).toBe(0)
    expect(warned?.counters.falsePositives).toBe(0)
    expect(warned?.counters.lastFiredAt).toBeGreaterThanOrEqual(before)
    expect(warned?.counters.lastFalsePositiveAt).toBeUndefined()
  })

  test('satisfies the canonical PlaybookStoreContract surface', async () => {
    const repository = await open(temporaryRepository())
    // The assignment only typechecks while BunSQLiteMemoryRepository provides
    // every contract member with the contract's exact shape, so the common DI
    // contract and the shipped driver cannot drift apart silently; reading
    // back through the contract-typed reference then exercises that surface.
    const store: PlaybookStoreContract = repository
    await repository.ensureSeedPlaybooks(WORKSPACE_ID)
    const playbooks = await store.listPlaybooks(WORKSPACE_ID)
    expect(playbooks.length).toBe(2)
  })
})
