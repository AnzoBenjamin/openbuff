import { describe, expect, test } from 'bun:test'

import { taskMemoryV1Schema } from '@codebuff/common/types/task-memory'
import {
  getInitialAgentState,
  type AgentState,
} from '@codebuff/common/types/session-state'
import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import {
  createAgentState,
  type SharedSpawnCloneCache,
} from '../spawn-agent-utils'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'
import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'

/**
 * Regression tests for the per-batch spawn clone cache (createAgentState
 * optional `sharedSpawnCloneCache`):
 * - sibling children of ONE spawn batch share the SAME taskMemory/playbook
 *   Context/workspaceState clone object identity instead of re-cloning;
 * - a NEW handler invocation (fresh cache object) clones again — the cache is
 *   never reused across batches and never held at module scope;
 * - the cache slot is keyed by the SOURCE object, so a batch whose parent
 *   node was replaced between two children still gets a fresh clone;
 * - messageHistoryMode 'none' keeps producing taskMemory: undefined.
 */

const makeTemplate = (
  messageHistoryMode: 'none' | 'pinned' | 'full',
): AgentTemplate => ({
  id: 'spawn-cache-test-agent',
  displayName: 'Spawn Cache Test',
  outputMode: 'last_message' as const,
  inputSchema: {},
  includeMessageHistory: messageHistoryMode !== 'none',
  messageHistoryMode,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: [],
  spawnableAgents: [],
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
})

const makePlaybook = (playbookId = 'pb-spawn-cache-test'): MemoryPlaybook =>
  MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId,
    workspaceId: 'ws-1',
    title: 'Test playbook',
    instruction: 'Test instruction.',
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [],
    },
    scope: { repos: [] },
    status: 'active',
    enforcement: 'warn',
    counters: {
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    },
    provenance: {
      origin: 'derived',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: `sig-${playbookId}`,
    createdAt: 1,
    updatedAt: 2,
  })

const makeTaskMemory = (goal: string): TaskMemoryV1 =>
  taskMemoryV1Schema.parse({
    schemaVersion: 1,
    goal,
    revision: 0,
    updatedAt: 0,
    checksum: 'test-checksum',
  })

const makeParentState = (): AgentState => ({
  ...getInitialAgentState(),
  taskMemory: makeTaskMemory('parent goal'),
  playbookContext: [makePlaybook()],
  workspaceState: createInitialWorkspaceState(),
})

