import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createBase2 } from '../base2/base2'
import {
  hashGateSnapshotDetails,
  isAttestableSnapshotFingerprint,
} from '../base2/gate-fingerprint'

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

/** Minimal pushed background-job digest payload for the post-git_status list_jobs yield. */
const LIST_JOBS_RESULT = {
  jobs: [],
  note: 'No action required unless you need this output.',
}

function feedListJobs() {
  return feedJson(LIST_JOBS_RESULT)
}

function gateFileMarker(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const linkText = readlinkSync(path)
      // Mirror production: reject symlinks whose resolved target escapes cwd.
      const cwd = process.cwd()
      const absolutePath = resolve(cwd, path)
      const resolvedPath = realpathSync(absolutePath)
      const resolvedRelative = relative(cwd, resolvedPath)
      if (
        resolvedRelative === '..' ||
        resolvedRelative.startsWith(`..${sep}`) ||
        isAbsolute(resolvedRelative)
      ) {
        return 'unreadable:outside-project-symlink'
      }
      const data = readFileSync(path)
      const hash = createHash('sha256')
        .update(`0:${linkText}`)
        .update('\0')
        .update(data)
        .digest('hex')
      return `symlink-sha256:${hash}:${data.length}`
    }
    const data = readFileSync(path)
    return `sha256:${createHash('sha256').update(data).digest('hex')}:${data.length}`
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'unknown')
        : 'unknown'
    return code === 'ENOENT' ? 'missing' : `unreadable:${code}`
  }
}

function gateFingerprint(path: string, validationSummary = ''): string {
  const marker = gateFileMarker(path)
  const details = `files-v4\n${path}\t${marker}\n--\n${validationSummary}`
  return `v3:${createHash('sha256').update(details).digest('hex')}`
}

