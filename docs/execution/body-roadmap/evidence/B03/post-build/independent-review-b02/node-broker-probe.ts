import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const fetchObservation = { attempted: 0, forwarded: 0 }
globalThis.fetch = Object.assign(async () => { fetchObservation.attempted++; throw new Error('Independent B03 fixture refuses fetch') }, globalThis.fetch)
const root = path.resolve(import.meta.dirname, '../../../../../../..')
const { WorkspaceMutationBroker } = await import(path.join(root, 'sdk/src/services/workspace-mutation-broker.ts'))
const { createNodeFileSystem } = await import(path.join(root, 'sdk/src/tools/node-filesystem.ts'))
const { changeFiles } = await import(path.join(root, 'sdk/src/tools/change-file.ts'))
const { getContentHash, getExactContentHash } = await import(path.join(root, 'common/src/util/content-hash.ts'))
const { fileMutationResultV1Schema, getConfirmedAppliedActionsV1 } = await import(path.join(root, 'common/src/tools/results/filesystem.ts'))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'b03-node-confirmed-'))
try {
  const file = path.join(workspace, 'fixture.txt')
  const before = Buffer.from('before\r\nkept\r\n')
  const intended = Buffer.from('after\r\nkept\r\n')
  fs.writeFileSync(file, before)
  const broker = await WorkspaceMutationBroker.create({ cwd: workspace, stateDir: path.join(import.meta.dirname, 'node-broker-state') })
  const adapter = createNodeFileSystem({ mutationBroker: broker })
  const delegate = adapter.conditionalCommit.bind(adapter)
  const adapterReturns = []
  adapter.conditionalCommit = async (...args) => {
    const result = await delegate(...args)
    adapterReturns.push({ result, requestedBase64: Buffer.from(args[1]).toString('base64'), expectedHash: args[2].expectedHash })
    return result
  }
  const output = await changeFiles({ parameters: [{ type: 'file', path: 'fixture.txt', content: intended.toString('utf8'), expectedHash: getContentHash(before.toString('utf8')) }], cwd: workspace, fs: adapter, capabilityIssuer: { projectId: workspace, runId: 'b03-independent-node' } })
  const mutation = fileMutationResultV1Schema.parse(output[0].value)
  const after = fs.readFileSync(file)
  assert.equal(mutation.outcome, 'applied')
  assert.equal(getConfirmedAppliedActionsV1(mutation).length, 1)
  assert.deepEqual(after, intended)
  assert.equal(mutation.actions[0].beforeHash, getExactContentHash(before))
  assert.equal(mutation.actions[0].afterHash, getExactContentHash(after))
  assert.equal(mutation.actions[0].forward.outcome, 'applied')
  assert.equal(mutation.actions[0].forward.afterHashes['fixture.txt'], getExactContentHash(after))
  assert.equal(mutation.authorityReceipt.finalHashes['fixture.txt'], getExactContentHash(after))
  assert.equal(adapterReturns.length, 1)
  assert.equal(adapterReturns[0].result.applied, true)
  assert.equal(fetchObservation.attempted, 0)
  const bytes = (data) => ({ base64: data.toString('base64'), hash: getExactContentHash(data) })
  fs.writeFileSync(path.join(import.meta.dirname, 'node-broker-probe.json'), JSON.stringify({ scope: 'Actual Node filesystem and cooperating local broker ordinary conditional success; no B04 exclusion/crash reclamation or native/installed claim', workspace, before: bytes(before), after: bytes(after), mutation, adapterReturns, fetchObservation }, null, 2) + '\n')
  console.log('Actual Node cooperative broker CRLF conditional success: one confirmed exact-hash action.')
} finally {
  fs.rmSync(workspace, { recursive: true, force: true })
}
