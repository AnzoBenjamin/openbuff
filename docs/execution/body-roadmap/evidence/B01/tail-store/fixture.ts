import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

let fetchAttempted = 0
const refusedFetch = async () => {
  fetchAttempted++
  throw new Error('B01 fixture refuses network fetch')
}
globalThis.fetch = Object.assign(refusedFetch, {
  preconnect() {},
}) as typeof fetch
// Observe network calls before loading actual source tools.
const {
  getChangeReviewBundle,
  computeWorktreeSnapshotIdentity,
  hashIdentityFileBytes,
} = await import('../../../../../../sdk/src/tools/get-change-review-bundle')
const { runGitBounded } =
  await import('../../../../../../sdk/src/tools/git-status')
const { runTargetedValidation } =
  await import('../../../../../../sdk/src/tools/run-targeted-validation')
const { LocalHarnessStore } =
  await import('../../../../../../sdk/src/services/local-harness-store')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-tail-store-fixture-'))
const output = path.join(import.meta.dir, 'fixture-report.json')
const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
function repository(name: string) {
  const cwd = path.join(root, name)
  fs.mkdirSync(cwd)
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr.toString())
    return result
  }
  git('init')
  git('config', 'user.email', 'b01@example.invalid')
  git('config', 'user.name', 'B01 Fixture')
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n')
  git('add', '.')
  git('commit', '-m', 'initial')
  return { cwd, git }
}
async function bundle(cwd: string, stateDir?: string) {
  const part = (await getChangeReviewBundle({ cwd, stateDir }))[0]
  assert(part?.type === 'json')
  return part.value
}
const cases: Record<string, unknown> = {}
try {
  const tailRepo = repository('untracked-tail')
  const file = path.join(tailRepo.cwd, 'tail.txt')
  const prefix = 'x'.repeat(1024 * 1024 + 128)
  fs.writeFileSync(file, `${prefix}before\n`)
  const beforeBytes = fs.readFileSync(file)
  const before = await bundle(tailRepo.cwd)
  assert('snapshotId' in before)
  const beforeIdentity = await computeWorktreeSnapshotIdentity({
    cwd: tailRepo.cwd,
  })
  assert('snapshotId' in beforeIdentity)
  assert.equal(before.snapshotId, beforeIdentity.snapshotId)
  let hookRan = false
  const validation = (
    await runTargetedValidation({
      cwd: tailRepo.cwd,
      snapshotId: before.snapshotId,
      files: ['tail.txt'],
      runHooks: async () => {
        hookRan = true
        fs.writeFileSync(file, `${prefix}after!\n`)
        return [
          {
            type: 'json',
            value: [
              { command: 'fixture-pass', hookName: 'fixture', exitCode: 0 },
            ],
          },
        ]
      },
    })
  )[0]
  const afterBytes = fs.readFileSync(file)
  const after = await bundle(tailRepo.cwd)
  assert('snapshotId' in after)
  assert.equal(beforeBytes.length, afterBytes.length)
  assert(
    beforeBytes
      .subarray(0, 1024 * 1024)
      .equals(afterBytes.subarray(0, 1024 * 1024)),
  )
  assert.notEqual(before.snapshotId, after.snapshotId)
  assert(validation?.type === 'json')
  assert.equal(validation.value.status, 'failed')
  assert.equal(validation.value.assurance, 'none')
  assert(
    validation.value.summary.includes('worktree changed during validation'),
  )
  assert(hookRan)
  cases.equalLengthUntrackedTail = {
    beforeSize: beforeBytes.length,
    afterSize: afterBytes.length,
    retainedPrefixEqual: true,
    beforeSha256: sha256(beforeBytes),
    afterSha256: sha256(afterBytes),
    beforeTailBase64: beforeBytes.subarray(-7).toString('base64'),
    afterTailBase64: afterBytes.subarray(-7).toString('base64'),
    beforeSnapshot: before.snapshotId,
    afterSnapshot: after.snapshotId,
    identityOnlyAgreed: true,
    passingHook: { command: 'fixture-pass', hookName: 'fixture', exitCode: 0 },
    validation: validation.value,
  }

  const diffRepo = repository('git-tail')
  fs.writeFileSync(path.join(diffRepo.cwd, 'a-prefix.txt'), 'seed\n')
  fs.writeFileSync(path.join(diffRepo.cwd, 'z-tail.txt'), 'seed\n')
  diffRepo.git('add', '.')
  diffRepo.git('commit', '-m', 'tracked files')
  fs.writeFileSync(
    path.join(diffRepo.cwd, 'a-prefix.txt'),
    `${'x'.repeat(5 * 1024 * 1024)}\n`,
  )
  const observeDiff = async (tail: string) => {
    fs.writeFileSync(path.join(diffRepo.cwd, 'z-tail.txt'), `${tail}\n`)
    const result = await runGitBounded(
      ['diff', '--binary', 'HEAD'],
      diffRepo.cwd,
      undefined,
      {
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      },
    )
    const reference = diffRepo.git('diff', '--binary', 'HEAD').stdout
    assert.equal(result.stdoutSha256, sha256(reference))
    assert(result.stdoutComplete && result.stdoutTruncated)
    return result
  }
  const firstDiff = await observeDiff('one')
  const secondDiff = await observeDiff('two')
  assert.equal(firstDiff.stdout, secondDiff.stdout)
  assert.equal(firstDiff.stdoutTotalBytes, secondDiff.stdoutTotalBytes)
  assert.notEqual(firstDiff.stdoutSha256, secondDiff.stdoutSha256)
  cases.equalLengthGitTail = {
    retainedBytes: Buffer.byteLength(firstDiff.stdout),
    retainedPrefixEqual: true,
    beforeTotal: firstDiff.stdoutTotalBytes,
    afterTotal: secondDiff.stdoutTotalBytes,
    beforeFullSha256: firstDiff.stdoutSha256,
    afterFullSha256: secondDiff.stdoutSha256,
    complete: firstDiff.stdoutComplete && secondDiff.stdoutComplete,
    independentFullGitReferenceAgreed: true,
  }

  const overflowRepo = repository('membership-overflow')
  const deep = Array.from(
    { length: 4 },
    (_, index) => `d${'x'.repeat(190)}${index}`,
  ).join('/')
  fs.mkdirSync(path.join(overflowRepo.cwd, deep), { recursive: true })
  for (let index = 0; index < 5500; index++) {
    fs.writeFileSync(
      path.join(
        overflowRepo.cwd,
        deep,
        `f-${String(index).padStart(4, '0')}.txt`,
      ),
      'x\n',
    )
  }
  const status = await runGitBounded(
    ['status', '--porcelain', '-z', '-uall'],
    overflowRepo.cwd,
    undefined,
    {
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    },
  )
  assert(status.stdoutTruncated && status.stdoutComplete)
  const refusedBundle = await bundle(overflowRepo.cwd)
  const refusedIdentity = await computeWorktreeSnapshotIdentity({
    cwd: overflowRepo.cwd,
  })
  assert('errorMessage' in refusedBundle)
  assert('errorMessage' in refusedIdentity)
  let overflowHooksRan = false
  const refusedValidation = (
    await runTargetedValidation({
      cwd: overflowRepo.cwd,
      snapshotId: 'unavailable',
      files: ['seed.txt'],
      runHooks: async () => {
        overflowHooksRan = true
        return [{ type: 'json', value: [] }]
      },
    })
  )[0]
  assert(!overflowHooksRan)
  assert(refusedValidation?.type === 'json')
  assert.equal(refusedValidation.value.status, 'failed')
  assert.equal(refusedValidation.value.assurance, 'none')
  cases.membershipOverflow = {
    enumeratedFixtureFiles: 5500,
    totalStatusBytes: status.stdoutTotalBytes,
    retainedStatusBytes: Buffer.byteLength(status.stdout),
    fullStatusSha256: status.stdoutSha256,
    completeStream: status.stdoutComplete,
    truncatedMembership: status.stdoutTruncated,
    bundle: refusedBundle,
    identity: refusedIdentity,
    validation: refusedValidation.value,
    hooksRan: overflowHooksRan,
  }

  const stateDir = path.join(root, 'store')
  const initial = await bundle(tailRepo.cwd, stateDir)
  assert('snapshotId' in initial)
  const record = {
    schemaVersion: 1 as const,
    id: 'open',
    revision: 0,
    repositoryId: initial.repositoryId,
    workspaceId: initial.workspaceId,
    snapshotId: initial.snapshotId,
    runId: 'fixture',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'open',
    files: ['tail.txt'],
  }
  new LocalHarnessStore(stateDir).put('findings', record)
  const healthy = await bundle(tailRepo.cwd, stateDir)
  assert('findings' in healthy)
  assert.equal(healthy.findings.length, 1)
  const originalPath = path.join(
    stateDir,
    record.repositoryId,
    'findings',
    'open.json',
  )
  fs.writeFileSync(originalPath, '{broken')
  const diagnostics = new LocalHarnessStore(stateDir).listWithDiagnostics(
    record.repositoryId,
    'findings',
  )
  assert.equal(diagnostics.diagnostics.length, 1)
  const restarted = new LocalHarnessStore(stateDir)
  assert.deepEqual(
    restarted.listWithDiagnostics(record.repositoryId, 'findings'),
    diagnostics,
  )
  assert.throws(
    () => restarted.read(record.repositoryId, 'findings', 'open'),
    /Quarantined harness record/,
  )
  const corruptBundle = await bundle(tailRepo.cwd, stateDir)
  const subsequentBundle = await bundle(tailRepo.cwd, stateDir)
  assert('errorMessage' in corruptBundle)
  assert.deepEqual(corruptBundle, subsequentBundle)
  const quarantinedPath = diagnostics.diagnostics[0]!.quarantinedPath!
  assert.equal(fs.readFileSync(quarantinedPath, 'utf8'), '{broken')
  fs.unlinkSync(`${quarantinedPath}.diagnostic.json`)
  const lostSidecar = new LocalHarnessStore(stateDir).listWithDiagnostics(
    record.repositoryId,
    'findings',
  )
  assert.equal(lostSidecar.diagnostics.length, 1)
  assert('errorMessage' in (await bundle(tailRepo.cwd, stateDir)))
  cases.durableQuarantine = {
    healthyOpenFindings: healthy.findings.length,
    corruptRawSha256: sha256('{broken'),
    diagnosticsPersistedAcrossInstances: true,
    subsequentDirectReadRejected: true,
    quarantinedBytesPreserved: true,
    bundle: corruptBundle,
    subsequentBundle,
    lostSidecarStillUnavailable: true,
    lostSidecarMessage: lostSidecar.diagnostics[0]!.message,
  }

  const controller = new AbortController()
  const pending = hashIdentityFileBytes(
    createHash('sha256'),
    tailRepo.cwd,
    ['tail.txt'],
    { signal: controller.signal },
  )
  controller.abort(new Error('fixture cancel'))
  await assert.rejects(pending, /fixture cancel/)
  cases.cancellation = { observedRejection: 'fixture cancel' }
  assert.equal(fetchAttempted, 0)
  fs.writeFileSync(
    output,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        allAssertionsPassed: true,
        runtime: { executable: process.execPath, bun: Bun.version },
        environment: {
          replacementEnvironment: true,
          homeIsEphemeral: process.env.HOME?.startsWith('/tmp/'),
          configIsEphemeral: process.env.XDG_CONFIG_HOME?.startsWith('/tmp/'),
        },
        codingFetch: { attempted: fetchAttempted, forwarded: 0 },
        cases,
        limits: [
          'Filesystem metadata checks detect observed concurrent drift; they are not an OS snapshot or filesystem fence.',
          'A timed-out OS read may finish later; its task observes cancellation and closes the file handle when I/O returns.',
          'Status overflow explicitly refuses incomplete membership. Corruption remains unavailable until repaired; no automatic diagnostic acknowledgement is implemented.',
        ],
      },
      null,
      2,
    )}\n`,
  )
  console.log(
    JSON.stringify({
      allAssertionsPassed: true,
      cases: Object.keys(cases),
      fetchAttempted,
    }),
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
