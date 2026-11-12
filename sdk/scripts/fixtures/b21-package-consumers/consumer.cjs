const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

// Install observational guards before loading either packed SDK export. The
// public SDK supplies every profile, installation, deadline and launch service.
function prepare(format, output, specification) {
  const input = JSON.parse(fs.readFileSync(specification, 'utf8'))
  const state = { schemaVersion: 1, card: 'B21', format, status: 'running',
    runtime: { path: process.execPath, version: process.version }, input,
    fetchCalls: 0, nativeSpawns: [], scenarios: [], accepted: false,
    limitations: ['Packed Node config-only native consumer scope only',
      'Existing installed third-party dependency graph copied offline; no fresh dependency acquisition',
      'No authored negative-control, installed CLI, other-platform or whole-card acceptance'] }
  const save = () => json(output, state)
  const originalFetch = globalThis.fetch
  const forbiddenFetch = () => { state.fetchCalls++; save(); throw new Error('B21 provider/network fetch is forbidden') }
  globalThis.fetch = Object.assign(async () => forbiddenFetch(), { preconnect: forbiddenFetch })
  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function (specifier, ...args) {
    if (/^@(codebuff|openbuff)\//.test(specifier) &&
        !['@openbuff/sdk', '@openbuff/sdk/package.json'].includes(specifier)) {
      throw new Error('Workspace package import is forbidden: ' + specifier)
    }
    const resolved = originalResolve.call(this, specifier, ...args)
    if (typeof resolved === 'string' && resolved.startsWith(input.workspace + path.sep))
      throw new Error('Checkout import is forbidden: ' + resolved)
    return resolved
  }
  const originalSpawn = childProcess.spawn
  const children = []
  childProcess.spawn = function (command, argv, options) {
    let witness
    if (command === '/proc/self/fd/5' && typeof options?.stdio?.[5] === 'number') {
      const descriptorPath = '/proc/self/fd/' + options.stdio[5]
      witness = { command, argv: [...argv], installedDescriptorTarget: fs.readlinkSync(descriptorPath),
        installedDescriptorSha256: sha(descriptorPath), observedAtUtc: new Date().toISOString(),
        phase: state.phase, events: [] }
      assert.equal(witness.installedDescriptorSha256, input.native.sha256)
      assert.equal(witness.installedDescriptorTarget, input.native.installedPath)
      state.nativeSpawns.push(witness)
    }
    const child = originalSpawn.call(this, command, argv, options)
    if (witness) {
      witness.pid = child.pid
      const pending = new Promise(resolve => child.once('close', (code, signal) => {
        witness.events.push({ event: 'close', code, signal, atUtc: new Date().toISOString() })
        save(); resolve()
      }))
      children.push(pending)
      child.once('error', error => { witness.events.push({ event: 'error', message: error.message }); save() })
      save()
    }
    return child
  }
  Module.syncBuiltinESMExports()
  save()
  return { state, save, children, restore() {
    globalThis.fetch = originalFetch
    Module._resolveFilename = originalResolve
    childProcess.spawn = originalSpawn
    Module.syncBuiltinESMExports()
  } }
}

