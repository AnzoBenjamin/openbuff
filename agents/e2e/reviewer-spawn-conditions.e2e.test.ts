import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

import { afterAll, describe, expect, test } from 'bun:test'

import { createBase2 } from '../base2/base2'
import {
  hashGateSnapshotDetails,
  isAttestableSnapshotFingerprint,
} from '../base2/gate-fingerprint'
import { editReceipt, feedJson } from '../__tests__/helpers/base2-step-fixtures'
import { extractInlineFunctionSource } from '../__tests__/helpers/extract-inline-function-source'

/**
 * Shared cwd-local scratch parent for this file's mkdtemp children. Each test
 * removes its own mkdtemp child in a finally block; the afterAll below then
 * removes the parent once it is empty so no stray `.base2-test-scratch`
 * directory survives the run, without disturbing other test files that share
 * it.
 */
const SCRATCH_PARENT_DIR = join(process.cwd(), '.base2-test-scratch')

afterAll(() => {
  if (
    existsSync(SCRATCH_PARENT_DIR) &&
    readdirSync(SCRATCH_PARENT_DIR).length === 0
  ) {
    rmSync(SCRATCH_PARENT_DIR, { recursive: true, force: true })
  }
})

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

function finishStep(value: unknown) {
  return {
    stepsComplete: true,
    toolResult: [{ type: 'json', value }],
  } as any
}

/**
 * Shared `base2ActiveWork` fixture seeding a validated, gate-passed, and
 * reviewed agent state. Tests inject their gate-passed file marker, reviewable
 * fingerprint, and review receipts to exercise content-drift, external-symlink,
 * and symlink-content-drift reopen scenarios without ~30 lines of near-identical
 * scaffolding each.
 */
function base2ActiveWorkFixture({
  agentId,
  path,
  durableFingerprint,
  validationSummary,
  gatePassedFileMarkers,
  reviewedReviewableFingerprint = '',
  reviewReceipts = [],
}: {
  agentId: string
  path: string
  durableFingerprint: string
  validationSummary: string
  gatePassedFileMarkers: Record<string, string>
  reviewedReviewableFingerprint?: string
  reviewReceipts?: unknown[]
}) {
  return {
    agentId,
    base2ActiveWork: {
      changedFiles: [path],
      touchedFiles: [path],
      pendingGateFiles: [path],
      gatePassedFiles: [path],
      gatePassedFileMarkers,
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
      reviewedReviewableFingerprint,
      reviewReceipts,
    },
  }
}

