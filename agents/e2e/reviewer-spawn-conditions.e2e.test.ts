import { describe, expect, test } from 'bun:test'

import { createBase2 } from '../base2/base2'

function parseGateStateBlock(text: string): {
  gate: string
  status: string
  details: string
} {
  const match = text.match(/<gate-state>([\s\S]*?)<\/gate-state>/)
  expect(match).not.toBeNull()
  return JSON.parse(match![1]) as {
    gate: string
    status: string
    details: string
  }
}

function feedJson(value: unknown) {
  return { toolResult: [{ type: 'json', value }] } as any
}

function finishStep(value: unknown) {
  return {
    stepsComplete: true,
    toolResult: [{ type: 'json', value }],
  } as any
}

/**
 * Canonical file_mutation_result receipt (the real production edit-artifact
 * shape) for `path`. Feed this instead of a bare `{ file }` so the edited file
 * lands in the live changedFiles set before the mid-turn git-status sweep.
 */
function editReceipt(path: string) {
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId: `op-${path}`,
    receiptId: `receipt-${path}`,
    outcome: 'applied',
    authorityTier: 'conditional_commit',
    actions: [
      {
        actionId: `action-${path}`,
        index: 0,
        action: 'update',
        path,
        outcome: 'applied',
        beforeHash: 'before',
        afterHash: 'after',
      },
    ],
    authorityReceipt: {
      operationId: `op-${path}`,
      receiptId: `receipt-${path}`,
      actions: [{ actionId: `action-${path}` }],
    },
    errors: [],
    freshCapabilities: [],
  }
}

