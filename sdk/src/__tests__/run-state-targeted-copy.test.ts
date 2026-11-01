import { describe, expect, test } from 'bun:test'

import {
  getInitialAgentState,
  type SessionState,
} from '@codebuff/common/types/session-state'
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import {
  applyOverridesToSessionState,
  withMessageHistory,
  type RunState,
} from '../run-state'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'

/**
 * Regression tests for the targeted-copy change in run-state.ts:
 *
 * - `withMessageHistory` must give the ROOT RunState, its sessionState, and
 *   the mainAgentState NEW identities (consumers detect run progress from the
 *   root and sessionState identity change). Copy-on-write memory and
 *   fileContext remain shared, while mutable runtime controls are isolated.
 * - `applyOverridesToSessionState` must return a fresh root, fileContext, and
 *   mainAgentState (all three get in-place property writes during the run) and
 *   never write through to the base session state.
 */

const makeMessages = (...texts: string[]): Message[] =>
  texts.map((text) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    tags: ['USER_PROMPT'] as string[],
  }))

const makeTaskMemory = (goal: string): TaskMemoryV1 => ({
  schemaVersion: 1,
  goal,
  requirements: [],
  decisions: [],
  filesInspected: [],
  editsMade: [],
  validationResults: [],
  reviewReceipts: [],
  blockers: [],
  nextActions: [],
  historicalSummary: '',
  evidence: [],
  revision: 0,
  updatedAt: 0,
  checksum: 'test-checksum',
})

const makeSessionState = (): SessionState => ({
  fileContext: {
    projectRoot: '/test-project',
    cwd: '/test-project',
    fileTree: [],
    fileTokenScores: {},
    knowledgeFiles: {},
    agentTemplates: {},
    customToolDefinitions: {},
    gitChanges: {
      status: '',
      diff: '',
      diffCached: '',
      lastCommitMessages: '',
    },
    changesSinceLastChat: {},
    shellConfigFiles: {},
    systemInfo: {
      platform: 'test',
      shell: 'test',
      nodeVersion: 'test',
      arch: 'test',
      homedir: '/home/test',
      cpus: 1,
      chromeAvailable: false,
    },
  },
  mainAgentState: {
    ...getInitialAgentState(),
    messageHistory: makeMessages('old message one', 'old message two'),
    taskMemory: makeTaskMemory('persisted goal'),
    workspaceState: createInitialWorkspaceState(),
  },
})