function reviewableFingerprint(path: string): string {
  return gateFingerprint(path)
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
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
      input: {},
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
      toolName: 'list_jobs',
      input: {},
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
      input: {},
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
      toolName: 'list_jobs',
      input: {},
    })

    const skippedGate = gen.next(feedListJobs())
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStep(editReceipt('.agents/sessions/x/PLAN.md'))).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ' M .agents/sessions/x/PLAN.md' })).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    const skipped = gen.next(feedListJobs())
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStep(editReceipt('src/lifecycle.ts'))).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ' M src/lifecycle.ts' })).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })

    const noEditsGate = gen.next(feedListJobs())
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
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).done).toBe(true)
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
    expect(
      gen.next(feedJson({ status: ' M src/lifecycle.ts' })).value,
    ).toMatchObject({ toolName: 'list_jobs' })

    const blocked = gen.next(feedListJobs())
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

  test('unreviewed resumed pending file already committed cannot finalize', () => {
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
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/lifecycle.ts'] },
    })
    expect(
      gen.next(
        feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
      ).value,
    ).toMatchObject({ toolName: 'git_status' })
    const reviewerSpawn = gen.next(feedJson({ status: '' }))
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'awaiting_review',
      pendingGateFiles: ['src/lifecycle.ts'],
      reviewedReviewableFingerprint: '',
      reviewReceipts: [],
    })
  })

  test('matching durable review evidence skips clean resumed pending file', () => {
    const base2 = createBase2('default')
    const fingerprint = reviewableFingerprint('src/lifecycle.ts')
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
        reviewedReviewableFingerprint: fingerprint,
        reviewReceipts: [
          {
            gateId: `code-reviewer:${fingerprint}`,
            reviewer: 'code-reviewer',
            verdict: 'LOOKS_GOOD',
            snapshotFingerprint: fingerprint,
            reviewedFiles: ['src/lifecycle.ts'],
            reviewedFileCount: 1,
            dimensions: {},
            findings: [],
            findingCount: 0,
            requirementCoverage: [],
            requirementCoverageCount: 0,
            recordedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Now commit the previous lifecycle change.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      gen.next(
        feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
      ).value,
    ).toMatchObject({ toolName: 'git_status' })
    const reviewerSkip = gen.next(feedJson({ status: '' }))
    expect(reviewerSkip.value).toMatchObject({ toolName: 'add_message' })
    expect((reviewerSkip.value as any).input.content).toContain(
      'Reviewer gate skipped',
    )
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'add_message',
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
    })
  })

  test('same-size content drift with restored mtime reopens durable validation and review', () => {
    const tempDir = mkdtempSync(join(process.cwd(), '.reviewer-gate-drift-'))
    const absolutePath = join(tempDir, 'fixture.ts')
    const path = relative(process.cwd(), absolutePath).replace(/\\/g, '/')
    const validationSummary = 'Hook typecheck passed.'

    try {
      writeFileSync(absolutePath, 'export const value = 1\n')
      const originalStat = statSync(absolutePath)
      const originalData = readFileSync(absolutePath)
      const originalMarker = `sha256:${createHash('sha256').update(originalData).digest('hex')}:${originalData.length}`
      const reviewedFingerprint = reviewableFingerprint(path)
      const durableFingerprint = gateFingerprint(path, validationSummary)
      const agentState = {
        agentId: 'base2-content-drift',
        base2ActiveWork: {
          changedFiles: [path],
          touchedFiles: [path],
          pendingGateFiles: [path],
          gatePassedFiles: [path],
          gatePassedFileMarkers: { [path]: originalMarker },
          gatePassedPendingFiles: [],
          gatePassedFingerprint: durableFingerprint,
          gatePassedValidationSummary: validationSummary,
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          reviewedReviewableFingerprint: reviewedFingerprint,
          reviewReceipts: [
            {
              gateId: `code-reviewer:${reviewedFingerprint}`,
              reviewer: 'code-reviewer',
              verdict: 'LOOKS_GOOD',
              snapshotFingerprint: reviewedFingerprint,
              reviewedFiles: [path],
              reviewedFileCount: 1,
              dimensions: {},
              findings: [],
              findingCount: 0,
              requirementCoverage: [],
              requirementCoverageCount: 0,
              recordedAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        },
      }

      const base2 = createBase2('default')
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the validated and reviewed change.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      writeFileSync(absolutePath, 'export const value = 2\n')
      utimesSync(absolutePath, originalStat.atime, originalStat.mtime)
      const changedStat = statSync(absolutePath)
      const changedData = readFileSync(absolutePath)
      const changedMarker = `sha256:${createHash('sha256').update(changedData).digest('hex')}:${changedData.length}`
      expect(changedStat.size).toBe(originalStat.size)
      expect(Math.trunc(changedStat.mtimeMs)).toBe(
        Math.trunc(originalStat.mtimeMs),
      )
      expect(changedMarker).not.toBe(originalMarker)

      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'list_jobs',
      })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect((agentState as any).base2ActiveWork).toMatchObject({
        currentPhase: 'awaiting_validation',
        pendingGateFiles: [path],
        gatePassedFiles: [],
        gatePassedFileMarkers: {},
        gatePassedPendingFiles: [],
        gatePassedFingerprint: durableFingerprint,
        latestWorkSummary:
          'A previously gate-passed file changed after crediting; validation and review were reopened.',
      })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'list_jobs',
      })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [path] },
      })
      expect(
        gen.next(
          feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
        ).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('external symlink is rejected without reading its target', () => {
    const projectDir = mkdtempSync(
      join(process.cwd(), '.reviewer-gate-symlink-'),
    )
    const externalDir = mkdtempSync(join(tmpdir(), 'reviewer-gate-target-'))
    const target = join(externalDir, 'target.ts')
    const absolutePath = join(projectDir, 'fixture.ts')
    const path = relative(process.cwd(), absolutePath).replace(/\\/g, '/')
    const validationSummary = 'Hook typecheck passed.'

    try {
      writeFileSync(target, 'export const value = 1\n')
      // Windows requires elevated privileges to create symlinks; skip there.
      if (process.platform === 'win32') {
        try {
          symlinkSync(target, absolutePath, 'file')
        } catch {
          return
        }
      } else {
        symlinkSync(target, absolutePath, 'file')
      }
      // External symlinks are rejected without reading the target.
      expect(gateFileMarker(path)).toBe('unreadable:outside-project-symlink')

      const reviewedFingerprint = reviewableFingerprint(path)
      const durableFingerprint = gateFingerprint(path, validationSummary)
      const agentState = {
        agentId: 'base2-external-symlink',
        base2ActiveWork: {
          changedFiles: [path],
          touchedFiles: [path],
          pendingGateFiles: [path],
          gatePassedFiles: [path],
          gatePassedFileMarkers: { [path]: 'unreadable:outside-project-symlink' },
          gatePassedPendingFiles: [],
          gatePassedFingerprint: durableFingerprint,
          gatePassedValidationSummary: validationSummary,
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          reviewedReviewableFingerprint: '',
          reviewReceipts: [],
        },
      }

      const base2 = createBase2('default')
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the validated and reviewed symlink change.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // The target file is never read by the marker; its content is unchanged.
      expect(readFileSync(target, 'utf8')).toBe('export const value = 1\n')

      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'list_jobs',
      })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      // The non-attestable marker evicts the file from the durable ledger.
      expect((agentState as any).base2ActiveWork).toMatchObject({
        currentPhase: 'awaiting_validation',
        pendingGateFiles: [path],
        gatePassedFiles: [],
        gatePassedFileMarkers: {},
        latestWorkSummary:
          'A previously gate-passed file changed after crediting; validation and review were reopened.',
      })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'list_jobs',
      })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [path] },
      })
      expect(
        gen.next(
          feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
        ).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  test('external symlink target content drift is rejected without reading target', () => {
    const projectDir = mkdtempSync(
      join(process.cwd(), '.reviewer-gate-symlink-content-'),
    )
    const externalDir = mkdtempSync(join(tmpdir(), 'reviewer-gate-target-'))
    const target = join(externalDir, 'target.ts')
    const absolutePath = join(projectDir, 'fixture.ts')
    const path = relative(process.cwd(), absolutePath).replace(/\\/g, '/')
    const validationSummary = 'Hook typecheck passed.'

    try {
      writeFileSync(target, 'export const value = 1\n')
      // Windows requires elevated privileges to create symlinks; skip there.
      if (process.platform === 'win32') {
        try {
          symlinkSync(target, absolutePath, 'file')
        } catch {
          return
        }
      } else {
        symlinkSync(target, absolutePath, 'file')
      }
      const originalLinkText = readlinkSync(absolutePath)
      // External symlinks are always rejected.
      expect(gateFileMarker(path)).toBe('unreadable:outside-project-symlink')

      const reviewedFingerprint = reviewableFingerprint(path)
      const durableFingerprint = gateFingerprint(path, validationSummary)
      const agentState = {
        agentId: 'base2-symlink-content-drift',
        base2ActiveWork: {
          changedFiles: [path],
          touchedFiles: [path],
          pendingGateFiles: [path],
          gatePassedFiles: [path],
          gatePassedFileMarkers: { [path]: 'unreadable:outside-project-symlink' },
          gatePassedPendingFiles: [],
          gatePassedFingerprint: durableFingerprint,
          gatePassedValidationSummary: validationSummary,
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          reviewedReviewableFingerprint: '',
          reviewReceipts: [],
        },
      }

      const base2 = createBase2('default')
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the validated and reviewed symlink change.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // Mutate the external target; the symlink link text is unchanged.
      writeFileSync(target, 'export const value = 2\n')
      expect(readlinkSync(absolutePath)).toBe(originalLinkText)
      // Still rejected: external symlinks never read the target.
      expect(gateFileMarker(path)).toBe('unreadable:outside-project-symlink')

      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'list_jobs',
      })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect((agentState as any).base2ActiveWork).toMatchObject({
        currentPhase: 'awaiting_validation',
        pendingGateFiles: [path],
        gatePassedFiles: [],
        gatePassedFileMarkers: {},
        latestWorkSummary:
          'A previously gate-passed file changed after crediting; validation and review were reopened.',
      })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'list_jobs',
      })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [path] },
      })
      expect(
        gen.next(
          feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
        ).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  test('hashGateSnapshotDetails fails closed without crypto (no FNV fallback)', () => {
    // The shared hashGateSnapshotDetails resolves node:crypto lazily at call
    // time (never at import time), so deleting both module loaders forces the
    // fail-closed sentinel — proving there is no FNV fallback.
    const hadGetBuiltinModule = Object.prototype.hasOwnProperty.call(
      process,
      'getBuiltinModule',
    )
    const savedGetBuiltinModule = hadGetBuiltinModule
      ? (process as any).getBuiltinModule
      : undefined
    const hadRequire = Object.prototype.hasOwnProperty.call(globalThis, 'require')
    const savedRequire = hadRequire ? (globalThis as any).require : undefined
    try {
      delete (process as any).getBuiltinModule
      delete (globalThis as any).require
      const result = hashGateSnapshotDetails('test-details')
      // Must fail closed, not fall back to FNV.
      expect(result).toBe('unreadable:no-crypto')
      expect(result).not.toMatch(/^v3:fnv1a-/)

      // Non-attestable fingerprints are rejected.
      expect(isAttestableSnapshotFingerprint(result)).toBe(false)
      expect(isAttestableSnapshotFingerprint('v3:fnv1a-12345678')).toBe(false)
      expect(isAttestableSnapshotFingerprint('')).toBe(false)
      // Canonical SHA-256 fingerprints are accepted.
      expect(isAttestableSnapshotFingerprint(`v3:${'a'.repeat(64)}`)).toBe(true)
    } finally {
      if (hadGetBuiltinModule) {
        ;(process as any).getBuiltinModule = savedGetBuiltinModule
      } else {
        delete (process as any).getBuiltinModule
      }
      if (hadRequire) {
        ;(globalThis as any).require = savedRequire
      } else {
        delete (globalThis as any).require
      }
    }
  })

  test('explicit Git delivery adopts turn-start dirty files into validation', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const prompt =
      'Check the full validation gate, then commit and push our current changes'
    const gen = base2.handleSteps!({ agentState, prompt, params: {} } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ' M src/owned.ts\n?? src/new.ts' })).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({ toolName: 'add_message' })
    expect((pinned.value as any).input.content).toContain(
      'Pending validation/reviewer gate files: src/owned.ts, src/new.ts',
    )
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(
        feedJson({ status: ' M src/owned.ts\n?? src/new.ts' }),
      ).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/owned.ts', 'src/new.ts'] },
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/owned.ts', 'src/new.ts'],
      touchedFiles: ['src/owned.ts', 'src/new.ts'],
      pendingGateFiles: ['src/owned.ts', 'src/new.ts'],
      currentPhase: 'awaiting_validation',
    })
  })

  test('explicit Git delivery adopts only reviewable turn-start dirty files', () => {
    // Git-delivery adoption must NOT drag the whole dirty worktree into the
    // gate. Non-reviewable dirt (docs, session STATE.json, jsonl) belongs to
    // the worktree / other tabs, not to this conversation's review; only
    // reviewable source/test files the delivery is committing enter the gate.
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const prompt =
      'Check the full validation gate, then commit and push our current changes'
    const gen = base2.handleSteps!({ agentState, prompt, params: {} } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(
        feedJson({
          status:
            ' M src/owned.ts\n M docs/readme.md\n M .agents/sessions/x/STATE.json\n?? src/new.ts',
        }),
      ).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/owned.ts', 'src/new.ts'],
      touchedFiles: ['src/owned.ts', 'src/new.ts'],
      pendingGateFiles: ['src/owned.ts', 'src/new.ts'],
      currentPhase: 'awaiting_validation',
    })
    // Non-reviewable turn-start dirt is never adopted into the gate.
    expect((agentState as any).base2ActiveWork.pendingGateFiles).not.toContain(
      'docs/readme.md',
    )
    expect((agentState as any).base2ActiveWork.pendingGateFiles).not.toContain(
      '.agents/sessions/x/STATE.json',
    )
  })

  test('non-Git turn does not adopt turn-start dirty files', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const prompt =
      'Check the full validation gate for our current changes, but do not commit'
    const gen = base2.handleSteps!({ agentState, prompt, params: {} } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ' M src/owned.ts\n?? src/new.ts' })).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: [],
      touchedFiles: [],
      pendingGateFiles: [],
    })
  })

  test('advisory Git questions do not adopt turn-start dirty files', () => {
    for (const prompt of [
      'Should I commit changes?',
      'How do I commit changes?',
    ]) {
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2-custom' }
      const gen = base2.handleSteps!({ agentState, prompt, params: {} } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next(feedJson({ status: ' M src/owned.ts\n?? src/new.ts' })).value,
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect((agentState as any).base2ActiveWork).toMatchObject({
        changedFiles: [],
        touchedFiles: [],
        pendingGateFiles: [],
      })
    }
  })

  test('COMMIT ANYWAY bypass phrase does not re-arm the gate or adopt dirty files', () => {
    // Regression: hasExplicitGitDeliveryIntent matched "COMMIT ANYWAY" because it
    // starts with "commit", re-arming the gate (canSuggestFollowups=false) and
    // blocking the very commit the bypass authorizes. The exact standalone
    // phrase must be excluded from delivery-intent classification.
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      messageHistory: [
        { role: 'user', content: 'Please commit the pending changes.' },
        { role: 'assistant', content: 'The validation gate is still pending.' },
        { role: 'user', content: 'COMMIT ANYWAY' },
      ],
      uncommittedUnvalidatedFiles: ['src/owned.ts'],
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'COMMIT ANYWAY',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ' M src/owned.ts\n?? src/new.ts' })).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    // The bypass phrase must NOT adopt turn-start dirty files into the gate.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: [],
      touchedFiles: [],
      pendingGateFiles: [],
    })
    // The bypass flag is published (turn-start recognition), but the gate is
    // not re-armed: canSuggestFollowups stays unset (not forced to false).
    expect((agentState as any).commitScopeBypassAuthorized).toBe(true)
    expect((agentState as any).canSuggestFollowups).toBeUndefined()
  })
})
