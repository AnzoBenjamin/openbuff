import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
let fetchAttempted = 0
globalThis.fetch = Object.assign(
  async () => {
    fetchAttempted++
    throw new Error('Independent specialist consumer refuses fetch')
  },
  { preconnect() {} },
) as typeof fetch
const { createBase2 } = await import('../../../../../../agents/base2/base2')
const { default: reliability } =
  await import('../../../../../../agents/specialists/reliability-reviewer')
const { collectReviewerAttestationIssues } =
  await import('../../../../../../agents/base2/gate-reviewer')
const originalCwd = process.cwd()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-specialist-consumer-'))
const wrap = (value: unknown) => ({ toolResult: [{ type: 'json', value }] })
const reports = []
try {
  for (const kind of [
    'current',
    'foreign-clean',
    'foreign-parent-owned',
    'missing-file',
    'invalid-schema',
    'no-verdict',
    'transient-crash',
    'protocol-crash',
    'current-scoped',
    'retry-positive',
    'scoped-retry-positive',
    'inflight-byte-drift',
    'foreign-windowed-wave',
  ]) {
    const cwd = path.join(root, kind)
    fs.mkdirSync(path.join(cwd, 'state'), { recursive: true })
    const file = 'state/session.ts'
    fs.writeFileSync(path.join(cwd, file), 'export const session = "v1"\n')
    const scoped = kind === 'current-scoped' || kind === 'scoped-retry-positive'
    const positive = kind === 'current' || scoped || kind === 'retry-positive'
    const sibling = 'state/other.ts'
    const siblingBytes = 'export const other = "kept"\n'
    const siblingMarker = `sha256:${createHash('sha256').update(siblingBytes).digest('hex')}:${Buffer.byteLength(siblingBytes)}`
    const windowed = kind === 'foreign-windowed-wave'
    const files = windowed
      ? [file, ...Array.from({ length: 40 }, (_, index) => `state/item-${String(index).padStart(2, '0')}.ts`)]
      : scoped ? [file, sibling] : [file]
    if (scoped) fs.writeFileSync(path.join(cwd, sibling), siblingBytes)
    if (windowed) {
      for (const [index, sourcePath] of files.entries())
        fs.writeFileSync(path.join(cwd, sourcePath), `export const item = ${index}\n`)
    }
    process.chdir(cwd)
    assert(files.every((sourcePath) => fs.statSync(path.join(cwd, sourcePath)).isFile()))
    const agentState: any = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: files,
        touchedFiles: files,
        pendingGateFiles: files,
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
        securityReviewGateDone: true,
        preEditSecurityReviewDone: true,
        specialistReviewGatesDone: [],
        specialistNoVerdictCounts: { 'reliability-reviewer': 1 },
        auxGatesLastPendingFiles: files,
        ...(scoped ? {
          specialistReviewFileMarkers: {
            'reliability-reviewer': { [sibling]: siblingMarker },
          },
        } : {}),
      },
    }
    const base2 = createBase2('default', { maxSpecialistNoVerdictRetries: 1 })
    const generator = base2.handleSteps!({
      agentState,
      prompt: 'Please finish the pending reliability finding.',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    let next: any = generator.next()
    let receipt: any
    let expectedFingerprint = ''
    let helperIssues: string[] = []
    let reviewerSpawns = 0
    let originalFingerprint = ''
    const observations = []
    const calls = []
    for (let index = 0; index < 150 && !next.done; index++) {
      if (
        !windowed && receipt &&
        (agentState.base2ActiveWork.currentPhase === 'blocked' ||
          agentState.base2ActiveWork.specialistReviewGatesDone.includes(
            'reliability-reviewer',
          ))
      )
        break
      const call = next.value
      if (call === 'STEP') {
        next = generator.next({ ...wrap({}), stepsComplete: true } as any)
        continue
      }
      calls.push({
        toolName: call?.toolName,
        agents: call?.input?.agents?.map((agent: any) => agent.agent_type),
        ...(call?.toolName === 'add_message' ? { message: call.input?.content } : {}),
      })
      if (call?.toolName === 'git_status')
        next = generator.next(wrap({ status: files.map((path) => ` M ${path}`).join('\n') }) as any)
      else if (call?.toolName === 'get_change_review_bundle')
        next = generator.next(
          wrap({
            snapshotId: 'evidence-only-specialist-fixture',
            files,
          }) as any,
        )
      else if (
        call?.toolName === 'spawn_agents' &&
        call.input.agents.some(
          (agent: any) => agent.agent_type === 'reliability-reviewer',
        )
      ) {
        const agent = call.input.agents.find(
          (agent: any) => agent.agent_type === 'reliability-reviewer',
        )
        reviewerSpawns++
        expectedFingerprint = agent.params.snapshot_id
        originalFingerprint ||= expectedFingerprint
        assert.deepEqual(agent.params.files, windowed ? files : [file])
        const retryPositive = kind === 'retry-positive' || kind === 'scoped-retry-positive'
        const outputSchema: any = reliability.outputSchema
        const dimensions = Object.fromEntries(
          Object.keys(outputSchema.properties.dimensions.properties).map(
            (key) => [key, 'pass: final source read'],
          ),
        )
        receipt = {
          schemaVersion: kind === 'invalid-schema' ? 2 : 1,
          family: 'reviewer',
          verdict: 'LOOKS_GOOD',
          findings: [],
          coverage: 'covered',
          snapshotFingerprint: kind === 'inflight-byte-drift'
            ? originalFingerprint
            : kind.startsWith('foreign') || (retryPositive && reviewerSpawns === 1)
            ? `v3:${'e'.repeat(64)}`
            : expectedFingerprint,
          reviewedFiles: kind === 'missing-file' ? [] : windowed ? files : [file],
          dimensions,
          requirementCoverage: [
            {
              requirement:
                kind === 'foreign-parent-owned'
                  ? 'Commit and push'
                  : 'Inspect the requested reliability behavior',
              status: kind === 'foreign-parent-owned' ? 'missing' : 'satisfied',
              evidence:
                kind === 'foreign-parent-owned'
                  ? ['Parent owns the commit/push workflow']
                  : ['state/session.ts:session'],
            },
          ],
        }
        if (kind === 'no-verdict')
          receipt = 'The session retry path looks acceptable to me.'
        if (kind === 'transient-crash')
          receipt = {
            errorMessage: '429 Too many requests: provider rate limit',
          }
        if (kind === 'protocol-crash')
          receipt = {
            errorMessage:
              'Reviewer schema validation failed: invalid structured output',
          }
        helperIssues = collectReviewerAttestationIssues(
          receipt,
          expectedFingerprint,
          [file],
          [],
        )
        const dispatchedContentSha256 = createHash('sha256')
          .update(fs.readFileSync(path.join(cwd, file))).digest('hex')
        if (kind === 'inflight-byte-drift' && reviewerSpawns === 1)
          fs.writeFileSync(path.join(cwd, file), 'export const session = "v2"\n')
        observations.push({
          reviewerSpawns,
          spawnParams: agent.params,
          receipt,
          helperIssues,
          dispatchedContentSha256,
          returnedContentSha256: createHash('sha256')
            .update(fs.readFileSync(path.join(cwd, file))).digest('hex'),
        })
        next = generator.next(
          wrap({ agentType: 'reliability-reviewer', value: receipt }) as any,
        )
      } else next = generator.next(wrap({}) as any)
    }
    assert(receipt)
    const work = agentState.base2ActiveWork
    reports.push({
      kind,
      expectedFingerprint,
      receipt,
      helperIssues,
      positive,
      reviewerSpawns,
      observations,
      windowed,
      sourcePathCount: files.length,
      ...(windowed ? {
        sourceFileBindings: files.map((sourcePath) => {
          const bytes = fs.readFileSync(path.join(cwd, sourcePath))
          return { path: sourcePath, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
        }),
      } : {}),
      generatorStoppedNaturally: next.done === true,
      phase: work.currentPhase,
      specialistReviewGatesDone: work.specialistReviewGatesDone,
      creditedFingerprint:
        work.specialistReviewGateFingerprints?.['reliability-reviewer'],
      creditedFileMarkers:
        work.specialistReviewFileMarkers?.['reliability-reviewer'],
      waveCreditMarkers:
        work.specialistWaveCreditMarkers?.['reliability-reviewer'],
      waveCompletions: work.waveCompletions ?? {},
      reviewReceipts: work.reviewReceipts,
      openBlockers: work.openReviewerBlockers,
      actualContentSha256: createHash('sha256')
        .update(fs.readFileSync(path.join(cwd, file)))
        .digest('hex'),
      siblingMarker,
      calls,
    })
    if (!positive && kind !== 'inflight-byte-drift') assert(helperIssues.length > 0)
    generator.return(undefined)
  }
  assert.equal(fetchAttempted, 0)
  const rejectedPositiveControls = reports.filter(
    (item) => item.positive &&
      (!item.specialistReviewGatesDone.includes('reliability-reviewer') ||
        item.phase === 'blocked' ||
        item.reviewReceipts.length !== 1 ||
        item.reviewReceipts[0]?.snapshotFingerprint !== item.expectedFingerprint ||
        (item.kind.includes('scoped') && item.creditedFileMarkers?.['state/other.ts'] !== item.siblingMarker) ||
        (item.kind.includes('retry') && item.reviewerSpawns !== 2)),
  )
  const blocking = reports.filter(
    (item) =>
      !item.positive &&
      (item.phase !== 'blocked' ||
        item.specialistReviewGatesDone.includes('reliability-reviewer') ||
        item.creditedFingerprint !== undefined ||
        Object.keys(item.creditedFileMarkers ?? {}).length > 0 ||
        Object.keys(item.waveCreditMarkers ?? {}).length > 0 ||
        Object.keys(item.waveCompletions ?? {}).length > 0 ||
        item.reviewReceipts.length > 0 ||
        (item.windowed && (!item.generatorStoppedNaturally || item.reviewerSpawns !== 2))),
  )
  fs.writeFileSync(
    path.join(import.meta.dir, 'specialist-consumer-report.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        runtime: { executable: process.execPath, bun: Bun.version },
        reports,
        blockingCounterexamples: [
          ...blocking.map((item) => item.kind),
          ...rejectedPositiveControls.map((item) => 'positive-control:' + item.kind),
        ],
        codingFetch: { attempted: fetchAttempted, forwarded: 0 },
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify({
      controlsObserved: reports.length,
      blocking: blocking.map((item) => item.kind),
      rejectedPositiveControls: rejectedPositiveControls.map((item) => item.kind),
      fetchAttempted,
    }),
  )
  if (blocking.length > 0 || rejectedPositiveControls.length > 0)
    process.exitCode = 1
} finally {
  process.chdir(originalCwd)
  fs.rmSync(root, { recursive: true, force: true })
}