describe('base2 reviewer spawn conditions e2e', () => {
  test('default mode with edits and passing validation spawns code-reviewer', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2-custom' },
      prompt: 'Edit the lifecycle file.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({
      toolName: 'query_index',
      input: {
        query: 'Edit the lifecycle file.',
        limit: 14,
        mode: 'search',
      },
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
      includeToolCall: false,
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStep(editReceipt('src/lifecycle.ts'))).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ' M src/lifecycle.ts' })).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/lifecycle.ts'] },
    })

    const postValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(postValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const reviewerSpawn = gen.next(
      feedJson({ status: ' M src/lifecycle.ts' }),
    )
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
  })

  test('fast mode skips disabled validation and reviewer gates with explicit state', () => {
    const base2 = createBase2('fast')
    const agentState = { agentId: 'base2-fast' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Edit the lifecycle file quickly.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({
      toolName: 'query_index',
      input: {
        query: 'Edit the lifecycle file quickly.',
        limit: 14,
        mode: 'search',
      },
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
      includeToolCall: false,
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStep(editReceipt('src/lifecycle.ts'))).value,
    ).toMatchObject({
      toolName: 'git_status',
    })

    const skippedGate = gen.next(feedJson({ status: ' M src/lifecycle.ts' }))
    expect(skippedGate.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const skipText = (skippedGate.value as any).input.content as string
    expect(skipText).toContain('validation-and-reviewer-gates-disabled')
    const skipGate = parseGateStateBlock(skipText)
    expect(skipGate).toMatchObject({
      gate: 'validation/reviewer',
      status: 'skipped',
    })
    expect(skipGate.details).toContain('validation-and-reviewer-gates-disabled')
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/lifecycle.ts'],
      pendingGateFiles: ['src/lifecycle.ts'],
      lastReviewerGateSkipReason: 'validation-and-reviewer-gates-disabled',
    })

    const done = gen.next()
    expect(done.done).toBe(true)
  })

  test('PLAN-only skips the automatic finalization gate with an explicit reason', () => {
    const base2 = createBase2('default', { planOnly: true })
    const agentState = { agentId: 'base2-plan' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Plan the lifecycle change in the code.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    expect(gen.next(feedJson([])).value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next(feedJson([])).value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStep(editReceipt('.agents/sessions/x/PLAN.md'))).value).toMatchObject({
      toolName: 'git_status',
    })
    const skipped = gen.next(
      feedJson({ status: ' M .agents/sessions/x/PLAN.md' }),
    )
    expect(skipped.value).toMatchObject({ toolName: 'add_message' })
    const text = (skipped.value as any).input.content as string
    expect(text).toContain('plan-only-automatic-finalization-gate-disabled')
    expect(parseGateStateBlock(text)).toMatchObject({
      gate: 'validation/reviewer',
      status: 'skipped',
    })
    expect(base2.spawnableAgents).toContain('code-reviewer')
  })

  test('EXECUTE_PLAN retains automatic validation before reviewer spawn', () => {
    const base2 = createBase2('default', { executePlan: true })
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2-execute-plan' },
      prompt: 'Execute the lifecycle change in the code.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    expect(gen.next(feedJson([])).value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next(feedJson([])).value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStep(editReceipt('src/lifecycle.ts'))).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ' M src/lifecycle.ts' })).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/lifecycle.ts'] },
    })
  })

  test('no edits detected emits passed no-edits gate and does not spawn reviewer', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Inspect without editing.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })

    const noEditsGate = gen.next(feedJson({ status: '' }))
    expect(noEditsGate.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const noEditsText = (noEditsGate.value as any).input.content as string
    expect(noEditsText).toContain('No edited files were detected.')
    const noEditsState = parseGateStateBlock(noEditsText)
    expect(noEditsState).toMatchObject({
      gate: 'validation/reviewer',
      status: 'passed',
    })
    expect(noEditsState.details).toContain('no edited files were detected')
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
    })

    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).done).toBe(true)
  })

  test('unsafe edits without pending files blocks finalization and skips reviewer', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: ['src/lifecycle.ts'],
        touchedFiles: ['src/lifecycle.ts'],
        pendingGateFiles: [],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous lifecycle work.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ' M src/lifecycle.ts' })).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({ toolName: 'add_message' })
    expect((pinned.value as any).input.content).toContain(
      'Current phase: awaiting_validation',
    )
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })

    const blocked = gen.next(feedJson({ status: ' M src/lifecycle.ts' }))
    expect(blocked.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const blockedText = (blocked.value as any).input.content as string
    expect(blockedText).toContain('edits-detected-without-pending-gate-files')
    expect(blockedText).toContain('cannot safely continue')
    const blockedState = parseGateStateBlock(blockedText)
    expect(blockedState).toMatchObject({
      gate: 'validation/reviewer',
      status: 'failed',
    })
    expect(blockedState.details).toContain(
      'edits-detected-without-pending-gate-files',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/lifecycle.ts'],
      pendingGateFiles: [],
      currentPhase: 'blocked',
      lastReviewerGateSkipReason: 'edits-detected-without-pending-gate-files',
      nextRequiredAction:
        'Unsafe reviewer gate state: edits were detected without pending gate files. Re-read the edited files/status, make a minimal follow-up edit if needed to restore pending gate files, then finish so validation/review can run safely.',
    })
  })

  test('resumed pending file already committed (clean tree) skips reviewer instead of looping', () => {
    // Fix 2: a follow-up turn (e.g. "commit the changes") can reopen the gate
    // on a reviewable pending file whose bytes are already committed. The
    // working tree is clean for that file, so a spawned reviewer could only
    // fail file attestation and loop. The gate must skip the reviewer and
    // treat the pass as green instead. editsHappened is true here because the
    // resumed state carries a pending gate file with an awaiting_validation
    // phase, but git_status reports the reviewable file is NOT dirty.
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: ['src/lifecycle.ts'],
        touchedFiles: ['src/lifecycle.ts'],
        pendingGateFiles: ['src/lifecycle.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Now commit the previous lifecycle change.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    // Turn-start git_status: clean tree (the reviewable file is committed).
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })

    // Post-step git_status: still clean — the pending reviewable file has no
    // working-tree diff. The gate must NOT spawn code-reviewer; it emits a
    // reviewer-skip gate-state and treats the gate as passed. Validation hooks
    // still run on the pending set — only the reviewer spawn is skipped.
    let next = gen.next(feedJson({ status: '' }))
    // Walk any run_file_change_hooks / add_message steps until we reach either
    // a reviewer spawn (bug) or the skip message. Assert we never spawn the
    // reviewer for the clean reviewable set.
    let sawReviewerSpawn = false
    let sawReviewerSkip = false
    for (let i = 0; i < 12 && !next.done; i += 1) {
      const value = next.value as any
      if (
        value?.toolName === 'spawn_agents' &&
        Array.isArray(value?.input?.agents) &&
        value.input.agents.some(
          (agent: any) => agent?.agent_type === 'code-reviewer',
        )
      ) {
        sawReviewerSpawn = true
        break
      }
      if (
        value?.toolName === 'add_message' &&
        typeof value?.input?.content === 'string' &&
        value.input.content.includes('Reviewer gate skipped')
      ) {
        sawReviewerSkip = true
      }
      if (value === 'STEP') break
      next = gen.next(feedJson({ status: '' }))
    }

    expect(sawReviewerSpawn).toBe(false)
    expect(sawReviewerSkip).toBe(true)
    // Structural signal alongside the operator-string check so a reworded skip
    // message cannot silently produce a vacuous pass (both booleans false):
    // the gate must actually reach the green finalization phase.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
    })
  })
})
