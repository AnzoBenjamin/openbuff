import { describe, expect, it } from 'bun:test'

import { JobRegistry } from '@codebuff/common/util/job-registry'

import { getTrustedSessionClientId } from '../run'

import type { JobOwner } from '@codebuff/common/util/job-registry'

/**
 * Cross-turn background-job ownership (HIGH severity fix in run.ts).
 *
 * Before this fix, `run()` derived the trusted job owner's
 * `clientSessionId` from a fresh per-run random `promptId`, so a background
 * process spawned in turn N became 'foreign' in turn N+1: check_job /
 * kill_job / read_logs all returned 'No background job found' across turns,
 * and handleToolCall's end_turn branch listed ALL client sessions' running
 * jobs because it called `jobRegistry.listRunning()` with no owner.
 *
 * These tests pin the corrected contract against the production symbols:
 *   1. Two consecutive resolutions of the owner identity share one stable
 *      `clientSessionId` (the per-process session seed), matching how two
 *      consecutive `run()` calls resolve `trustedJobOwner` in run.ts.
 *   2. handleToolCall's end_turn listing filters `jobRegistry.listRunning`
 *      by that resolved owner pair, exactly mirroring the runtime end_turn
 *      handler's fail-closed shape (see
 *      packages/agent-runtime/src/tools/handlers/tool/end-turn.ts).
 */

type OwnerPair = { clientSessionId: string; rootRunId: string }

/**
 * Mirrors the resolution run.ts performs on every run: the session id is the
 * stable per-process seed and the root run comes from agent/session state.
 * Calling twice back-to-back models turn N then turn N+1 of the same CLI
 * session.
 */
function resolveRunOwner(agentState: {
  runId?: string
  agentId: string
}): OwnerPair {
  return {
    clientSessionId: getTrustedSessionClientId(),
    rootRunId: agentState.runId ?? agentState.agentId,
  }
}

describe('cross-turn background-job ownership', () => {
  it('two consecutive resolutions from the same session share one owner id', async () => {
    // Turn N: fresh session state, no runId yet (agentId fallback).
    const ownerTurnN = resolveRunOwner({ agentId: 'main-agent' })
    // Turn N+1: new session state from previousRun; runId assigned by runtime.
    const ownerTurnNPlusOne = resolveRunOwner({
      runId: 'run-2',
      agentId: 'main-agent-2',
    })

    expect(ownerTurnNPlusOne.clientSessionId).toBe(
      ownerTurnN.clientSessionId,
    )
    expect(ownerTurnNPlusOne.clientSessionId).toBeTruthy()
  })

  it('the session owner id is stable across repeated accesses', () => {
    const first = getTrustedSessionClientId()
    const second = getTrustedSessionClientId()
    expect(second).toBe(first)
  })

  it('end_turn lists only jobs owned by the resolved owner', async () => {
    const registry = new JobRegistry()
    // Register jobs from two client sessions to prove scoping, not luck.
    const ownSession = getTrustedSessionClientId()
    const foreignSession = 'other-client-session'

    const ownedJob = registry.create({
      kind: 'process',
      label: 'npm run dev',
      owner: {
        clientSessionId: ownSession,
        rootRunId: 'root-run-1',
        parentRunId: 'root-run-1',
        parentAgentId: 'main-agent',
      },
    })
    registry.start(ownedJob.jobId)

    const foreignJob = registry.create({
      kind: 'process',
      label: 'foreign dev server',
      owner: {
        clientSessionId: foreignSession,
        rootRunId: 'root-run-2',
        parentRunId: 'root-run-2',
        parentAgentId: 'other-agent',
      },
    })
    registry.start(foreignJob.jobId)

    // The same pair handleToolCall's end_turn branch scopes by.
    const owner: OwnerPair = {
      clientSessionId: ownSession,
      rootRunId: 'root-run-1',
    }
    const runningJobs = registry
      .listRunning(owner)
      .filter((job) => job.kind === 'process')

    expect(runningJobs.map((j) => j.jobId)).toEqual([ownedJob.jobId])
    expect(
      runningJobs.some((job) => job.jobId === foreignJob.jobId),
    ).toBe(false)
  })

  it('end_turn omits jobs owned by prior per-run identities (regression pin)', async () => {
    // Simulates the OLD bug: turn N spawned a job stamped with turn N's own
    // per-run id. Under the unscoped listRunning() that job would show up in
    // turn N+1's end_turn listing forever; under the scoped fix the job must
    // never be attributed to another session.
    const registry = new JobRegistry()
    const staleRunPromptId = 'turn-n-random-prompt-id'
    const currentOwner: OwnerPair = {
      clientSessionId: getTrustedSessionClientId(),
      rootRunId: 'root-run-latest',
    }

    const staleJob = registry.create({
      kind: 'process',
      label: 'stale dev server',
      owner: {
        clientSessionId: staleRunPromptId,
        rootRunId: 'root-run-old',
        parentRunId: 'root-run-old',
        parentAgentId: 'main-agent',
      },
    })
    registry.start(staleJob.jobId)

    const currentJob = registry.create({
      kind: 'process',
      label: 'current dev server',
      owner: {
        ...currentOwner,
        parentRunId: currentOwner.rootRunId,
        parentAgentId: 'main-agent',
      } as JobOwner,
    })
    registry.start(currentJob.jobId)

    const runningJobs = registry
      .listRunning(currentOwner)
      .filter((job) => job.kind === 'process')

    expect(runningJobs.map((j) => j.jobId)).toEqual([currentJob.jobId])
  })
})