describe('createAgentState shared spawn clone cache', () => {
  test('same-batch siblings share the SAME taskMemory/playbookContext/workspaceState object identity', () => {
    const cache: SharedSpawnCloneCache = {}
    const parent = makeParentState()
    const template = makeTemplate('full')

    const childA = createAgentState('a', template, parent, {}, cache)
    const childB = createAgentState('b', template, parent, {}, cache)

    expect(childA.taskMemory).toBe(childB.taskMemory)
    expect(childA.playbookContext).toBe(childB.playbookContext)
    expect(childA.workspaceState).toBe(childB.workspaceState)

    // The shared objects are still deep-clone copies of the parent's nodes
    // (copy-safe against parent cross-mutation), NOT references to them.
    expect(childA.taskMemory).toEqual(parent.taskMemory)
    expect(childA.taskMemory).not.toBe(parent.taskMemory)
    expect(childA.playbookContext).not.toBe(parent.playbookContext)
    expect(childA.workspaceState).not.toBe(parent.workspaceState)
  })

  test('sibling states still differ in per-child identity fields', () => {
    const cache: SharedSpawnCloneCache = {}
    const parent = makeParentState()
    const template = makeTemplate('full')

    const childA = createAgentState('a', template, parent, {}, cache)
    const childB = createAgentState('b', template, parent, {}, cache)

    expect(childA.agentId).not.toBe(childB.agentId)
    expect(childA).not.toBe(childB)
  })

  test('a new invocation with a fresh cache does NOT reuse the same batch clone', () => {
    const parent = makeParentState()
    const template = makeTemplate('full')

    const batchACache: SharedSpawnCloneCache = {}
    const batchAChild = createAgentState('a', template, parent, {}, batchACache)

    const batchBCache: SharedSpawnCloneCache = {}
    const batchBChild = createAgentState('b', template, parent, {}, batchBCache)

    expect(batchAChild.taskMemory).toEqual(batchBChild.taskMemory)
    expect(batchAChild.taskMemory).not.toBe(batchBChild.taskMemory)
    expect(batchAChild.playbookContext).not.toBe(batchBChild.playbookContext)
    expect(batchAChild.workspaceState).not.toBe(batchBChild.workspaceState)
  })

  test('re-clones when the parent node is replaced mid-batch (slot keyed by source)', () => {
    const cache: SharedSpawnCloneCache = {}
    const parent = makeParentState()
    const template = makeTemplate('full')

    const first = createAgentState('a', template, parent, {}, cache)

    // Mid-batch parent replacement of a cloned node: the memoized slot holds
    // the OLD source, so the next child must get a fresh clone, not the
    // memoized value of a source no longer live on the parent.
    const replacementMemory = makeTaskMemory('replaced goal')
    const firstTaskMemory = first.taskMemory
    parent.taskMemory = replacementMemory
    const second = createAgentState('b', template, parent, {}, cache)

    expect(first.taskMemory).toBe(firstTaskMemory)
    expect(second.taskMemory).toEqual(replacementMemory)
    expect(second.taskMemory).not.toBe(replacementMemory)
    expect(second.taskMemory).not.toBe(first.taskMemory)
  })

  test('no cache threaded keeps exactly one fresh clone per child (default behavior)', () => {
    const parent = makeParentState()
    const template = makeTemplate('full')

    const childA = createAgentState('a', template, parent, {})
    const childB = createAgentState('b', template, parent, {})

    expect(childA.taskMemory).toEqual(parent.taskMemory)
    expect(childA.taskMemory).not.toBe(parent.taskMemory)
    expect(childB.taskMemory).not.toBe(childA.taskMemory)
  })

  test('messageHistoryMode none keeps taskMemory undefined even with a warm cache', () => {
    const cache: SharedSpawnCloneCache = {}
    const parent = makeParentState()
    const template = makeTemplate('none')

    const withMemory = createAgentState('a', makeTemplate('full'), parent, {}, cache)
    const noneModeChild = createAgentState('b', template, parent, {}, cache)

    expect(withMemory.taskMemory).not.toBeUndefined()
    expect(noneModeChild.taskMemory).toBeUndefined()
    expect(noneModeChild.messageHistory).toEqual([])
  })

  // Defense-in-depth at the isolation boundary (dev/test only): the shared
  // memoized clone is deep-frozen, so a writer that breaks the
  // copy-on-write convention fails loudly (strict-mode TypeError on a
  // frozen object) instead of silently cross-contaminating siblings.
  test('the shared clone is deep-frozen with its parent untouched', () => {
    const cache: SharedSpawnCloneCache = {}
    const parent = makeParentState()

    const child = createAgentState('a', makeTemplate('full'), parent, {}, cache)

    expect(Object.isFrozen(child.taskMemory)).toBe(true)
    expect(Object.isFrozen(child.playbookContext)).toBe(true)
    expect(Object.isFrozen(child.playbookContext![0])).toBe(true)
    expect(Object.isFrozen(child.workspaceState)).toBe(true)
    // Nested rows/arrays are frozen too, not just the root node.
    expect(Object.isFrozen(parent.taskMemory)).toBe(false)
  })

  test('a nested in-place write on one sibling cannot leak through the shared clone', () => {
    const cache: SharedSpawnCloneCache = {}
    const parent = makeParentState()

    const childA = createAgentState('a', makeTemplate('full'), parent, {}, cache)
    const childB = createAgentState('b', makeTemplate('full'), parent, {}, cache)

    // Simulate the exact violation the freeze guards: a writer mutating a
    // nested node on the shared clone before its first COW assignment. The
    // strict-mode assignment on the frozen root cannot land: it either
    // throws or (in non-strict code) silently no-ops — both leave the shared
    // state identical for every sibling of the batch.
    expect(() => {
      try {
        ;(childB.workspaceState as unknown as Record<string, unknown>).imports =
          'leaked'
      } catch {
        // Frozen-object strict-mode throw IS the guard firing.
      }
    }).not.toThrow()
    // No cross-contamination: sibling A observes the pristine snapshot.
    expect(
      (childA.workspaceState as unknown as Record<string, unknown>).imports,
    ).toBeUndefined()
    expect(Object.isFrozen(childA.workspaceState)).toBe(true)
  })
})
