import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

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

function finishStepWithToolResult(value: unknown) {
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

const SCRATCH_ROOT = '.e2e-scratch/base2-gate-lifecycle'
const LIFECYCLE_FILE = `${SCRATCH_ROOT}/lifecycle.ts`
const MULTI_BATCH_FILE_A = `${SCRATCH_ROOT}/multi-batch-a.ts`
const MULTI_BATCH_FILE_B = `${SCRATCH_ROOT}/multi-batch-b.ts`
const HAPPY_PATH_FILE = `${SCRATCH_ROOT}/happy-path.ts`
const DELETED_FILE = `${SCRATCH_ROOT}/deleted.ts`

afterEach(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true })
})

function reviewerFingerprintFromSpawn(value: any): string {
  const prompt = value?.input?.agents?.[0]?.prompt
  expect(typeof prompt).toBe('string')
  const match = prompt.match(/Snapshot fingerprint \(echo exactly\): ([^\n]+)/)
  expect(match).not.toBeNull()
  return match![1].trim()
}

function reviewerResult(params: {
  snapshotFingerprint: string
  reviewedFiles: string[]
  verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING'
  findings?: string[]
}) {
  return feedJson({
    schemaVersion: 1,
    verdict: params.verdict,
    snapshotFingerprint: params.snapshotFingerprint,
    reviewedFiles: params.reviewedFiles,
    findings: params.findings ?? [],
    coverage: 'covered',
    dimensions: {
      correctness: 'pass',
      security: 'pass',
      tests: 'pass',
      apiCompatibility: 'pass',
      performance: 'pass',
    },
    requirementCoverage: [],
  })
}

