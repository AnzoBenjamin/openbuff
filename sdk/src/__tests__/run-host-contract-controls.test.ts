import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from 'zod/v4'

import * as supervisedSpawn from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { isOwnedTempPath } from '@codebuff/common/util/project-path-containment'
import { OpenbuffClient } from '../client'
import { getCustomToolDefinition } from '../custom-tool'
import * as hostExecution from '../host-execution'
import { getCapturedProviderConfig, nodeConfigReadFs } from '../host-config'
import * as runtimeImpl from '../impl/agent-runtime'
import * as modelProvider from '../impl/model-provider'
import { recommendConfiguredModel } from '../provider-config'
import { handleToolCall } from '../run'
import { createLanguageIntelligence } from '../services/language-intelligence'
import * as languageIntelligence from '../services/language-intelligence'
import * as lspMultiplexer from '../services/lsp-multiplexer'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { HandleStepsToolCallSchema } from '@codebuff/common/types/agent-template'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ChildProcess } from 'node:child_process'
import type { CapturedCredentialPort, HostConfigurationInputs } from '../host-config'
import type { OpenbuffClientOptions } from '../run'
import type { RunState } from '../run-state'
import type { LspMultiplexer } from '../services/lsp-multiplexer'

const realHost = hostExecution.createHostExecutionServices
const realRuntime = runtimeImpl.getAgentRuntimeImpl
const realModel = modelProvider.getModelForRequest
const realSupervised = supervisedSpawn.buildDefaultSpawnSupervised
const roots: string[] = [], restores: Array<() => void> = []
const children: Array<{ child: ChildProcess; close: Promise<void> }> = []
let hosts: hostExecution.RunHostServices[] = []
let runtimes: Array<{ host: hostExecution.RunHostServices | undefined; runtime: runtimeImpl.AgentRuntimeImplDeps }> = []
let supervisedSeeds: Array<NonNullable<Parameters<typeof realSupervised>[0]>> = []
let editDispatches: Array<{ request: unknown; result?: unknown; error?: unknown }> = []
let fetchCalls = 0
// Snapshot diagnostic data without allowing observation failures to alter the
// actual request/result. Error properties otherwise disappear in JSON logs.
function captureObservation(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error
      ? { ...item, name: item.name, message: item.message, stack: item.stack, cause: item.cause }
      : item))
  } catch (error) { return { captureError: String(error) } }
}
beforeEach(() => {
  hosts = []; runtimes = []; supervisedSeeds = []; editDispatches = []; fetchCalls = 0
  const forbidden = () => { fetchCalls++; throw new Error('Provider/network requests forbidden in B19 SDK controls') }
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidden(), { preconnect: forbidden }))
  const hostSpy = spyOn(hostExecution, 'createHostExecutionServices').mockImplementation(options => {
    const result = realHost(options)
    if (result.ok) hosts.push(result.value)
    return result
  })
  const runtimeSpy = spyOn(runtimeImpl, 'getAgentRuntimeImpl').mockImplementation(options => {
    const requestToolCall: typeof options.requestToolCall = async request => {
      if (request.toolName !== 'edit_transaction') return options.requestToolCall(request)
      const observed: typeof editDispatches[number] = { request: captureObservation({
        toolName: request.toolName, callId: request.callId, input: request.input,
        executionIdentity: request.executionIdentity, executionRequestHash: request.executionRequestHash,
      }) }
      editDispatches.push(observed)
      try {
        const result = await options.requestToolCall(request)
        observed.result = captureObservation(result)
        return result
      } catch (error) { observed.error = captureObservation(error); throw error }
    }
    // Preserve the actual SDK callback and its independent canonical receipt;
    // capture the result before runtime normalization can replace a refusal.
    const result = realRuntime({ ...options, requestToolCall })
    runtimes.push({ host: options.hostServices, runtime: result })
    return result
  })
  // Observe the actual factory consumer while preserving its implementation.
  const supervisionSpy = spyOn(supervisedSpawn, 'buildDefaultSpawnSupervised').mockImplementation((...args) => {
    supervisedSeeds.push(structuredClone(args[0] ?? {}))
    return realSupervised(...args)
  })
  restores.push(() => supervisionSpy.mockRestore(), () => runtimeSpy.mockRestore(), () => hostSpy.mockRestore(), () => fetchSpy.mockRestore())
})
afterEach(async () => {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.all(children.splice(0).map(entry => entry.close))
  for (const restore of restores.splice(0).reverse()) restore()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  expect(fetchCalls).toBe(0)
})

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const fullAccess = { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false } as const
function fixture(configuration: Record<string, unknown> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b19-sdk-controls-')); roots.push(directory)
  const root = path.join(directory, 'project'), allowed = path.join(directory, 'allowed'), denied = path.join(directory, 'denied')
  for (const dir of [root, allowed, denied]) fs.mkdirSync(dir)
  const configFile = path.join(root, 'openbuff.json'), peer = path.join(root, 'peer.cjs')
  fs.copyFileSync(path.join(import.meta.dir, 'fixtures/b19-r3-sdk-contract-peer.cjs'), peer)
  fs.writeFileSync(path.join(root, 'input.txt'), 'before\n')
  const config = { autoFileChangeHooks: false, defaultModel: 'chosen/selected', providers: {
    chosen: { type: 'openai-compatible', baseURL: 'https://chosen.invalid/v1', apiKeyEnv: 'CUSTOM_PROVIDER_KEY', models: ['selected'],
      modelCapabilities: { selected: { context: { windowTokens: 48_000 } } } },
  }, ...configuration }
  fs.writeFileSync(configFile, JSON.stringify(config))
  const home = path.join(directory, 'home'), xdg = path.join(directory, 'xdg')
  fs.mkdirSync(home); fs.mkdirSync(xdg)
  const environment: Record<string, string | undefined> = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdg, LANG: 'C.UTF-8', PROJECT_VALUE: 'captured-project',
    OPENAI_API_KEY: 'fixture-canonical-key', CUSTOM_PROVIDER_KEY: 'fixture-selected-key', OPENCODE_GO_API_KEY: 'fixture-go-key',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  const inputs: HostConfigurationInputs = { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: true } }
  const events: LaunchEvent[] = [], launches: Array<{ command: string; argv: readonly string[]; pid?: number; closed?: boolean }> = []
  const launch: CodebuffSpawn = (command, argv = [], options) => {
    const child = spawn(command, [...argv], options ?? {})
    const observed = { command, argv: [...argv], pid: child.pid, closed: false }; launches.push(observed)
    children.push({ child, close: new Promise(resolve => child.once('close', () => { observed.closed = true; resolve() })) })
    return child
  }
  const diagnostics: { entries: Array<{ level: string; data: unknown; message?: string; args: unknown }>; omitted: number } = { entries: [], omitted: 0 }
  const recordDiagnostic = (level: string, data: unknown, message?: string, ...args: unknown[]) => {
    if (diagnostics.entries.length >= 100) { diagnostics.omitted++; return }
    diagnostics.entries.push({ level, data: captureObservation(data), message, args: captureObservation(args) })
  }
  const defaults: OpenbuffClientOptions = { cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(directory, 'harness'),
    hostConfiguration: inputs, configReadFs: nodeConfigReadFs, spawnSource: launch, approvalMode: 'allow-all', executionProfile: fullAccess,
    logger: { debug() {}, info() {}, warn: (data, message, ...args) => recordDiagnostic('warn', data, message, ...args),
      error: (data, message, ...args) => recordDiagnostic('error', data, message, ...args) },
    recordExecution: event => { events.push(event) } }
  const run = (agent: AgentDefinition, prompt = '', extra: OpenbuffClientOptions = {}) => new OpenbuffClient({ ...defaults, ...extra }).run({ agent, prompt })
  return { root, directory, allowed, denied, configFile, config, peer, environment, inputs, events, launches, diagnostics, run }
}
function completed(result: RunState) {
  expect(result.output.type).toBe('structuredOutput')
  expect(result.runOutcome?.termination).toBe('completed')
}
function jsonValue(output: Array<{ type: string; value?: unknown }>): Record<string, unknown> {
  return output.find(item => item.type === 'json')?.value as Record<string, unknown>
}

