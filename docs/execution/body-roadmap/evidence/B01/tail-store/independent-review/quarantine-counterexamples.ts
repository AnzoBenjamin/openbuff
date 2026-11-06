import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

let fetchCalls = 0
globalThis.fetch = Object.assign(async () => { fetchCalls++; throw new Error('Independent B01 probe refuses fetch') }, { preconnect() {} }) as typeof fetch
const { getChangeReviewBundle } = await import('../../../../../../../sdk/src/tools/get-change-review-bundle')
const { LocalHarnessStore } = await import('../../../../../../../sdk/src/services/local-harness-store')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-independent-quarantine-'))
const observations: unknown[] = []
try {
  const cwd = path.join(root, 'repo')
  fs.mkdirSync(cwd)
  for (const args of [['init'], ['config','user.email','fixture@example.invalid'], ['config','user.name','Fixture']]) assert.equal(spawnSync('git', args, { cwd }).status, 0)
  fs.writeFileSync(path.join(cwd,'file.txt'),'seed\n')
  for (const args of [['add','.'],['commit','-m','seed']]) assert.equal(spawnSync('git',args,{cwd}).status,0)
  fs.writeFileSync(path.join(cwd,'file.txt'),'changed\n')
  for (const id of ['ordinary-finding', 'finding.tmp.tail']) {
    const stateDir = path.join(root,id)
    const initial = (await getChangeReviewBundle({cwd,stateDir}))[0]
    assert(initial?.type === 'json' && 'snapshotId' in initial.value)
    const scope = initial.value
    const store = new LocalHarnessStore(stateDir)
    store.put('findings', { schemaVersion:1, id, revision:0, repositoryId:scope.repositoryId, workspaceId:scope.workspaceId, runId:'run',snapshotId:scope.snapshotId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'open',files:['file.txt'] })
    const recordPath = path.join(stateDir,scope.repositoryId,'findings',id+'.json')
    fs.writeFileSync(recordPath,'{broken')
    const first = store.listWithDiagnostics(scope.repositoryId,'findings')
    assert.equal(first.diagnostics.length,1)
    const raw = first.diagnostics[0].quarantinedPath!
    fs.unlinkSync(raw+'.diagnostic.json')
    const restarted = new LocalHarnessStore(stateDir)
    const after = restarted.listWithDiagnostics(scope.repositoryId,'findings')
    let directRead: unknown
    try { directRead = { value: restarted.read(scope.repositoryId,'findings',id) ?? null } }
    catch (error) { directRead = { error: String(error) } }
    const bundle = (await getChangeReviewBundle({cwd,stateDir}))[0]
    observations.push({id, first, after, directRead, bundle, rawBytes:fs.readFileSync(raw,'utf8')})
  }
  fs.writeFileSync(path.join(import.meta.dir,'quarantine-observations.json'),JSON.stringify({fetchCalls,observations},null,2)+'\n')
  for (const row of observations as Array<{id:string;after:{diagnostics:unknown[]};bundle:{value:Record<string,unknown>}}>) {
    assert.equal(row.after.diagnostics.length,1,row.id+': missing sidecar must remain unavailable')
    assert('errorMessage' in row.bundle.value,row.id+': no empty finding assurance')
  }
  console.log(JSON.stringify({cases:observations.length,fetchCalls}))
} finally { fs.rmSync(root,{recursive:true,force:true}) }
