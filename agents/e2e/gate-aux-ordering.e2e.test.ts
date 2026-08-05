import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

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

/** Minimal pushed background-job digest payload for the post-git_status list_jobs yield. */
const LIST_JOBS_RESULT = {
  jobs: [],
  note: 'No action required unless you need this output.',
}

function feedListJobs() {
  return feedJson(LIST_JOBS_RESULT)
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

function writerNoopResult(receiptId: string) {
  const agentReceipt = {
    schemaVersion: 1,
    receiptId,
    status: 'completed',
    changedFiles: [],
    findingsAddressed: [],
    requestedValidation: [],
    completionKind: 'noop',
    evidence: ['Existing coverage already satisfies the requested behavior.'],
  }
  return feedJson({
    agentId: 'aux-writer-1',
    agentName: 'Auxiliary Writer',
    agentType: 'test-writer',
    value: {},
    agentReceipt,
  })
}

function reviewerFingerprintFromSpawn(value: any): string {
  const prompt = value?.input?.agents?.[0]?.prompt
  expect(typeof prompt).toBe('string')
  const match = prompt.match(/Snapshot fingerprint \(echo exactly\): ([^\n]+)/)
  expect(match).not.toBeNull()
  return match![1].trim()
}

/** Gate-owned v3 attestation token from a specialist spawn (params.snapshot_id only). */
function specialistFingerprintFromSpawn(value: any): string {
  const fromParams = value?.input?.agents?.[0]?.params?.snapshot_id
  // Fail closed if the gate-owned spawn param is missing — do not fall back to
  // the prompt line, or e2e would still pass after dropping params.snapshot_id.
  expect(typeof fromParams).toBe('string')
  expect(fromParams.trim().length).toBeGreaterThan(0)
  expect(fromParams).toMatch(/^v3:[a-f0-9]{64}$/)
  return fromParams.trim()
}

function reviewerValue(snapshotFingerprint: string, reviewedFiles: string[]) {
  return {
    schemaVersion: 1,
    family: 'reviewer',
    verdict: 'LOOKS_GOOD',
    snapshotFingerprint,
    reviewedFiles,
    findings: [],
    coverage: 'covered',
    dimensions: {},
    requirementCoverage: [],
  }
}

function reviewerResult(snapshotFingerprint: string, reviewedFiles: string[]) {
  return feedJson(reviewerValue(snapshotFingerprint, reviewedFiles))
}

function spawnedReviewerResult(
  agentType: string,
  snapshotFingerprint: string,
  reviewedFiles: string[],
) {
  return feedJson({
    agentType,
    value: reviewerValue(snapshotFingerprint, reviewedFiles),
  })
}

function staleSpawnedReviewerResult(
  agentType: string,
  snapshotFingerprint: string,
  // Pending files that still need attestation — deliberately NOT listed in
  // reviewedFiles so collectReviewerAttestationIssues reports a coverage gap
  // (protocol retry path). With gate-owned v3, echoing the correct fingerprint
  // alone no longer fails attestation; the gap is required for the retry.
  _pendingFiles: string[],
) {
  return feedJson({
    agentType,
    value: {
      schemaVersion: 1,
      family: 'reviewer',
      verdict: 'BLOCKING',
      snapshotFingerprint,
      // Empty reviewedFiles → attestation issues remain → one evidence refresh.
      reviewedFiles: [] as string[],
      findings: [
        {
          id: 'reliability-reviewer:correctness:stale-snapshot',
          severity: 'critical',
          dimension: 'correctness',
          summary: 'The supplied snapshot is stale and does not match.',
          evidence: ['The current review bundle has a newer snapshot.'],
          correction: 'Refresh the bundle and retry once.',
        },
      ],
      coverage: 'missing',
      dimensions: { correctness: 'block' },
      requirementCoverage: [],
    },
  })
}

function crashedSpawnedReviewerResult(
  agentType: string,
  snapshotFingerprint: string,
  reviewedFiles: string[],
) {
  return feedJson({
    agentType,
    value: {
      ...reviewerValue(snapshotFingerprint, reviewedFiles),
      verdict: 'LOOKS_GOOD',
      runtime: {
        errorMessage: 'Specialist process crashed after emitting its verdict.',
      },
    },
  })
}

// A pending gate file that satisfies ALL THREE pre-reviewer aux predicates in
// a single iteration:
//  - test-writer: non-test source under `cli/src/` -> inferPackageTestCommand
//    returns `'cd cli && bun run typecheck && bun test'` and isNonTestSourceFile
//    is true, so selectTestWriterTargets keeps it.
//  - doc-writer: `cli/src/` -> isPublicApiSourceFile is true, so
//    selectDocWriterTargets keeps it.
//  - security-reviewer: the `auth` path segment is in SECURITY_SENSITIVE_GLOBS,
//    so matchesSecuritySensitiveGlob is true.
const AUX_TRIPLE_FILE = 'cli/src/auth/session.ts'
const AUX_TEST_COMMAND = 'cd cli && bun run typecheck && bun test'

// All aux gates use spawn_agent_inline with includeToolCall:false.
const AUX_AGENT_TYPES = ['test-writer', 'doc-writer', 'security-reviewer']

function isAuxSpawn(value: any): boolean {
  return (
    value?.toolName === 'spawn_agent_inline' &&
    AUX_AGENT_TYPES.includes(value?.input?.agent_type)
  )
}

describe('base2 pre-reviewer aux gate ordering e2e', () => {
  test('fires test-writer -> doc-writer -> security-reviewer before validation hooks + code-reviewer, then does not re-spawn', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const prompt =
      'Implement the auth session lifecycle change, add tests, and update docs.'
    const gen = base2.handleSteps!({
      agentState,
      // 'implement' + 'code' triggers shouldProactivelyQueryIndex.
      prompt,
      params: {},
    } as any)

    // 1) Codebase-oriented prompts first gather indexed context.
    expect(gen.next().value).toMatchObject({
      toolName: 'query_index',
      input: {
        query: prompt,
        limit: 14,
        mode: 'search',
      },
    })

    // 2) Retrieval routing annotation, then working-tree snapshot.
    const retrievalRoute = gen.next(feedJson([])).value
    expect(retrievalRoute).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
      includeToolCall: false,
    })
    expect((retrievalRoute as any).input.content).toContain(
      'Proactive retrieval route',
    )
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })

    // 3) Context pruning before the first model step.
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
      input: {},
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')

    // 4) The model step edits the triple-aux-relevant file, then finishes.
    expect(
      gen.next(finishStepWithToolResult(editReceipt(AUX_TRIPLE_FILE))).value,
    ).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // 5) git_status reports the pending edit -> the aux block fires.
    const environmentYield = gen.next(feedListJobs())
    expect(environmentYield.value).toMatchObject({
      toolName: 'inspect_environment',
      input: {},
      includeToolCall: false,
    })
    const affectedTestsYield = gen.next(feedJson({ workspaces: [] }))
    expect(affectedTestsYield.value).toMatchObject({
      toolName: 'get_affected_tests',
      input: { files: [AUX_TRIPLE_FILE] },
      includeToolCall: false,
    })
    const buildTargetsYield = gen.next(
      feedJson({
        targets: [
          {
            source: AUX_TRIPLE_FILE,
            candidates: [],
            packageRoot: 'cli',
          },
        ],
      }),
    )
    expect(buildTargetsYield.value).toMatchObject({
      toolName: 'get_build_targets',
      input: { files: [AUX_TRIPLE_FILE] },
      includeToolCall: false,
    })
    const testWriterYield = gen.next(feedJson({ targets: [] }))
    // Invariant 1a: test-writer fires FIRST (before validation hooks and
    // code-reviewer), via spawn_agent_inline with includeToolCall:false.
    expect(testWriterYield.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'test-writer',
        params: {
          target_files: [AUX_TRIPLE_FILE],
          test_command: AUX_TEST_COMMAND,
        },
      },
      includeToolCall: false,
    })

    // Invariant 2a: the test-writer yield suspends; the doc-writer if-block
    // only runs AFTER we resume the generator.
    const testValidationYield = gen.next(writerNoopResult('test-writer-noop'))
    expect(testValidationYield.value).toMatchObject({
      toolName: 'spawn_agents',
      input: {
        agents: [
          {
            agent_type: 'basher',
            params: { command: AUX_TEST_COMMAND },
          },
        ],
      },
      includeToolCall: false,
    })
    const docWriterYield = gen.next(
      feedJson([{ command: AUX_TEST_COMMAND, exitCode: 0, stdout: 'ok' }]),
    )
    // Invariant 1b: doc-writer fires SECOND.
    expect(docWriterYield.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'doc-writer',
        params: {
          source_files: [AUX_TRIPLE_FILE],
        },
      },
      includeToolCall: false,
    })

    // Invariant 2b: the doc-writer yield suspends; the security-reviewer
    // if-block only runs AFTER we resume the generator.
    const securityReviewerYield = gen.next(writerNoopResult('doc-writer-noop'))
    // Invariant 1c: security-reviewer fires THIRD.
    expect(securityReviewerYield.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'security-reviewer',
        params: { changed_files: [AUX_TRIPLE_FILE] },
      },
      includeToolCall: false,
    })

    // Invariant 2c: exact aux ordering is test-writer -> doc-writer ->
    // security-reviewer (the THIRD aux yield is security-reviewer, proving the
    // sequence is not shuffled).
    expect((testWriterYield.value as any).input.agent_type).toBe('test-writer')
    expect((docWriterYield.value as any).input.agent_type).toBe('doc-writer')
    expect((securityReviewerYield.value as any).input.agent_type).toBe(
      'security-reviewer',
    )

    // The security gate is not marked done until its yielded reviewer result
    // is resumed and validated.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      testWriterGateDone: true,
      docWriterGateDone: true,
      securityReviewGateDone: false,
      preEditSecurityReviewDone: false,
    })

    // The security gate is resolved by feeding a NON_BLOCKING attesting result
    // that matches the security snapshot. The auth path does NOT route any
    // reliability specialist (that router needs a /state/ /sessions/ /process/
    // segment), so the aux block re-enters the loop directly at context pruning
    // rather than fetching a specialist review bundle.
    const securityFingerprint = (securityReviewerYield.value as any).input
      .params.snapshot_fingerprint as string
    // Invariant 3: after every routed aux gate passes,
    // auxGateFiredThisIteration re-enters the loop at context pruning.
    const reLoopContextPruner = gen.next(
      reviewerResult(securityFingerprint, [AUX_TRIPLE_FILE]),
    )
    expect(reLoopContextPruner.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(isAuxSpawn(reLoopContextPruner.value)).toBe(false)

    // The re-loop re-emits the pinned active-work state (phase is now
    // awaiting_validation with pending gate files).
    const reLoopPinnedState = gen.next()
    expect(reLoopPinnedState.value).toMatchObject({ toolName: 'add_message' })
    expect((reLoopPinnedState.value as any).input.content).toContain(
      'Current phase: awaiting_validation',
    )
    expect((reLoopPinnedState.value as any).input.content).toContain(
      `Pending validation/reviewer gate files: ${AUX_TRIPLE_FILE}`,
    )

    // Re-loop model step: no new edits, same pending set. Finishing drives to
    // git_status, NOT directly to run_file_change_hooks.
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Invariant 4 (no infinite re-spawn loop): with the same aux-relevant
    // pending file set, the done-flags stay true and selectAuxRelevantFiles
    // filters out nothing new, so the aux block skips entirely. The next yield
    // is the FINAL validation gate (run_file_change_hooks). Assert NO
    // spawn_agent_inline for any aux agent_type occurs here.
    const finalValidationGate = gen.next(feedListJobs())
    expect(isAuxSpawn(finalValidationGate.value)).toBe(false)
    expect(finalValidationGate.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [AUX_TRIPLE_FILE] },
    })

    // The done-flags persist across the re-loop (no reset, no respawn).
    expect((agentState as any).base2ActiveWork).toMatchObject({
      testWriterGateDone: true,
      docWriterGateDone: true,
      preEditSecurityReviewDone: true,
    })

    // 8) Passing validation hooks first trigger the post-validation dirty-
    // scope re-derivation (base2 re-runs git_status after hooks to detect
    // hook-driven mutation before freezing the reviewer snapshot), then
    // advance to the code-reviewer spawn_agents gate (the FINAL reviewer
    // gate), NOT another aux spawn.
    const postValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(postValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const reviewerSpawn = gen.next(
      feedJson({ status: ` M ${AUX_TRIPLE_FILE}` }),
    )
    expect(isAuxSpawn(reviewerSpawn.value)).toBe(false)
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })

    // 9) A LOOKS_GOOD reviewer verdict re-checks the final gate scope (base2
    // re-runs git_status once more to confirm the frozen scope/bytes did not
    // drift after review), then finalizes.
    const finalReviewerFingerprint = reviewerFingerprintFromSpawn(
      reviewerSpawn.value,
    )
    const finalGateStatus = gen.next(
      reviewerResult(finalReviewerFingerprint, [AUX_TRIPLE_FILE]),
    )
    expect(finalGateStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const gatePassed = gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` }))
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

    // 10) Finalization clears the pending files and resets per-edit-set aux
    // flags so a future distinct edit set can run them again.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      testWriterGateDone: false,
      docWriterGateDone: false,
      securityReviewGateDone: false,
      preEditSecurityReviewDone: false,
      pendingGateFiles: [],
    })
  })

  test('blocks without finalization when a routed specialist returns stale attestations twice', () => {
    // Route via SPECIALIST_FILE (state/session.ts), which the reliability
    // reviewer router actually matches (cli/src/auth/session.ts does not),
    // so the two-stale-retry terminal-block path fires exactly as intended.
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: specialistSeed(),
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Aux block: the router selects reliability-reviewer for the state/session
    // path; the bundle freezes then the specialist spawns.
    const specialistBundle = gen.next(feedListJobs())
    expect(specialistBundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const protocolSpawn = gen.next(
      feedJson({
        snapshotId: 'specialist-protocol-snapshot',
        files: [SPECIALIST_FILE],
      }),
    )
    expect(protocolSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const protocolFingerprint = specialistFingerprintFromSpawn(
      protocolSpawn.value,
    )

    // A stale attestation (coverage 'missing' + stale-snapshot finding) does
    // NOT attestEverything, so it uses the one bounded evidence refresh/retry
    // while identity stays the gate-owned v3 fingerprint.
    expect(
      gen.next(
        staleSpawnedReviewerResult(
          'reliability-reviewer',
          protocolFingerprint,
          [SPECIALIST_FILE],
        ),
      ).value,
    ).toMatchObject({ toolName: 'get_change_review_bundle' })
    const retrySpawn = gen.next(
      feedJson({ snapshotId: 'specialist-protocol-snapshot-refreshed' }),
    )
    expect(retrySpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: {
        agents: [
          {
            agent_type: 'reliability-reviewer',
          },
        ],
      },
      includeToolCall: false,
    })
    const retryFingerprint = specialistFingerprintFromSpawn(retrySpawn.value)

    // The retry is also stale: fail closed rather than clearing the gate or
    // spawning repair-editor for a reviewer-protocol failure.
    const blocked = gen.next(
      staleSpawnedReviewerResult(
        'reliability-reviewer',
        retryFingerprint,
        [SPECIALIST_FILE],
      ),
    )
    expect(blocked.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
      includeToolCall: false,
    })
    expect((blocked.value as any).input.content).toContain(
      'did not spawn repair-editor or finalize',
    )
    expect(gen.next().done).toBe(true)
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: [SPECIALIST_FILE],
      gatePassedFiles: [],
      lastReviewerGateSkipReason: 'specialist-terminal-failure',
      nextRequiredAction: expect.stringContaining(
        'fresh matching specialist review',
      ),
    })
    expect((agentState as any).base2ActiveWork.openReviewerBlockers).not.toEqual(
      [],
    )
    expect((agentState as any).canSuggestFollowups).toBe(false)
    rmSync(`${SPECIALIST_SCRATCH_ROOT}`, { recursive: true, force: true })
  })

  test('a coverage-complete routed specialist review with a matching gate fingerprint does not block the gate', () => {
    const base2 = createBase2('default')
    // Seed a reliability-reviewer owed marker (the reliability router would not
    // auto-route a bare auth/session.ts path, so the marker forces the routing;
    // mirror the passing 'revalidates an owed specialist reviewer' test). The
    // other aux gates are seeded done so only the specialist gate runs.
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: [AUX_TRIPLE_FILE],
        touchedFiles: [AUX_TRIPLE_FILE],
        pendingGateFiles: [AUX_TRIPLE_FILE],
        currentPhase: 'awaiting_validation',
        openReviewerBlockers: [],
        openReviewerFindings: [
          {
            id: 'reliability-reviewer:correctness:drift-tolerance',
            gateId: 'reliability-reviewer:prior-snapshot',
            text: 'Review the session refresh token write.',
            status: 'open',
            files: [AUX_TRIPLE_FILE],
            snapshotFingerprint: 'prior-snapshot',
            reviewer: 'reliability-reviewer',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gatePassedFiles: [],
        gatePassedPendingFiles: [],
        gatePassedReviewerVerdict: '',
        gatePassedValidationSummary: '',
        gatePassedFingerprint: '',
        lastReviewerGateSkipReason: '',
        reviewReceipts: [],
        testWriterGateDone: true,
        docWriterGateDone: true,
        securityReviewGateDone: true,
        preEditSecurityReviewDone: true,
        specialistReviewGatesDone: [],
        auxGatesLastPendingFiles: [AUX_TRIPLE_FILE],
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // The owed specialist re-routes reliability-reviewer; the bundle freezes
    // and the specialist spawns.
    const bundle = gen.next(feedListJobs())
    expect(bundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn = gen.next(
      feedJson({ snapshotId: 'tolerance-snapshot', files: [AUX_TRIPLE_FILE] }),
    )
    expect(spawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const expectedGateFingerprint = specialistFingerprintFromSpawn(spawn.value)

    // Coverage-complete review that echoes the matching gate-owned v3 fingerprint
    // is a clean PASS (zero attestation issues). This path locks the primary
    // happy path: correct echo + full file coverage does not block the gate.
    const after = gen.next(
      spawnedReviewerResult(
        'reliability-reviewer',
        expectedGateFingerprint,
        [AUX_TRIPLE_FILE],
      ),
    )

    // Invariant: the coverage-complete review is accepted, not terminal-blocked.
    // The gate re-enters the loop at context pruning; it does NOT refresh/retry
    // (no new spawn_agents) and does NOT emit a blocked-phase message.
    expect(after.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect((after.value as any)?.toolName).not.toBe('spawn_agents')
    expect(after.done).toBe(false)

    // The coverage-complete review is credited done and the owed marker is
    // cleared as the gate re-enters the loop at context pruning (after.value
    // above). Assert the accepting work-state invariants directly here; the
    // generator does NOT re-emit a second pinned add_message because the
    // credited-specialist path advances toward finalization rather than a fresh
    // re-loop model step.
    expect((agentState as any).base2ActiveWork).not.toMatchObject({
      currentPhase: 'blocked',
      lastReviewerGateSkipReason: 'specialist-terminal-failure',
    })
    // The coverage-complete reliability review was accepted: no open blockers
    // for reliability-reviewer and the specialist is credited done.
    expect(
      (agentState as any).base2ActiveWork.openReviewerBlockers,
    ).not.toContain(expect.stringContaining('reliability-reviewer'))
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).toContain('reliability-reviewer')
  })

  test('fails closed when a routed specialist crashes alongside a valid LOOKS_GOOD attestation', () => {
    // Route via SPECIALIST_FILE (state/session.ts), which the reliability
    // reviewer router actually matches (cli/src/auth/session.ts does not), so
    // the reliability-reviewer specialist gate the crash targets fires. The
    // other aux gates are seeded done so only the specialist gate runs.
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: specialistSeed(),
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Aux block: the router selects reliability-reviewer for the state/session
    // path; the bundle freezes then the specialist spawns.
    const specialistBundle = gen.next(feedListJobs())
    expect(specialistBundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const crashSpawn = gen.next(
      feedJson({
        snapshotId: 'specialist-crash-snapshot',
        files: [SPECIALIST_FILE],
      }),
    )
    expect(crashSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const crashFingerprint = specialistFingerprintFromSpawn(crashSpawn.value)

    // The specialist LOOKS_GOOD but crashed after emitting its verdict: the
    // gate must fail closed (no repair-editor, no finalize) instead of treating
    // the LOOKS_GOOD verdict as a pass.
    const blocked = gen.next(
      crashedSpawnedReviewerResult(
        'reliability-reviewer',
        crashFingerprint,
        [SPECIALIST_FILE],
      ),
    )
    expect(blocked.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
      includeToolCall: false,
    })
    expect((blocked.value as any).input.content).toContain(
      'did not spawn repair-editor or finalize',
    )
    expect(gen.next().done).toBe(true)
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: [SPECIALIST_FILE],
      gatePassedFiles: [],
      specialistReviewGatesDone: [],
      lastReviewerGateSkipReason: 'specialist-terminal-failure',
      nextRequiredAction: expect.stringContaining(
        'fresh matching specialist review',
      ),
    })
    expect((agentState as any).base2ActiveWork.openReviewerBlockers).toEqual([
      expect.stringContaining('crashed during specialist review'),
    ])
    expect((agentState as any).canSuggestFollowups).toBe(false)
    rmSync(`${SPECIALIST_SCRATCH_ROOT}`, { recursive: true, force: true })
  })

  test('does not re-spawn any aux gate on a second iteration with the same aux-relevant pending file set', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt:
        'Implement the auth session lifecycle change, add tests, and update docs.',
      params: {},
    } as any)

    // Drive to the point where all three aux gates have fired once.
    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'add_message',
      includeToolCall: false,
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'list_jobs',
    })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStepWithToolResult(editReceipt(AUX_TRIPLE_FILE))).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs' })

    // First iteration fires all three aux gates in order.
    const environmentYield = gen.next(feedListJobs())
    expect(environmentYield.value).toMatchObject({
      toolName: 'inspect_environment',
      input: {},
      includeToolCall: false,
    })
    expect(gen.next(feedJson({ workspaces: [] })).value).toMatchObject({
      toolName: 'get_affected_tests',
      input: { files: [AUX_TRIPLE_FILE] },
      includeToolCall: false,
    })
    expect(
      gen.next(
        feedJson({
          targets: [
            {
              source: AUX_TRIPLE_FILE,
              candidates: [],
              packageRoot: 'cli',
            },
          ],
        }),
      ).value,
    ).toMatchObject({
      toolName: 'get_build_targets',
      input: { files: [AUX_TRIPLE_FILE] },
      includeToolCall: false,
    })
    expect(gen.next(feedJson({ targets: [] })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'test-writer' },
    })
    expect(
      gen.next(writerNoopResult('test-writer-noop-2')).value,
    ).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'basher' }] },
      includeToolCall: false,
    })
    expect(
      gen.next(feedJson([{ exitCode: 0, stdout: 'ok' }])).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'doc-writer' },
    })
    const securityReviewerYield = gen.next(
      writerNoopResult('doc-writer-noop-2'),
    )
    expect(securityReviewerYield.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      testWriterGateDone: true,
      docWriterGateDone: true,
      securityReviewGateDone: false,
      preEditSecurityReviewDone: false,
    })

    // The security gate is resolved by feeding a NON_BLOCKING attesting result
    // that matches. No reliability specialist routes for the auth path, so the
    // aux block re-enters the loop directly at context pruning.
    const securityFingerprint = (securityReviewerYield.value as any).input
      .params.snapshot_fingerprint as string
    // The re-loop starts with context-pruner.
    expect(
      gen.next(reviewerResult(securityFingerprint, [AUX_TRIPLE_FILE])).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    // Pinned state + model step with the SAME pending file (no new files added
    // -> aux-relevant snapshot is stable -> no resetAuxGateFlags). This second
    // step makes NO new edit: AUX_TRIPLE_FILE is already in the live
    // changedFiles set from the first iteration, so the scoped git-status sweep
    // still absorbs it. Feeding a fresh edit receipt here would reset the aux
    // gate flags and re-fire the aux gates, defeating the idempotency
    // invariant under test.
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStepWithToolResult({})).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs' })

    // Idempotency invariant: on this second iteration reaching the aux block
    // with the same aux-relevant pending file set, NONE of the three aux gates
    // re-spawn. The next yield goes straight to run_file_change_hooks.
    const secondIterationNext = gen.next(feedListJobs())
    expect(isAuxSpawn(secondIterationNext.value)).toBe(false)
    expect(secondIterationNext.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [AUX_TRIPLE_FILE] },
    })

    // Done-flags remain true (no reset happened).
    expect((agentState as any).base2ActiveWork).toMatchObject({
      testWriterGateDone: true,
      docWriterGateDone: true,
      preEditSecurityReviewDone: true,
    })
  })

  test('security LOOKS_GOOD credit stays fresh when only a plan-session STATUS path is newly dirty', () => {
    const base2 = createBase2('default')
    // Seed test/doc done so only security runs on the first aux pass; keep
    // auxGatesLastPendingFiles aligned so resetAuxGateFlags does not re-arm
    // writers when the non-reviewable STATUS path later joins pending.
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: [AUX_TRIPLE_FILE],
        touchedFiles: [AUX_TRIPLE_FILE],
        pendingGateFiles: [AUX_TRIPLE_FILE],
        currentPhase: 'awaiting_validation',
        openReviewerBlockers: [],
        openReviewerFindings: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gatePassedFiles: [],
        gatePassedPendingFiles: [],
        gatePassedReviewerVerdict: '',
        gatePassedValidationSummary: '',
        gatePassedFingerprint: '',
        lastReviewerGateSkipReason: '',
        reviewReceipts: [],
        testWriterGateDone: true,
        docWriterGateDone: true,
        securityReviewGateDone: false,
        preEditSecurityReviewDone: false,
        specialistReviewGatesDone: [],
        auxGatesLastPendingFiles: [AUX_TRIPLE_FILE],
      },
    }
    const sessionStatusPath = '.agents/sessions/thrash-e2e/STATUS.md'
    const gen = base2.handleSteps!({
      agentState,
      // Non-codebase-intent prompt: no query_index prelude; first yield is
      // turn-start git_status (mirrors specialist seed tests).
      prompt: 'Please finish the pending auth session gate item.',
      params: {},
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // First iteration: security-reviewer only (test/doc already seeded done).
    const securityReviewerYield = gen.next(feedListJobs())
    expect(securityReviewerYield.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: {
        agent_type: 'security-reviewer',
        params: { changed_files: [AUX_TRIPLE_FILE] },
      },
      includeToolCall: false,
    })
    const securityFingerprint = (securityReviewerYield.value as any).input
      .params.snapshot_fingerprint as string
    expect(securityFingerprint).toMatch(/^v3:[a-f0-9]{64}$/)

    // LOOKS_GOOD / NON_BLOCKING attesting result credits security for the
    // reviewable auth file set.
    expect(
      gen.next(reviewerResult(securityFingerprint, [AUX_TRIPLE_FILE])).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      securityReviewGateDone: true,
      preEditSecurityReviewDone: true,
      securityReviewGateFingerprint: securityFingerprint,
    })

    // Second iteration: a non-reviewable plan-session STATUS path becomes
    // newly dirty alongside the auth file. STATUS is not aux-relevant, so
    // resetAuxGateFlags must not clear security credit; the reviewable-only
    // fingerprint must stay fresh.
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStepWithToolResult(editReceipt(sessionStatusPath))).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(
        feedJson({
          status: ` M ${AUX_TRIPLE_FILE}\n M ${sessionStatusPath}`,
        }),
      ).value,
    ).toMatchObject({ toolName: 'list_jobs' })

    // No security-reviewer re-spawn; next yield is the final validation gate.
    const secondIterationNext = gen.next(feedListJobs())
    expect(isAuxSpawn(secondIterationNext.value)).toBe(false)
    expect(
      (secondIterationNext.value as any)?.input?.agent_type,
    ).not.toBe('security-reviewer')
    expect(secondIterationNext.value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      ((secondIterationNext.value as any).input.files as string[]).sort(),
    ).toEqual([AUX_TRIPLE_FILE, sessionStatusPath].sort())

    // Credit stays done and fingerprint unchanged for the auth reviewable set.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      securityReviewGateDone: true,
      preEditSecurityReviewDone: true,
      securityReviewGateFingerprint: securityFingerprint,
      testWriterGateDone: true,
      docWriterGateDone: true,
    })
  })

  test('revalidates an owed specialist reviewer as aux-owned across turns before the final code-reviewer', () => {
    const base2 = createBase2('default')
    // Seed the turn so the marker is already owed to a specialist, simulating
    // a prior-turn blocking reliability-reviewer finding. The other aux gates
    // are seeded done for THIS aux-relevant pending set (and
    // auxGatesLastPendingFiles matches it) so resetAuxGateFlags does not
    // re-arm them: the specialist revalidation is the only owed aux work.
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: [AUX_TRIPLE_FILE],
        touchedFiles: [AUX_TRIPLE_FILE],
        pendingGateFiles: [AUX_TRIPLE_FILE],
        currentPhase: 'awaiting_validation',
        openReviewerBlockers: [
          'BLOCKING: reliability-reviewer:correctness:retry-races - fix the retry race',
        ],
        openReviewerFindings: [
          {
            id: 'reliability-reviewer:correctness:retry-races',
            gateId: 'reliability-reviewer:prior-snapshot',
            text: 'Fix the retry race in the session refresh path.',
            status: 'open',
            files: [AUX_TRIPLE_FILE],
            snapshotFingerprint: 'prior-snapshot',
            reviewer: 'reliability-reviewer',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gatePassedFiles: [],
        gatePassedPendingFiles: [],
        gatePassedReviewerVerdict: '',
        gatePassedValidationSummary: '',
        gatePassedFingerprint: '',
        lastReviewerGateSkipReason: '',
        reviewReceipts: [],
        // Focus the turn on specialist revalidation only.
        testWriterGateDone: true,
        docWriterGateDone: true,
        securityReviewGateDone: true,
        preEditSecurityReviewDone: true,
        specialistReviewGatesDone: [],
        auxGatesLastPendingFiles: [AUX_TRIPLE_FILE],
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      // A NON-codebase-intent prompt: classifyProactiveRetrieval returns
      // undefined, so there is no query_index/retrieval prelude to drive.
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Resumed-state prelude: initial git_status -> context-pruner -> pinned
    // active-work state -> STEP -> post-step git_status. A generator runs no
    // body code (including setup rehydration) until the first next() call, so
    // the marker assertion below must follow this first next().
    expect(gen.next().value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })

    // Setup rehydrates the owed specialist marker from the persisted finding's
    // reviewer provenance (a prior turn's blocking reliability-reviewer
    // finding). It is NOT set in-turn.
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('reliability-reviewer')
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
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
    // The resumed model step makes no new edit; the seeded pending file stays
    // pending, driving the post-step git_status.
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // The test/doc/security aux gates are already satisfied (and the security
    // gate is family-guarded off while a specialist marker is owed), so the
    // specialist aux block is the only owed work. It classifies the marker
    // family as 'specialist', re-includes the owed reliability-reviewer into
    // the routed specialists, freezes a fresh review bundle, and re-fires it
    // via spawn_agents.
    const specialistBundle = gen.next(feedListJobs())
    expect(specialistBundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const specialistSpawn = gen.next(
      feedJson({ snapshotId: 'revalidation-snapshot', files: [AUX_TRIPLE_FILE] }),
    )
    // Invariant 1: the owed specialist re-fires here (reliability-reviewer with
    // the gate-owned v3 snapshot_id), NOT the final code-reviewer.
    expect(specialistSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: {
        agents: [
          {
            agent_type: 'reliability-reviewer',
          },
        ],
      },
      includeToolCall: false,
    })
    const revalidationFingerprint = specialistFingerprintFromSpawn(
      specialistSpawn.value,
    )

    // A passing (NON_BLOCKING, non-stale, attesting) specialist result records
    // the receipt, marks the specialist done, and clears the owed marker
    // (family-guarded clear). The aux block then re-enters the loop at context
    // pruning.
    const reLoopContextPruner = gen.next(
      spawnedReviewerResult(
        'reliability-reviewer',
        revalidationFingerprint,
        [AUX_TRIPLE_FILE],
      ),
    )
    expect(reLoopContextPruner.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    // Invariant 2: a passing specialist result clears the marker to undefined.
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBeUndefined()
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).toEqual(['reliability-reviewer'])

    // Re-loop: pinned state, model step (no new edits), post-step git_status.
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // With the specialist family cleared and its gate done, no aux gate
    // re-fires; the loop advances to the FINAL validation hooks.
    const finalValidationGate = gen.next(feedListJobs())
    expect(isAuxSpawn(finalValidationGate.value)).toBe(false)
    expect(finalValidationGate.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [AUX_TRIPLE_FILE] },
    })

    // Passing hooks trigger the post-validation dirty-scope re-derivation, then
    // the FINAL reviewer spawn.
    const postValidationStatus = gen.next(
      feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
    )
    expect(postValidationStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const reviewerSpawn = gen.next(
      feedJson({ status: ` M ${AUX_TRIPLE_FILE}` }),
    )
    // Invariant 3: the FINAL reviewer is code-reviewer, only reached after the
    // specialist family was cleared (family is now 'none'/'code').
    expect(isAuxSpawn(reviewerSpawn.value)).toBe(false)
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })

    // A passing code-reviewer verdict re-checks the frozen gate scope, then
    // finalizes.
    const finalReviewerFingerprint = reviewerFingerprintFromSpawn(
      reviewerSpawn.value,
    )
    const finalGateStatus = gen.next(
      reviewerResult(finalReviewerFingerprint, [AUX_TRIPLE_FILE]),
    )
    expect(finalGateStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const gatePassed = gen.next(feedJson({ status: ` M ${AUX_TRIPLE_FILE}` }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((gatePassed.value as any).input.content).toContain(
      'Automated validation and reviewer gate passed with LOOKS_GOOD',
    )
    expect(parseGateStateBlock((gatePassed.value as any).input.content)).toMatchObject(
      {
        gate: 'validation/reviewer',
        status: 'passed',
      },
    )

    // Invariant 4: the turn finalizes and the owed marker stays cleared.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
      requiredReviewerRevalidation: undefined,
    })
  })
})

/* ------------------------------------------------------------------------ */
/* Specialist reviewer-gate state machine (repair loop, budget, owed set,    */
/* snapshot-bound credit, no-verdict retry). These tests use a REAL scratch  */
/* file because the specialist repair loop's snapshot-progress guard reads    */
/* live file bytes: a repair-editor receipt with non-empty changedFiles is    */
/* only accepted as progress when the on-disk content marker actually         */
/* changed (postRepairFingerprint !== preRepairFingerprint).                  */
/*                                                                            */
/* Every prompt below is deliberately free of classifyProactiveRetrieval      */
/* code-intent keywords (no fix/implement/refactor/review/test/file/...), so  */
/* the generator emits NO query_index retrieval prelude and the first yield   */
/* is the turn-start git_status.                                              */
/* ------------------------------------------------------------------------ */

const SPECIALIST_SCRATCH_ROOT = '.e2e-scratch/base2-gate-aux-specialist'
// Reliability-routed: the `state` path segment matches the reliability
// reviewer router regex (state/session/process/...), so
// selectSpecialistReviewersInline routes this file to reliability-reviewer.
const SPECIALIST_FILE = `${SPECIALIST_SCRATCH_ROOT}/state/session.ts`

function specialistSeed(overrides: Record<string, unknown> = {}) {
  return {
    changedFiles: [SPECIALIST_FILE],
    touchedFiles: [SPECIALIST_FILE],
    pendingGateFiles: [SPECIALIST_FILE],
    currentPhase: 'awaiting_validation',
    openReviewerBlockers: [],
    openReviewerFindings: [],
    lastValidationSummary: '',
    nextRequiredAction: '',
    lastPinnedStateMessage: '',
    gatePassedFiles: [],
    gatePassedPendingFiles: [],
    gatePassedReviewerVerdict: '',
    gatePassedValidationSummary: '',
    gatePassedFingerprint: '',
    lastReviewerGateSkipReason: '',
    reviewReceipts: [],
    // Focus the turn on the specialist aux block only.
    testWriterGateDone: true,
    docWriterGateDone: true,
    securityReviewGateDone: true,
    preEditSecurityReviewDone: true,
    specialistReviewGatesDone: [],
    auxGatesLastPendingFiles: [SPECIALIST_FILE],
    ...overrides,
  }
}

/**
 * A structured specialist reviewer value that BLOCKS with exactly ONE typed
 * finding. `dimensions` is deliberately empty: collectReviewerBlockers
 * synthesizes an extra `BLOCKING: <dimension> review dimension failed` blocker
 * for every dimension marked 'block', which would double the blocker count (and
 * with it the repair handoff's requirements/findings) for a single finding.
 */
function blockingSpecialistValue(
  snapshotFingerprint: string,
  files: string[],
  finding: { id: string; summary: string },
) {
  return {
    schemaVersion: 1,
    family: 'reviewer',
    verdict: 'BLOCKING',
    snapshotFingerprint,
    reviewedFiles: files,
    findings: [
      {
        id: finding.id,
        severity: 'critical',
        dimension: 'correctness',
        summary: finding.summary,
        evidence: [`${finding.summary} (evidence)`],
        correction: 'Repair the implicated code path.',
      },
    ],
    coverage: 'covered',
    dimensions: {},
    requirementCoverage: [],
  }
}

/** A single-agent spawn_agents result that BLOCKS with one typed finding. */
function blockingSpecialistResult(
  agentType: string,
  snapshotFingerprint: string,
  files: string[],
  finding: { id: string; summary: string },
) {
  return feedJson({
    agentType,
    value: blockingSpecialistValue(snapshotFingerprint, files, finding),
  })
}

/**
 * A BATCHED spawn_agents result carrying one `{ agentType, value }` entry per
 * routed specialist. Every routed agent must appear: extractSpawnedAgentResult
 * matches on agentType, so a missing entry resolves to undefined,
 * collectReviewerAttestationIssues reports a missing structured attestation and
 * the bundle-refresh retry path fires instead of the expected verdict handling.
 * Entries without a `blocking` finding pass (NON_BLOCKING, coverage covered).
 */
function batchedSpecialistResults(
  snapshotFingerprint: string,
  files: string[],
  entries: Array<{
    agentType: string
    blocking?: { id: string; summary: string }
  }>,
) {
  return feedJson(
    entries.map(({ agentType, blocking }) => ({
      agentType,
      value: blocking
        ? blockingSpecialistValue(snapshotFingerprint, files, blocking)
        : reviewerValue(snapshotFingerprint, files),
    })),
  )
}

/**
 * A schema-valid, fully attesting specialist result whose text verdict passes
 * (NON_BLOCKING) but whose coverage is 'missing': collectReviewerBlockers
 * synthesizes a blocking coverage finding regardless of the verdict, so the gate
 * must treat the result as blocking and must not credit the specialist.
 *
 * The adjacent production `!verdict` branch is intentionally NOT exercised by an
 * e2e test: visitForStructuredVerdict only records a structured entry when
 * `verdict` is exactly LOOKS_GOOD/NON_BLOCKING/BLOCKING, so omitting the verdict
 * produces zero structured entries and collectReviewerAttestationIssues rejects
 * the result before the verdict check. Every other verdict-suppressing shape
 * (BLOCKING findings, coverage 'missing', a 'block' dimension) produces a
 * blocker that is also evaluated first, making that branch unreachable from a
 * well-formed spawn result.
 */
function coverageMissingSpecialistResult(
  agentType: string,
  snapshotFingerprint: string,
  files: string[],
) {
  return feedJson({
    agentType,
    value: {
      ...reviewerValue(snapshotFingerprint, files),
      coverage: 'missing',
    },
  })
}

/** A completed repair-editor receipt addressing every supplied finding id. */
function repairReceipt(changedPath: string, findingIds: string[]) {
  return feedJson({
    agentId: 'repair-editor-1',
    agentName: 'Repair Editor',
    agentType: 'repair-editor',
    value: {},
    agentReceipt: {
      schemaVersion: 1,
      receiptId: `specialist-repair-${changedPath}`,
      status: 'completed',
      changedFiles: [{ path: changedPath }],
      findingsAddressed: findingIds,
      requestedValidation: [],
    },
  })
}

/* ------------------------------------------------------------------------ */
/* FINAL code-reviewer repair loop no-progress detection. Uses a REAL scratch */
/* file for the same reason as the specialist loop above: the reviewer        */
/* repair guard compares live pending-file bytes before and after the repair  */
/* spawn, so a receipt-only "repair" must be observable as unchanged bytes.   */
/*                                                                            */
/* The path is deliberately NOT security-sensitive and NOT matched by any      */
/* specialist router pattern, and the prompt carries no test/doc/specialist    */
/* keywords, so the FINAL code-reviewer gate is the only gate that runs.       */
/* ------------------------------------------------------------------------ */

const REVIEWER_REPAIR_FILE = `${SPECIALIST_SCRATCH_ROOT}/lib/widget.ts`

function reviewerRepairSeed(overrides: Record<string, unknown> = {}) {
  return {
    changedFiles: [REVIEWER_REPAIR_FILE],
    touchedFiles: [REVIEWER_REPAIR_FILE],
    pendingGateFiles: [REVIEWER_REPAIR_FILE],
    currentPhase: 'awaiting_validation',
    openReviewerBlockers: [],
    openReviewerFindings: [],
    lastValidationSummary: '',
    nextRequiredAction: '',
    lastPinnedStateMessage: '',
    gatePassedFiles: [],
    gatePassedPendingFiles: [],
    gatePassedReviewerVerdict: '',
    gatePassedValidationSummary: '',
    gatePassedFingerprint: '',
    lastReviewerGateSkipReason: '',
    reviewReceipts: [],
    // Focus the turn on the FINAL reviewer gate only.
    testWriterGateDone: true,
    docWriterGateDone: true,
    securityReviewGateDone: true,
    preEditSecurityReviewDone: true,
    specialistReviewGatesDone: [],
    auxGatesLastPendingFiles: [REVIEWER_REPAIR_FILE],
    ...overrides,
  }
}

/**
 * A BLOCKING final-reviewer result (fed directly, not wrapped in a spawned
 * `{ agentType, value }` entry, exactly like the passing `reviewerResult`
 * helper the final code-reviewer gate consumes).
 */
function blockingReviewerResult(
  snapshotFingerprint: string,
  files: string[],
  finding: { id: string; summary: string },
) {
  return feedJson(
    blockingSpecialistValue(snapshotFingerprint, files, finding),
  )
}

describe('base2 specialist reviewer-gate state machine e2e', () => {
  afterEach(() => {
    rmSync(SPECIALIST_SCRATCH_ROOT, { recursive: true, force: true })
  })

  test('specialist blocking findings drive a repair->revalidate loop with the owed marker set in-turn (G1+G2)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom', base2ActiveWork: specialistSeed() }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Resumed-state prelude: initial git_status -> context-pruner -> pinned
    // state -> STEP -> post-step git_status. The generator runs no body code
    // until the first next().
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Aux block: router selects reliability-reviewer for the state/session
    // path; the bundle freezes then the specialist spawns.
    const bundle = gen.next(feedListJobs())
    expect(bundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-1', files: [SPECIALIST_FILE] }),
    )
    expect(spawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const snap1 = specialistFingerprintFromSpawn(spawn.value)

    // Feed a BLOCKING reliability-reviewer result with one typed finding.
    const finding = {
      id: 'reliability-reviewer:correctness:retry-race',
      summary: 'The session refresh retry races the in-flight token write.',
    }
    const blockingNotice = gen.next(
      blockingSpecialistResult(
        'reliability-reviewer',
        snap1,
        [SPECIALIST_FILE],
        finding,
      ),
    )
    // (c) an add_message tells the model the exact findings go to repair-editor.
    expect(blockingNotice.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((blockingNotice.value as any).input.content).toContain(
      'reliability-reviewer returned blocking findings. The harness will send these exact findings to repair-editor:',
    )
    // (a)+(b) the owed marker and repair phase are set IN-TURN (before any
    // turn boundary), immediately after the blocking result is processed.
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('reliability-reviewer')
    expect((agentState as any).base2ActiveWork.currentPhase).toBe('repair_loop')
    expect(
      (agentState as any).base2ActiveWork.specialistRepairRoundCount,
    ).toBe(1)

    // (d) the next yield is a repair-editor spawn carrying a typed handoff
    // whose requirements/acceptanceCriteria/findings derive ONLY from this
    // reviewer's open findings.
    const repairSpawn = gen.next()
    expect(repairSpawn.value).toMatchObject({ toolName: 'spawn_agents' })
    const repairAgent = (repairSpawn.value as any).input.agents[0]
    expect(repairAgent.agent_type).toBe('repair-editor')
    expect(repairAgent.handoff.schemaVersion).toBe(1)
    expect(repairAgent.handoff.role).toBe('repair-editor')
    expect(repairAgent.handoff.objective).toContain('reliability-reviewer')
    expect(repairAgent.handoff.requirements).toEqual([
      { id: finding.id, text: expect.any(String), required: true },
    ])
    expect(repairAgent.handoff.acceptanceCriteria).toEqual([
      expect.objectContaining({ id: `clear-${finding.id}` }),
    ])
    expect(repairAgent.handoff.findings).toEqual([
      expect.objectContaining({
        id: finding.id,
        files: [SPECIALIST_FILE],
        snapshotFingerprint: snap1,
      }),
    ])
    // Only this reviewer's finding is in the handoff (exactly one).
    expect(repairAgent.handoff.findings).toHaveLength(1)

    // The repair-editor repairs the file: change the real bytes so the
    // snapshot-progress guard observes a drift, then return a completed
    // receipt addressing the finding id.
    writeFileSync(SPECIALIST_FILE, 'export const session = "v2-repaired"\n')
    const repairStatus = gen.next(repairReceipt(SPECIALIST_FILE, [finding.id]))
    expect(repairStatus.value).toMatchObject({ toolName: 'git_status', input: {} })
    // The repair loop re-enters the outer loop at context-pruner.
    const reLoopPruner = gen.next(
      feedJson({ status: ` M ${SPECIALIST_FILE}` }),
    )
    expect(reLoopPruner.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    // The specialist STAYS owed after the repair (it must re-attest).
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('reliability-reviewer')

    // Re-loop: pinned state -> STEP -> post-step git_status -> aux block
    // re-fires the owed specialist against the post-repair bytes.
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    const bundle2 = gen.next(feedListJobs())
    expect(bundle2.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const respawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-2', files: [SPECIALIST_FILE] }),
    )
    expect(respawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const snap2 = specialistFingerprintFromSpawn(respawn.value)

    // The re-attestation passes: the owed marker clears and the specialist is
    // credited done. The aux block re-enters the loop.
    const reLoopPruner2 = gen.next(
      spawnedReviewerResult('reliability-reviewer', snap2, [
        SPECIALIST_FILE,
      ]),
    )
    expect(reLoopPruner2.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBeUndefined()
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).not.toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).toEqual(['reliability-reviewer'])
    expect(
      (agentState as any).base2ActiveWork.specialistRepairRoundCount,
    ).toBe(1)
  })

  test('specialist repair budget exhaustion stops respawning repair-editor and blocks (G2)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    // Explicit hard cap: default createBase2 specialist budget is unlimited
    // (progress-gated). This test needs a finite cap so round 4 blocks.
    const base2 = createBase2('default', { maxSpecialistRepairRounds: 3 })
    const agentState = { agentId: 'base2-custom', base2ActiveWork: specialistSeed() }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
      // Pass programmaticConfig so the finite specialist budget (3) is
      // re-clamped from config rather than only the local handleSteps literal.
      config: base2.programmaticConfig,
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    gen.next(feedListJobs()) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    const finding = {
      id: 'reliability-reviewer:correctness:retry-race',
      summary: 'The session refresh retry races the in-flight token write.',
    }
    // Drive MAX_SPECIALIST_REPAIR_ROUNDS (3) full repair rounds, each of which
    // blocks again, then a 4th blocking result that exhausts the budget.
    let next: IteratorResult<any, any> = gen.next(feedListJobs())
    let budgetNotice: any
    for (let round = 1; round <= 4; round += 1) {
      // `next` is the get_change_review_bundle yield for this round's aux pass.
      expect(next.value).toMatchObject({
        toolName: 'get_change_review_bundle',
        input: {},
        includeToolCall: false,
      })
      const spawn = gen.next(
        feedJson({
          snapshotId: `spec-snap-r${round}`,
          files: [SPECIALIST_FILE],
        }),
      )
      expect(spawn.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'reliability-reviewer' }] },
        includeToolCall: false,
      })
      const roundFingerprint = specialistFingerprintFromSpawn(spawn.value)
      const notice = gen.next(
        blockingSpecialistResult(
          'reliability-reviewer',
          roundFingerprint,
          [SPECIALIST_FILE],
          finding,
        ),
      )
      expect(notice.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect(
        (agentState as any).base2ActiveWork.specialistRepairRoundCount,
      ).toBe(round)

      if (round < 4) {
        // Rounds 1..3 spawn repair-editor with the blocking notice; repair the
        // file (real byte change) and return a completed receipt.
        expect((notice.value as any).input.content).toContain(
          'returned blocking findings',
        )
        expect((agentState as any).base2ActiveWork.currentPhase).toBe(
          'repair_loop',
        )
        const repairSpawn = gen.next()
        expect(repairSpawn.value).toMatchObject({ toolName: 'spawn_agents' })
        expect((repairSpawn.value as any).input.agents[0].agent_type).toBe(
          'repair-editor',
        )
        writeFileSync(
          SPECIALIST_FILE,
          `export const session = "v${round + 1}-repaired"\n`,
        )
        const repairStatus = gen.next(
          repairReceipt(SPECIALIST_FILE, [finding.id]),
        )
        expect(repairStatus.value).toMatchObject({
          toolName: 'git_status',
          input: {},
        })
        // Re-enter the loop: context-pruner -> pinned -> STEP -> git_status ->
        // next round's get_change_review_bundle.
        expect(
          gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
        ).toMatchObject({
          toolName: 'spawn_agent_inline',
          input: { agent_type: 'context-pruner' },
        })
        gen.next() // pinned add_message
        expect(gen.next().value).toBe('STEP')
        gen.next(finishStepWithToolResult({})) // post-step git_status
        expect(
          gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
        ).toMatchObject({ toolName: 'list_jobs', input: {} })
        next = gen.next(feedListJobs())
      } else {
        // Round 4's blocking result exhausts the budget: its add_message is the
        // budget-exhausted notice, not another blocking-findings notice.
        budgetNotice = notice.value
      }
    }

    // The 4th blocking result exhausted the budget: no repair-editor spawn, the
    // phase is blocked, and the nextRequiredAction names the exhausted budget.
    expect((agentState as any).base2ActiveWork.currentPhase).toBe('blocked')
    expect(
      (agentState as any).base2ActiveWork.specialistRepairRoundCount,
    ).toBe(4)
    expect((budgetNotice as any).input.content).toContain(
      'automated repair budget exhausted',
    )
    expect((budgetNotice as any).input.content).toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.nextRequiredAction,
    ).toContain('Specialist repair budget exhausted')
    expect(
      (agentState as any).base2ActiveWork.nextRequiredAction,
    ).toContain('reliability-reviewer')
    // The generator `break`s out of the gate loop after the budget message; the
    // next next() is NOT another repair-editor spawn (the turn ends blocked).
    const after = gen.next()
    const afterValue = after.value as any
    const isRepairSpawn =
      afterValue?.toolName === 'spawn_agents' &&
      afterValue?.input?.agents?.[0]?.agent_type === 'repair-editor'
    expect(isRepairSpawn).toBe(false)
  })

  test('owed set tracks two specialists without cross-reviewer findings clobber (G3)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: specialistSeed({
        openReviewerBlockers: [
          'BLOCKING: reliability-reviewer:correctness:retry-race - fix the retry race',
          'BLOCKING: compatibility-reviewer:api:breaking-change - restore the public contract',
        ],
        openReviewerFindings: [
          {
            id: 'reliability-reviewer:correctness:retry-race',
            gateId: 'reliability-reviewer:prior-snap',
            text: 'Fix the retry race in the session refresh path.',
            status: 'open',
            files: [SPECIALIST_FILE],
            snapshotFingerprint: 'prior-snap',
            reviewer: 'reliability-reviewer',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
          {
            id: 'compatibility-reviewer:api:breaking-change',
            gateId: 'compatibility-reviewer:prior-snap',
            text: 'Restore the public session contract.',
            status: 'open',
            files: [SPECIALIST_FILE],
            snapshotFingerprint: 'prior-snap',
            reviewer: 'compatibility-reviewer',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      }),
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending findings.',
      params: {},
    } as any)

    // First next() runs setup rehydration.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    // Owed set contains BOTH families; requiredReviewerRevalidation is the
    // first-seen one (reliability-reviewer, the first finding's reviewer).
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toEqual(['reliability-reviewer', 'compatibility-reviewer'])
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('reliability-reviewer')

    // Prelude.
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    gen.next(feedListJobs()) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Aux block unions BOTH owed specialists into the routed set. Feed the
    // bundle and capture the two-agent spawn.
    const bundle = gen.next(feedListJobs())
    expect(bundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-g3', files: [SPECIALIST_FILE] }),
    )
    const spawnedTypes = (
      (spawn.value as any).input.agents as Array<{ agent_type: string }>
    ).map((a) => a.agent_type)
    expect(spawnedTypes).toEqual(
      expect.arrayContaining(['reliability-reviewer', 'compatibility-reviewer']),
    )
    const g3Fingerprint = specialistFingerprintFromSpawn(spawn.value)

    // Drive BOTH routed specialists to BLOCK. The batched result must carry an
    // entry for every routed agent, otherwise the missing one fails attestation
    // and the evidence-refresh retry path fires instead of the blocking notice.
    // reliability-reviewer is processed first (router order), and the per-agent
    // loop breaks on the first blocking specialist, so its notice is next.
    const relFinding = {
      id: 'reliability-reviewer:correctness:retry-race',
      summary: 'Fix the retry race in the session refresh path.',
    }
    const compatFinding = {
      id: 'compatibility-reviewer:api:breaking-change',
      summary: 'Restore the public session contract.',
    }
    const notice = gen.next(
      batchedSpecialistResults(g3Fingerprint, [SPECIALIST_FILE], [
        { agentType: 'reliability-reviewer', blocking: relFinding },
        { agentType: 'compatibility-reviewer', blocking: compatFinding },
      ]),
    )
    expect(notice.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((notice.value as any).input.content).toContain(
      'reliability-reviewer returned blocking findings',
    )
    // The compatibility-reviewer finding is still open (not clobbered).
    const openFindings = (agentState as any).base2ActiveWork
      .openReviewerFindings as Array<{ reviewer: string; id: string }>
    expect(openFindings.some((f) => f.reviewer === 'compatibility-reviewer')).toBe(
      true,
    )
    expect(openFindings.some((f) => f.reviewer === 'reliability-reviewer')).toBe(
      true,
    )
    // Both reviewers remain owed.
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toEqual(expect.arrayContaining(['reliability-reviewer', 'compatibility-reviewer']))

    // Repair the reliability finding so the loop can re-enter, then let
    // reliability-reviewer PASS: only its own owed entry clears.
    const repairSpawn = gen.next()
    expect((repairSpawn.value as any).input.agents[0].agent_type).toBe(
      'repair-editor',
    )
    writeFileSync(SPECIALIST_FILE, 'export const session = "v2-repaired"\n')
    const repairStatus = gen.next(repairReceipt(SPECIALIST_FILE, [relFinding.id]))
    expect(repairStatus.value).toMatchObject({ toolName: 'git_status', input: {} })
    // Re-enter loop.
    gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    const bundle2 = gen.next(feedListJobs())
    expect(bundle2.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn2 = gen.next(
      feedJson({ snapshotId: 'spec-snap-g3b', files: [SPECIALIST_FILE] }),
    )
    // Both specialists re-fire (both still owed).
    const spawnedTypes2 = (
      (spawn2.value as any).input.agents as Array<{ agent_type: string }>
    ).map((a) => a.agent_type)
    expect(spawnedTypes2).toEqual(
      expect.arrayContaining(['reliability-reviewer', 'compatibility-reviewer']),
    )
    const g3bFingerprint = specialistFingerprintFromSpawn(spawn2.value)
    // Feed every routed agent again: reliability-reviewer now PASSES while
    // compatibility-reviewer still blocks, so only reliability's owed entry
    // clears and the compatibility blocking notice is the next yield.
    const compatNotice = gen.next(
      batchedSpecialistResults(g3bFingerprint, [SPECIALIST_FILE], [
        { agentType: 'reliability-reviewer' },
        { agentType: 'compatibility-reviewer', blocking: compatFinding },
      ]),
    )
    expect(compatNotice.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((compatNotice.value as any).input.content).toContain(
      'compatibility-reviewer returned blocking findings',
    )
    // Only reliability-reviewer's owed entry cleared; compatibility stays owed.
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toEqual(['compatibility-reviewer'])
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('compatibility-reviewer')
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).toContain('reliability-reviewer')
  })

  test('snapshot-bound specialist credit skips on a matching fingerprint and re-fires on drift (G4)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')

    // --- Part 1: a credited specialist whose stored fingerprint matches the
    // current bytes is SKIPPED (the converse of drift). ---
    {
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2-custom', base2ActiveWork: specialistSeed() }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Please finish the pending reliability finding.',
        params: {},
      } as any)
      expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
      expect(
        gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })
      gen.next(feedListJobs()) // context-pruner
      gen.next() // pinned add_message
      expect(gen.next().value).toBe('STEP')
      gen.next(finishStepWithToolResult({})) // post-step git_status
      expect(
        gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })
      // First aux pass: spawn + PASS reliability-reviewer; credit is stored.
      let next = gen.next(feedListJobs())
      expect(next.value).toMatchObject({
        toolName: 'get_change_review_bundle',
        input: {},
        includeToolCall: false,
      })
      const spawn = gen.next(
        feedJson({ snapshotId: 'spec-snap-c1', files: [SPECIALIST_FILE] }),
      )
      expect(spawn.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'reliability-reviewer' }] },
        includeToolCall: false,
      })
      const c1Fingerprint = specialistFingerprintFromSpawn(spawn.value)
      next = gen.next(
        spawnedReviewerResult('reliability-reviewer', c1Fingerprint, [
          SPECIALIST_FILE,
        ]),
      )
      expect(
        (agentState as any).base2ActiveWork.specialistReviewGatesDone,
      ).toContain('reliability-reviewer')
      const storedFingerprint = (
        (agentState as any).base2ActiveWork.specialistReviewGateFingerprints ?? {}
      )['reliability-reviewer']
      expect(typeof storedFingerprint).toBe('string')
      expect(storedFingerprint.length).toBeGreaterThan(0)
      // Re-enter the loop with NO byte change: the aux block reaches the
      // specialist phase but the credited specialist is skipped (no respawn),
      // so the gate falls through to the final validation hooks.
      expect(next.value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      gen.next() // pinned add_message
      expect(gen.next().value).toBe('STEP')
      gen.next(finishStepWithToolResult({})) // post-step git_status
      expect(
        gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })
      next = gen.next(feedListJobs())
      // No specialist respawn: the next gate yield is NOT a specialist bundle
      // fetch and NOT a reliability-reviewer spawn.
      expect((next.value as any)?.toolName).not.toBe('get_change_review_bundle')
      const isSpecialistSpawn =
        (next.value as any)?.toolName === 'spawn_agents' &&
        ((next.value as any)?.input?.agents ?? []).some(
          (a: any) => a?.agent_type === 'reliability-reviewer',
        )
      expect(isSpecialistSpawn).toBe(false)
    }

    // --- Part 2: a credited specialist whose stored fingerprint does NOT
    // match the current bytes is RE-ROUTED (spawned again). Seed the stored
    // credit fingerprint to a deliberately stale value; the real file bytes
    // (and thus the current specialist credit fingerprint) do not match it. ---
    {
      const base2 = createBase2('default')
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: specialistSeed({
          specialistReviewGatesDone: ['reliability-reviewer'],
          specialistReviewGateFingerprints: {
            'reliability-reviewer': 'v3:deliberately-stale-credit-fingerprint',
          },
        }),
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Please finish the pending reliability finding.',
        params: {},
      } as any)
      expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
      expect(
        gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })
      gen.next(feedListJobs()) // context-pruner
      gen.next() // pinned add_message
      expect(gen.next().value).toBe('STEP')
      gen.next(finishStepWithToolResult({})) // post-step git_status
      expect(
        gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })
      // The aux block must re-route reliability-reviewer because its stored
      // credit fingerprint is stale relative to the current bytes.
      const bundle = gen.next(feedListJobs())
      expect(bundle.value).toMatchObject({
        toolName: 'get_change_review_bundle',
        input: {},
        includeToolCall: false,
      })
      const respawn = gen.next(
        feedJson({ snapshotId: 'spec-snap-c2', files: [SPECIALIST_FILE] }),
      )
      expect(respawn.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'reliability-reviewer' }] },
        includeToolCall: false,
      })
      expect(specialistFingerprintFromSpawn(respawn.value)).toMatch(
        /^v3:[a-f0-9]{64}$/,
      )
    }
  })

  test('a coverage-missing specialist result is treated as blocking and is not credited (G5)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom', base2ActiveWork: specialistSeed() }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    gen.next(feedListJobs()) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Aux pass: the router selects reliability-reviewer for the state/session
    // path; the bundle freezes, then the specialist spawns.
    const bundle = gen.next(feedListJobs())
    expect(bundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-cm1', files: [SPECIALIST_FILE] }),
    )
    expect(spawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const cm1Fingerprint = specialistFingerprintFromSpawn(spawn.value)

    // The result attests correctly and its text verdict is NON_BLOCKING, but
    // coverage 'missing' synthesizes a blocking coverage finding, so the gate
    // takes the blocking path: a blocking notice naming the reviewer.
    const notice = gen.next(
      coverageMissingSpecialistResult('reliability-reviewer', cm1Fingerprint, [
        SPECIALIST_FILE,
      ]),
    )
    expect(notice.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((notice.value as any).input.content).toContain(
      'reliability-reviewer returned blocking findings',
    )
    expect((notice.value as any).input.content).toContain(
      'test coverage missing for changed behavior',
    )

    // Not credited done, owed a fresh re-attestation, and the turn is in repair.
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).not.toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('reliability-reviewer')
    expect((agentState as any).base2ActiveWork.currentPhase).toBe('repair_loop')

    // The blocking notice is followed by the repair-editor spawn.
    const repairSpawn = gen.next()
    expect(repairSpawn.value).toMatchObject({ toolName: 'spawn_agents' })
    expect((repairSpawn.value as any).input.agents[0].agent_type).toBe(
      'repair-editor',
    )
  })

  test('a passing gate leaves no stale owed reviewer and restores the full specialist repair budget (G6)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom', base2ActiveWork: specialistSeed() }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    gen.next(feedListJobs()) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Round 1: the specialist BLOCKS, so it spends one repair round and is owed
    // a fresh re-attestation. Both must be gone once the gate finally passes.
    const bundle = gen.next(feedListJobs())
    expect(bundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-g6', files: [SPECIALIST_FILE] }),
    )
    expect(spawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const g6Fingerprint = specialistFingerprintFromSpawn(spawn.value)
    const finding = {
      id: 'reliability-reviewer:correctness:retry-race',
      summary: 'The session refresh retry races the in-flight token write.',
    }
    gen.next(
      blockingSpecialistResult(
        'reliability-reviewer',
        g6Fingerprint,
        [SPECIALIST_FILE],
        finding,
      ),
    ) // blocking notice
    expect(
      (agentState as any).base2ActiveWork.specialistRepairRoundCount,
    ).toBe(1)
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toContain('reliability-reviewer')

    // Repair with a real byte change, then let the specialist re-attest PASS.
    const repairSpawn = gen.next()
    expect((repairSpawn.value as any).input.agents[0].agent_type).toBe(
      'repair-editor',
    )
    writeFileSync(SPECIALIST_FILE, 'export const session = "v2-repaired"\n')
    gen.next(repairReceipt(SPECIALIST_FILE, [finding.id])) // git_status
    gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    const bundle2 = gen.next(feedListJobs())
    expect(bundle2.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const respawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-g6b', files: [SPECIALIST_FILE] }),
    )
    expect(respawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const g6bFingerprint = specialistFingerprintFromSpawn(respawn.value)
    // The passing re-attestation credits the specialist and re-enters the loop.
    expect(
      gen.next(
        spawnedReviewerResult('reliability-reviewer', g6bFingerprint, [
          SPECIALIST_FILE,
        ]),
      ).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Final validation hooks -> post-validation git_status -> code-reviewer.
    const finalValidation = gen.next(feedListJobs())
    expect(finalValidation.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [SPECIALIST_FILE] },
    })
    expect(
      gen.next(feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]))
        .value,
    ).toMatchObject({ toolName: 'git_status', input: {} })
    const reviewerSpawn = gen.next(
      feedJson({ status: ` M ${SPECIALIST_FILE}` }),
    )
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const finalGateStatus = gen.next(
      reviewerResult(reviewerFingerprintFromSpawn(reviewerSpawn.value), [
        SPECIALIST_FILE,
      ]),
    )
    expect(finalGateStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    const gatePassed = gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` }))
    expect(
      parseGateStateBlock((gatePassed.value as any).input.content),
    ).toMatchObject({ gate: 'validation/reviewer', status: 'passed' })

    // The passing gate must leave the state clean for the NEXT edit set: no
    // owed reviewer (set and scalar) and a full specialist repair/retry budget.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
      requiredReviewerRevalidation: undefined,
    })
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toEqual([])
    expect(
      (agentState as any).base2ActiveWork.specialistRepairRoundCount,
    ).toBe(0)
    expect(
      (agentState as any).base2ActiveWork.specialistNoVerdictCounts,
    ).toEqual({})
  })

  test('a repair round that changes no on-disk bytes blocks as no-progress instead of looping (G7)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom', base2ActiveWork: specialistSeed() }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    gen.next(feedListJobs()) // context-pruner
    gen.next() // pinned add_message
    expect(gen.next().value).toBe('STEP')
    gen.next(finishStepWithToolResult({})) // post-step git_status
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // Round 1: the routed specialist BLOCKS, so repair-editor is spawned.
    const bundle = gen.next(feedListJobs())
    expect(bundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    const spawn = gen.next(
      feedJson({ snapshotId: 'spec-snap-g7', files: [SPECIALIST_FILE] }),
    )
    expect(spawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const g7Fingerprint = specialistFingerprintFromSpawn(spawn.value)
    const finding = {
      id: 'reliability-reviewer:correctness:retry-race',
      summary: 'The session refresh retry races the in-flight token write.',
    }
    const notice = gen.next(
      blockingSpecialistResult(
        'reliability-reviewer',
        g7Fingerprint,
        [SPECIALIST_FILE],
        finding,
      ),
    )
    expect(notice.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const repairSpawn = gen.next()
    expect((repairSpawn.value as any).input.agents[0].agent_type).toBe(
      'repair-editor',
    )
    expect(
      (agentState as any).base2ActiveWork.specialistRepairRoundCount,
    ).toBe(1)

    // The repair-editor returns a completed receipt naming a changed file but
    // NEVER touches the real bytes (the scratch file is deliberately left at
    // "v1"). A receipt alone must not count as progress.
    const repairStatus = gen.next(repairReceipt(SPECIALIST_FILE, [finding.id]))
    expect(repairStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    // The snapshot-progress guard sees postRepairFingerprint ===
    // preRepairFingerprint and exits the gate loop instead of re-spawning
    // repair-editor or re-firing the specialist: the turn ends immediately.
    const afterGuard = gen.next(feedListJobs())
    expect(afterGuard.done).toBe(true)

    // The turn is blocked, the specialist is still owed and uncredited, and the
    // repair budget was NOT spent again by a second automatic round.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: [SPECIALIST_FILE],
      gatePassedFiles: [],
      specialistRepairRoundCount: 1,
      nextRequiredAction: expect.stringContaining(
        'no snapshot-visible progress',
      ),
    })
    expect(
      (agentState as any).base2ActiveWork.latestWorkSummary,
    ).toContain('no workspace fingerprint change')
    expect(
      (agentState as any).base2ActiveWork.owedReviewerRevalidations,
    ).toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.requiredReviewerRevalidation,
    ).toBe('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).not.toContain('reliability-reviewer')
    expect((agentState as any).canSuggestFollowups).toBe(false)
  })

  test('empty-tree change-review bundle does not auto-credit specialists when reviewable pending files exist', () => {
    // RF-1/RF-2/RF-3: an empty bundle (snapshotId present, files: []) must not
    // mark specialists done while specialistPendingFiles is non-empty. The gate
    // still spawns with the gate-owned v3 fingerprint.
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/state`, { recursive: true })
    writeFileSync(SPECIALIST_FILE, 'export const session = "v1"\n')
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: specialistSeed(),
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${SPECIALIST_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    const specialistBundle = gen.next(feedListJobs())
    expect(specialistBundle.value).toMatchObject({
      toolName: 'get_change_review_bundle',
      input: {},
      includeToolCall: false,
    })
    // Empty-tree evidence with non-empty reviewable pending: must still spawn.
    const emptyTreeSpawn = gen.next(
      feedJson({ snapshotId: 'empty-tree', files: [] }),
    )
    expect(emptyTreeSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      includeToolCall: false,
    })
    const emptyTreeFingerprint = specialistFingerprintFromSpawn(
      emptyTreeSpawn.value,
    )
    expect(emptyTreeFingerprint.startsWith('v3:')).toBe(true)
    expect((emptyTreeSpawn.value as any).input.agents[0].params).toMatchObject({
      files: [SPECIALIST_FILE],
      snapshot_id: emptyTreeFingerprint,
    })
    // Not silently credited done before spawn/attestation.
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).not.toContain('reliability-reviewer')
    expect(
      (agentState as any).base2ActiveWork.lastReviewerGateSkipReason,
    ).not.toBe('no-pending-changes-in-snapshot')

    // Completing attestation still credits normally after a real spawn.
    const afterPass = gen.next(
      spawnedReviewerResult('reliability-reviewer', emptyTreeFingerprint, [
        SPECIALIST_FILE,
      ]),
    )
    expect(afterPass.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(
      (agentState as any).base2ActiveWork.specialistReviewGatesDone,
    ).toEqual(['reliability-reviewer'])
  })

  test('a reviewer repair round that changes no on-disk bytes blocks as no-progress instead of looping (G8)', () => {
    mkdirSync(`${SPECIALIST_SCRATCH_ROOT}/lib`, { recursive: true })
    writeFileSync(REVIEWER_REPAIR_FILE, 'export const widget = "v1"\n')
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: reviewerRepairSeed(),
    }
    const gen = base2.handleSteps!({
      agentState,
      // Deliberately free of test/doc keywords AND of specialist-router
      // keywords, so no aux writer gate fires and no specialist is routed for
      // `lib/widget.ts`: the FINAL code-reviewer gate is the only gate.
      prompt: 'Please finish the pending gate item.',
      params: {},
    } as any)

    // Resumed-state prelude.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
    expect(
      gen.next(feedJson({ status: ` M ${REVIEWER_REPAIR_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toBe('STEP')
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
    expect(
      gen.next(feedJson({ status: ` M ${REVIEWER_REPAIR_FILE}` })).value,
    ).toMatchObject({ toolName: 'list_jobs', input: {} })

    // No aux gate is owed, so the loop advances straight to the final
    // validation hooks, then to the post-validation dirty-scope re-derivation.
    const finalValidation = gen.next(feedListJobs())
    expect(isAuxSpawn(finalValidation.value)).toBe(false)
    expect(finalValidation.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: [REVIEWER_REPAIR_FILE] },
    })
    expect(
      gen.next(feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]))
        .value,
    ).toMatchObject({ toolName: 'git_status', input: {} })
    const reviewerSpawn = gen.next(
      feedJson({ status: ` M ${REVIEWER_REPAIR_FILE}` }),
    )
    expect(reviewerSpawn.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })

    // The code-reviewer BLOCKS with one typed finding, so one repair round is
    // spent and repair-editor is spawned with that finding.
    const notice = gen.next(
      blockingReviewerResult(
        reviewerFingerprintFromSpawn(reviewerSpawn.value),
        [REVIEWER_REPAIR_FILE],
        {
          id: 'code-reviewer:correctness:missing-guard',
          summary: 'The widget update path is missing its bounds guard.',
        },
      ),
    )
    expect(notice.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((notice.value as any).input.content).toContain(
      'returned blocking feedback',
    )
    expect(
      (agentState as any).base2ActiveWork.reviewerRepairRoundCount,
    ).toBe(1)
    const repairSpawn = gen.next()
    const repairAgent = (repairSpawn.value as any).input.agents[0]
    expect(repairAgent.agent_type).toBe('repair-editor')
    const findingIds = repairAgent.handoff.findings.map(
      (finding: { id: string }) => finding.id,
    )
    expect(findingIds.length).toBeGreaterThan(0)

    // The repair-editor returns a completed receipt naming a changed file but
    // never changes the real bytes (the scratch file stays at "v1").
    const repairStatus = gen.next(
      repairReceipt(REVIEWER_REPAIR_FILE, findingIds),
    )
    expect(repairStatus.value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })

    // No-progress detection: the gate must NOT re-run validation hooks or spawn
    // another repair round; it exits the loop with the turn blocked.
    const afterGuard = gen.next(
      feedJson({ status: ` M ${REVIEWER_REPAIR_FILE}` }),
    )
    expect(afterGuard.done).toBe(true)
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: [REVIEWER_REPAIR_FILE],
      gatePassedFiles: [],
      reviewerRepairRoundCount: 1,
      lastReviewerGateSkipReason: 'reviewer-repair-no-progress',
      nextRequiredAction: expect.stringContaining(
        'no snapshot-visible progress',
      ),
    })
    expect(
      (agentState as any).base2ActiveWork.latestWorkSummary,
    ).toContain('no workspace fingerprint change')
    expect(
      (agentState as any).base2ActiveWork.openReviewerBlockers,
    ).not.toEqual([])
    expect((agentState as any).canSuggestFollowups).toBe(false)
  })
})
