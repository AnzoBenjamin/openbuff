import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as sdk from '../../../../sdk/src/index'

// Companion to the reviewed positive fixture: real configured SDK refusals.
// Mutated artifacts are negative-control inputs, never source-built candidates.
const [manifestArgument, evidenceArgument] = process.argv.slice(2)
assert.ok(manifestArgument && evidenceArgument && process.argv.length === 4)
const manifestPath = path.resolve(manifestArgument)
const evidenceDir = path.resolve(evidenceArgument)
fs.mkdirSync(evidenceDir)
const hash = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const artifact = manifest.artifacts.find(
  (row: any) => row.id === 'native-checkout',
)
assert.ok(artifact?.sha256 && artifact.buildReceipt)
assert.equal(hash(artifact.path), artifact.sha256)
assert.equal(hash(artifact.buildReceipt.path), artifact.buildReceipt.sha256)
const bindings = Object.fromEntries(
  Object.values(manifest.inputs)
    .flat()
    .map((row: any) => [row.path, row.sha256]),
)
for (const [file, expected] of Object.entries(bindings))
  assert.equal(hash(file), expected)
const bwrap = fs.realpathSync('/usr/bin/bwrap')
assert.equal(
  hash(bwrap),
  manifest.tools.bwrap.expectedSha256ByHost['linux-x64'],
)
const before = { ...bindings, [import.meta.path]: hash(import.meta.path) }
const sourceBinary = path.resolve(artifact.path)
const installed = path.join(evidenceDir, 'openbuff-native')
fs.copyFileSync(sourceBinary, installed, fs.constants.COPYFILE_EXCL)
fs.chmodSync(installed, 0o700)
const originalFetch = globalThis.fetch
let providerCalls = 0
globalThis.fetch = Object.assign(
  async () => {
    providerCalls++
    throw new Error('Adverse fixture attempted provider fetch')
  },
  { preconnect() {} },
) as typeof fetch
const observations: any[] = []
let failure: string | null = null
try {
  const program = {
    id: 'fixture-a-adverse',
    displayName: 'Authored adverse native fixture',
    model: 'fixture-model',
    outputMode: 'structured_output' as const,
    toolNames: ['run_terminal_command', 'set_output'] as any,
    handleSteps: function* ({ prompt }: any): Generator<any, void, any> {
      const input = JSON.parse(prompt)
      const result = yield {
        toolName: 'run_terminal_command',
        input: {
          command: input.command,
          process_type: 'SYNC',
          timeout_seconds: 5,
        },
      }
      yield { toolName: 'set_output', input: { result: result.toolResult } }
    },
  }
  const scoped = {
    policy: 'workspace-write',
    preferredBackend: 'native-exec',
    required: [
      'exact-env',
      'filesystem-isolation',
      'network-isolation',
      'process-tree-containment',
    ],
    optional: [],
    allowBackendFallback: false,
  }
  const native = {
    artifact: {
      path: installed,
      sha256: artifact.sha256,
      platform: 'linux-x64-gnu',
      crateVersion: '0.1.0',
      workspaceProtocol: '1',
    },
    bwrap: { path: bwrap, sha256: hash(bwrap) },
    runtimePaths: ['/usr', '/bin', '/lib', '/lib64'],
    network: 'deny',
    landlock: 'optional',
  }
  const incompatible = path.join(evidenceDir, 'incompatible-native')
  const bytes = fs.readFileSync(installed)
  const oldProtocol = Buffer.from('openbuff.exec.v1'),
    newProtocol = Buffer.from('openbuff.exec.v9')
  const offsets: number[] = []
  for (
    let offset = bytes.indexOf(oldProtocol);
    offset >= 0;
    offset = bytes.indexOf(oldProtocol, offset + oldProtocol.length)
  ) {
    offsets.push(offset)
    newProtocol.copy(bytes, offset)
  }
  assert.ok(offsets.length > 0)
  fs.writeFileSync(incompatible, bytes, { flag: 'wx', mode: 0o700 })
  const incompatibleProbe = spawnSync(incompatible, ['version', '--json'], {
    env: { LANG: 'C' },
    encoding: 'utf8',
    timeout: 2000,
  })
  fs.writeFileSync(
    path.join(evidenceDir, 'incompatible-probe.json'),
    JSON.stringify(
      {
        offsets,
        originalSha256: artifact.sha256,
        mutatedSha256: hash(incompatible),
        status: incompatibleProbe.status,
        stdout: incompatibleProbe.stdout,
        stderr: incompatibleProbe.stderr,
      },
      null,
      2,
    ) + '\n',
  )
  assert.equal(incompatibleProbe.status, 0)
  assert.equal(
    JSON.parse(incompatibleProbe.stdout).execProtocol,
    'openbuff.exec.v9',
  )
  const nonExecutable = path.join(evidenceDir, 'nonexecutable-native')
  fs.copyFileSync(installed, nonExecutable)
  fs.chmodSync(nonExecutable, 0o600)
  const corrupt = path.join(evidenceDir, 'corrupt-native')
  fs.copyFileSync(installed, corrupt)
  const corruptBytes = fs.readFileSync(corrupt)
  corruptBytes[0] = 0
  fs.writeFileSync(corrupt, corruptBytes)
  fs.chmodSync(corrupt, 0o700)
  const scenarios = [
    {
      name: 'missing-artifact',
      native: {
        ...native,
        artifact: {
          ...native.artifact,
          path: path.join(evidenceDir, 'missing-native'),
        },
      },
      profile: scoped,
      succeeds: false,
    },
    {
      name: 'nonexecutable-artifact',
      native: {
        ...native,
        artifact: { ...native.artifact, path: nonExecutable },
      },
      profile: scoped,
      succeeds: false,
    },
    {
      name: 'corrupt-artifact',
      native: { ...native, artifact: { ...native.artifact, path: corrupt } },
      profile: scoped,
      succeeds: false,
    },
    {
      name: 'incompatible-exec-version',
      native: {
        ...native,
        artifact: {
          ...native.artifact,
          path: incompatible,
          sha256: hash(incompatible),
        },
      },
      profile: scoped,
      succeeds: false,
    },
    {
      name: 'required-unavailable-filesystem',
      native: { ...native, network: 'inherit', landlock: 'disabled' },
      profile: {
        ...scoped,
        policy: 'full-access',
        required: ['exact-env', 'filesystem-isolation'],
      },
      succeeds: false,
    },
    {
      name: 'optional-unavailable-filesystem',
      native: { ...native, network: 'inherit', landlock: 'disabled' },
      profile: {
        ...scoped,
        policy: 'full-access',
        required: ['exact-env'],
        optional: ['filesystem-isolation', 'network-isolation'],
      },
      succeeds: true,
    },
    {
      name: 'required-unavailable-full-access-deadline',
      native: { ...native, network: 'inherit', landlock: 'disabled' },
      profile: {
        ...scoped,
        policy: 'full-access',
        required: ['exact-env', 'deadline-termination'],
      },
      succeeds: false,
    },
  ]
  for (const scenario of scenarios) {
    const root = path.join(evidenceDir, scenario.name)
    fs.mkdirSync(root)
    const bin = path.join(root, '.fixture-bin')
    fs.mkdirSync(bin)
    for (const command of ['bash', 'git', 'sleep'])
      fs.symlinkSync(
        fs.realpathSync('/usr/bin/' + command),
        path.join(bin, command),
      )
    const python = spawnSync(
      '/usr/bin/bash',
      ['-c', 'command -v python || command -v python3'],
      { env: { PATH: bin }, encoding: 'utf8' },
    )
    assert.equal(python.status, 1)
    assert.equal(python.stdout, '')
    assert.equal(
      spawnSync('/usr/bin/git', ['init', '--quiet', root], {
        env: { PATH: '/usr/bin:/bin' },
      }).status,
      0,
    )
    const config = path.join(root, 'openbuff.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        providers: {},
        autoFileChangeHooks: false,
        fileChangeHooks: [],
        execution: { profile: scenario.profile, native: scenario.native },
      }),
    )
    const client = new sdk.OpenbuffClient({
      cwd: root,
      hostConfiguration: {
        environment: {
          PATH: bin,
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          OPENBUFF_PROCESS_SUPERVISION: '0',
        },
        platform: 'linux',
        invocationCwd: root,
        projectRoot: root,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: config, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
      configReadFs: sdk.nodeConfigReadFs,
      fsSource: sdk.createNodeFileSystem(),
      projectFiles: {},
      knowledgeFiles: {},
      harnessStateDir: path.join(root, 'harness'),
      approvalMode: 'allow-all',
    })
    const marker = path.join(root, 'target-ran')
    const events: any[] = [],
      start = performance.now()
    const result = await client.run({
      agent: program,
      prompt: JSON.stringify({
        command: 'printf adverse-control > target-ran; exit 7',
      }),
      runTimeoutMs: 15000,
      recordExecution: (event) => events.push(event),
    })
    const observation = {
      name: scenario.name,
      result,
      events,
      python: { status: python.status, stdout: python.stdout },
      elapsedMs: performance.now() - start,
      markerPresent: fs.existsSync(marker),
    }
    observations.push(observation)
    fs.writeFileSync(
      path.join(evidenceDir, scenario.name + '.json'),
      JSON.stringify(observation, null, 2) + '\n',
      { flag: 'wx' },
    )
    if (scenario.succeeds) {
      assert.equal(result.output.type, 'structuredOutput')
      const terminal = (result.output as any).value.result[0].value
      assert.equal(terminal.exitCode, 7)
      assert.ok(fs.existsSync(marker))
      assert.equal(terminal.executionWaitStatusSource, 'native-target-wait')
      assert.equal(terminal.processCleanup.status, 'complete')
      assert.equal(
        terminal.executionUsage.scope,
        'actual-target-wait4; maxrss is target peak',
      )
    } else {
      assert.equal(
        fs.existsSync(marker),
        false,
        'Refused configuration must not dispatch the target',
      )
      assert.ok(
        !events.some((event) => event.phase === 'native-entry-committed'),
        'No native target commit for refused configuration/profile',
      )
      const terminal =
        result.output.type === 'structuredOutput'
          ? (result.output as any).value.result[0].value
          : null
      assert.ok(
        result.output.type === 'error' ||
          terminal?.executionRefusal ||
          terminal?.errorMessage,
        'Refusal must reach the public result',
      )
      if (scenario.name === 'required-unavailable-full-access-deadline') {
        assert.equal(terminal?.executionRefusal?.reason, 'unavailable')
        const refused = events.find(
          (event) =>
            event.phase === 'no-launch' &&
            event.facts.branchId === 'terminal.sync',
        )
        assert.ok(refused)
        const profile = refused.facts.profile
        assert.ok(profile.requested.required.includes('deadline-termination'))
        assert.equal(profile.selected, null)
        const nativeBackend = profile.available.find(
          (backend: any) => backend.backend === 'native-exec',
        )
        assert.equal(
          nativeBackend?.generation,
          `native-exec:${native.artifact.sha256}`,
        )
        assert.ok(nativeBackend.capabilities.includes('exact-env'))
        assert.ok(
          profile.available.every(
            (backend: any) =>
              !backend.capabilities.includes('deadline-termination'),
          ),
        )
      }
    }
    assert.ok(
      (result.executionCleanup ?? []).every(
        (entry) => entry.status === 'complete',
      ),
      'Returned retained cleanup must remain explicit',
    )
    assert.equal(providerCalls, 0)
  }
} catch (error) {
  failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
} finally {
  globalThis.fetch = originalFetch
  const after = Object.fromEntries(
    Object.keys(before).map((file) => [file, hash(file)]),
  )
  if (JSON.stringify(after) !== JSON.stringify(before))
    failure ??= 'Selected source/input drift'
  fs.writeFileSync(
    path.join(evidenceDir, 'receipt.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        node: 'B21',
        boundary:
          'authored fixture A adverse real configured source SDK controls',
        sourceBefore: before,
        sourceAfter: after,
        artifactSha256: artifact.sha256,
        installedSha256: hash(installed),
        providerCalls,
        observations,
        failure,
        accepted: false,
        limitations: [
          'Mutated native protocol is a declared negative control, not compiled artifact credit',
          'Cancellation, stale basis, native hard limit, packed SDK and installed CLI remain separate obligations',
        ],
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
}
if (failure) throw new Error(failure)
console.log(
  JSON.stringify({ ok: true, scenarios: observations.length, providerCalls }),
)