async function run(sdk, context) {
  const { state, save } = context
  const input = state.input
  try {
    assert.equal(process.version, 'v26.1.0')
    const entry = Module.createRequire(path.join(process.cwd(), 'host.cjs')).resolve('@openbuff/sdk')
    state.packageEntry = { path: entry, realpath: fs.realpathSync(entry), sha256: sha(entry) }
    assert.equal(fs.realpathSync(entry), path.join(input.installedPackage, 'dist/index.cjs'))
    const activeEntry = path.join(input.installedPackage, 'dist/index.' + (state.format === 'cjs' ? 'cjs' : 'mjs'))
    state.activePackageEntry = { path: activeEntry, sha256: sha(activeEntry) }
    assert.equal(sha(activeEntry), input.artifacts['sdk/dist/index.' + (state.format === 'cjs' ? 'cjs' : 'mjs')])
    const root = path.join(process.cwd(), state.format + '-workspace')
    const excluded = path.join(process.cwd(), state.format + '-excluded')
    fs.mkdirSync(root); fs.mkdirSync(excluded)
    const bin = path.join(root, '.fixture-bin')
    fs.mkdirSync(bin)
    for (const command of ['bash', 'git', 'cat', 'sleep'])
      fs.symlinkSync(fs.realpathSync('/usr/bin/' + command), path.join(bin, command))
    const lookup = childProcess.spawnSync('/usr/bin/bash', ['-c', 'command -v python || command -v python3'],
      { env: { PATH: bin }, encoding: 'utf8' })
    state.pythonLookup = { path: bin, status: lookup.status, stdout: lookup.stdout, stderr: lookup.stderr }
    assert.equal(lookup.status, 1); assert.equal(lookup.stdout, '')
    assert.equal(childProcess.spawnSync('/usr/bin/git', ['init', '--quiet', root],
      { env: { PATH: '/usr/bin:/bin' } }).status, 0)
    fs.writeFileSync(path.join(root, 'allowed.txt'), 'packed-B21-allowed')
    fs.writeFileSync(path.join(excluded, 'excluded.txt'), 'packed-B21-excluded')
    const configPath = path.join(root, 'openbuff.json')
    json(configPath, { providers: {}, autoFileChangeHooks: false, fileChangeHooks: [] })
    const client = new sdk.OpenbuffClient({ cwd: root,
      hostConfiguration: { environment: { PATH: bin, FIXTURE_VALUE: 'packed-B21-exact',
        OPENAI_API_KEY: 'fixture-only-secret', OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }, platform: 'linux', invocationCwd: root,
        projectRoot: root, home: { kind: 'none' }, globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: configPath, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false } },
      configReadFs: sdk.nodeConfigReadFs, projectFiles: {}, knowledgeFiles: {},
      fsSource: sdk.createNodeFileSystem(), harnessStateDir: path.join(root, 'harness'), approvalMode: 'allow-all' })
    const agent = { id: 'packed-b21-native', displayName: 'Packed B21 native consumer',
      model: 'fixture-model', outputMode: 'structured_output',
      toolNames: ['run_terminal_command', 'check_job', 'set_output'],
      handleSteps: function* ({ prompt }) {
        const scenario = JSON.parse(prompt ?? '{}')
        const result = yield { toolName: 'run_terminal_command', input: { command: scenario.command,
          process_type: scenario.background ? 'BACKGROUND' : 'SYNC', timeout_seconds: 5 } }
        const results = [result.toolResult]
        if (scenario.background) {
          const jobId = result.toolResult[0]?.value?.jobId
          if (!jobId) throw new Error('Background native job did not start')
          const poll = yield { toolName: 'check_job', input: { jobId, timeout_seconds: 2 } }
          results.push(poll.toolResult)
        }
        yield { toolName: 'set_output', input: { results } }
      } }
    const scoped = { policy: 'workspace-write', preferredBackend: 'native-exec',
      required: ['exact-env', 'filesystem-isolation', 'network-isolation', 'process-tree-containment', 'deadline-termination'],
      optional: ['memory-limit'], allowBackendFallback: false }
    const scenarios = [
      { name: 'sync-env-files-json-exit7', profile: scoped,
        command: `printf '%s|%s|%s\\n' "$FIXTURE_VALUE" "${'$'}{OPENAI_API_KEY-unset}" "$PWD"; cat allowed.txt; printf '\\n{"jsonrpc":"2.0","method":"ordinary-target-output"}\\n'; cat ${quote(path.join(excluded, 'excluded.txt'))}; exit 7` },
      { name: 'background-exit7-check-job', profile: scoped, background: true,
        command: 'printf packed-B21-background; sleep 0.1; exit 7' },
      { name: 'direct-target-signal11', profile: { ...scoped, policy: 'full-access',
        required: ['exact-env'], optional: ['filesystem-isolation', 'network-isolation'] },
        command: 'ulimit -c 0; sleep 0.1; kill -SEGV $$' },
    ]
    for (const scenario of scenarios) {
      state.phase = scenario.name
      const observation = { ...scenario, startedAtUtc: new Date().toISOString(), events: [], assertions: 'pending' }
      state.scenarios.push(observation); save()
      try {
        json(configPath, { providers: {}, autoFileChangeHooks: false, fileChangeHooks: [],
          execution: { profile: scenario.profile, native: { artifact: { path: input.native.installedPath,
            sha256: input.native.sha256, platform: 'linux-x64-gnu', crateVersion: '0.1.0', workspaceProtocol: '1' },
            bwrap: input.bwrap, runtimePaths: ['/usr', '/bin', '/lib', '/lib64'], network: 'deny', landlock: 'optional' } } })
        observation.configurationSha256 = sha(configPath)
        observation.result = await client.run({ agent, prompt: JSON.stringify(scenario), runTimeoutMs: 10000,
          recordExecution: event => { observation.events.push(event) } })
        observation.finishedAtUtc = new Date().toISOString(); save()
        const result = observation.result
        assert.equal(result.output.type, 'structuredOutput')
        const results = result.output.value.results
        const terminal = (scenario.background ? results[1] : results[0])[0].value
        observation.targetOutput = terminal; save()
        assert.equal(terminal.processCleanup.status, 'complete')
        assert.equal(terminal.processCleanup.selectedTier, scenario.profile.policy === 'full-access' ? 'direct-child' : 'linux-pid-namespace')
        assert.equal(terminal.processCleanup.observedTier, terminal.processCleanup.selectedTier)
        assert.equal(terminal.processCleanup.satisfiesSelectedTier, true)
        assert.equal(terminal.processCleanup.cleanupAuthorityRetained, false)
        assert.equal(terminal.processCleanup.finalObservation.leader, 'exited-reaped')
        assert.equal(terminal.executionWaitStatusSource, 'native-target-wait')
        assert.equal(terminal.executionUsage.scope, 'actual-target-wait4; maxrss is target peak')
        assert.ok(Number.isFinite(terminal.executionUsage.cpuMicros) && terminal.executionUsage.cpuMicros >= 0)
        assert.ok(Number.isFinite(terminal.executionUsage.maxRssKiB) && terminal.executionUsage.maxRssKiB > 0)
        if (scenario.name === 'sync-env-files-json-exit7') {
          assert.equal(terminal.exitCode, 7)
          assert.ok(terminal.stdout.includes('packed-B21-exact|unset|' + root))
          assert.ok(terminal.stdout.includes('packed-B21-allowed'))
          assert.ok(terminal.stdout.includes('{"jsonrpc":"2.0","method":"ordinary-target-output"}'))
          assert.ok(!terminal.stdout.includes('packed-B21-excluded'))
          assert.match(terminal.stderr, /No such file|Permission denied/)
          assert.equal(terminal.dirtyObservationRefusal, undefined)
        } else if (scenario.background) {
          assert.equal(terminal.exitCode, 7)
          assert.ok(terminal.events.filter(event => event.payload.type === 'output')
            .map(event => event.payload.data).join('').includes('packed-B21-background'))
          assert.ok(results[0][0].value.jobId)
        } else {
          assert.equal(terminal.executionSignal, 11)
          assert.ok(terminal.errorMessage)
        }
        assert.ok(observation.events.some(event => event.phase === 'native-entry-committed'))
        assert.ok(observation.events.some(event => event.phase === 'spawn-observed' && event.facts.profile.active?.backend === 'native-exec'))
        assert.ok(!observation.events.some(event => event.phase === 'dispatch-failed'))
        assert.ok(result.executionCleanup?.length)
        assert.ok(result.executionCleanup.every(cleanup => cleanup.status === 'complete'))
        assert.ok(result.executionCleanup.some(cleanup => cleanup.selectedTier === 'posix-owned-group'))
        assert.equal(terminal.processCleanup.launchFacts?.profile.selected?.backend, 'native-exec')
        observation.assertions = 'passed'
      } catch (error) {
        observation.assertions = 'failed'
        observation.failure = error.stack ?? String(error)
      }
      save()
    }
    await Promise.all(context.children)
    assert.equal(state.fetchCalls, 0)
    assert.equal(sha(input.native.installedPath), input.native.sha256)
    assert.ok(state.nativeSpawns.some(spawn => spawn.argv[0] === 'version'))
    assert.ok(state.nativeSpawns.some(spawn => spawn.argv[0] === 'exec'))
    assert.ok(state.nativeSpawns.every(spawn => spawn.events.some(event => event.event === 'close')))
    assert.ok(state.scenarios.every(scenario => scenario.assertions === 'passed'), 'One or more packed native scenarios failed; original adverse target outputs are retained')
    state.status = 'scoped-checks-passed'
  } catch (error) {
    state.status = 'failed'; state.failure = error.stack ?? String(error)
  } finally {
    save(); context.restore()
  }
  console.log(JSON.stringify({ format: state.format, status: state.status, fetchCalls: state.fetchCalls,
    scenarios: state.scenarios.map(scenario => ({ name: scenario.name, assertions: scenario.assertions })) }))
  if (state.status !== 'scoped-checks-passed') process.exitCode = 1
}

module.exports = { prepare, run }