describe('withMessageHistory targeted copy', () => {
  test('gives root, sessionState, and mainAgentState fresh identities and installs the new history', () => {
    const oldSessionState = makeSessionState()
    const oldRunState: RunState = {
      sessionState: oldSessionState,
      output: { type: 'error', message: 'No output yet' },
    }
    const messages = makeMessages('rebuilt message')

    const newRunState = withMessageHistory({
      runState: oldRunState,
      messages,
    })

    // Replaced fields: fresh identities, exactly what the old deep clone
    // provided so consumers can detect run progress by identity change.
    expect(newRunState).not.toBe(oldRunState)
    expect(newRunState.sessionState).not.toBe(oldRunState.sessionState)
    expect(newRunState.sessionState?.mainAgentState).not.toBe(
      oldSessionState.mainAgentState,
    )
    expect(newRunState.sessionState?.mainAgentState.messageHistory).toBe(
      messages,
    )

    // Structural isolation for the replaced field: appending to the NEW
    // history must never leak into the OLD run state's history.
    newRunState.sessionState?.mainAgentState.messageHistory.push(
      makeMessages('late append')[0],
    )
    expect(oldSessionState.mainAgentState.messageHistory).toHaveLength(2)
    expect(oldSessionState.mainAgentState.messageHistory[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'old message one' }],
      tags: ['USER_PROMPT'],
    })
  })

  test('shares copy-on-write memory but owns mutable runtime controls', () => {
    const oldSessionState = makeSessionState()
    const oldRunState: RunState = {
      sessionState: oldSessionState,
      output: { type: 'error', message: 'No output yet' },
    }

    const newRunState = withMessageHistory({
      runState: oldRunState,
      messages: makeMessages('new'),
    })

    const oldMain = oldSessionState.mainAgentState
    const newMain = newRunState.sessionState?.mainAgentState
    expect(newMain).toBeDefined()
    if (!newMain) return

    // Memory nodes are copy-on-write; mutable controls must be independent.
    expect(newMain.taskMemory).toBe(oldMain.taskMemory)
    expect(newMain.taskMemory).toEqual(oldMain.taskMemory)
    expect(newMain.workspaceState).toBe(oldMain.workspaceState)
    expect(newMain.readAuthorizationsByPath).not.toBe(
      oldMain.readAuthorizationsByPath,
    )
    expect(newMain.subagents).not.toBe(oldMain.subagents)
    expect(newRunState.output).toBe(oldRunState.output)
    // SessionState has exactly { fileContext, mainAgentState } on disk, and
    // withMessageHistory does not replace fileContext: it is carried through
    // the spread verbatim (same identity as the source).
    expect(newRunState.sessionState?.fileContext).toBe(
      oldSessionState.fileContext,
    )
  })

  test('mutating a copy-on-write nested node after the copy does not corrupt either side', () => {
    const oldSessionState = makeSessionState()
    const oldRunState: RunState = {
      sessionState: oldSessionState,
      output: { type: 'error', message: 'No output yet' },
    }

    const newRunState = withMessageHistory({
      runState: oldRunState,
      messages: makeMessages('new'),
    })

    // The runtime contract for shared nodes is copy-on-write: a write replaces
    // the property on the owning state instead of mutating the shared node.
    // Simulate it and assert both sides stay intact.
    const freshMemory = makeTaskMemory('replaced goal')
    const oldMemory = oldSessionState.mainAgentState.taskMemory
    if (newRunState.sessionState) {
      newRunState.sessionState.mainAgentState.taskMemory = freshMemory
    }
    expect(oldSessionState.mainAgentState.taskMemory).toBe(oldMemory)
    expect(oldSessionState.mainAgentState.taskMemory?.goal).toBe(
      'persisted goal',
    )
    expect(newRunState.sessionState?.mainAgentState.taskMemory).toBe(
      freshMemory,
    )
  })

  test('copies gate controls before a prior run is frozen', () => {
    const sessionState = makeSessionState()
    const work = { changedFiles: ['old.ts'] }
    sessionState.mainAgentState.base2ActiveWork = work
    const updated = withMessageHistory({
      runState: { sessionState, output: { type: 'error', message: 'pending' } },
      messages: makeMessages('new'),
    })

    Object.freeze(work.changedFiles)
    Object.freeze(work)
    const copied = updated.sessionState!.mainAgentState
      .base2ActiveWork as typeof work
    copied.changedFiles.push('new.ts')
    expect(work.changedFiles).toEqual(['old.ts'])
    expect(copied.changedFiles).toEqual(['old.ts', 'new.ts'])
  })

  // Runtime guard for the targeted-copy contract (dev/test only):
  // withMessageHistory shares taskMemory/workspaceState/playbookContext
  // with the OLD state by identity, so those nodes cross the boundary
  // deep-frozen: a future in-place writer fails loudly (or no-ops) instead
  // of silently corrupting the caller's original state across RunState
  // generations.
  test('the shared nested nodes cross the targeted-copy boundary deep-frozen, so an in-place write cannot alias state across runs', () => {
    const oldSessionState = makeSessionState()
    const oldRunState: RunState = {
      sessionState: oldSessionState,
      output: { type: 'error', message: 'No output yet' },
    }

    const newRunState = withMessageHistory({
      runState: oldRunState,
      messages: makeMessages('new'),
    })

    const newMain = newRunState.sessionState?.mainAgentState
    expect(newMain).toBeDefined()
    if (!newMain) return

    // Shared nodes ARE frozen (replaced fields — root, sessionState,
    // mainAgentState, messageHistory — keep fresh identities).
    expect(Object.isFrozen(newMain.taskMemory)).toBe(true)
    expect(Object.isFrozen(newMain.taskMemory!.evidence)).toBe(true)
    expect(Object.isFrozen(newMain.workspaceState)).toBe(true)
    expect(Object.isFrozen(oldSessionState.mainAgentState.taskMemory)).toBe(true)

    // The in-place mutation a conforming copy-on-write writer would never
    // perform cannot land through the NEW generation's handle.
    const oldGoal = oldSessionState.mainAgentState.taskMemory?.goal
    expect(() => {
      try {
        ;(newMain.taskMemory as unknown as Record<string, unknown>).goal =
          'corrupted'
      } catch {
        // Frozen-object strict-mode throw IS the guard firing.
      }
    }).not.toThrow()
    expect(oldSessionState.mainAgentState.taskMemory?.goal).toBe(oldGoal)
    expect(newMain.taskMemory?.goal).toBe(oldGoal)
  })
})

