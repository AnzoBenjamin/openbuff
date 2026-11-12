const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const Module = require('node:module')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const readEvents = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
async function waitUntil(predicate, ms = 3000) {
  const until = performance.now() + ms
  while (!predicate() && performance.now() < until) await delay(10)
  return predicate()
}
function unwrap(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}
function firstJson(output) {
  const value = output.find(item => item.type === 'json')?.value
  assert.ok(value, 'Expected JSON tool output')
  return value
}
function retainOutput(state, operation, output) {
  const observation = { phase: state.phase, operation, at: Date.now(), output }
  state.attemptedOutputs.push(observation)
  fs.appendFileSync(process.argv[2] + '.outputs.jsonl', JSON.stringify(observation) + '\n')
  return output
}
function prepare(format) {
  const state = { format, startedAt: new Date().toISOString(), runtime: { executable: process.execPath, version: process.version },
    scenarios: [], attemptedOutputs: [], children: [], controllers: [], fetchCalls: 0, forbiddenSpawns: 0,
    mutationCommitAttempts: 0, warnings: [], phase: 'import', forbidSpawn: false }
  const fetch = globalThis.fetch
  const forbiddenFetch = () => { state.fetchCalls++; throw new Error('Provider/network fetch is forbidden in the B19 package consumer') }
  globalThis.fetch = Object.assign(async () => forbiddenFetch(), { preconnect: forbiddenFetch })
  state.restoreFetch = () => { globalThis.fetch = fetch }
  const spawn = childProcess.spawn
  childProcess.spawn = (command, argv = [], options = {}) => {
    if (state.forbidSpawn) { state.forbiddenSpawns++; throw new Error('No-context public 3D tried to spawn') }
    const child = spawn(command, argv, options)
    const entry = { phase: state.phase, command, argv: [...argv], child, events: [], closed: false }
    const record = event => {
      entry.events.push(event)
      fs.appendFileSync(process.argv[2] + '.events.jsonl', JSON.stringify({ phase: entry.phase, ...event }) + '\n')
    }
    entry.close = new Promise(resolve => child.once('close', (code, signal) => {
      entry.closed = true; record({ event: 'close', at: Date.now(), pid: child.pid, code, signal }); resolve()
    }))
    child.once('spawn', () => record({ event: 'spawn', at: Date.now(), pid: child.pid }))
    child.once('error', error => record({ event: 'error', at: Date.now(), pid: child.pid, name: error.name, code: error.code }))
    state.children.push(entry)
    return child
  }
  state.spawn = childProcess.spawn
  const otherFunctions = new Map()
  for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name]
    otherFunctions.set(name, original)
    childProcess[name] = (...args) => {
      if (state.forbidSpawn) { state.forbiddenSpawns++; throw new Error('No-context public 3D tried ' + name) }
      return original(...args)
    }
  }
  Module.syncBuiltinESMExports()
  state.restoreSpawn = () => {
    childProcess.spawn = spawn
    for (const [name, original] of otherFunctions) childProcess[name] = original
    Module.syncBuiltinESMExports()
  }
  const resolve = Module._resolveFilename
  Module._resolveFilename = function (specifier, ...args) {
    if (/^@(codebuff|openbuff)\//.test(specifier) && !['@openbuff/sdk', '@openbuff/sdk/package.json'].includes(specifier)) {
      throw new Error('Workspace package import is forbidden: ' + specifier)
    }
    const result = resolve.call(this, specifier, ...args), workspace = process.env.B19_WORKSPACE_ROOT
    if (workspace && typeof result === 'string' && result.startsWith(workspace + path.sep) && !result.startsWith(workspace + '/node_modules/') && !result.startsWith(workspace + '/sdk/node_modules/')) {
      throw new Error('Workspace source import is forbidden: ' + result)
    }
    return result
  }
  state.restoreResolver = () => { Module._resolveFilename = resolve }
  const onWarning = warning => state.warnings.push({ name: warning.name, message: warning.message })
  process.on('warning', onWarning)
  state.restoreWarnings = () => process.off('warning', onWarning)
  return state
}
function configuration(root) {
  fs.mkdirSync(root, { recursive: true })
  const configFile = path.join(root, 'openbuff.json')
  fs.writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  } }))
  const environment = { PATH: '/usr/bin:/bin', PUBLIC_VALUE: 'captured-public', DELETE_ME: 'delete-this',
    OPENAI_API_KEY: 'fixture-canonical-secret', CUSTOM_PROVIDER_KEY: 'fixture-configured-secret',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  return { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false } }
}
function direct(sdk, state, root, extra = {}) {
  const stop = new AbortController(), execution = []
  state.controllers.push(stop)
  const value = unwrap(sdk.createDirectHostExecution({ cwd: root, hostConfiguration: extra.hostConfiguration ?? configuration(root), configReadFs: sdk.nodeConfigReadFs,
    spawn: state.spawn, signal: stop.signal, record: event => execution.push(event), approvalMode: 'allow-all', ...extra }))
  return { ...value, stop, execution }
}
async function terminal(sdk, scope, root, command, extra = {}) {
  return sdk.runTerminalCommand({ command, cwd: root, projectRoot: root, process_type: 'SYNC', timeout_seconds: 5,
    executionContext: scope.executionContext, terminalShell: scope.hostServices.terminalShell,
    getTerminalLaunchMetadata: scope.hostServices.getTerminalLaunchMetadata, ...extra })
}
async function exercise(sdk, state, resolved) {
  const resolvedFile = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved
  assert.equal(fs.realpathSync(resolvedFile), path.join(process.cwd(), 'node_modules/@openbuff/sdk/dist', state.format === 'esm' ? 'index.mjs' : 'index.cjs'))
  state.sdkEntry = resolvedFile
  for (const name of ['createDirectHostExecution', 'runTerminalCommand', 'inspect3dAsset', 'render3dPreview', 'edit3dAsset', 'OpenbuffClient', 'createNodeFileSystem']) {
    assert.equal(typeof sdk[name], 'function', 'Missing public SDK export: ' + name)
  }
  const peer = path.join(process.cwd(), 'peer.cjs')
  const scenarioRoot = name => path.join(process.cwd(), 'scenarios', state.format, name)

  state.phase = 'direct-env'
  {
    const root = scenarioRoot(state.phase), scope = direct(sdk, state, root)
    const log = path.join(root, 'peer.jsonl')
    const output = await terminal(sdk, scope, root, `exec /usr/bin/node ${quote(peer)} env ${quote(log)}`, {
      env: { PUBLIC_VALUE: 'child-public', DELETE_ME: undefined, OPENAI_API_KEY: 'attempted-reinsert', CUSTOM_PROVIDER_KEY: 'attempted-configured-reinsert' },
    })
    retainOutput(state, 'runTerminalCommand', output)
    assert.equal(firstJson(output).exitCode, 0)
    const events = readEvents(log), observed = events.find(event => event.event === 'environment')?.values
    assert.deepEqual(observed, { PUBLIC_VALUE: 'child-public' })
    assert.equal(scope.hostServices.provider.credentialEnvironment.OPENAI_API_KEY, 'fixture-canonical-secret')
    assert.equal(scope.hostServices.provider.credentialEnvironment.CUSTOM_PROVIDER_KEY, 'fixture-configured-secret')
    assert.ok(scope.execution.some(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync'))
    assert.ok(await waitUntil(() => state.children.filter(entry => entry.phase === state.phase).every(entry => entry.closed)))
    scope.stop.abort(new Error('Direct environment scenario completed'))
    state.scenarios.push({ name: state.phase, passed: true, output, peer: events, execution: scope.execution })
  }

  state.phase = 'long-finite-timeout'
  {
    const root = scenarioRoot(state.phase), durationMs = 2 ** 31 + 60_000
    const scope = direct(sdk, state, root, { limit: { kind: 'finite', durationMs } })
    const log = path.join(root, 'peer.jsonl')
    const pending = terminal(sdk, scope, root, `exec /usr/bin/node ${quote(peer)} heartbeat ${quote(log)}`, { timeout_seconds: durationMs / 1000 })
      .then(output => retainOutput(state, 'runTerminalCommand', output))
    assert.ok(await waitUntil(() => readEvents(log).some(event => event.event === 'start')), 'Long finite peer did not start')
    const peers = state.children.filter(entry => entry.phase === state.phase && entry.argv.some(arg => arg.includes(peer)))
    assert.equal(peers.length, 1)
    const before = readEvents(log).filter(event => event.event === 'heartbeat').length
    await delay(160)
    assert.equal(scope.executionContext.signal.aborted, false)
    assert.equal(peers[0].closed, false)
    assert.ok(readEvents(log).filter(event => event.event === 'heartbeat').length > before)
    const start = scope.execution.find(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync')
    assert.ok(start)
    assert.equal(start.facts.deadlines.resourceLifetime.kind, 'finite')
    assert.ok(start.facts.deadlines.resourceLifetime.expiresAtMs - performance.now() > 2 ** 31)
    const cancelledAt = Date.now()
    scope.stop.abort(new Error('Consumer explicitly cancels the long finite operation'))
    const output = await pending
    assert.ok(await waitUntil(() => peers[0].closed), 'Cancellation did not close actual child')
    assert.ok(peers[0].events.some(event => event.event === 'close' && event.at >= cancelledAt))
    assert.equal(state.warnings.some(warning => warning.name === 'TimeoutOverflowWarning'), false)
    state.scenarios.push({ name: state.phase, passed: true, durationMs, observedMs: 160, cancelledAt, output,
      peer: readEvents(log), execution: scope.execution })
  }

  state.phase = 'public-3d-no-context'
  {
    const root = scenarioRoot(state.phase)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'scene.blend'), 'fixture')
    fs.writeFileSync(path.join(root, 'scene.fbx'), 'fixture')
    // Pass the edit's filesystem-authority precondition while trapping all
    // commits. This negative fixture does not implement or exercise real CAS.
    const filesystem = Object.assign(sdk.createNodeFileSystem(), {
      mutationAuthority: 'cooperative_cas',
      conditionalCommit: async () => {
        state.mutationCommitAttempts++
        throw new Error('Missing-context public 3D must refuse before conditionalCommit')
      },
    }), before = state.children.length
    state.forbidSpawn = true
    const outputs = []
    try {
      for (const asset of ['scene.blend', 'scene.fbx']) outputs.push(retainOutput(state, 'inspect3dAsset:' + asset,
        await sdk.inspect3dAsset({ path: asset, cwd: root, fs: filesystem })))
      outputs.push(retainOutput(state, 'render3dPreview', await sdk.render3dPreview({
        path: 'scene.blend', cwd: root, fs: filesystem, views: ['front'], mode: 'clay', width: 128, height: 128 })))
      outputs.push(retainOutput(state, 'edit3dAsset', await sdk.edit3dAsset({ path: 'scene.blend', cwd: root, fs: filesystem,
        sourceHash: sdk.hashFileContent(Buffer.from('fixture')), operations: [{ type: 'rename_object', object: 'Cube', new_name: 'Hero' }] })))
    } finally { state.forbidSpawn = false }
    assert.equal(outputs.length, 4)
    for (const output of outputs) assert.deepEqual(firstJson(output).executionRefusal?.reason, 'unavailable')
    assert.equal(firstJson(outputs[3]).outcome, 'not_applied')
    assert.equal(firstJson(outputs[3]).executionRefusal.cause, 'Captured Blender execution context is unavailable')
    assert.equal(state.children.length, before)
    assert.equal(state.forbiddenSpawns, 0)
    assert.equal(state.mutationCommitAttempts, 0)
    state.scenarios.push({ name: state.phase, passed: true, attemptedSpawns: state.forbiddenSpawns,
      mutationAuthority: filesystem.mutationAuthority, mutationCommitAttempts: state.mutationCommitAttempts, outputs })
  }

  state.phase = 'programmatic-sdk-run'
  {
    const root = scenarioRoot(state.phase), execution = [], callbacks = []
    const hostConfiguration = configuration(root), stop = new AbortController()
    state.controllers.push(stop)
    const log = path.join(root, 'peer.jsonl')
    const client = new sdk.OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, '..', 'harness-' + state.phase),
      hostConfiguration, configReadFs: sdk.nodeConfigReadFs, spawnSource: state.spawn, fsSource: sdk.createNodeFileSystem(), approvalMode: 'allow-all',
      recordExecution: event => execution.push(event), handleEvent: event => callbacks.push(event) })
    const agent = { id: 'tarball-b19-agent', displayName: 'Tarball B19 agent', model: 'fixture-model',
      toolNames: ['run_terminal_command', 'set_output'], outputMode: 'structured_output',
      handleSteps: function* ({ prompt }) {
        const { toolResult } = yield { toolName: 'run_terminal_command', input: { command: prompt, process_type: 'SYNC' } }
        yield { toolName: 'set_output', input: { result: toolResult } }
      } }
    const result = await client.run({ agent, prompt: `exec /usr/bin/node ${quote(peer)} env ${quote(log)}`, signal: stop.signal })
    retainOutput(state, 'OpenbuffClient.run', { output: result.output, runOutcome: result.runOutcome, actionOutcomes: result.actionOutcomes,
      mainAgentIdentity: { agentId: result.sessionState?.mainAgentState.agentId, runId: result.sessionState?.mainAgentState.runId } })
    assert.equal(result.output.type, 'structuredOutput')
    assert.equal(result.runOutcome?.termination, 'completed')
    const action = result.actionOutcomes?.find(action => action.toolName === 'run_terminal_command')
    const start = execution.find(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync')
    assert.ok(action && start)
    assert.equal(action.outcome, 'succeeded')
    assert.equal(start.facts.correlation.kind, 'action')
    assert.equal(start.facts.correlation.actionId, action.actionId)
    assert.equal(start.facts.correlation.attemptId, action.attemptId)
    assert.equal(start.facts.correlation.owner.rootRunId, action.runId)
    assert.equal(action.runId, result.sessionState.mainAgentState.runId)
    assert.ok(callbacks.some(event => event.type === 'tool_result' && event.actionOutcome?.actionId === action.actionId && event.actionOutcome.attemptId === action.attemptId))
    assert.ok(await waitUntil(() => state.children.filter(entry => entry.phase === state.phase).every(entry => entry.closed)))
    assert.equal(state.fetchCalls, 0)
    assert.equal(stop.signal.aborted, false)
    state.scenarios.push({ name: state.phase, passed: true, output: result.output, termination: result.runOutcome.termination,
      actionOutcomes: result.actionOutcomes, execution, peer: readEvents(log), providerFetchCalls: state.fetchCalls })
  }
  state.phase = 'sdk-full-access-read-edit-command'
  const fullAccess = { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false }
  {
    const root = scenarioRoot(state.phase), execution = [], callbacks = []
    const hostConfiguration = configuration(root), stop = new AbortController()
    state.controllers.push(stop)
    fs.writeFileSync(path.join(root, 'input.txt'), 'before\n')
    const log = path.join(root, 'peer.jsonl')
    const client = new sdk.OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, '..', 'harness-' + state.phase),
      hostConfiguration, configReadFs: sdk.nodeConfigReadFs, spawnSource: state.spawn, approvalMode: 'allow-all', executionProfile: fullAccess,
      recordExecution: event => execution.push(event), handleEvent: event => callbacks.push(event) })
    const agent = { id: 'tarball-full-access-agent', displayName: 'Packed SDK full access', model: 'fixture-model',
      toolNames: ['read_files', 'edit_transaction', 'run_terminal_command', 'set_output'], outputMode: 'structured_output',
      handleSteps: function* ({ prompt }) {
        const { toolResult: read } = yield { toolName: 'read_files', input: { paths: ['input.txt'] } }
        const findReadCapability = value => {
          if (!value || typeof value !== 'object') return undefined
          if (typeof value.readCapability === 'string') return value.readCapability
          for (const child of Object.values(value)) {
            const found = findReadCapability(child)
            if (found) return found
          }
        }
        const capability = findReadCapability(read)
        if (!capability) {
          yield { toolName: 'set_output', input: { error: 'Read capability missing', read } }
          return
        }
        const { toolResult: edit } = yield { toolName: 'edit_transaction', input: { edits: [{ type: 'str_replace', path: 'input.txt',
          replacements: [{ oldString: 'before\n', newString: 'after\n', basedOnRead: capability }] }] } }
        const { toolResult: command } = yield { toolName: 'run_terminal_command', input: { command: prompt, process_type: 'SYNC' } }
        yield { toolName: 'set_output', input: { read, edit, command } }
      } }
    const result = await client.run({ agent, prompt: `exec /usr/bin/node ${quote(peer)} env ${quote(log)}`, signal: stop.signal })
    retainOutput(state, 'OpenbuffClient.run', { output: result.output, runOutcome: result.runOutcome, actionOutcomes: result.actionOutcomes })
    assert.equal(result.output.type, 'structuredOutput')
    assert.equal(result.runOutcome?.termination, 'completed')
    assert.equal(fs.readFileSync(path.join(root, 'input.txt'), 'utf8'), 'after\n')
    for (const name of ['read_files', 'edit_transaction', 'run_terminal_command']) {
      assert.equal(result.actionOutcomes.find(action => action.toolName === name)?.outcome, 'succeeded', name)
    }
    const edit = result.actionOutcomes.find(action => action.toolName === 'edit_transaction')
    assert.equal(edit.effect.status, 'confirmed')
    assert.ok(edit.effect.receiptIds.length > 0)
    const action = result.actionOutcomes.find(action => action.toolName === 'run_terminal_command')
    const start = execution.find(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync')
    assert.ok(start)
    assert.equal(start.facts.profile.active.policy, 'full-access')
    assert.equal(start.facts.correlation.kind, 'action')
    assert.equal(start.facts.correlation.actionId, action.actionId)
    assert.equal(start.facts.correlation.attemptId, action.attemptId)
    assert.equal(start.facts.correlation.owner.rootRunId, result.sessionState.mainAgentState.runId)
    const phases = execution.filter(event => 'facts' in event && event.facts.launchId === start.facts.launchId).map(event => event.phase)
    assert.ok(phases.indexOf('admitted') >= 0 && phases.indexOf('admitted') < phases.indexOf('dispatched'))
    assert.equal(stop.signal.aborted, false)
    assert.deepEqual(readEvents(log).find(event => event.event === 'environment')?.values, { PUBLIC_VALUE: 'captured-public', DELETE_ME: 'delete-this' })
    state.scenarios.push({ name: state.phase, passed: true, output: result.output, actionOutcomes: result.actionOutcomes,
      execution, peer: readEvents(log), signalAborted: stop.signal.aborted, callbacks })

    state.phase = 'sdk-required-unavailable'
    const unavailableRoot = scenarioRoot(state.phase), unavailableExecution = [], beforeChildren = state.children.length
    const unavailableConfiguration = configuration(unavailableRoot)
    fs.writeFileSync(path.join(unavailableRoot, 'input.txt'), 'before\n')
    const unavailableLog = path.join(unavailableRoot, 'must-not-exist.jsonl')
    const unavailable = new sdk.OpenbuffClient({ cwd: unavailableRoot, projectFiles: {}, knowledgeFiles: {},
      harnessStateDir: path.join(unavailableRoot, '..', 'harness-' + state.phase), hostConfiguration: unavailableConfiguration, configReadFs: sdk.nodeConfigReadFs,
      spawnSource: state.spawn, approvalMode: 'allow-all', executionProfile: { ...fullAccess, preferredBackend: 'native-exec' },
      recordExecution: event => unavailableExecution.push(event), handleEvent: () => {} })
    const refused = await unavailable.run({ agent, prompt: `exec /usr/bin/node ${quote(peer)} env ${quote(unavailableLog)}` })
    retainOutput(state, 'OpenbuffClient.run', { output: refused.output, runOutcome: refused.runOutcome })
    assert.equal(refused.output.type, 'error')
    assert.equal(refused.runOutcome?.termination, 'failed')
    assert.match(refused.output.message, /execution (profile|backend) unavailable/i)
    assert.equal(state.children.length, beforeChildren)
    assert.equal(fs.existsSync(unavailableLog), false)
    assert.equal(fs.readFileSync(path.join(unavailableRoot, 'input.txt'), 'utf8'), 'before\n')
    assert.equal(unavailableExecution.some(event => event.phase === 'dispatched'), false)
    state.scenarios.push({ name: state.phase, passed: true, output: refused.output, execution: unavailableExecution,
      processStarts: state.children.length - beforeChildren })
  }

  state.phase = 'captured-explicit-route-precedence'
  {
    const root = scenarioRoot(state.phase), hostConfiguration = configuration(root)
    const file = hostConfiguration.selection.path
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    config.defaultModel = 'backup/fallback'
    config.agents = { contradictory: 'advice/recommended' }
    config.providers.backup = { type: 'openai-compatible', baseURL: 'https://backup.invalid/v1', models: ['fallback'] }
    config.providers.advice = { type: 'openai-compatible', baseURL: 'https://advice.invalid/v1', models: ['recommended'],
      modelCapabilities: { recommended: { quality: { coding: [{ language: 'typescript', taskType: 'bug-fix', agentRole: 'editor', score: 99, sampleSize: 20 }] } } } }
    fs.writeFileSync(file, JSON.stringify(config))
    const scope = direct(sdk, state, root, { hostConfiguration })
    const loadedConfig = scope.hostServices.provider.snapshot.loaded
    const recommendation = sdk.recommendConfiguredModel({ context: { language: 'typescript', taskType: 'bug-fix', agentRole: 'editor' }, loadedConfig })
    assert.equal(recommendation.model, 'advice/recommended')
    fs.writeFileSync(file, JSON.stringify({ ...config, defaultModel: 'advice/recommended' }))
    hostConfiguration.environment.CUSTOM_PROVIDER_KEY = 'late-caller-key'
    const selected = sdk.resolveConfiguredAgentModelConfig({ agentId: 'contradictory', model: 'fixture/fixture-model', preferModelParam: true, loadedConfig })
    assert.equal(selected.model, 'fixture/fixture-model')
    const provider = sdk.resolveConfiguredProviderModel({ model: selected.model, env: scope.hostServices.provider.credentialEnvironment, loadedConfig })
    assert.equal(provider.providerId, 'fixture')
    assert.equal(provider.providerModel, 'fixture-model')
    assert.equal(provider.apiKey, 'fixture-configured-secret')
    assert.equal(loadedConfig.config.defaultModel, 'backup/fallback')
    state.scenarios.push({ name: state.phase, passed: true, recommendation: recommendation.model,
      selectedModel: selected.model, providerId: provider.providerId, providerModel: provider.providerModel,
      snapshotId: scope.hostServices.provider.snapshot.snapshotId, scope: 'Public captured route/credential resolver; no model transport request' })
  }

  state.phase = 'explicit-credential-delegation'
  {
    const root = scenarioRoot(state.phase), scope = direct(sdk, state, root, { profile: fullAccess })
    const host = scope.hostServices, execution = host.execution
    const registration = unwrap(execution.actionRegistration(scope.executionContext.execution))
    const log = path.join(root, 'peer.jsonl'), argv = [peer, 'env', log]
    const destination = unwrap(execution.registerDestination({ snapshotId: host.provider.snapshot.snapshotId, origin: 'host',
      resolved: { kind: 'executable', command: '/usr/bin/node', args: argv, declaredEnv: {} } }))
    const delegation = unwrap(execution.registerDelegation({ destination, snapshotId: host.provider.snapshot.snapshotId, origin: 'host',
      purpose: 'Owned local sentinel-only delegation fixture', expiresUnder: registration.budget,
      values: { CUSTOM_PROVIDER_KEY: host.provider.credentialEnvironment.CUSTOM_PROVIDER_KEY }, permittedOwners: [registration.owner] }))
    const target = { executable: '/usr/bin/node', argv, cwd: root, projectRoot: root, allowedPaths: [root], mode: 'assistant',
      processType: 'SYNC', profile: fullAccess, family: 'sync-shell', branchId: 'terminal.sync', delegation,
      adapterOptions: { runtime: 'node', stdio: 'pipe', shell: false } }
    const launch = unwrap(scope.executionContext.execution.prepareTarget({ target, destination }))
    const admission = unwrap(await launch.admit())
    const dispatched = unwrap(launch.dispatchNow(admission.permit, (input, observer) => {
      const child = state.spawn(input.executable, input.argv, { cwd: input.cwd, env: input.env, stdio: 'pipe', signal: input.resourceSignal, shell: false })
      child.once('spawn', () => unwrap(observer.spawnObserved({ source: 'node-spawn-event', pid: child.pid })))
      return child
    }))
    assert.ok(await waitUntil(() => state.children.find(entry => entry.child === dispatched.handle)?.closed))
    assert.deepEqual(readEvents(log).find(event => event.event === 'environment')?.values,
      { PUBLIC_VALUE: 'captured-public', DELETE_ME: 'delete-this', CUSTOM_PROVIDER_KEY: 'fixture-configured-secret' })
    const start = scope.execution.find(event => event.phase === 'spawn-observed')
    assert.ok(start && start.facts.environment.delegationIds.length === 1)
    state.scenarios.push({ name: state.phase, passed: true, peer: readEvents(log), execution: scope.execution,
      scope: 'Public host-registered destination and delegation dispatched to a real local child' })
  }

  assert.equal(state.scenarios.length, 8)
  assert.equal(state.fetchCalls, 0)
}
async function finish(state) {
  const observation = { endedAt: new Date().toISOString(), children: state.children.map(entry => ({ phase: entry.phase,
    command: entry.command, argv: entry.argv, pid: entry.child.pid, closed: entry.closed, events: [...entry.events] })) }
  const teardownStartedAt = Date.now()
  for (const controller of state.controllers) controller.abort(new Error('Consumer fixture teardown'))
  await waitUntil(() => state.children.every(entry => entry.closed), 300)
  for (const entry of state.children) if (!entry.closed) entry.child.kill('SIGKILL')
  await waitUntil(() => state.children.every(entry => entry.closed), 3000)
  if (state.children.some(entry => !entry.closed)) state.failure ??= { message: 'Fixture could not close all owned children' }
  if (state.fetchCalls !== 0) state.failure ??= { message: 'Unexpected fetch calls: ' + state.fetchCalls }
  if (state.forbiddenSpawns !== 0) state.failure ??= { message: 'Missing-context path attempted a spawn' }
  if (state.mutationCommitAttempts !== 0) state.failure ??= { message: 'Missing-context path attempted conditionalCommit' }
  const result = { schemaVersion: 1, card: 'B19', scope: 'package-public boundary only; not B19 acceptance, B31, all-feature, OS, process-tree, or installation assurance',
    format: state.format, status: state.failure ? 'failed' : 'passed', runtime: state.runtime, sdkEntry: state.sdkEntry,
    startedAt: state.startedAt, fetchCalls: state.fetchCalls, forbiddenSpawns: state.forbiddenSpawns,
    mutationCommitAttempts: state.mutationCommitAttempts, attemptedOutputs: state.attemptedOutputs,
    warnings: state.warnings, failure: state.failure, scenarios: state.scenarios, observation, teardownStartedAt,
    childrenAfterTeardown: state.children.map(entry => ({ phase: entry.phase, pid: entry.child.pid, closed: entry.closed, events: entry.events })) }
  fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  console.log('B19_PACKAGE_CONSUMER', JSON.stringify(result))
  state.restoreWarnings(); state.restoreResolver(); state.restoreSpawn()
  // Keep the no-network guard active through natural standalone-process exit.
  process.once('beforeExit', () => {
    if (state.fetchCalls !== result.fetchCalls) {
      result.fetchCalls = state.fetchCalls
      result.status = 'failed'
      result.failure = { message: 'Fetch attempted after consumer observation' }
      fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
      process.exitCode = 1
    }
  })
  process.exitCode = state.failure ? 1 : 0
}
module.exports = { prepare, exercise, finish }