function gateFileMarker(path: string): string {
  try {
    // Mirror production readGateFileContentMarker: walk EVERY project-relative
    // segment and record each symlink by its 0-based index within the
    // segments (``${index}:${link}``). Production rejects intermediate escaping
    // symlinks too, not just a final-segment symlink, so a mid-path symlink
    // must still take the symlink-sha256 branch (or the
    // outside-project-symlink rejection) rather than falling back to a plain
    // sha256. This is not a final-segment-only mirror.
    const cwd = process.cwd()
    const absolutePath = resolve(cwd, path)
    const projectRelativePath = relative(cwd, absolutePath)
    if (
      projectRelativePath === '..' ||
      projectRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(projectRelativePath)
    ) {
      return 'unreadable:outside-project'
    }
    const pathSegments = projectRelativePath.split(sep).filter(Boolean)
    const symlinkParts: string[] = []
    let entryPath = cwd
    for (let index = 0; index < pathSegments.length; index += 1) {
      entryPath = join(entryPath, pathSegments[index])
      const entryStat = lstatSync(entryPath)
      if (entryStat.isSymbolicLink()) {
        symlinkParts.push(`${index}:${readlinkSync(entryPath)}`)
        continue
      }
      if (index < pathSegments.length - 1 && !entryStat.isDirectory()) {
        return 'unreadable:not-a-directory'
      }
      if (index === pathSegments.length - 1 && !entryStat.isFile()) {
        return 'unreadable:not-a-file'
      }
    }
    if (pathSegments.length === 0) return 'unreadable:not-a-file'

    const resolvedPath =
      symlinkParts.length > 0 ? realpathSync(absolutePath) : absolutePath
    // Fail closed BEFORE opening: if the resolved target escapes the project
    // root, reject without reading the target bytes.
    if (symlinkParts.length > 0) {
      const resolvedRelative = relative(cwd, resolvedPath)
      if (
        resolvedRelative === '..' ||
        resolvedRelative.startsWith(`..${sep}`) ||
        isAbsolute(resolvedRelative)
      ) {
        return 'unreadable:outside-project-symlink'
      }
    }
    const data = readFileSync(path)
    if (symlinkParts.length > 0) {
      // Per-segment index scheme (``${index}:${link}``), NOT a hardcoded `0:`.
      const hash = createHash('sha256')
        .update(symlinkParts.join('\0'))
        .update('\0')
        .update(data)
        .digest('hex')
      return `symlink-sha256:${hash}:${data.length}`
    }
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
 * Load the REAL production `readGateFileContentMarker` from base2.ts by
 * extracting its inline declaration, transpiling, and evaluating it as a
 * standalone function (no module closure needed: it resolves fs/path/crypto
 * lazily via process.getBuiltinModule / global require at call time). This is
 * the parity oracle the test-local `gateFileMarker` must agree with.
 *
 * Inline extraction is preferred over importing the member from base2 because
 * importing would pull in the whole module and run its top-level module-closure
 * side effects (agent/step registries, provider construction, and other init
 * work) in this test context. Evaluating this one pure helper in isolation
 * keeps the oracle hermetic while still exercising the exact production source.
 */
function loadProductionGateFileContentMarker(): (path: string) => string {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const base2JavaScript = transpiler.transformSync(base2Source)
  const helperSource = extractInlineFunctionSource(
    base2JavaScript,
    'readGateFileContentMarker',
  )
  const fn = new Function(
    `"use strict";\n${helperSource}\nreturn readGateFileContentMarker`,
  ) as () => (path: string) => string
  return fn()
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
    const reviewerSpawn = gen.next(feedJson({ status: ' M src/lifecycle.ts' }))
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStep(editReceipt('.agents/sessions/x/PLAN.md'))).value,
    ).toMatchObject({
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
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
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/lifecycle.ts'] },
    })
    expect(
      gen.next(feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]))
        .value,
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
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      gen.next(feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]))
        .value,
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

  test('resumed session with unrelated dirty reviewable files does not re-arm review', () => {
    // P0-negative as an e2e: a resumed conversation with a durable gate pass on
    // a real file A must NOT re-arm / re-spawn the reviewer when the working
    // tree also contains an unrelated (non-task) dirty reviewable file
    // src/c.ts. That foreign dirt belongs to another tab or tool, not to this
    // conversation's task ledger, so it must not re-open validation/review nor
    // surface as an uncommitted-unvalidated file for the git-committer guard.
    mkdirSync(join(process.cwd(), '.base2-test-scratch'), { recursive: true })
    const tempDir = mkdtempSync(
      join(process.cwd(), '.base2-test-scratch', '.reviewer-resume-foreign-'),
    )
    const absoluteA = join(tempDir, 'a.ts')
    const pathA = relative(process.cwd(), absoluteA).replace(/\\/g, '/')
    const validationSummary = 'No configured file-change hooks ran.'
    const base2 = createBase2('default')
    try {
      // A must be a real, attestable file so its gatePassed marker survives
      // the per-file eviction guard (a ledger entry with no stored marker is
      // treated as drifted and evicted, which would re-arm the gate and break
      // the regression we are asserting).
      writeFileSync(absoluteA, 'export const a = 1\n')
      const marker = `sha256:${createHash('sha256')
        .update(readFileSync(absoluteA))
        .digest('hex')}:${readFileSync(absoluteA).length}`
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          changedFiles: [pathA],
          touchedFiles: [pathA],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [pathA],
          gatePassedFileMarkers: { [pathA]: marker },
          gatePassedPendingFiles: [pathA],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: gateFingerprint(pathA, validationSummary),
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Can you confirm whether those earlier reports still hold',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // A is still dirty + gate-passed; src/c.ts is foreign (not task-related).
      expect(
        gen.next(feedJson({ status: ` M ${pathA}\n M src/c.ts` })).value,
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      const maybePinned = gen.next().value
      if (maybePinned !== 'STEP') {
        // A pinned-state message here must be the concrete task-ledger state
        // (final_response_allowed with the gate already passed), never a
        // re-armed gate message. Assert its exact role and content so a
        // regression that re-arms the reviewer with a different pinned-state
        // add_message cannot be silently consumed.
        expect(maybePinned).toMatchObject({
          toolName: 'add_message',
          input: { role: 'user' },
        })
        const pinnedContent = (maybePinned as any).input.content as string
        expect(pinnedContent).toContain('Current phase: final_response_allowed')
        expect(gen.next().value).toBe('STEP')
      }

      // The foreign dirty file neither re-arms the gate nor gets adopted into
      // the task ledger, so finalization stays open with no pending work.
      expect((agentState as any).base2ActiveWork).toMatchObject({
        changedFiles: [pathA],
        pendingGateFiles: [],
        currentPhase: 'final_response_allowed',
      })
      expect(
        (agentState as any).base2ActiveWork.pendingGateFiles,
      ).not.toContain('src/c.ts')
      expect(
        (agentState as any).base2ActiveWork.unreviewedDirtyReviewableFiles,
      ).toEqual([])
      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([])
      expect((agentState as any).canSuggestFollowups).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('same-size content drift with restored mtime reopens durable validation and review', () => {
    mkdirSync(join(process.cwd(), '.base2-test-scratch'), { recursive: true })
    const tempDir = mkdtempSync(
      join(process.cwd(), '.base2-test-scratch', '.reviewer-gate-drift-'),
    )
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
      const agentState = base2ActiveWorkFixture({
        agentId: 'base2-content-drift',
        path,
        durableFingerprint,
        validationSummary,
        gatePassedFileMarkers: { [path]: originalMarker },
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
      })

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
    mkdirSync(join(process.cwd(), '.base2-test-scratch'), { recursive: true })
    const projectDir = mkdtempSync(
      join(process.cwd(), '.base2-test-scratch', '.reviewer-gate-symlink-'),
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
      const agentState = base2ActiveWorkFixture({
        agentId: 'base2-external-symlink',
        path,
        durableFingerprint,
        validationSummary,
        gatePassedFileMarkers: {
          [path]: 'unreadable:outside-project-symlink',
        },
      })

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
    mkdirSync(join(process.cwd(), '.base2-test-scratch'), { recursive: true })
    const projectDir = mkdtempSync(
      join(
        process.cwd(),
        '.base2-test-scratch',
        '.reviewer-gate-symlink-content-',
      ),
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
      const agentState = base2ActiveWorkFixture({
        agentId: 'base2-symlink-content-drift',
        path,
        durableFingerprint,
        validationSummary,
        gatePassedFileMarkers: {
          [path]: 'unreadable:outside-project-symlink',
        },
      })

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
    const hadRequire = Object.prototype.hasOwnProperty.call(
      globalThis,
      'require',
    )
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
    ).toMatchObject({
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
      gen.next(feedJson({ status: ' M src/owned.ts\n?? src/new.ts' })).value,
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
      ).toMatchObject({
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
    ).toMatchObject({
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

  test('test-local gateFileMarker matches production readGateFileContentMarker (parity guard)', () => {
    // The test-local `gateFileMarker` (and its symlink escape logic) is a hand
    // mirror of the production `readGateFileContentMarker` security-sensitive
    // code path. This parity guard prevents silent drift: it runs BOTH the
    // test mirror and the real extracted production marker on the exact same
    // fixtures and asserts they agree, so the security assertions (e.g.
    // external-symlink rejection) verify the real gate, not just the mirror.
    const productionMarker = loadProductionGateFileContentMarker()
    mkdirSync(join(process.cwd(), '.base2-test-scratch'), { recursive: true })
    const tempDir = mkdtempSync(
      join(process.cwd(), '.base2-test-scratch', '.reviewer-marker-parity-'),
    )
    const externalDir = mkdtempSync(join(tmpdir(), 'reviewer-marker-target-'))
    try {
      const regularAbsolute = join(tempDir, 'a.ts')
      writeFileSync(regularAbsolute, 'export const a = 1\n')
      const regularPath = relative(process.cwd(), regularAbsolute).replace(
        /\\/g,
        '/',
      )
      expect(gateFileMarker(regularPath)).toBe(productionMarker(regularPath))

      const missingAbsolute = join(tempDir, 'missing.ts')
      const missingPath = relative(process.cwd(), missingAbsolute).replace(
        /\\/g,
        '/',
      )
      expect(gateFileMarker(missingPath)).toBe(productionMarker(missingPath))

      // External symlink: both implementations must reject without reading the
      // target. Windows requires elevated privileges to create symlinks; skip there.
      if (process.platform !== 'win32') {
        const target = join(externalDir, 'target.ts')
        writeFileSync(target, 'export const value = 1\n')
        const symlinkAbsolute = join(tempDir, 'fixture.ts')
        try {
          symlinkSync(target, symlinkAbsolute, 'file')
        } catch {
          return
        }
        const symlinkPath = relative(process.cwd(), symlinkAbsolute).replace(
          /\\/g,
          '/',
        )
        expect(gateFileMarker(symlinkPath)).toBe(productionMarker(symlinkPath))
        expect(gateFileMarker(symlinkPath)).toBe(
          'unreadable:outside-project-symlink',
        )
      }

      // Internal symlink (target under cwd): both implementations must RUN the
      // symlink-HASH branch (not the outside-project rejection) and agree on
      // the symlink-sha256 marker, exercising the ``${index}:${link}`` scheme.
      // Nested under a subdir so the symlink is NOT segment index 0 — this
      // catches any drift between a hardcoded `0:` and production's
      // per-segment index. Windows requires elevated privileges for file
      // symlinks; skip there.
      if (process.platform !== 'win32') {
        const internalDir = join(tempDir, 'internal')
        mkdirSync(internalDir, { recursive: true })
        const internalTarget = join(internalDir, 'target.ts')
        writeFileSync(internalTarget, 'export const value = 42\n')
        const linkDir = join(tempDir, 'links')
        mkdirSync(linkDir, { recursive: true })
        const internalSymlinkAbsolute = join(linkDir, 'link.ts')
        try {
          symlinkSync(internalTarget, internalSymlinkAbsolute, 'file')
        } catch {
          return
        }
        const internalSymlinkPath = relative(
          process.cwd(),
          internalSymlinkAbsolute,
        ).replace(/\\/g, '/')
        const internalMarker = gateFileMarker(internalSymlinkPath)
        // Both implementations must exercise (not reject) the symlink branch.
        expect(internalMarker).toMatch(/^symlink-sha256:/)
        expect(internalMarker).toBe(productionMarker(internalSymlinkPath))
      }

      // Mid-path (intermediate-directory) symlink: the symlink is an
      // INTERMEDIATE segment, not the final one, so its final segment is a
      // regular file. Production walkEverySegment records the intermediate link
      // by its own segment index and still returns a symlink-sha256 marker; the
      // mirror must agree rather than falling back to a plain sha256 just
      // because the final segment is not itself a symlink. This closes the gap
      // that only exercised the symlink-hash index branch for final-segment
      // symlinks (index = segment-count-minus-1). Windows requires elevated
      // privileges for symlinks; skip there.
      if (process.platform !== 'win32') {
        const realDir = join(tempDir, 'real')
        const realSubDir = join(realDir, 'sub')
        mkdirSync(realSubDir, { recursive: true })
        const midTarget = join(realSubDir, 'file.ts')
        writeFileSync(midTarget, 'export const value = 7\n')
        const aliasDir = join(tempDir, 'alias')
        let midSymlinkAbsolute: string
        try {
          symlinkSync(realDir, aliasDir, 'dir')
          midSymlinkAbsolute = join(aliasDir, 'sub', 'file.ts')
        } catch {
          return
        }
        const midSymlinkPath = relative(
          process.cwd(),
          midSymlinkAbsolute,
        ).replace(/\\/g, '/')
        const midMarker = gateFileMarker(midSymlinkPath)
        // Production records the intermediate symlink segment with its own
        // index, so the marker must be symlink-sha256 (not plain sha256), and
        // the mirror must agree with production exactly.
        expect(midMarker).toMatch(/^symlink-sha256:/)
        expect(midMarker).toBe(productionMarker(midSymlinkPath))
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(externalDir, { recursive: true, force: true })
    }
  })
})
