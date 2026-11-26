import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectReviewerAttestationIssues } from '../../../agents/base2/gate-reviewer'
import { evaluateAuditCoverage, inspectCodebaseStructure, inspectFeatureCompleteness } from '../../../sdk/src/services/audit-intelligence'

// A real source inventory on a private projection of the current checkout.
// No historical acceptance, secret/live/third-party content, or code review
// is inferred from a path list or a heuristic feature match.
const root = path.resolve(import.meta.dir, '../../..')
assert(process.argv.length === 3, 'Usage: record-b01-root-proof.ts <fresh-evidence-file>')
const output = path.resolve(process.argv[2]!)
assert(output.startsWith(path.join(root, '.tmp') + path.sep))
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const ledger = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'ledger.json'), 'utf8'))
const frozenPlan = fs.readFileSync(path.join(root, ledger.plan))
assert.equal(hash(frozenPlan), ledger.planSha256)
const plan = frozenPlan.toString('utf8')
const graph = Array.from(plan.matchAll(/```json\s*\n(.*?)\n```/gs), (m) => JSON.parse(m[1]!))
  .find((value) => value.dependencySemantics === 'all-of')
assert.deepEqual(graph, ledger.completionGraph)
assert.equal(graph.nodes.length, graph.nodeCount)
const capabilityFile = path.join(path.dirname(ledger.plan), 'CAPABILITY-RECORDS.json')
const capabilityBytes = fs.readFileSync(path.join(root, capabilityFile))
const capabilities = JSON.parse(capabilityBytes.toString('utf8')) as Array<{ shardId: string; id: string; name: string }>
const keys = new Set(capabilities.map((x) => `${x.shardId}:${x.id}`))
assert.equal(keys.size, capabilities.length)
const declared = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
const names = [...new Set(declared.split('\0').filter(Boolean))].sort()
const prior = new Set(fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name))
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b01-source-proof-'))
const inputs: Record<string, string> = {}
const omitted: Record<string, number> = {}
function exclude(name: string) {
  return name.startsWith('.agents/sessions/') || name.startsWith('docs/execution/body-roadmap/evidence/') ||
    name.startsWith('docs/execution/body-roadmap/archive/objects.') ||
    /(^|\/)(\.env(\.|$)|\.npmrc$|\.pypirc$|credentials\.json$)/.test(name) ||
    name === 'docs/execution/body-roadmap/ledger.json' || name === 'docs/execution/body-roadmap/STATE.md' ||
    name.startsWith('sdk/test/ripgrep-bundling/test-files/')
}
try {
  for (const name of names) {
    const dirname = name.split('/').length > 1 ? name.split('/')[0]! : '.'
    assert(!path.isAbsolute(name) && !name.split('/').includes('..'))
    const file = path.join(root, name)
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (exclude(name) || !stat?.isFile() || fs.realpathSync(file) !== file || stat.size > 12 * 1024 * 1024) {
      omitted[dirname] = (omitted[dirname] ?? 0) + 1
      continue
    }
    const bytes = fs.readFileSync(file)
    inputs[name] = hash(bytes)
    const target = path.join(mirror, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: stat.mode & 0o777 })
  }
  const inventory = inspectCodebaseStructure(mirror)
  const represented = graph.nodes.map((node: { id: string; kind: string; parentCardId?: string }) => {
    const title = node.kind === 'card'
      ? plan.match(new RegExp(`^### \\[ \\] ${node.id} — (.+)$`, 'm'))?.[1]
      : `${node.parentCardId} milestone ${node.id}`
    assert(title, `Missing frozen body family title: ${node.id}`)
    return { ...node, title, assessment: inspectFeatureCompleteness(mirror, title, inventory) }
  })
  const actual = evaluateAuditCoverage({ inventory, structuralReceipts: [], featureRecords: represented.map((row: typeof represented[number]) => row.assessment) })
  assert.equal(actual.featureAssessments.length, graph.nodeCount)
  assert.equal(actual.inspectionComplete, false)
  assert.equal(actual.readinessComplete, false)
  assert.equal(actual.sourceBinding.snapshotId, inventory.snapshotId)
  assert(actual.featureAssessments.every(row => row.assurance === 'heuristic' && row.runtimeReadiness === 'not_assessed'))
  const onDisk = new Map((inventory.directoryDispositions ?? []).map((row) => [row.id, row]))
  const dispositions = [...prior].sort().map((id) => {
    const projected = onDisk.get(id)
    return { id, status: projected?.status ?? 'out-of-scope',
      reason: projected?.reason ?? 'No selected regular versioned source in this projection; runtime/history/ignored state is not inferred.',
      omittedSourceCandidates: omitted[id] ?? 0 }
  })
  assert.equal(dispositions.length, prior.size)
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(fs.readFileSync(path.join(root, file))), digest, `Source changed: ${file}`)
  assert.equal(inspectCodebaseStructure(mirror).snapshotId, inventory.snapshotId)

  // Real gate outcomes on explicitly synthetic receipts, not an independent review of the tree.
  const fingerprint = `v3:${inventory.snapshotId}`
  const files = ['src/owned-fixture.ts']
  const empty = { schemaVersion: 1, family: 'reviewer', verdict: 'LOOKS_GOOD', snapshotFingerprint: fingerprint,
    reviewedFiles: files, coverage: 'n/a', dimensions: {}, findings: [], requirementCoverage: [] }
  const ordinary = collectReviewerAttestationIssues(empty, fingerprint, files, [], { requireFullEvidence: true })
  const reduced = collectReviewerAttestationIssues(empty, fingerprint, files, [], { lightweight: true })
  const stale = collectReviewerAttestationIssues({ ...empty, snapshotFingerprint: `v3:${'0'.repeat(64)}` }, fingerprint, files, [], { lightweight: true })
  assert(ordinary.length >= 6 && reduced.length === 0 && stale.some((issue) => issue.includes('did not match')))
  fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, acceptance: false,
    scope: 'Current worktree directory census and exact selected regular-source projection. Family presence and heuristic evidence do not mark any family implemented, assessed, or accepted.',
    planSha256: ledger.planSha256, capabilityCatalog: { path: capabilityFile, sha256: hash(capabilityBytes),
      responsibilityRecords: capabilities.map(({ shardId, id, name }) => ({ shardId, id, name })) },
    sourceBinding: { ...actual.sourceBinding, inventory: inventory.sourceBinding, inputs },
    directoryDispositions: dispositions,
    inspection: { complete: actual.inspectionComplete, assurance: actual.assurance, readinessComplete: actual.readinessComplete,
      uncoveredSubsystems: actual.uncoveredSubsystems, uncoveredFileCount: actual.uncoveredFiles.length },
    taskFamilies: represented.map(({ assessment, ...definition }: typeof represented[number]) => ({ ...definition,
      snapshotId: assessment.snapshotId, maturity: assessment.maturity, status: assessment.status, evidenceKind: assessment.evidenceKind,
      runtimeReadiness: 'not_assessed', evidenceCounts: Object.fromEntries(Object.entries(assessment.evidence).map(([key, value]) => [key, (value as unknown[]).length])) })),
    reviewerDimensions: { fixtureOnly: true, ordinaryEmptyDimensions: ordinary, reducedEligible: reduced, staleBasis: stale },
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ output, inputs: Object.keys(inputs).length, directories: dispositions.length, families: represented.length,
    responsibilities: capabilities.length, inspectionComplete: actual.inspectionComplete, readinessComplete: actual.readinessComplete }))
} finally {
  fs.rmSync(mirror, { recursive: true, force: true })
}
