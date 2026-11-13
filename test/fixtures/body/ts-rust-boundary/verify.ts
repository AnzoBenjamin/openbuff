import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  captureBootstrapEnvironment,
  defaultBootstrapDependencies,
  verifyBootstrap,
} from '../../../../scripts/body-bootstrap'
import type { AgentDefinition } from '../../../../common/src/templates/initial-agents-dir/types/agent-definition'
import type {
  LaunchEvent,
  ProfileRequest,
} from '../../../../common/src/types/contracts/execution-context'

// Authored fixture A: real installed native artifact and public SDK, no Python.
const arguments_ = new Map<string, string>()
let withoutPython = false
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index]!
  if (key === '--without-python' && !withoutPython) {
    withoutPython = true
    continue
  }
  assert.ok(
    ['--manifest', '--native-binary', '--evidence-dir'].includes(key) &&
      !arguments_.has(key),
    `Unexpected/repeated argument: ${key}`,
  )
  const value = process.argv[++index]
  assert.ok(value && !value.startsWith('--'), `Missing argument value: ${key}`)
  arguments_.set(key, value)
}
assert.ok(
  withoutPython && arguments_.size === 3,
  'Require --manifest, --native-binary, --without-python and --evidence-dir',
)
const evidenceDir = path.resolve(arguments_.get('--evidence-dir')!)
const manifestPath = path.resolve(arguments_.get('--manifest')!)
const sourceBinary = path.resolve(arguments_.get('--native-binary')!)
fs.mkdirSync(evidenceDir, { recursive: false })
process.once('exit', (exitCode) => {
  const receiptPath = path.join(evidenceDir, 'receipt.json')
  if (!fs.existsSync(receiptPath))
    fs.writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          node: 'B21',
          boundary: 'incomplete authored-fixture preparation',
          argv: process.argv.slice(2),
          exitCode,
          accepted: false,
          failure:
            'Fixture stopped before its complete receipt; preserve the raw command log and any bootstrap receipt',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    )
})
const sha = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const manifestBytes = fs.readFileSync(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const environment = captureBootstrapEnvironment(process.env)
const bootstrap = await verifyBootstrap(
  manifest,
  {
    manifestPath,
    evidenceDir: path.join(evidenceDir, 'bootstrap'),
    requiredCells: ['native-linux', 'node'],
  },
  defaultBootstrapDependencies(environment),
)
assert.equal(
  bootstrap.exitCode,
  0,
  'Selected current prerequisite verification failed; no native adoption credit',
)
const artifact = manifest.artifacts.find(
  (entry: { id: string }) => entry.id === 'native-checkout',
)
assert.ok(
  artifact?.sha256 && artifact.buildReceipt,
  'Native artifact requires a source-bound build receipt and selected checksum',
)
assert.equal(path.resolve(artifact.path), sourceBinary)
assert.equal(sha(sourceBinary), artifact.sha256)
assert.equal(
  sha(path.resolve(artifact.buildReceipt.path)),
  artifact.buildReceipt.sha256,
)
const buildProof = JSON.parse(
  fs.readFileSync(path.resolve(artifact.buildReceipt.path), 'utf8'),
)
assert.equal(buildProof.schemaVersion, 1)
assert.equal(buildProof.type, 'body-bootstrap-artifact-build')
assert.equal(buildProof.exitCode, 0)
assert.equal(buildProof.artifact?.sha256, artifact.sha256)
assert.equal(path.resolve(buildProof.artifact?.path ?? ''), sourceBinary)
for (const source of manifest.inputs.sources)
  assert.equal(
    buildProof.sourceContractHashes?.[source.path],
    source.sha256,
    `Build source binding: ${source.path}`,
  )
for (const source of [
  ...manifest.inputs.packages,
  ...manifest.inputs.locks,
  ...manifest.inputs.configuration,
])
  assert.equal(
    buildProof.contextContractHashes?.[source.path],
    source.sha256,
    `Build context binding: ${source.path}`,
  )
const installationDir = path.join(evidenceDir, 'installation')
fs.mkdirSync(installationDir)
const installedBinary = path.join(installationDir, 'openbuff-native')
fs.copyFileSync(sourceBinary, installedBinary, fs.constants.COPYFILE_EXCL)
fs.chmodSync(installedBinary, 0o700)
assert.equal(sha(installedBinary), artifact.sha256)
assert.ok(fs.statSync(installedBinary).isFile())
const bwrap = bootstrap.observed.tools.find(
  (entry: { id: string }) => entry.id === 'bwrap',
)
assert.ok(bwrap?.resolvedPath && bwrap.before?.sha256)
const sourceFiles = [
  'test/fixtures/body/ts-rust-boundary/verify.ts',
  'scripts/body-bootstrap.ts',
  'sdk/src/index.ts',
  'sdk/src/run.ts',
  'sdk/src/run-state.ts',
  'sdk/src/host-execution.ts',
  'sdk/src/host-config.ts',
  'sdk/src/provider-config.ts',
  'sdk/src/services/configured-host-execution.ts',
  'sdk/src/services/host-execution-config.ts',
  'sdk/src/services/execution-launch.ts',
  'sdk/src/services/native-host-execution.ts',
  'sdk/src/services/native-exec.ts',
  'sdk/src/tools/run-terminal-command.ts',
  'sdk/src/tools/background-jobs.ts',
  'sdk/src/tools/check-job.ts',
  'common/src/util/execution-context.ts',
  'common/src/types/contracts/execution-context.ts',
  'common/src/types/contracts/native-execution.ts',
  'common/src/types/contracts/process-scope.ts',
  'common/src/tools/params/execution-usage.ts',
  'common/src/tools/params/native-wait-status.ts',
  'rust/Cargo.lock',
  'rust/crates/openbuff-native/Cargo.toml',
  'rust/crates/openbuff-native/src/exec/control.rs',
  'rust/crates/openbuff-native/src/exec/runner.rs',
  'rust/crates/openbuff-native/src/exec/entry_waiter.rs',
  'rust/crates/openbuff-native/src/exec/linux_sandbox.rs',
  'rust/crates/openbuff-native/src/exec/plan.rs',
]
const sourceHashes = () =>
  Object.fromEntries(sourceFiles.map((file) => [file, sha(path.resolve(file))]))
const before = sourceHashes()
const roots = [
  path.join(evidenceDir, 'workspace'),
  path.join(evidenceDir, 'excluded'),
]
for (const root of roots) fs.mkdirSync(root)
const [root, excluded] = roots as [string, string]
const targetPath = path.join(root, '.fixture-bin')
fs.mkdirSync(targetPath)
for (const command of ['bash', 'git', 'cat', 'sleep'])
  fs.symlinkSync(
    fs.realpathSync(`/usr/bin/${command}`),
    path.join(targetPath, command),
  )
assert.deepEqual(fs.readdirSync(targetPath).sort(), [
  'bash',
  'cat',
  'git',
  'sleep',
])
const pythonLookup = spawnSync(
  '/usr/bin/bash',
  ['-c', 'command -v python || command -v python3'],
  {
    env: { PATH: targetPath },
    encoding: 'utf8',
  },
)
assert.equal(
  pythonLookup.status,
  1,
  'Python must be absent from the fixture target PATH',
)
assert.equal(pythonLookup.stdout, '')
assert.equal(
  spawnSync('/usr/bin/git', ['init', '--quiet', root], {
    env: { PATH: '/usr/bin:/bin' },
  }).status,
  0,
)
fs.writeFileSync(path.join(root, 'allowed.txt'), 'allowed-body-A')
fs.writeFileSync(path.join(excluded, 'excluded.txt'), 'excluded-body-A')
const configPath = path.join(root, 'openbuff.json')
fs.writeFileSync(
  configPath,
  '{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}',
)
const hostConfiguration = {
  environment: {
    PATH: targetPath,
    FIXTURE_VALUE: 'body-A-exact',
    OPENAI_API_KEY: 'fixture-only-secret',
    OPENBUFF_PROCESS_SUPERVISION: '0',
    OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  },
  platform: 'linux' as const,
  invocationCwd: root,
  projectRoot: root,
  home: { kind: 'none' as const },
  globals: { kind: 'disabled' as const },
  selection: {
    kind: 'explicit' as const,
    path: configPath,
    required: true as const,
  },
  trust: { ancestorConfig: false, projectReadableRoots: false },
}
const originalFetch = globalThis.fetch
let providerCalls = 0
globalThis.fetch = Object.assign(
  async () => {
    providerCalls++
    throw new Error('Authored fixture A attempted provider/network inference')
  },
  { preconnect() {} },
) as typeof fetch
const observations: unknown[] = []
let failure: string | null = null
const sdk = await import('../../../../sdk/src/index')
const nativeDeclaration = {
  artifact: {
    path: installedBinary,
    sha256: artifact.sha256,
    platform: 'linux-x64-gnu' as const,
    crateVersion: '0.1.0' as const,
    workspaceProtocol: '1' as const,
  },
  bwrap: { path: bwrap.resolvedPath, sha256: bwrap.before.sha256 },
  runtimePaths: ['/usr', '/bin', '/lib', '/lib64'],
  network: 'deny' as const,
  landlock: 'optional' as const,
}
try {
  const program: AgentDefinition = {
    id: 'fixture-a-native',
    displayName: 'Authored native fixture',
    model: 'fixture-model',
    outputMode: 'structured_output',
    toolNames: ['run_terminal_command', 'check_job', 'set_output'],
    handleSteps: function* ({ prompt }) {
      const input = JSON.parse(prompt ?? '{}')
      const result = yield {
        toolName: 'run_terminal_command',
        input: {
          command: input.command,
          process_type: input.background ? 'BACKGROUND' : 'SYNC',
          timeout_seconds: 5,
        },
      }
      const results = [result.toolResult]
      if (input.background) {
        const jobId = (result.toolResult as any)[0]?.value?.jobId
        if (!jobId) throw new Error('Background job was not started')
        const poll = yield {
          toolName: 'check_job',
          input: { jobId, timeout_seconds: 2 },
        }
        results.push(poll.toolResult)
      }
      yield { toolName: 'set_output', input: { results } }
    },
  }
  const client = new sdk.OpenbuffClient({
    cwd: root,
    hostConfiguration,
    configReadFs: sdk.nodeConfigReadFs,
    projectFiles: {},
    knowledgeFiles: {},
    fsSource: sdk.createNodeFileSystem(),
    harnessStateDir: path.join(root, 'harness'),
    approvalMode: 'allow-all',
  })
  const scoped: ProfileRequest = {
    policy: 'workspace-write',
    preferredBackend: 'native-exec',
    required: [
      'exact-env',
      'filesystem-isolation',
      'network-isolation',
      'process-tree-containment',
      'deadline-termination',
    ],
    optional: ['memory-limit'],
    allowBackendFallback: false,
  }
  const scenarios = [
    {
      name: 'raw-env-file-exit',
      command: `printf '%s|%s|%s\\n' "$FIXTURE_VALUE" "${'$'}{OPENAI_API_KEY-unset}" "$PWD"; cat allowed.txt; printf '\\n{"jsonrpc":"2.0","method":"ordinary-target-output"}\\n'; cat '${path.join(excluded, 'excluded.txt')}'; exit 7`,
      profile: scoped,
    },
    {
      name: 'background-target-exit',
      command: 'printf background-body-A; sleep 0.1; exit 7',
      profile: scoped,
      background: true,
    },
    {
      name: 'direct-target-signal',
      command: 'ulimit -c 0; sleep 0.1; kill -SEGV $$',
      profile: {
        ...scoped,
        policy: 'full-access' as const,
        required: ['exact-env'] as const,
        optional: ['filesystem-isolation', 'network-isolation'] as const,
      },
    },
  ]
  for (const scenario of scenarios) {
    // The public SDK performs verification/calibration under this run's
    // original boundary, with its setup cleanup joined into the result.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {},
        autoFileChangeHooks: false,
        fileChangeHooks: [],
        execution: { profile: scenario.profile, native: nativeDeclaration },
      }),
    )
    const events: LaunchEvent[] = [],
      startedAtUtc = new Date().toISOString(),
      startMs = performance.now()
    const result = await client.run({
      agent: program,
      prompt: JSON.stringify(scenario),
      runTimeoutMs: 10000,
      recordExecution: (event) => events.push(event),
    })
    observations.push({
      ...scenario,
      result,
      events,
      startedAtUtc,
      finishedAtUtc: new Date().toISOString(),
      elapsedMs: performance.now() - startMs,
    })
    fs.writeFileSync(
      path.join(evidenceDir, `${scenario.name}.json`),
      JSON.stringify(observations.at(-1), null, 2) + '\n',
      { flag: 'wx' },
    )
    assert.equal(result.output.type, 'structuredOutput')
    const results = (result.output as any).value.results
    const terminal = results[0][0].value
    if (!scenario.background)
      assert.equal(
        terminal.processCleanup.status,
        'complete',
        'Every completed target tool must confirm its physical cleanup',
      )
    if (scenario.name === 'raw-env-file-exit') {
      assert.equal(terminal.exitCode, 7)
      assert.match(terminal.stdout, /body-A-exact\|unset/)
      assert.ok(
        terminal.stdout.includes(root) &&
          terminal.stdout.includes('allowed-body-A') &&
          terminal.stdout.includes('"jsonrpc":"2.0"'),
      )
      assert.ok(!terminal.stdout.includes('excluded-body-A'))
      assert.match(terminal.stderr, /No such file|Permission denied/)
      assert.equal(
        terminal.dirtyObservationRefusal,
        undefined,
        'Native Git side observations must also complete',
      )
      assert.equal(terminal.processCleanup.status, 'complete')
      assert.ok(terminal.executionUsage)
      assert.equal(terminal.executionWaitStatusSource, 'native-target-wait')
      assert.equal(
        terminal.executionUsage.scope,
        'actual-target-wait4; maxrss is target peak',
      )
    } else if (scenario.name === 'background-target-exit') {
      const poll = results[1][0].value
      assert.equal(poll.exitCode, 7)
      assert.equal(poll.processCleanup.status, 'complete')
      assert.ok(poll.executionUsage)
      assert.equal(poll.executionWaitStatusSource, 'native-target-wait')
      assert.equal(
        poll.executionUsage.scope,
        'actual-target-wait4; maxrss is target peak',
      )
    } else {
      assert.equal(terminal.executionSignal, 11)
      assert.ok(terminal.errorMessage && terminal.executionUsage)
      assert.equal(terminal.executionWaitStatusSource, 'native-target-wait')
      assert.equal(
        terminal.executionUsage.scope,
        'actual-target-wait4; maxrss is target peak',
      )
    }
    assert.ok(events.some((event) => event.phase === 'native-entry-committed'))
    assert.ok(
      events.some(
        (event) =>
          event.phase === 'spawn-observed' &&
          event.facts.profile.active?.backend === 'native-exec',
      ),
    )
    assert.ok(
      !events.some((event) => event.phase === 'dispatch-failed'),
      'Preserve and repair any native side-operation failure',
    )
    assert.ok(
      !result.executionCleanup?.some(
        (cleanup) => cleanup.status !== 'complete',
      ),
    )
    assert.ok(
      result.executionCleanup?.some(
        (cleanup) =>
          cleanup.selectedTier === 'posix-owned-group' &&
          cleanup.status === 'complete',
      ),
      'Configured native setup must publish its original owned cleanup',
    )
  }
  assert.equal(providerCalls, 0)
  assert.equal(sha(installedBinary), artifact.sha256)
  assert.deepEqual(sourceHashes(), before, 'Fixture source drift')
  assert.equal(
    sha(manifestPath),
    createHash('sha256').update(manifestBytes).digest('hex'),
  )
} catch (error) {
  failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
} finally {
  globalThis.fetch = originalFetch
  const receipt = {
    schemaVersion: 1,
    node: 'B21',
    boundary:
      'authored-fixture-A; source public SDK plus copied installed native artifact',
    withoutPython: true,
    pythonLookup: {
      targetPath,
      exitCode: pythonLookup.status,
      stdout: pythonLookup.stdout,
    },
    sourceBinary: {
      path: sourceBinary,
      sha256: artifact.sha256,
      buildReceipt: artifact.buildReceipt,
    },
    installedBinary: {
      path: installedBinary,
      sha256: sha(installedBinary),
      mode: fs.statSync(installedBinary).mode & 0o777,
    },
    manifest: {
      path: manifestPath,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    },
    sourceBefore: before,
    sourceAfter: sourceHashes(),
    providerCalls,
    failure,
    scenarios: observations,
    accepted: false,
    limitations: [
      'No packed SDK or installed CLI credit',
      'No unsupported-platform enforcement credit',
      'No whole-card acceptance without independent review and remaining required controls',
    ],
  }
  fs.writeFileSync(
    path.join(evidenceDir, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  )
}
if (failure) throw new Error(failure)
console.log(
  JSON.stringify({
    ok: true,
    scenarios: observations.length,
    providerCalls,
    evidenceDir,
  }),
)