const strategy: AgentDefinition = {
  id: 'b19-r3-trusted-strategy', displayName: 'B19 trusted strategy', model: 'chosen/selected', outputMode: 'structured_output',
  toolNames: ['read_files', 'edit_transaction', 'run_terminal_command', 'set_output'],
  handleSteps: function* ({ prompt }) {
    const { toolResult: read } = yield { toolName: 'read_files', input: { paths: ['input.txt'] } }
    const findCapability = (value: unknown): string | undefined => {
      if (!value || typeof value !== 'object') return undefined
      if ('readCapability' in value && typeof value.readCapability === 'string') return value.readCapability
      for (const child of Object.values(value)) { const found = findCapability(child); if (found) return found }
      return undefined
    }
    const capability = findCapability(read)
    if (!capability || !JSON.stringify(read).includes('before')) {
      yield { toolName: 'set_output', input: { error: 'Strategy could not observe its edit basis', read } }
      return
    }
    const { toolResult: edit } = yield { toolName: 'edit_transaction', input: { edits: [{ type: 'str_replace', path: 'input.txt',
      replacements: [{ oldString: 'before\n', newString: 'after\n', basedOnRead: capability }] }] } }
    const { toolResult: command } = yield { toolName: 'run_terminal_command', input: { command: prompt!, process_type: 'SYNC' } }
    yield { toolName: 'set_output', input: { read, edit, command } }
  },
}