describe('applyOverridesToSessionState targeted copy', () => {
  const freezeTree = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value))
      return
    for (const child of Object.values(value)) freezeTree(child)
    Object.freeze(value)
  }

  test.each([false, true])(
    'owns mutable controls without cloning transcript bodies (frozen base: %s)',
    async (frozen) => {
      const base = makeSessionState()
      const original = base.mainAgentState
      const activeWork = {
        currentPhase: 'idle',
        pendingGateFiles: ['original.ts'],
      }
      original.base2ActiveWork = activeWork
      original.childRunIds = ['existing-child']
      original.agentContext = { goal: { logs: ['original log'] } }
      original.backgroundAgentJobs = [{
        jobId: 'job-1',
        agentType: 'editor',
        status: 'running',
        startedAt: 1,
      }]
      original.compactionArchive = [{
        archivedAt: 1,
        action: 'mechanical_trim',
        keepRecentSteps: 1,
        messages: makeMessages('archived body'),
      }]
      original.subagents = [{
        ...getInitialAgentState(),
        childRunIds: ['grandchild'],
        messageHistory: makeMessages('child history'),
      }]
      if (frozen) freezeTree(base)

      const resumed = (await applyOverridesToSessionState(undefined, base, {}))
        .mainAgentState
      const resumedWork = resumed.base2ActiveWork as typeof activeWork
      expect(() => {
        resumedWork.currentPhase = 'reviewing'
        resumedWork.pendingGateFiles.push('new.ts')
        resumed.childRunIds.push('new-child')
        resumed.agentContext.goal.logs.push('new log')
        resumed.backgroundAgentJobs![0].status = 'completed'
        resumed.subagents[0].childRunIds.push('new-grandchild')
        resumed.messageHistory.push(makeMessages('new message')[0])
      }).not.toThrow()

      expect(activeWork).toEqual({
        currentPhase: 'idle',
        pendingGateFiles: ['original.ts'],
      })
      expect(original.childRunIds).toEqual(['existing-child'])
      expect(original.agentContext.goal.logs).toEqual(['original log'])
      expect(original.backgroundAgentJobs[0].status).toBe('running')
      expect(original.subagents[0].childRunIds).toEqual(['grandchild'])
      expect(original.messageHistory).toHaveLength(2)
      expect(resumed.messageHistory[0]).toBe(original.messageHistory[0])
      expect(resumed.subagents[0]).not.toBe(original.subagents[0])
      expect(resumed.subagents[0].messageHistory[0]).toBe(
        original.subagents[0].messageHistory[0],
      )
      expect(resumed.compactionArchive).not.toBe(original.compactionArchive)
      expect(resumed.compactionArchive![0]).toBe(original.compactionArchive[0])
      expect(resumed.taskMemory).toBe(original.taskMemory)
      expect(resumed.workspaceState).toBe(original.workspaceState)
    },
  )

  test('gate bookkeeping remains writable if the previous state is frozen after resuming', async () => {
    const base = makeSessionState()
    const work = {
      touchedFiles: ['old.ts'],
      changedFiles: ['old.ts'],
      pendingGateFiles: ['old.ts'],
      gatePassedFileMarkers: { 'new.ts': 'old-hash' } as Record<string, string>,
      validationEvidence: [
        { fileMarkers: { 'new.ts': 'old-hash' } as Record<string, string> },
      ],
    }
    base.mainAgentState.base2ActiveWork = work

    const resumed = await applyOverridesToSessionState(undefined, base, {})
    // Immer can freeze a saved state after a run starts. The active run must
    // still be able to record an edit and invalidate nested gate evidence.
    freezeTree(base)
    const active = resumed.mainAgentState.base2ActiveWork as typeof work
    active.touchedFiles.push('new.ts')
    active.changedFiles.push('new.ts')
    active.pendingGateFiles.push('new.ts')
    delete active.gatePassedFileMarkers['new.ts']
    delete active.validationEvidence[0].fileMarkers['new.ts']

    expect(work.changedFiles).toEqual(['old.ts'])
    expect(work.gatePassedFileMarkers['new.ts']).toBe('old-hash')
    expect(work.validationEvidence[0].fileMarkers['new.ts']).toBe('old-hash')
    expect(active.changedFiles).toEqual(['old.ts', 'new.ts'])
  })

  test('returns a fresh root/fileContext/mainAgentState without mutating the base state', async () => {
    // cwd is undefined so the function performs no filesystem work; with no
    // overrides the function is a pure re-rooted copy plus sanitization.
    const base = makeSessionState()

    const result = await applyOverridesToSessionState(undefined, base, {})

    expect(result).not.toBe(base)
    expect(result.fileContext).not.toBe(base.fileContext)
    expect(result.mainAgentState).not.toBe(base.mainAgentState)

    // Shared nested nodes keep their identity (copy-on-write downstream).
    expect(result.mainAgentState.taskMemory).toBe(base.mainAgentState.taskMemory)
    expect(result.mainAgentState.workspaceState).toBe(
      base.mainAgentState.workspaceState,
    )
    expect(result.mainAgentState.messageHistory).not.toBe(
      base.mainAgentState.messageHistory,
    )
    expect(result.mainAgentState.messageHistory[0]).toBe(
      base.mainAgentState.messageHistory[0],
    )

    // Writing into the fresh root/fileContext must never leak into base. The
    // continuing run reassigns fileContext properties wholesale.
    result.fileContext.knowledgeFiles = { 'knowledge.md': 'rebuilt' }
    expect(base.fileContext.knowledgeFiles).toEqual({})

    // The fresh mainAgentState identity makes the maxAgentSteps override
    // visible on the copy without touching base.
    const stepsBefore = base.mainAgentState.stepsRemaining
    const overridden = await applyOverridesToSessionState(undefined, base, {
      maxAgentSteps: stepsBefore + 1,
    })
    expect(overridden.mainAgentState.stepsRemaining).toBe(stepsBefore + 1)
    expect(base.mainAgentState.stepsRemaining).toBe(stepsBefore)

    // The security-map restore boundary still runs: valid entries survive.
    base.mainAgentState.readAuthorizationsByPath = { 'a.ts': true }
    const sanitized = await applyOverridesToSessionState(undefined, base, {})
    expect(sanitized.mainAgentState.readAuthorizationsByPath).toEqual({
      'a.ts': true,
    })
  })
})
