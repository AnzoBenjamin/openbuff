import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

let fetchAttempted = 0
globalThis.fetch = Object.assign(
  async () => {
    fetchAttempted++
    throw new Error('Independent B01 review refuses fetch')
  },
  { preconnect() {} },
) as typeof fetch
const service =
  await import('../../../../../../sdk/src/services/audit-intelligence')
const tools = await import('../../../../../../sdk/src/tools/audit-intelligence')
const schema =
  await import('../../../../../../common/src/tools/params/tool/audit-intelligence')
const gates = await import('../../../../../../agents/base2/gate-reviewer')
const { createReviewer } =
  await import('../../../../../../agents/reviewer/code-reviewer')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-independent-main-'))
const value = (result: unknown): any => {
  assert(Array.isArray(result) && result[0]?.type === 'json')
  return result[0].value
}
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const observations: Record<string, unknown> = {}
const blocking: Array<{ id: string; expected: string; observed: unknown }> = []
try {
  fs.mkdirSync(path.join(root, 'sdk/src/__tests__'), { recursive: true })
  fs.mkdirSync(path.join(root, 'cli/commands'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'cli/commands/claim.ts'),
    'export function claim() { throw new Error("unimplemented") }\n',
  )
  fs.writeFileSync(
    path.join(root, 'sdk/src/claim.ts'),
    'export function claim() { throw new Error("unimplemented") }\n',
  )
  fs.writeFileSync(
    path.join(root, 'sdk/src/__tests__/claim.test.ts'),
    'test("claim", () => {})\n',
  )
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# Claim\nclaim command is available\n',
  )
  fs.mkdirSync(path.join(root, 'empty-directory'))
  const inventory = value(tools.inspectCodebaseStructureTool(root))
  const receipts = inventory.subsystems.map((subsystem: { id: string }) => ({
    schema_version: 1 as const,
    snapshot_id: inventory.snapshotId,
    shard_id: subsystem.id,
    subsystem_ids: [subsystem.id],
    files: inventory.files.filter(
      (file: string) =>
        (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
    ),
    domains: [...service.auditDomains],
  }))
  const feature = value(
    tools.inspectFeatureCompletenessTool(root, {
      feature: 'claim',
      snapshot_id: inventory.snapshotId,
    }),
  )
  assert.notEqual(feature.status, 'complete')
  assert.equal(feature.maturity, 'unknown')
  observations.unimplementedDiscovery = feature
  const featureReceipt = {
    ...feature.coverageReceipt,
    evidence_kind: 'verified' as const,
    evidence: {
      entrypoints: [],
      implementation: [],
      consumers: [],
      tests: [],
      docs: ['README.md'],
      failure_states: [],
    },
    status: 'partial',
    missing: ['implementation', 'tests'],
  }
  const coverage = (features: any[], structural_receipts = receipts) =>
    value(
      tools.evaluateAuditCoverageTool(root, {
        snapshot_id: inventory.snapshotId,
        structural_receipts,
        features,
      }),
    )
  const maturityResults = []
  for (const maturity of ['partial', 'unwired', 'absent', 'unknown']) {
    const result = coverage([{ ...featureReceipt, maturity }])
    assert.equal(result.inspectionComplete, true)
    assert.equal(result.readinessComplete, false)
    assert.equal(result.featureAssessments[0].maturity, maturity)
    maturityResults.push(result)
  }
  observations.inspectionAndMaturity = maturityResults
  const foreign = coverage([{ ...featureReceipt, snapshot_id: 'foreign' }])
  assert.equal(foreign.inspectionComplete, false)
  assert.equal(foreign.incompleteFeatures[0].reason, 'snapshot_mismatch')
  observations.foreignNestedSnapshot = foreign
  const missingNested =
    schema.evaluateAuditCoverageParams.inputSchema.safeParse({
      snapshot_id: inventory.snapshotId,
      structural_receipts: receipts,
      features: [{ ...featureReceipt, snapshot_id: undefined }],
    })
  assert.equal(missingNested.success, false)
  observations.missingNestedSnapshotSchemaRejected = !missingNested.success
  const omitted = coverage(
    [featureReceipt],
    receipts.map((receipt: any) => ({
      ...receipt,
      files: receipt.files.slice(0, 1),
    })),
  )
  assert.equal(omitted.inspectionComplete, false)
  assert(omitted.uncoveredFiles.length > 0)
  observations.omittedInventoriedSource = omitted
  fs.mkdirSync(path.join(root, '.agents/sessions/probe/findings'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(root, '.agents/sessions/probe/findings/one.md'),
    'claim audit findings',
  )
  const churn = value(
    tools.inspectFeatureCompletenessTool(root, {
      feature: 'claim',
      snapshot_id: inventory.snapshotId,
    }),
  )
  assert.equal(churn.coverageReceipt.snapshot_id, inventory.snapshotId)
  observations.findingsOnlyChurn = {
    snapshotIdUnchanged: true,
    response: churn,
  }
  fs.writeFileSync(path.join(root, 'sdk/src/big.ts'), 'x'.repeat(300_000))
  const bigInventory = value(tools.inspectCodebaseStructureTool(root))
  fs.writeFileSync(path.join(root, 'sdk/src/big.ts'), 'x'.repeat(299_999) + 'y')
  const stale = value(
    tools.inspectFeatureCompletenessTool(root, {
      feature: 'claim',
      snapshot_id: bigInventory.snapshotId,
    }),
  )
  assert.equal(stale.sourceBinding.status, 'stale')
  observations.cachedEqualLengthTailDrift = stale

  fs.mkdirSync(path.join(root, 'release/tools'), { recursive: true })
  fs.mkdirSync(path.join(root, 'release-staging/tools'), { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'release/tools/publish.ts'),
    'export const release = true\n',
  )
  fs.writeFileSync(
    path.join(root, 'release-staging/tools/bootstrap.sh'),
    '#!/bin/sh\necho ready\n',
  )
  fs.writeFileSync(path.join(root, 'bin/launch.mjs'), 'console.log("ready")\n')
  const release = service.inspectCodebaseStructure(root)
  for (const file of [
    'release/tools/publish.ts',
    'release-staging/tools/bootstrap.sh',
    'bin/launch.mjs',
  ])
    assert(release.files.includes(file))
  observations.recognizedReleaseSource = {
    sourceBinding: release.sourceBinding,
    directoryDispositions: release.directoryDispositions,
  }
  // Runnable extensionless wrappers and C++ source are still shipped source.
  const omittedSources = [
    'release/tools/bootstrap',
    'bin/openbuff',
    'release/tools/worker.hpp',
  ]
  fs.writeFileSync(
    path.join(root, omittedSources[0]!),
    '#!/bin/sh\necho one\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(root, omittedSources[1]!),
    '#!/usr/bin/env bun\nconsole.log("one")\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(root, omittedSources[2]!),
    'inline int worker() { return 1; }\n',
  )
  const omittedBefore = service.inspectCodebaseStructure(root)
  fs.writeFileSync(
    path.join(root, omittedSources[0]!),
    '#!/bin/sh\necho two\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(root, omittedSources[1]!),
    '#!/usr/bin/env bun\nconsole.log("two")\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(root, omittedSources[2]!),
    'inline int worker() { return 2; }\n',
  )
  const omittedAfter = service.inspectCodebaseStructure(root)
  const omittedObserved = {
    missingFiles: omittedSources.filter(
      (file) => !omittedBefore.files.includes(file),
    ),
    beforeSnapshot: omittedBefore.snapshotId,
    afterSnapshot: omittedAfter.snapshotId,
    sourceBinding: omittedAfter.sourceBinding,
  }
  observations.unrecognizedShippedSource = omittedObserved
  if (
    omittedObserved.missingFiles.length ||
    omittedBefore.snapshotId === omittedAfter.snapshotId
  )
    blocking.push({
      id: 'shipped-source-omitted',
      expected:
        'Every runnable shipped wrapper and shipped language source participates in source binding, or binding explicitly refuses completeness.',
      observed: omittedObserved,
    })
  fs.writeFileSync(
    path.join(root, 'sdk/src/link-a.ts'),
    'export const one = 1\n',
  )
  fs.writeFileSync(
    path.join(root, 'sdk/src/link-b.ts'),
    'export const two = 2\n',
  )
  fs.symlinkSync(
    '../../sdk/src/link-a.ts',
    path.join(root, 'release/tools/link.ts'),
  )
  const linkBefore = service.inspectCodebaseStructure(root)
  fs.unlinkSync(path.join(root, 'release/tools/link.ts'))
  fs.symlinkSync(
    '../../sdk/src/link-b.ts',
    path.join(root, 'release/tools/link.ts'),
  )
  const linkAfter = service.inspectCodebaseStructure(root)
  const linkObserved = {
    included: linkBefore.files.includes('release/tools/link.ts'),
    beforeSnapshot: linkBefore.snapshotId,
    afterSnapshot: linkAfter.snapshotId,
    sourceBinding: linkAfter.sourceBinding,
  }
  observations.shippedSymlinkIdentity = linkObserved
  if (!linkObserved.included || linkBefore.snapshotId === linkAfter.snapshotId)
    blocking.push({
      id: 'source-symlink-omitted',
      expected:
        'Source symlink identity participates or the binding explicitly declares unavailable/incomplete source.',
      observed: linkObserved,
    })

  // Full bytes still need unambiguous record framing. Removing a source file
  // must not alias embedding its former hash preimage in the previous file.
  const framingA = path.join(root, 'release/tools/a.ts')
  const framingB = path.join(root, 'release/tools/b.ts')
  fs.writeFileSync(framingA, 'x')
  fs.writeFileSync(framingB, 'y')
  const framingBefore = service.inspectCodebaseStructure(root)
  const embeddedHeader = `release/tools/b.ts\0${fs.statSync(framingB).mode}\0file\0`
  const joinedBytes = `x\n${embeddedHeader}y`
  fs.unlinkSync(framingB)
  fs.writeFileSync(framingA, joinedBytes)
  const framingAfter = service.inspectCodebaseStructure(root)
  const framingObserved = {
    beforeSnapshot: framingBefore.snapshotId,
    afterSnapshot: framingAfter.snapshotId,
    beforeABytesBase64: Buffer.from('x').toString('base64'),
    beforeBBytesBase64: Buffer.from('y').toString('base64'),
    afterABytesBase64: Buffer.from(joinedBytes).toString('base64'),
    beforeFiles: framingBefore.files.filter(
      (file) => file === 'release/tools/a.ts' || file === 'release/tools/b.ts',
    ),
    afterFiles: framingAfter.files.filter(
      (file) => file === 'release/tools/a.ts' || file === 'release/tools/b.ts',
    ),
    sourceBinding: framingAfter.sourceBinding,
  }
  observations.sourceRecordFraming = framingObserved
  if (framingBefore.snapshotId === framingAfter.snapshotId)
    blocking.push({
      id: 'source-record-framing-alias',
      expected:
        'Source identity uses length-delimited/domain-separated records so changing membership cannot alias moving one file preimage into another file body.',
      observed: framingObserved,
    })

  // Actual byte write at the final metadata observation boundary. This is
  // controlled I/O fault injection into real temp files, not a mock digest.
  const metadataTarget = path.join(root, 'sdk/src/claim.ts')
  const originalBytes = fs.readFileSync(metadataTarget)
  const changedBytes = Buffer.from(
    originalBytes.toString().replace('unimplemented', 'unimplementEd'),
  )
  assert.equal(changedBytes.length, originalBytes.length)
  const metadataBefore = service.inspectCodebaseStructure(root)
  const originalLstat = fs.lstatSync
  let targetStats = 0
  let mutationInjected = false
  fs.lstatSync = ((file: any, ...args: any[]) => {
    if (String(file) === metadataTarget && ++targetStats === 2) {
      fs.writeFileSync(metadataTarget, changedBytes)
      mutationInjected = true
    }
    return (originalLstat as any)(file, ...args)
  }) as typeof fs.lstatSync
  let metadataDuring:
    | ReturnType<typeof service.inspectCodebaseStructure>
    | undefined
  let metadataError: string | undefined
  try {
    metadataDuring = service.inspectCodebaseStructure(root)
  } catch (error) {
    metadataError = String(error)
  } finally {
    fs.lstatSync = originalLstat
  }
  const metadataFresh = service.inspectCodebaseStructure(root)
  assert(mutationInjected)
  const metadataObserved = {
    mutationInjected,
    beforeBytesSha256: sha(originalBytes),
    afterBytesSha256: sha(changedBytes),
    beforeSnapshot: metadataBefore.snapshotId,
    duringSnapshot: metadataDuring?.snapshotId,
    freshSnapshot: metadataFresh.snapshotId,
    error: metadataError,
    sourceBinding: metadataDuring?.sourceBinding,
  }
  observations.finalMetadataBoundaryDrift = metadataObserved
  if (
    !metadataError &&
    metadataDuring?.snapshotId === metadataBefore.snapshotId &&
    metadataFresh.snapshotId !== metadataBefore.snapshotId
  ) {
    blocking.push({
      id: 'final-metadata-drift-unchecked',
      expected:
        'The final path metadata observation must reject same-inode/size drift after fd post-stat, or explicitly mark source binding incomplete.',
      observed: metadataObserved,
    })
  }

  const expected = `v3:${sha('current same-path source basis')}`
  const obsolete = `v3:${sha('obsolete same-path source basis')}`
  const dimensions = {
    correctness: 'pass: scoped bytes read',
    security: 'pass: no external input',
    tests: 'pass: covering test read',
    apiCompatibility: 'pass: unchanged exports',
    performance: 'pass: bounded read',
  }
  const requirements = [
    {
      requirement: 'Implement the requested behavior',
      status: 'satisfied',
      evidence: ['sdk/src/claim.ts:claim'],
    },
  ]
  const clean = {
    schemaVersion: 1,
    verdict: 'LOOKS_GOOD',
    findings: [],
    snapshotFingerprint: expected,
    reviewedFiles: ['src/a.ts'],
    coverage: 'covered',
    dimensions,
    requirementCoverage: requirements,
  }
  const full = (receipt: unknown) =>
    gates.collectReviewerAttestationIssues(
      receipt,
      expected,
      ['src/a.ts'],
      [],
      { requireFullEvidence: true },
    )
  assert.deepEqual(full(clean), [])
  const emptyDimensions = full({ ...clean, dimensions: {} })
  const emptyRequirements = full({ ...clean, requirementCoverage: [] })
  const staleReview = full({ ...clean, snapshotFingerprint: obsolete })
  const borrowedDimensions = full([
    { ...clean, dimensions: {}, requirementCoverage: [] },
    { ...clean, snapshotFingerprint: obsolete },
  ])
  assert.equal(emptyDimensions.length, 5)
  assert(
    emptyRequirements.some((issue) => issue.includes('requirement evidence')),
  )
  assert(
    staleReview.some((issue) => issue.includes('fingerprint did not match')),
  )
  assert(borrowedDimensions.length >= 6)
  const reduced = {
    ...clean,
    dimensions: undefined,
    requirementCoverage: undefined,
  }
  assert.deepEqual(
    gates.collectReviewerAttestationIssues(
      reduced,
      expected,
      ['src/a.ts'],
      [],
      { lightweight: true },
    ),
    [],
  )
  const reducedContractScope = gates.collectReviewerAttestationIssues(
    { ...reduced, reviewedFiles: ['package.json'] },
    expected,
    ['package.json'],
    [],
    { lightweight: true },
  )
  const reducedSubstantive = gates.collectReviewerAttestationIssues(
    { ...reduced, verdict: 'NON_BLOCKING', findings: ['Fix the behavior'] },
    expected,
    ['src/a.ts'],
    [],
    { lightweight: true },
  )
  assert(reducedContractScope.some((issue) => issue.includes('not eligible')))
  assert(
    reducedSubstantive.some((issue) =>
      issue.includes('full reviewer contract'),
    ),
  )
  observations.reviewerEligibility = {
    fullClean: full(clean),
    emptyDimensions,
    emptyRequirements,
    staleReview,
    borrowedDimensions,
    eligibleReduced: [],
    ineligibleReduced: reducedContractScope,
    substantiveReduced: reducedSubstantive,
    reducedRequired: gates.buildLightweightReviewContract(['src/a.ts'])
      .required,
    fullRequired: gates.buildLightweightReviewContract(['package.json'])
      .required,
  }
  const reviewer = createReviewer('fixture/unavailable-model')
  const outputSchema: any = reviewer.outputSchema
  observations.ordinaryReviewerSchema = {
    required: outputSchema.required,
    dimensions: outputSchema.properties.dimensions,
    requirements: outputSchema.properties.requirementCoverage,
  }
  assert(outputSchema.required.includes('requirementCoverage'))
  assert.equal(fetchAttempted, 0)
  fs.writeFileSync(
    path.join(import.meta.dir, 'probe-report.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        runtime: { executable: process.execPath, bun: Bun.version },
        observations,
        blocking,
        codingFetch: { attempted: fetchAttempted, forwarded: 0 },
        note: 'Actual-source controls; the review manifest identifies the exact source/configuration basis. This fixture does not approve the reviewer-owned tail/store subset.',
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify({
      controlsObserved: Object.keys(observations).length,
      blocking: blocking.map((item) => item.id),
      fetchAttempted,
    }),
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