describe('B19 actual SDK host contract controls', () => {
  test('strategy.sdk: trusted strategy chooses a real read/edit/command sequence and retains effects and B02 identities', async () => {
    const f = fixture(), observed = path.join(f.root, 'command.json')
    const result = await f.run(strategy, `exec /usr/bin/node ${quote(f.peer)} ${quote(observed)} strategy ${quote(path.join(f.root, 'input.txt'))}`)
    console.log('B19_SDK_STRATEGY', JSON.stringify({ output: result.output, actions: result.actionOutcomes, execution: f.events, launches: f.launches,
      editDispatches, diagnostics: f.diagnostics }))
    completed(result)
    expect(fs.readFileSync(path.join(f.root, 'input.txt'), 'utf8')).toBe('after\n')
    const recorded = JSON.parse(fs.readFileSync(observed, 'utf8'))
    expect(recorded).toMatchObject({ label: 'strategy', content: 'after\n', environment: { PROJECT_VALUE: 'captured-project' } })
    expect(recorded.environment.CUSTOM_PROVIDER_KEY).toBeUndefined()
    expect(recorded.environment.OPENAI_API_KEY).toBeUndefined()
    const actions = result.actionOutcomes!
    for (const name of ['read_files', 'edit_transaction', 'run_terminal_command']) expect(actions.find(action => action.toolName === name)?.outcome).toBe('succeeded')
    const edit = actions.find(action => action.toolName === 'edit_transaction')!
    expect(edit.effect.status).toBe('confirmed')
    expect(edit.effect.receiptIds.length).toBeGreaterThan(0)
    expect(edit.effect.confirmedPaths.some(value => path.resolve(f.root, value) === path.join(f.root, 'input.txt'))).toBe(true)
    const start = f.events.find(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync')
    if (start?.phase !== 'spawn-observed' || start.facts.correlation.kind !== 'action') throw new Error('Missing actual terminal action launch')
    const correlation = start.facts.correlation
    expect(actions.some(action => action.actionId === correlation.actionId && action.attemptId === correlation.attemptId)).toBe(true)
    expect(start.facts.profile.active?.policy).toBe('full-access')
    expect(correlation.owner.rootRunId).toBe(result.sessionState!.mainAgentState.runId!)
  }, 20_000)

  test('strategy.sdk: a second run with required unavailable execution starts no command target', async () => {
    const f = fixture(), observed = path.join(f.root, 'must-not-exist.json')
    const result = await f.run(strategy, `exec /usr/bin/node ${quote(f.peer)} ${quote(observed)} unavailable`, {
      executionProfile: { ...fullAccess, preferredBackend: 'native-exec' },
    })
    console.log('B19_SDK_REQUIRED_UNAVAILABLE', JSON.stringify({ output: result.output, execution: f.events, launches: f.launches }))
    expect(f.launches).toEqual([])
    expect(f.events.some(event => event.phase === 'dispatched')).toBe(false)
    expect(fs.existsSync(observed)).toBe(false)
    expect(fs.readFileSync(path.join(f.root, 'input.txt'), 'utf8')).toBe('before\n')
    expect(result.runOutcome?.termination).toBe('failed')
    if (result.output.type !== 'error') throw new Error('Required unavailable profile must fail the SDK run')
    expect(result.output.message).toMatch(/execution (profile|backend) unavailable/i)
  }, 20_000)

  test('route.precedence and review.config.actual-consumers: live SDK closures consume one captured provider/hook/read/supervision snapshot', async () => {
    const f = fixture()
    // OS temp paths are readable independently of configured readableRoots.
    // Keep this allow/deny pair outside that exception before capturing config.
    const readRoot = fs.mkdtempSync(path.join(path.resolve(import.meta.dir, '../../..'), '.b19-sdk-read-roots-'))
    roots.push(readRoot)
    f.allowed = path.join(readRoot, 'allowed'); f.denied = path.join(readRoot, 'denied')
    for (const directory of [f.allowed, f.denied]) {
      fs.mkdirSync(directory)
      expect(isOwnedTempPath(directory)).toBe(false)
    }
    const hookFile = path.join(f.root, 'hook.json')
    const selectedConfiguration = { ...f.config, defaultModel: 'backup/fallback', readableRoots: [f.allowed],
      agents: { 'b19-r3-consumer': 'chosen/selected', 'contradictory-agent': 'advice/recommended' },
      failoverModels: ['backup/fallback'], providers: {
        ...(f.config.providers as Record<string, unknown>),
        backup: { type: 'openai-compatible', baseURL: 'https://backup.invalid/v1', models: ['fallback'],
          modelCapabilities: { fallback: { context: { windowTokens: 16_000 } } } },
        advice: { type: 'openai-compatible', baseURL: 'https://advice.invalid/v1', models: ['recommended'], apiKeyEnv: 'DORMANT_KEY',
          modelCapabilities: { recommended: { quality: { coding: [{ language: 'typescript', taskType: 'bug-fix', agentRole: 'editor', score: 99, sampleSize: 20 }] } } } },
        'opencode-go': { type: 'openai-compatible', baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', models: ['stale-model-list'] },
        oauth: { type: 'chatgpt-oauth', models: ['gpt-5.4'] },
      }, fileChangeHooks: [{ name: 'captured-hook', command: `exec /usr/bin/node ${quote(f.peer)} ${quote(hookFile)} captured-hook` }],
    }
    fs.writeFileSync(f.configFile, JSON.stringify(selectedConfiguration))
    f.environment.OPENBUFF_PROCESS_SUPERVISION = '1'
    const captures: Array<{ snapshotId: string | undefined; effectiveModel: string; provider: string; modelId: string }> = []
    const transports: Array<{ kind: string; provider: string; modelId: string }> = []
    const modelSpy = spyOn(modelProvider, 'getModelForRequest').mockImplementation(async params => {
      // Real routing/credential/config logic runs first. Only its downstream
      // network model transport is replaced by a deterministic local adapter.
      const selected = await realModel(params)
      const actual = selected.model as LanguageModelV2
      captures.push({ snapshotId: params.providerContext?.snapshot.snapshotId, effectiveModel: selected.effectiveModel, provider: actual.provider, modelId: actual.modelId })
      const local: LanguageModelV2 = {
        specificationVersion: 'v2', provider: actual.provider, modelId: actual.modelId, supportedUrls: {},
        async doGenerate() {
          transports.push({ kind: 'generate', provider: actual.provider, modelId: actual.modelId })
          return { content: [{ type: 'text', text: '{"ok":true}' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }
        },
        async doStream() {
          transports.push({ kind: 'stream', provider: actual.provider, modelId: actual.modelId })
          const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: '{"ok":true}' }, { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]
          return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
        },
      }
      return { ...selected, model: local }
    })
    restores.push(() => modelSpy.mockRestore())
    const oldAmbient = { OPENBUFF_PROVIDER_CONFIG: process.env.OPENBUFF_PROVIDER_CONFIG, CUSTOM_PROVIDER_KEY: process.env.CUSTOM_PROVIDER_KEY,
      OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY, LANG: process.env.LANG }
    restores.push(() => { for (const [name, value] of Object.entries(oldAmbient)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
    let credentialCalls = 0, replacementCredentialCalls = 0
    const credentialPort: CapturedCredentialPort = { async getValidChatGptOAuthCredentials() { credentialCalls++; return { accessToken: 'fixture-port-token', refreshToken: '', expiresAt: Date.now() + 1e9, connectedAt: 1 } } }
    const probe = getCustomToolDefinition({ toolName: 'b19_contract_probe', description: 'Exercise actual captured SDK consumers', inputSchema: z.object({}),
      execute: async () => {
        const host = hosts.at(-1)!, runtime = runtimes.find(entry => entry.host === host)!.runtime
        const snapshot = host.provider.snapshot, loaded = getCapturedProviderConfig(snapshot)
        const recommendation = recommendConfiguredModel({ context: { language: 'typescript', taskType: 'bug-fix', agentRole: 'editor' }, loadedConfig: loaded })
        expect(recommendation?.model).toBe('advice/recommended')
        // Change all available caller/ambient config inputs after actual SDK
        // composition and before its real consumers execute.
        f.environment.CUSTOM_PROVIDER_KEY = 'late-caller-key'
        f.environment.OPENCODE_GO_API_KEY = 'late-caller-go-key'
        f.environment.LANG = 'late-caller-language'
        process.env.CUSTOM_PROVIDER_KEY = 'late-ambient-key'
        process.env.OPENCODE_GO_API_KEY = 'late-ambient-go-key'
        process.env.LANG = 'late-ambient-language'
        process.env.OPENBUFF_PROVIDER_CONFIG = f.configFile
        fs.writeFileSync(f.configFile, JSON.stringify({ defaultModel: 'advice/recommended', readableRoots: [f.denied], providers: selectedConfiguration.providers,
          fileChangeHooks: [{ name: 'late-hook', command: 'exit 97' }] }))
        credentialPort.getValidChatGptOAuthCredentials = async () => { replacementCredentialCalls++; return null }
        expect(runtime.resolveModelContextWindow?.({ agentId: 'b19-r3-consumer' })).toBe(48_000)
        expect(modelProvider.resolveModelContextWindows({ agentId: 'b19-r3-consumer', loadedConfig: loaded })).toEqual({ primary: 48_000, failoverFloor: 16_000 })
        const params = { apiKey: '', runId: 'consumer-probe', clientSessionId: 'consumer-session', fingerprintId: 'consumer-fingerprint', userInputId: 'consumer-input',
          agentId: 'b19-r3-consumer', model: undefined, userId: undefined,
          messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Return fixture JSON.' }] }],
          sendAction: () => {}, logger: { debug() {}, info() {}, warn() {}, error() {} }, trackEvent: () => {}, signal: host.rootSignal }
        const contextWindows: Array<number | undefined> = []
        const chunks = []
        for await (const chunk of runtime.promptAiSdkStream({ ...params, onModelContextResolved: window => { contextWindows.push(window) } })) chunks.push(chunk)
        const plain = await runtime.promptAiSdk(params)
        const structured = await runtime.promptAiSdkStructured({ ...params, schema: z.object({ ok: z.boolean() }) })
        expect(chunks.some(chunk => chunk.type === 'text' && chunk.text.includes('true'))).toBe(true)
        expect(plain).toMatchObject({ aborted: false, value: '{"ok":true}' })
        expect(structured).toEqual({ aborted: false, value: { ok: true } })
        expect(contextWindows.length).toBeGreaterThan(0)
        expect(contextWindows.every(window => window === 48_000)).toBe(true)
        expect(captures).toHaveLength(3)
        expect(captures.every(capture => capture.snapshotId === snapshot.snapshotId && capture.effectiveModel === 'chosen/selected' && capture.provider === 'chosen' && capture.modelId === 'selected')).toBe(true)
        expect(transports.map(item => item.kind).sort()).toEqual(['generate', 'generate', 'stream'])
        const explicitRoute = await realModel({ apiKey: '', model: 'chosen/selected', agentId: 'contradictory-agent', preferModelParam: true, providerContext: host.provider })
        expect(explicitRoute.effectiveModel).toBe('chosen/selected')
        expect((explicitRoute.model as LanguageModelV2).provider).toBe('chosen')
        expect(host.provider.credentialEnvironment.CUSTOM_PROVIDER_KEY).toBe('fixture-selected-key')
        const fallback = await realModel({ apiKey: '', model: 'opencode-go/muse-spark-1.3-contributor', preferModelParam: true, providerContext: host.provider })
        expect((fallback.model as LanguageModelV2).provider).toBe('opencode-go')
        expect((fallback.model as LanguageModelV2).modelId).toBe('muse-spark-1.3-contributor')
        expect(host.provider.credentialEnvironment.OPENCODE_GO_API_KEY).toBe('fixture-go-key')
        const oauth = await realModel({ apiKey: '', model: 'oauth/gpt-5.4', preferModelParam: true, providerContext: host.provider })
        expect(oauth.isChatGptOAuth).toBe(true)
        expect(credentialCalls).toBe(1)
        expect(replacementCredentialCalls).toBe(0)
        expect(supervisedSeeds).toHaveLength(1)
        expect(supervisedSeeds[0].passthroughEnv?.LANG).toBe('C.UTF-8')
        expect(supervisedSeeds[0].openbuffApiKey).toBeUndefined()
        expect(supervisedSeeds[0].chatGptOauthToken).toBeUndefined()
        expect(runtime.processSupervision).toBe(true)
        const containment = await directLspContainment(f, snapshot.readPolicy)
        console.log('B19_SDK_CAPTURED_CONSUMERS', JSON.stringify({ snapshotId: snapshot.snapshotId, recommendation, captures, transports, contextWindows,
          fallback: { provider: (fallback.model as LanguageModelV2).provider, model: (fallback.model as LanguageModelV2).modelId },
          explicitRoute: explicitRoute.effectiveModel, credentialCalls, replacementCredentialCalls, supervisedSeeds, containment }))
        return [{ type: 'json', value: { observed: true, snapshotId: snapshot.snapshotId } }]
      } })
    const agent: AgentDefinition = { id: 'b19-r3-consumer', displayName: 'Captured SDK consumer', model: 'chosen/selected', outputMode: 'structured_output',
      toolNames: ['b19_contract_probe', 'run_file_change_hooks', 'set_output'], handleSteps: function* () {
        // The runtime schema admits registered external tool names; the
        // generated public ToolCall union enumerates built-in tools only.
        const externalCall: z.infer<typeof HandleStepsToolCallSchema> = { toolName: 'b19_contract_probe', input: {} }
        const { toolResult: probe } = yield externalCall as unknown as ToolCall
        const { toolResult: hooks } = yield { toolName: 'run_file_change_hooks', input: { files: ['input.txt'] } }
        yield { toolName: 'set_output', input: { probe, hooks } }
      } }
    const result = await f.run(agent, '', { credentials: credentialPort, customToolDefinitions: [probe] })
    console.log('B19_SDK_CAPTURED_HOOK', JSON.stringify({ output: result.output, execution: f.events, launches: f.launches }))
    completed(result)
    expect(captures).toHaveLength(3)
    expect(JSON.parse(fs.readFileSync(hookFile, 'utf8'))).toMatchObject({ label: 'captured-hook', environment: { PROJECT_VALUE: 'captured-project', LANG: 'C.UTF-8' } })
    const hook = f.events.find(event => event.phase === 'spawn-observed' && event.facts.family === 'configured-hook')
    expect(hook?.phase).toBe('spawn-observed')
    expect(f.launches.some(launch => launch.argv.some(arg => arg.includes('exit 97')))).toBe(false)
  }, 30_000)

  test('sdk.lsp-fallback: direct handleToolCall reports unavailable before creating any external multiplexer', async () => {
    const f = fixture(), filesystem = createNodeFileSystem()
    const inputs: Parameters<typeof createLanguageIntelligence>[0][] = []
    const createService = createLanguageIntelligence
    const serviceSpy = spyOn(languageIntelligence, 'createLanguageIntelligence').mockImplementation(options => {
      inputs.push(options)
      return createService(options)
    })
    const muxSpy = spyOn(lspMultiplexer, 'createLspMultiplexer')
    const readSpy = spyOn(filesystem, 'readFile')
    restores.push(() => readSpy.mockRestore(), () => muxSpy.mockRestore(), () => serviceSpy.mockRestore())
    const position = { path: 'target.ts', line: 1, character: 0 }
    const calls = [
      { toolName: 'go_to_definition', input: position },
      { toolName: 'find_references', input: position },
      { toolName: 'hover_type', input: position },
      { toolName: 'workspace_symbol', input: { query: 'target' } },
    ] as const
    const outputs = []
    for (const call of calls) {
      const result = await handleToolCall({
        action: { type: 'tool-call-request', requestId: `fallback-${call.toolName}`, userInputId: 'fallback-input', ...call },
        cwd: f.root, fs: filesystem, overrides: {}, customToolDefinitions: {},
        trustedJobOwner: { clientSessionId: 'fallback-session', rootRunId: 'fallback-run', parentRunId: 'fallback-run', parentAgentId: 'fallback-agent' },
        approvalReceiptIds: [], approvalMode: 'allow-all', getWorkspaceState: () => undefined, setWorkspaceState: () => {},
      })
      outputs.push({ toolName: call.toolName, output: result.output })
      expect(jsonValue(result.output).errorMessage).toContain('No LSP spawner configured and no multiplexer injected')
    }
    expect(inputs).toHaveLength(4)
    for (const input of inputs) {
      expect(input.cwd).toBe(f.root)
      expect(input.fs).toBe(filesystem)
      expect(input.spawn).toBeUndefined()
      expect(input.resourceFactory).toBeUndefined()
    }
    expect(muxSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
    console.log('B19_SDK_LSP_FALLBACK', JSON.stringify({ outputs, serviceInputs: inputs.map(input => ({ cwd: input.cwd,
      hasSpawner: input.spawn !== undefined, hasResourceFactory: input.resourceFactory !== undefined })), multiplexerCreations: muxSpy.mock.calls.length }))
  })
})

async function directLspContainment(f: ReturnType<typeof fixture>, readPolicy: hostExecution.RunHostServices['readPolicy']) {
  const allowed = path.join(f.allowed, 'allowed.ts'), denied = path.join(f.denied, 'denied.ts')
  fs.writeFileSync(allowed, 'export const allowed = 1\n')
  fs.writeFileSync(denied, 'export const denied = 2\n')
  const base = createNodeFileSystem(), reads: string[] = [], synced: Array<{ filePath: string; text: string }> = []
  // Preserve the overloaded node readFile contract while observing every
  // delegated call; no file content or option is replaced by the wrapper.
  const observedRead = (...args: Parameters<CodebuffFileSystem['readFile']>) => { reads.push(String(args[0])); return base.readFile(...args) }
  // Node methods such as stat and realpath live on the adapter's prototype.
  const filesystem: CodebuffFileSystem = Object.assign(Object.create(base), { readFile: observedRead as CodebuffFileSystem['readFile'] })
  // Only the server sink is injected. The direct service performs actual
  // containment, stat and file reads against the captured HostReadPolicy.
  const multiplexer: LspMultiplexer = { definition: async () => null, references: async () => [], hover: async () => null,
    documentSymbol: async () => [], workspaceSymbol: async () => [], prepareRenameParams: async () => null,
    rename: async () => ({}), codeAction: async () => [], executeCommand: async () => ({ changesByUri: {}, createdUris: [] }),
    syncFile: async params => { synced.push({ filePath: params.filePath, text: params.text }) }, warmServerCount: () => 0, dispose: async () => {} }
  const service = createLanguageIntelligence({ cwd: f.root, fs: filesystem, readPolicy, multiplexer })
  try { await service.syncMutatedFiles([allowed, denied]) } finally { await service.dispose() }
  expect(reads).toEqual([allowed])
  expect(synced).toEqual([{ filePath: allowed, text: 'export const allowed = 1\n' }])

  // Exercise the second, lazy direct-document path too: the actual service
  // builds its openFile callback, and a query sink invokes that callback.
  // The multiplexer protocol/process is deliberately outside this oracle.
  const opened: Array<{ filePath: string; text: string }> = []
  const factory = spyOn(lspMultiplexer, 'createLspMultiplexer').mockImplementation(options => ({
    ...multiplexer,
    hover: async ({ filePath }) => {
      if (!options.openFile) throw new Error('Actual service omitted its direct document reader')
      const text = await options.openFile({ filePath })
      opened.push({ filePath, text })
      return { contents: text }
    },
  }))
  const direct = createLanguageIntelligence({ cwd: f.root, fs: filesystem, readPolicy,
    spawn: () => { throw new Error('The direct-reader sink must not launch an LSP process') } })
  let refused: Record<string, unknown>
  try {
    const result = await direct.hoverType({ path: allowed, line: 1, character: 0 })
    expect(jsonValue(result)).toMatchObject({ hover: { contents: 'export const allowed = 1\n' } })
    refused = jsonValue(await direct.hoverType({ path: denied, line: 1, character: 0 }))
    expect(refused.errorMessage).toContain('outside the project')
  } finally { await direct.dispose(); factory.mockRestore() }
  expect(reads).toEqual([allowed, allowed])
  expect(opened).toEqual([{ filePath: allowed, text: 'export const allowed = 1\n' }])
  return { reads, synced, opened, refusedPath: denied, refused,
    evidenceKind: 'actual sync and lazy direct-document containment and disk bytes; downstream multiplexer/server sink is injected' }
}
