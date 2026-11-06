import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

assert.equal(Bun.version, '1.3.5')
const out = import.meta.dir
const root = path.resolve(out, '../../../../../../..')
let fetchCalls = 0
globalThis.fetch = Object.assign(async () => {
  fetchCalls++
  throw new Error('Independent approval-store probe refuses network')
}, { preconnect() {} }) as typeof fetch
const { LocalHarnessStore } = await import(path.join(root, 'sdk/src/services/local-harness-store.ts'))
const { HarnessApprovalService, hashCommand, hashTerminalExecutionContext } = await import(path.join(root, 'sdk/src/services/harness-enforcement.ts'))
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const command = "git commit -m 'a  b'; rm -rf fixture"
const context = { permissionProfile: 'workspace-write', cwd: out, projectRoot: out, allowedPaths: ['a', 'b'], processType: 'SYNC' as const }
const scope = { repositoryId: 'repo', workspaceId: 'workspace', runId: 'run', snapshotId: 'snapshot' }
const action = { action: 'commit', target: "git commit -m 'a  b'", commandHash: hashCommand(command), executionContextHash: hashTerminalExecutionContext(context) }
const observations: unknown[] = []
for (const scenario of ['invalid-json', 'invalid-schema', 'lost-sidecar', 'corrupt-sidecar']) {
  const state = path.join(out, 'corrupt-approval-fixture', scenario)
  const store = new LocalHarnessStore(state)
  const service = new HarnessApprovalService(store)
  const grant = service.grant(scope, action)
  const id = scenario.includes('sidecar') ? 'approval.tmp.control' : grant.id
  if (id !== grant.id) store.put('approvals', { ...grant, id })
  const file = path.join(state, 'repo', 'approvals', id + '.json')
  const corruptBytes = scenario === 'invalid-schema' ? '{"id":"invalid"}' : '{broken approval'
  fs.writeFileSync(file, corruptBytes)
  const consume = { ...scope, ...action, approvalId: id }
  const errors: string[] = []
  let wins = 0
  const attempt = () => {
    try { new HarnessApprovalService(new LocalHarnessStore(state)).consume(consume); wins++ }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  attempt()
  assert.equal(wins, 0)
  assert.equal(fs.existsSync(file), false)
  const first = new LocalHarnessStore(state).listWithDiagnostics('repo', 'approvals')
  const diagnostic = first.diagnostics.find((row: { filePath: string }) => row.filePath === file)
  assert(diagnostic?.quarantinedPath)
  const sidecar = diagnostic.quarantinedPath + '.diagnostic.json'
  if (scenario === 'lost-sidecar') {
    const preserved = path.join(out, 'preserved-sidecars', scenario)
    fs.mkdirSync(path.dirname(preserved), { recursive: true })
    fs.renameSync(sidecar, preserved)
    fs.writeFileSync(sidecar + `.tmp.${process.pid}.00000000-0000-4000-8000-000000000000`, '{unfinished')
  }
  if (scenario === 'corrupt-sidecar') fs.writeFileSync(sidecar, '{broken sidecar')
  attempt(); attempt()
  const restarted = new LocalHarnessStore(state).listWithDiagnostics('repo', 'approvals')
  const evidence = restarted.diagnostics.filter((row: { filePath: string }) => row.filePath === file)
  assert.equal(wins, 0)
  assert.equal(errors.length, 3)
  assert(errors.slice(1).every((error) => error.includes('Quarantined harness record')))
  assert.equal(evidence.length, 1)
  assert.equal(digest(fs.readFileSync(diagnostic.quarantinedPath)), digest(corruptBytes))
  observations.push({ scenario, file, id, command, context, scope, action, wins, errors, diagnostic: evidence[0], corruptBytesSha256: digest(corruptBytes), quarantinedBytesSha256: digest(fs.readFileSync(diagnostic.quarantinedPath)), noConsumedCorruptRecord: !restarted.records.some((record: { id: string }) => record.id === id) })
}
const healthyState = path.join(out, 'corrupt-approval-fixture', 'healthy-control')
const healthyStore = new LocalHarnessStore(healthyState)
const healthyService = new HarnessApprovalService(healthyStore)
const healthyGrant = healthyService.grant(scope, action)
const healthyFile = path.join(healthyState, 'repo', 'approvals', healthyGrant.id + '.json')
const before = digest(fs.readFileSync(healthyFile))
const changes = [
  { commandHash: hashCommand("git commit -m 'a b'; rm -rf fixture") },
  { commandHash: hashCommand("rm -rf fixture; git commit -m 'a  b'") },
  { workspaceId: 'other' }, { runId: 'other' }, { snapshotId: 'other' },
  { executionContextHash: hashTerminalExecutionContext({ ...context, allowedPaths: ['b', 'a'] }) },
  { executionContextHash: hashTerminalExecutionContext({ ...context, cwd: out + '/other' }) },
]
for (const change of changes) {
  assert.throws(() => healthyService.consume({ ...scope, ...action, approvalId: healthyGrant.id, ...change }), /scope does not match/)
  assert.equal(digest(fs.readFileSync(healthyFile)), before)
}
const consumed = healthyService.consume({ ...scope, ...action, approvalId: healthyGrant.id })
assert.equal(consumed.revision, 1)
assert(consumed.consumedAt)
assert.throws(() => new HarnessApprovalService(new LocalHarnessStore(healthyState)).consume({ ...scope, ...action, approvalId: healthyGrant.id }), /already consumed/)
assert.equal(fetchCalls, 0)
fs.writeFileSync(path.join(out, 'approval-store-observations.json'), JSON.stringify({ schemaVersion: 1, observations, healthy: { command, context, scope, action, mismatchControls: changes.length, unchangedBytesAfterMismatch: true, consumed, persisted: JSON.parse(fs.readFileSync(healthyFile, 'utf8')) }, fetchCalls }, null, 2) + '\n')
console.log(JSON.stringify({ corruptApprovalCases: observations.length, mismatchControls: changes.length, healthySingleConsume: true, fetchCalls }))
