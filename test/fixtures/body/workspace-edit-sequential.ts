import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repo = path.resolve(import.meta.dir, '../../..')
const args = process.argv.slice(2)
assert.equal(
  args.length,
  4,
  'Usage: --manifest <path> --evidence-dir <fresh-directory>',
)
const flag = (key: string): string => {
  const index = args.indexOf(key)
  assert(index === 0 || index === 2, `Missing or invalid ${key}`)
  const value = args[index + 1]
  assert(value && !value.startsWith('--'), `Missing value for ${key}`)
  return path.resolve(value)
}
const manifestPath = flag('--manifest')
const evidence = flag('--evidence-dir')
const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const fileHash = (file: string) => digest(readFileSync(file))
const manifestBytes = readFileSync(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  schemaVersion?: number
  type?: string
  tools?: {
    bun?: {
      expectedVersion?: string
      expectedSha256ByHost?: Record<string, string>
    }
  }
}
assert.equal(manifest.schemaVersion, 1, 'Unsupported toolchain manifest')
assert.equal(manifest.type, 'body-bootstrap-selection')
const host = `${process.platform}-${process.arch}`
const selected = manifest.tools?.bun
const expectedHash = selected?.expectedSha256ByHost?.[host]
assert(
  typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash),
  `No selected Bun checksum for ${host}`,
)
assert.equal(
  Bun.version,
  selected?.expectedVersion,
  'Bun version differs from the manifest',
)
const executable = realpathSync(process.execPath)
const executableHash = fileHash(executable)
assert.equal(
  executableHash,
  expectedHash,
  'Bun executable differs from the manifest',
)

// Do not overwrite previous evidence, including a failed attempt.
mkdirSync(evidence, { mode: 0o700 })
const home = path.join(evidence, 'home')
mkdirSync(home, { mode: 0o700 })
const write = (name: string, value: string) =>
  writeFileSync(path.join(evidence, name), value, { mode: 0o600, flag: 'wx' })
const writeJson = (name: string, value: unknown) =>
  write(name, JSON.stringify(value, null, 2) + '\n')
const tests = [
  'sdk/src/__tests__/language-intelligence.test.ts',
  'sdk/src/__tests__/lsp-multiplexer.test.ts',
  'packages/agent-runtime/src/__tests__/edit-transaction-multi-file-recovery.e2e.test.ts',
  'sdk/src/__tests__/mutation-capabilities.test.ts',
  'sdk/src/__tests__/workspace-mutation-broker.test.ts',
  'sdk/src/__tests__/change-file.test.ts',
  'sdk/src/__tests__/run-mutation-dispatch.test.ts',
  'sdk/src/tools/__tests__/transaction-intent-log.test.ts',
]
const inputs = [
  '.bun-version',
  'bun.lock',
  'test/fixtures/body/workspace-edit-sequential.ts',
  ...tests,
  'sdk/src/__tests__/lsp-execution-fixture.ts',
  'sdk/src/__tests__/sdk-callback-fixture.ts',
  'sdk/src/client.ts',
  'sdk/src/run.ts',
  'sdk/src/services/language-intelligence.ts',
  'sdk/src/services/lsp-multiplexer.ts',
  'sdk/src/services/semantic-workspace-text.ts',
  'sdk/src/tools/semantic-edit-apply.ts',
  'sdk/src/tools/change-file.ts',
  'sdk/src/tools/transaction-intent-log.ts',
  'sdk/src/tools/transaction-path-identity.ts',
  'sdk/src/tools/node-filesystem.ts',
  'sdk/src/services/workspace-mutation-broker.ts',
  'sdk/src/services/workspace-mutation-recovery.ts',
  'sdk/src/services/transaction-mutation-proof.ts',
  'sdk/src/services/host-filesystem.ts',
  'sdk/src/tools/filesystem-authority.ts',
  'common/src/tools/params/tool/rename-symbol.ts',
  'common/src/tools/params/tool/code-action.ts',
  'common/src/tools/params/tool/extract-symbol.ts',
]
const snapshot = () =>
  Object.fromEntries(
    inputs.map((file) => [file, fileHash(path.join(repo, file))]),
  )