describe('base2 deterministic gate lifecycle e2e', () => {
  test('recovers across validation and reviewer blockers before allowing finalization', () => {
    mkdirSync(path.dirname(LIFECYCLE_FILE), { recursive: true })
    writeFileSync(LIFECYCLE_FILE, 'export const lifecycle = "before"\n')
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Implement the lifecycle change.',
      params: {},
    } as any)

    // Invariant: every lifecycle starts from an explicit working-tree snapshot.
    expect(gen.next().value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })

    // Invariant: context pruning happens before the first model step.
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')

    // Invariant 1: an edit detected after a model step opens the validation gate.
    expect(
      gen.next(finishStepWithToolResult(editReceipt(LIFECYCLE_FILE))).value,
    ).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${LIFECYCLE_FILE}` })).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [LIFECYCLE_FILE] },
    })

    // Invariant 2: a failing validation hook blocks finalization and reopens work.
    const validationFailed = gen.next(
      feedJson([
        {
          hookName: 'typecheck',
          exitCode: 1,
          stderr: 'TS2322: lifecycle value is not assignable',
        },
      ]),
    )
    expect(validationFailed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const validationFailureText = (validationFailed.value as any).input
      .content as string
    expect(validationFailureText).toContain('Verification gate')
    expect(validationFailureText).toContain('TS2322')
    expect(parseGateStateBlock(validationFailureText)).toMatchObject({
      gate: 'validation',
      status: 'failed',
    })

    // Invariant 4: validation blocker state is durable across generator yields.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: [LIFECYCLE_FILE],
      lastReviewerGateSkipReason: 'validation-hook-failures',
      nextRequiredAction:
        'Fix the blocking validation hook failures before doing anything else.',
    })

    // Invariant 3: the recovery iteration still starts with context pruning.
    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const validationPinnedState = gen.next()
    expect(validationPinnedState.value).toMatchObject({
      toolName: 'add_message',
    })
    expect((validationPinnedState.value as any).input.content).toContain(
      'Current phase: blocked',
    )
    expect((validationPinnedState.value as any).input.content).toContain(
      'Last reviewer gate skip/error reason: validation-hook-failures',
    )
    expect(gen.next().value).toBe('STEP')

    // Invariant 5: the model can apply a validation fix in the recovery step.
    expect(
      gen.next(finishStepWithToolResult(editReceipt(LIFECYCLE_FILE))).value,
    ).toMatchObject({ toolName: 'git_status' })
    // Invariant 6: passing validation advances to reviewer instead of finalizing.
    expect(
      gen.next(feedJson({ status: ` M ${LIFECYCLE_FILE}` })).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [LIFECYCLE_FILE] },
    })
    const postValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(postValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const blockingReviewerSpawn = gen.next(
      feedJson({ status: ` M ${LIFECYCLE_FILE}` }),
    )
    expect(blockingReviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })

    // Invariant 7: a BLOCKING reviewer verdict reopens the turn.
    const reviewerBlocked = gen.next(
      reviewerResult({
        snapshotFingerprint: reviewerFingerprintFromSpawn(
          blockingReviewerSpawn.value,
        ),
        reviewedFiles: [LIFECYCLE_FILE],
        verdict: 'BLOCKING',
        findings: ['Handle lifecycle retry idempotently.'],
      }),
    )
    expect(reviewerBlocked.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((reviewerBlocked.value as any).input.content).toContain(
      'BLOCKING: Handle lifecycle retry idempotently.',
    )

    // Invariant 8: reviewer blocker persists and is handed directly to the
    // repair-editor with typed path/tool permissions.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: [LIFECYCLE_FILE],
      openReviewerBlockers: ['BLOCKING: Handle lifecycle retry idempotently.'],
      nextRequiredAction:
        'Resolve the reviewer feedback below before any unrelated work, final response, or another review.',
    })
    const repairEditorSpawn = gen.next()
    expect(repairEditorSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
    })
    const repairAgent = (repairEditorSpawn.value as any).input.agents[0]
    expect(repairAgent.agent_type).toBe('repair-editor')
    expect(repairAgent.handoff.schemaVersion).toBe(1)
    expect(repairAgent.handoff.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          files: [LIFECYCLE_FILE],
          text: 'BLOCKING: Handle lifecycle retry idempotently.',
        }),
      ]),
    )
    // Repair handoffs grant least-privilege READ access: the implicated file,
    // its parent directory, and its package root (here `.e2e-scratch/**/*`),
    // never a project-wide wildcard scope. Writes stay finding-file only.
    expect(repairAgent.handoff.permissions.readablePaths).toEqual(
      expect.arrayContaining([
        LIFECYCLE_FILE,
        `${SCRATCH_ROOT}/**/*`,
        '.e2e-scratch/**/*',
      ]),
    )
    expect(
      new Set(repairAgent.handoff.permissions.readablePaths as string[]),
    ).toEqual(
      new Set([LIFECYCLE_FILE, `${SCRATCH_ROOT}/**/*`, '.e2e-scratch/**/*']),
    )
    expect(repairAgent.handoff.permissions.readablePaths).not.toEqual(
      expect.arrayContaining(['*', '**/*']),
    )
    expect(repairAgent.handoff.permissions.allowedTools).toEqual(
      expect.arrayContaining([
        'read_files',
        'read_outline',
        'read_subtree',
        'edit_transaction',
      ]),
    )
    expect(repairAgent.handoff.permissions.writablePaths).toEqual([
      LIFECYCLE_FILE,
    ])
    const findingIds = (
      repairEditorSpawn.value as any
    ).input.agents[0].handoff.findings.map(
      (finding: { id: string }) => finding.id,
    )
    writeFileSync(LIFECYCLE_FILE, 'export const lifecycle = "after"\n')
    expect(
      gen.next(
        feedJson({
          agentId: 'repair-editor-1',
          agentName: 'Repair Editor',
          agentType: 'repair-editor',
          value: {},
          agentReceipt: {
            schemaVersion: 1,
            receiptId: 'reviewer-repair-receipt',
            status: 'completed',
            changedFiles: [{ path: LIFECYCLE_FILE }],
            findingsAddressed: findingIds,
            requestedValidation: [],
          },
        }),
      ).value,
    ).toMatchObject({ toolName: 'git_status', input: {} })

    // Invariant 9 (regression): after repair-editor makes progress, the gate
    // re-runs validation INLINE — it must not return to a model STEP (which
    // previously let the run end without re-verifying the reviewer verdict).
    expect(
      gen.next(feedJson({ status: ` M ${LIFECYCLE_FILE}` })).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [LIFECYCLE_FILE] },
    })

    // Validation passed inline, so the gate re-enters the loop to run a fresh
    // reviewer (it must NOT re-run validation a second time). The fresh
    // reviewer snapshot is taken against the post-repair tree, so the loop
    // first re-reads git status.
    expect(
      gen.next(feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]))
        .value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }

    // The repair-editor already applied the fix, so the parent model finishes
    // without claiming another edit; the gate then snapshots and reviews.
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
    })
    // Invariant 10: the re-entered loop runs validation hooks before the
    // fresh reviewer (the specialist terminal-failure continue changed the
    // flow so validation re-runs on re-entry).
    const reValidation = gen.next(
      feedJson({ status: ` M ${LIFECYCLE_FILE}` }),
    )
    expect(reValidation.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [LIFECYCLE_FILE] },
    })
    // After validation passes, the fresh reviewer runs.
    const finalPostValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(finalPostValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const finalReviewerSpawn = gen.next(
      feedJson({ status: ` M ${LIFECYCLE_FILE}` }),
    )
    expect(finalReviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    // The repair loop persists the BLOCKING reviewer's family and explicitly
    // re-dispatches it after validation; this is not dependent on aux-gate order.
    expect((agentState as any).base2ActiveWork.requiredReviewerRevalidation).toBe(
      'code-reviewer',
    )

    // Invariant 11: only LOOKS_GOOD permits finalization.
    const finalPreCreditStatus = gen.next(
      reviewerResult({
        snapshotFingerprint: reviewerFingerprintFromSpawn(
          finalReviewerSpawn.value,
        ),
        reviewedFiles: [LIFECYCLE_FILE],
        verdict: 'LOOKS_GOOD',
      }),
    )
    expect(finalPreCreditStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const gatePassed = gen.next(feedJson({ status: ` M ${LIFECYCLE_FILE}` }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const passText = (gatePassed.value as any).input.content as string
    expect(passText).toContain(
      'Automated validation and reviewer gate passed with LOOKS_GOOD',
    )
    expect(parseGateStateBlock(passText)).toMatchObject({
      gate: 'validation/reviewer',
      status: 'passed',
    })

    // Invariant 12: final response is allowed only after all blockers clear.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
      openReviewerBlockers: [],
      nextRequiredAction: '',
      gatePassedPendingFiles: [LIFECYCLE_FILE],
      gatePassedReviewerVerdict: 'LOOKS_GOOD',
    })
    expect((agentState as any).canSuggestFollowups).toBe(true)
  })

  test('validates and credits the cumulative dirty scope for a multi-batch task', () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true })
    writeFileSync(MULTI_BATCH_FILE_A, 'export const batchA = "dirty"\n')
    writeFileSync(MULTI_BATCH_FILE_B, 'export const batchB = "dirty"\n')

    const dirtyStatus = ` M ${MULTI_BATCH_FILE_A}\n M ${MULTI_BATCH_FILE_B}`
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: [MULTI_BATCH_FILE_A, MULTI_BATCH_FILE_B],
        touchedFiles: [MULTI_BATCH_FILE_A, MULTI_BATCH_FILE_B],
        pendingGateFiles: [MULTI_BATCH_FILE_B],
        gatePassedFiles: [],
        gatePassedFileMarkers: {},
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(gen.next(feedJson({ status: dirtyStatus })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const hooks = gen.next(feedJson({ status: dirtyStatus }))
    expect(hooks.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [MULTI_BATCH_FILE_A, MULTI_BATCH_FILE_B] },
    })
    expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([
      MULTI_BATCH_FILE_B,
    ])

    const postValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(postValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const reviewerSpawn = gen.next(feedJson({ status: dirtyStatus }))
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const reviewerPrompt = (reviewerSpawn.value as any).input.agents[0]
      .prompt as string
    expect(reviewerPrompt).toContain(
      `Gate-scope changed files: ${MULTI_BATCH_FILE_A}, ${MULTI_BATCH_FILE_B}`,
    )
    expect(reviewerPrompt).toContain(`${MULTI_BATCH_FILE_A}\tsha256:`)
    expect(reviewerPrompt).toContain(`${MULTI_BATCH_FILE_B}\tsha256:`)
    expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([
      MULTI_BATCH_FILE_B,
    ])

    const finalPreCreditStatus = gen.next(
      reviewerResult({
        snapshotFingerprint: reviewerFingerprintFromSpawn(reviewerSpawn.value),
        reviewedFiles: [MULTI_BATCH_FILE_A, MULTI_BATCH_FILE_B],
        verdict: 'LOOKS_GOOD',
      }),
    )
    expect(finalPreCreditStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const gatePassed = gen.next(feedJson({ status: dirtyStatus }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })

    const activeWork = (agentState as any).base2ActiveWork
    expect(activeWork).toMatchObject({
      gatePassedFiles: [MULTI_BATCH_FILE_A, MULTI_BATCH_FILE_B],
      pendingGateFiles: [],
      gatePassedPendingFiles: [MULTI_BATCH_FILE_B],
      currentPhase: 'final_response_allowed',
    })
    expect(activeWork.gatePassedFileMarkers).toMatchObject({
      [MULTI_BATCH_FILE_A]: expect.any(String),
      [MULTI_BATCH_FILE_B]: expect.any(String),
    })

    expect(gen.next().value).toMatchObject({
      toolName: 'git_status',
      input: { include_diff: true },
    })
    expect(gen.next(feedJson({ status: dirtyStatus })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    gen.next()
    expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([])
  })

  test('a happy-path single-edit turn injects the post-gate finalization notice exactly once', () => {
    mkdirSync(path.dirname(HAPPY_PATH_FILE), { recursive: true })
    writeFileSync(HAPPY_PATH_FILE, 'export const happyPath = "before"\n')
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Implement the happy path change.',
      params: {},
    } as any)

    // Every yielded value is collected so the finalization notice can be
    // counted across the whole turn, not just at the gate-pass message.
    const yields: any[] = []
    const drive = (input?: unknown) => {
      const result = gen.next(input as any)
      yields.push(result.value)
      return result.value as any
    }

    expect(drive()).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(drive(feedJson({ status: '' }))).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    // The pinned active-work message is conditional (empty when there is no
    // unresolved gate work), so tolerate its absence.
    const maybePinnedState = drive()
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(drive()).toBe('STEP')
    }

    expect(
      drive(finishStepWithToolResult(editReceipt(HAPPY_PATH_FILE))),
    ).toMatchObject({ toolName: 'git_status', input: {} })
    expect(drive(feedJson({ status: ` M ${HAPPY_PATH_FILE}` }))).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [HAPPY_PATH_FILE] },
    })
    expect(
      drive(feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }])),
    ).toMatchObject({ toolName: 'git_status', input: {} })
    const reviewerSpawn = drive(
      feedJson({ status: ` M ${HAPPY_PATH_FILE}` }),
    )
    expect(reviewerSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    expect(
      drive(
        reviewerResult({
          snapshotFingerprint: reviewerFingerprintFromSpawn(reviewerSpawn),
          reviewedFiles: [HAPPY_PATH_FILE],
          verdict: 'LOOKS_GOOD',
        }),
      ),
    ).toMatchObject({ toolName: 'git_status', input: {} })

    // suggest_followups stays retracted right up to the gate-pass message.
    expect((agentState as any).canSuggestFollowups).toBe(false)
    const gatePassed = drive(feedJson({ status: ` M ${HAPPY_PATH_FILE}` }))
    expect(gatePassed).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((agentState as any).canSuggestFollowups).toBe(true)

    const passText = gatePassed.input.content as string
    expect(passText).toContain(
      'Automated validation and reviewer gate passed with LOOKS_GOOD',
    )
    expect(passText).toContain('Write at most one completion summary per turn')
    expect(parseGateStateBlock(passText)).toMatchObject({
      gate: 'validation/reviewer',
      status: 'passed',
    })

    const finalizationNotices = yields.filter(
      (v: any) =>
        v?.toolName === 'add_message' &&
        typeof v?.input?.content === 'string' &&
        v.input.content.includes(
          'Provide your single user-visible completion summary now',
        ),
    )
    expect(finalizationNotices).toHaveLength(1)
  })

  test('authorizes a deletion through review, credits it with missing, and does not re-arm the gate on the next turn', () => {
    // The file is present for task-tracking then removed BEFORE the gate turn,
    // so git status reports it as deleted (` D`) with no working-file content.
    mkdirSync(path.dirname(DELETED_FILE), { recursive: true })
    writeFileSync(DELETED_FILE, 'export const deleted = "gone"\n')
    rmSync(DELETED_FILE, { force: true })

    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: [DELETED_FILE],
        touchedFiles: [DELETED_FILE],
        pendingGateFiles: [],
        gatePassedFiles: [],
        gatePassedFileMarkers: {},
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

    // Continuity prompt starts from an explicit working-tree snapshot.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(gen.next(feedJson({ status: ` D ${DELETED_FILE}` })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    // The pinned active-work message is conditional (pendingGateFiles is empty),
    // so tolerate its absence before the first model step.
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }

    // The model turns the on-disk deletion into a tracked pending change.
    expect(
      gen.next(finishStepWithToolResult(editReceipt(DELETED_FILE))).value,
    ).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` D ${DELETED_FILE}` })).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [DELETED_FILE] },
    })
    const postValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(postValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const reviewerSpawn = gen.next(feedJson({ status: ` D ${DELETED_FILE}` }))
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })

    // The reviewer attests by absence; the deleted pending change is credited
    // with the stable 'missing' marker.
    const finalPreCreditStatus = gen.next(
      reviewerResult({
        snapshotFingerprint: reviewerFingerprintFromSpawn(reviewerSpawn.value),
        reviewedFiles: [DELETED_FILE],
        verdict: 'LOOKS_GOOD',
      }),
    )
    expect(finalPreCreditStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const gatePassed = gen.next(feedJson({ status: ` D ${DELETED_FILE}` }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })

    const activeWork = (agentState as any).base2ActiveWork
    expect(activeWork.gatePassedFiles).toEqual([DELETED_FILE])
    expect(activeWork.gatePassedFileMarkers[DELETED_FILE]).toBe('missing')
    expect(activeWork).toMatchObject({
      pendingGateFiles: [],
      currentPhase: 'final_response_allowed',
    })

    // Invariant (regression): on the next turn the still-deleted file carries a
    // stored 'missing' === current 'missing', so the gate must NOT re-arm — no
    // run_file_change_hooks re-validation is issued for the deleted path.
    const followupGen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous lifecycle work.',
      params: {},
    } as any)
    expect(followupGen.next().value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      followupGen.next(feedJson({ status: ` D ${DELETED_FILE}` })).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const followupPinnedState = followupGen.next().value
    if (followupPinnedState !== 'STEP') {
      expect(followupPinnedState).toMatchObject({ toolName: 'add_message' })
      expect(followupGen.next().value).toBe('STEP')
    }
    // No new edits: the step completes with an empty tool result and the gate
    // stays closed — uncommittedUnvalidatedFiles never re-adds the deleted path.
    expect(
      followupGen.next(finishStepWithToolResult({})).value,
    ).toMatchObject({ toolName: 'git_status', input: {} })

    const followupActiveWork = (agentState as any).base2ActiveWork
    expect(followupActiveWork.gatePassedFiles).toEqual([DELETED_FILE])
    expect(followupActiveWork.currentPhase).toBe('final_response_allowed')
    expect((agentState as any).uncommittedUnvalidatedFiles).not.toContain(
      DELETED_FILE,
    )

    // Drain the remaining generator to completion with a bounded guard.
    let guard = 0
    let drain = followupGen.next(feedJson({ status: ` D ${DELETED_FILE}` }))
    while (!drain.done && guard < 50) {
      guard++
      const dv = drain.value as any
      if (dv?.toolName === 'git_status') {
        drain = followupGen.next(feedJson({ status: ` D ${DELETED_FILE}` }))
      } else {
        drain = followupGen.next()
      }
    }
    expect(drain.done).toBe(true)
  })
})