const sourceSha256 = snapshot()
const testArgs = [
  '--no-env-file',
  '--no-install',
  'test',
  '--isolate',
  ...tests.map((file) => `./${file}`),
]
const startedAt = new Date().toISOString()
const run = spawnSync(executable, testArgs, {
  cwd: repo,
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    DO_NOT_TRACK: '1',
    OPENBUFF_TELEMETRY: '0',
    BODY_EVIDENCE: evidence,
    OPENBUFF_CAPTURE_B06_SEMANTICS: '1',
    OPENBUFF_CAPTURE_B07_BOUNDARIES: '1',
  },
})
const finishedAt = new Date().toISOString()
write('tests.stdout.log', run.stdout ?? '')
write('tests.stderr.log', run.stderr ?? '')
writeJson('invocation.json', {
  command: [executable, ...testArgs],
  startedAt,
  finishedAt,
  exitCode: run.status,
  signal: run.signal,
  error: run.error?.message,
})
assert.ifError(run.error)
assert.equal(run.status, 0, 'Evidence schedule failed; see tests.stderr.log')
const executedFiles = [
  ...(run.stderr ?? '').matchAll(/^(.+\.test\.ts):\r?$/gm),
].map((match) => path.relative(repo, path.resolve(repo, match[1]!)))
assert.deepEqual(
  executedFiles.sort(),
  [...tests].sort(),
  'The runner must execute each declared test file exactly once',
)
assert.deepEqual(
  snapshot(),
  sourceSha256,
  'A selected input changed during execution',
)
assert.equal(
  fileHash(executable),
  executableHash,
  'Bun executable changed during execution',
)
assert.equal(
  fileHash(manifestPath),
  digest(manifestBytes),
  'Toolchain manifest changed during execution',
)

function capture<T>(prefix: string): T[] {
  const lines = (run.stdout ?? '').split('\n')
  return lines
    .filter((line) => line.startsWith(prefix + ' '))
    .map((line) => JSON.parse(line.slice(prefix.length + 1)) as T)
}

type FileHashes = Record<string, string | null>
const semantic = capture<{
  mode: string
  mutationOutcome: string
  requested: Array<{ kind: string; editCount?: number }>
  actions: Array<{ status: string }>
  preApplicationHashes: FileHashes
  postApplicationHashes: FileHashes
  liveHashes: FileHashes
  consumerOracle?: { exitCode: number; output: string; stderr: string }
  recovery?: {
    blocked: { status: string }
    sameBytes: { status: string; revertedPaths: number }
    repaired: {
      ok: boolean
      revertedPaths: number
      revertedTransactions: number
    }
  }
}>('B06_SEMANTIC')
assert.deepEqual(semantic.map(({ mode }) => mode).sort(), [
  'committed', 'consumer-failure', 'foreign-midcommit', 'occupied-create', 'stale',
])
const joinedSemantic = semantic.map((row) => {
  // A receipt only attests the applied wire edits. The separately executed
  // consumer must also observe the exact intended result for this fixture.
  const oracle = row.consumerOracle
  const consumerValidation = !oracle ? 'not_run'
    : oracle.exitCode === 0 &&
      oracle.output === '{"consumed":42,"helper":true,"moved":2}' &&
      oracle.stderr === '' ? 'passed' : 'failed'
  const completeIntentSuccess =
    row.mutationOutcome === 'applied' &&
    row.actions.length === 5 &&
    row.actions.every(({ status }) => status === 'committed') &&
    consumerValidation === 'passed'
  return { ...row, consumerValidation, completeIntentSuccess }
})
const byMode = new Map(joinedSemantic.map((row) => [row.mode, row]))
const committed = byMode.get('committed')!
const consumerFailure = byMode.get('consumer-failure')!
for (const applied of [committed, consumerFailure]) {
  assert.equal(applied.mutationOutcome, 'applied')
  assert.deepEqual(applied.requested.map(({ kind }) => kind), [
    'text', 'create', 'text', 'text', 'rename', 'delete',
  ])
  assert.deepEqual(
    applied.actions.map(({ status }) => status),
    Array(5).fill('committed'),
  )
}
assert.equal(committed.requested[3]?.editCount, 2)
assert.equal(committed.consumerValidation, 'passed')
assert.equal(consumerFailure.requested[3]?.editCount, 1)
assert.equal(consumerFailure.consumerOracle?.exitCode, 1)
assert.equal(consumerFailure.consumerOracle?.output, '')
assert.match(consumerFailure.consumerOracle?.stderr ?? '', /ReferenceError: value is not defined/)
assert.equal(consumerFailure.consumerValidation, 'failed')
assert.deepEqual(
  joinedSemantic.filter(({ completeIntentSuccess }) => completeIntentSuccess).map(({ mode }) => mode),
  ['committed'],
)
for (const mode of ['stale', 'occupied-create']) {
  const refused = byMode.get(mode)!
  assert.equal(refused.mutationOutcome, 'not_applied')
  assert.equal(refused.consumerValidation, 'not_run')
  assert.deepEqual(refused.postApplicationHashes, refused.preApplicationHashes)
}
const interrupted = byMode.get('foreign-midcommit')!
assert.equal(interrupted.mutationOutcome, 'rollback_incomplete')
assert.equal(interrupted.consumerValidation, 'not_run')
assert.equal(
  interrupted.postApplicationHashes['definition.ts'],
  'sha256:' + digest('foreign source\n'),
)
assert.equal(interrupted.recovery?.blocked.status, 'recovery_required')
assert.equal(interrupted.recovery?.sameBytes.status, 'recovery_required')
assert.equal(interrupted.recovery?.sameBytes.revertedPaths, 0)
assert.deepEqual(interrupted.recovery?.repaired, {
  ok: true,
  revertedPaths: 0,
  revertedTransactions: 1,
  recoveredCommittedTransactions: 0,
})
assert.deepEqual(interrupted.liveHashes, interrupted.preApplicationHashes)

const emptyMembers = capture<{
  mode: string
  form: string
  output: { applied?: boolean; errorMessage: string }
  secondarySyncVersions: number[]
  wireReplyHash: string
  capturedHashes: string[]
  beforeHashes: string[]
  afterHashes: string[]
  commitAttempts: number
  brokerStates: string[]
  intentLogExists: boolean
}>('B06_EMPTY_MEMBER')
assert.deepEqual(emptyMembers.map(({ form, mode }) => `${form}/${mode}`).sort(), [
  'changes/raw-drift', 'documentChanges/fresh', 'documentChanges/raw-drift', 'documentChanges/resynchronized',
])
for (const row of emptyMembers) {
  assert.match(row.wireReplyHash, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(row.output.applied, true)
  assert.match(row.output.errorMessage, /empty text edit lists are unsupported/)
  assert.deepEqual(row.secondarySyncVersions, row.mode === 'resynchronized' ? [1, 2] : [1])
  assert.equal(row.beforeHashes[0], row.capturedHashes[0])
  if (row.mode === 'raw-drift') assert.notEqual(row.beforeHashes[1], row.capturedHashes[1])
  else assert.equal(row.beforeHashes[1], row.capturedHashes[1])
  assert.deepEqual(row.afterHashes, row.beforeHashes)
  assert.equal(row.commitAttempts, 0)
  assert.deepEqual(row.brokerStates, [])
  assert.equal(row.intentLogExists, false)
}

const multiplicity = capture<{
  mode: string
  observed: string[]
  commitAttempts: number
  beforeHashes: string[]
  afterHashes: string[]
  brokerStates: string[]
}>('B06_MULTIPLICITY')
assert.equal(multiplicity.length, 5)
const acceptedMultiplicity = new Map([
  ['duplicate insertions', 'xyxza'],
  ['insertions before replacement', 'xxrenamed'],
])
assert.equal(new Set(multiplicity.map(({ mode }) => mode)).size, 5)
for (const row of multiplicity) {
  const expected = acceptedMultiplicity.get(row.mode)
  if (expected) {
    assert.deepEqual(row.observed, [
      'const renamed = 1\r\n',
      `const ${expected} = 2\r\n`,
    ])
    assert.equal(row.commitAttempts, 2)
    assert.deepEqual(row.brokerStates, ['committed', 'committed'])
  } else {
    assert.deepEqual(row.afterHashes, row.beforeHashes)
    assert.equal(row.commitAttempts, 0)
    assert.deepEqual(row.brokerStates, [])
  }
}

const actions = capture<{
  mode: string
  outcome: string
  commandRequests: number
  brokerStates: string[]
}>('B06_ACTION')
assert.equal(actions.length, 12)
for (const action of actions) {
  assert.equal(action.commandRequests, 0)
  if (action.mode.endsWith('-applied') || action.mode.endsWith('-annotated')) {
    assert.equal(action.outcome, 'applied')
    assert(
      action.brokerStates.length >= 1 &&
        action.brokerStates.every((state) => state === 'committed'),
    )
  } else {
    assert.notEqual(action.outcome, 'applied')
    assert.deepEqual(action.brokerStates, [])
  }
}
const utf8 = capture<{
  mode: string
  encoding: string
  beforeHash: string
  afterHash: string
  sentPositions: Array<{ line: number; character: number }>
  brokerStates: string[]
}>('B06_UTF8')
assert.equal(utf8.length, 3)
for (const control of utf8) {
  assert.equal(control.encoding, 'utf-8')
  assert(
    control.sentPositions.length &&
      control.sentPositions.every(
        (position) => position.line === 0 && position.character === 8,
      ),
  )
  if (control.mode === 'rename') {
    assert.notEqual(control.beforeHash, control.afterHash)
    assert.deepEqual(control.brokerStates, ['committed'])
  } else {
    assert.equal(control.beforeHash, control.afterHash)
    assert.deepEqual(control.brokerStates, [])
  }
}

const crashes = capture<{
  boundary: number
  signal: string
  outcome: {
    ok: boolean
    revertedPaths: number
    recoveredCommittedTransactions: number
  }
}>('B07_BOUNDARY').sort((a, b) => a.boundary - b.boundary)
assert.deepEqual(
  crashes.map((row) => row.boundary),
  [0, 1, 2, 3, 4],
)
assert(crashes.every((row) => row.signal === 'SIGKILL' && row.outcome.ok))
assert.deepEqual(
  crashes.map((row) => row.outcome.revertedPaths),
  [0, 1, 2, 3, 0],
)
assert.equal(crashes.at(-1)?.outcome.recoveredCommittedTransactions, 1)
const conflicts = capture<{
  control: string
  signal: string
  outcome: { status: string; revertedPaths: number }
  retry: { status: string; revertedPaths: number }
  forwardReceiptIds: string[]
  transitions: Array<{ kind: string }>
}>('B07_FOREIGN')
const expectedConflicts = new Map([
  ['foreign-update', [0, 0]],
  ['foreign-delete', [2, 2]],
  ['foreign-move', [3, 3]],
  ['replaced-postimage', [1, 0]],
  ['lookalike', [1, 0]],
  ['recreated-move-source', [4, 3]],
])
assert.equal(conflicts.length, expectedConflicts.size)
assert.equal(
  new Set(conflicts.map(({ control }) => control)).size,
  expectedConflicts.size,
)
for (const row of conflicts) {
  assert.equal(row.signal, 'SIGKILL')
  assert.equal(row.outcome.status, 'recovery_required')
  assert.equal(row.retry.status, 'recovery_required')
  assert.equal(row.retry.revertedPaths, 0)
  assert.deepEqual(
    [row.forwardReceiptIds.length, row.outcome.revertedPaths],
    expectedConflicts.get(row.control),
  )
  assert(
    !row.transitions.some(
      ({ kind }) => kind === 'tx_abort' || kind === 'tx_commit',
    ),
  )
}

const lockedCrashes = capture<{
  signal: string
  beforeOperatorAction: string
  pending: { state: string; correlation: { actionId: string } }
  afterOperatorAction: {
    ok: boolean
    revertedPaths: number
    revertedTransactions: number
  }
  retry: { ok: boolean; revertedPaths: number }
  receipts: Array<{ receiptId: string; state: string }>
}>('B07_LOCKED_CRASH')
if (process.platform === 'linux') {
  assert.equal(lockedCrashes.length, 1)
  const locked = lockedCrashes[0]!
  assert.equal(locked.signal, 'SIGKILL')
  assert.equal(locked.beforeOperatorAction, 'recovery_required')
  assert.equal(locked.pending.state, 'prepared')
  assert.equal(locked.afterOperatorAction.ok, true)
  assert.equal(locked.afterOperatorAction.revertedPaths, 1)
  assert.equal(locked.afterOperatorAction.revertedTransactions, 1)
  assert.equal(locked.retry.ok, true)
  assert.equal(locked.retry.revertedPaths, 0)
  assert.equal(
    locked.receipts.find(
      ({ receiptId }) => receiptId === locked.pending.correlation.actionId,
    )?.state,
    'recovered_committed',
  )
}
writeJson('observations.json', {
  semantic: joinedSemantic,
  emptyMembers,
  multiplicity,
  actions,
  utf8,
  b07CoordinatorCrashControls: crashes,
  b07UnownedCrashControls: conflicts,
  b07OwnedInBrokerCrash: lockedCrashes,
})
writeJson('receipt.json', {
  schemaVersion: 1,
  kind: 'local-workspace-edit-sequential-evidence',
  node: 'B06',
  accepted: false,
  toolchain: {
    manifestPath,
    manifestSha256: digest(manifestBytes),
    host,
    executable,
    executableHash,
    version: Bun.version,
  },
  sourceSha256,
  artifactSha256: Object.fromEntries(
    [
      'tests.stdout.log',
      'tests.stderr.log',
      'invocation.json',
      'observations.json',
    ].map((name) => [name, fileHash(path.join(evidence, name))]),
  ),
  scope:
    'Framed offline LSP replies, real local workspace broker, separate local consumer execution, and B07 crash/capacity/SDK dispatch controls. Mutation applied is not consumer-validated success. This is not independent acceptance, an installed/remote LSP matrix, or a full source-closure receipt.',
})
console.log(`B06 local observations verified: ${evidence}`)
