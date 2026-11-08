import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getAllFilePaths } from '@codebuff/common/project-file-tree'
import { OpenbuffClient } from '../client'
import * as sdkEnvironment from '../env'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ConfigReadFs } from '../provider-config'
import type { OpenbuffClientOptions } from '../run'
import type { RunState } from '../run-state'

const program: AgentDefinition = {
  id: 'startup-context-fixture',
  displayName: 'Startup context fixture',
  model: 'fixture-model',
  outputMode: 'structured_output',
  toolNames: ['run_terminal_command', 'set_output'],
  handleSteps: function* ({ prompt }) {
    if (prompt === 'observe-cwd') {
      const { toolResult } = yield {
        toolName: 'run_terminal_command',
        input: { command: 'pwd', process_type: 'SYNC' },
      }
      yield { toolName: 'set_output', input: { terminal: toolResult } }
      return
    }
    yield { toolName: 'set_output', input: { startup: 'completed' } }
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

type FsCall = { operation: string; path: string }
type SpawnCall = { command: string; argv: readonly string[]; cwd: string | undefined }
type StartupFixture = {
  directory: string
  root: string
  peer: string
  late: string
  harness: string
  environment: Record<string, string>
  fsCalls: FsCall[]
  configCalls: FsCall[]
  observedFs: ReturnType<typeof createNodeFileSystem>
  spawns: SpawnCall[]
  children: Array<{ child: ChildProcess; closed: Promise<void> }>
  launch: CodebuffSpawn
  execution: LaunchEvent[]
  stop: AbortController
  options: OpenbuffClientOptions
}
const fixtures: StartupFixture[] = []
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
let networkAttempts = 0

beforeEach(() => {
  networkAttempts = 0
  const forbidden = () => {
    networkAttempts++
    throw new Error('Startup context tests must not request a provider')
  }
  network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbidden(), { preconnect: forbidden }),
  )
})

afterEach(async () => {
  const attempts = networkAttempts
  const calls = network.mock.calls.length
  network.mockRestore()
  for (const f of fixtures.splice(0)) {
    f.stop.abort(new Error('Startup fixture teardown'))
    for (const { child } of f.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await Promise.all(f.children.map(entry => entry.closed))
    fs.rmSync(f.directory, { recursive: true, force: true })
  }
  expect(attempts).toBe(0)
  expect(calls).toBe(0)
})

function fixture(): StartupFixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-startup-context-'))
  const root = path.join(directory, 'project')
  const peer = path.join(directory, 'peer')
  const late = path.join(directory, 'late')
  const home = path.join(directory, 'home')
  const harness = path.join(directory, 'harness')
  for (const [cwd, name] of [[root, 'startup-root'], [peer, 'startup-peer'], [late, 'startup-late']] as const) {
    fs.mkdirSync(cwd, { recursive: true })
    fs.writeFileSync(path.join(cwd, 'knowledge.md'), `Live knowledge from ${name}\n`)
    fs.writeFileSync(path.join(cwd, 'live-only.ts'), 'export const liveOnly = true\n')
    const skill = path.join(cwd, '.agents', 'skills', name)
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Startup root marker\n---\nCaptured ${name}\n`)
  }
  fs.mkdirSync(home)
  const environment = {
    PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home,
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  }
  const fsCalls: FsCall[] = []
  const source = createNodeFileSystem()
  const observedFs = new Proxy(source, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        const file = String(args[0])
        fsCalls.push({ operation: String(property), path: file })
        // The project adapter serves only this fixture; ambient home reads are absent.
        const relative = path.relative(directory, file)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          return Promise.reject(Object.assign(new Error('Outside fixture filesystem'), { code: 'ENOENT' }))
        }
        return Reflect.apply(member, target, args)
      }
    },
  })
  const configCalls: FsCall[] = []
  const absent = (operation: string, file: string): never => {
    configCalls.push({ operation, path: file })
    throw Object.assign(new Error('No fixture provider configuration'), { code: 'ENOENT' })
  }
  const configReadFs: ConfigReadFs = {
    stat: file => absent('stat', file),
    readFile: file => absent('readFile', file),
    readDirectory: file => absent('readDirectory', file),
    realpath: file => absent('realpath', file),
  }
  const spawns: SpawnCall[] = []
  const children: Array<{ child: ChildProcess; closed: Promise<void> }> = []
  const execution: LaunchEvent[] = []
  const launch: CodebuffSpawn = (command, argv = [], options) => {
    spawns.push({ command, argv: [...argv], cwd: options?.cwd === undefined ? undefined : String(options.cwd) })
    const child = spawn(command, [...argv], options ?? {})
    children.push({ child, closed: new Promise(resolve => child.once('close', () => resolve())) })
    return child
  }
  const stop = new AbortController()
  const options: OpenbuffClientOptions = {
    configReadFs, fsSource: observedFs, spawnSource: launch,
    harnessStateDir: harness, approvalMode: 'allow-all',
    executionProfile: { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false },
    handleEvent: () => {}, recordExecution: event => { execution.push(event) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const f = { directory, root, peer, late, harness, environment, fsCalls, configCalls,
    observedFs, spawns, children, launch, execution, stop, options }
  fixtures.push(f)
  return f
}

async function withAmbient<T>(f: ReturnType<typeof fixture>, initialCwd: string,
  body: (changeCwd: (cwd: string) => void) => Promise<T>): Promise<T> {
  // Bun's path.resolve reads the native cwd directly, bypassing a process.cwd
  // spy. Exercise real cwd changes and restore them before fixture teardown.
  const previousCwd = process.cwd()
  process.chdir(initialCwd)
  const environment = spyOn(sdkEnvironment, 'getSystemProcessEnv').mockImplementation(() => ({ ...f.environment }))
  try { return await body(value => { process.chdir(value) }) }
  finally { environment.mockRestore(); process.chdir(previousCwd) }
}

function completed(result: RunState) {
  expect(result.output.type).toBe('structuredOutput')
  expect(result.runOutcome?.termination).toBe('completed')
  if (!result.sessionState) throw new Error('Startup did not produce a session')
  return result.sessionState
}

function expectNoWorkspaceWork(f: ReturnType<typeof fixture>) {
  const projectRoots = [f.root, f.peer, f.late]
  expect(f.fsCalls.filter(call => call.operation === 'readdir' && projectRoots.includes(call.path))).toEqual([])
  expect(f.fsCalls.filter(call => call.operation === 'readFile' &&
    projectRoots.some(root => call.path === path.join(root, '.gitignore') ||
      call.path === path.join(root, 'live-only.ts') || call.path === path.join(root, 'knowledge.md')))).toEqual([])
  expect(f.fsCalls.filter(call => call.path.includes(`${path.sep}.openbuff${path.sep}memory${path.sep}`))).toEqual([])
  expect(f.fsCalls.filter(call => ['writeFile', 'mkdir', 'unlink', 'renameFile', 'createFileExclusive'].includes(call.operation))).toEqual([])
  expect(f.spawns).toEqual([])
  expect(f.execution.some(event => event.phase === 'dispatched' || event.phase === 'spawn-observed')).toBe(false)
  expect(fs.existsSync(f.harness)).toBe(false)
  for (const root of projectRoots) expect(fs.existsSync(path.join(root, '.openbuff'))).toBe(false)
}

function previousMemory(): TaskMemoryV1 {
  return { schemaVersion: 1, goal: 'Virtual host task memory', requirements: [], decisions: [],
    filesInspected: [], editsMade: [], validationResults: [], reviewReceipts: [], blockers: [],
    nextActions: [], historicalSummary: '', evidence: [], revision: 0, updatedAt: 1_000, checksum: 'fixture' }
}

describe('SDK optional workspace cwd and captured startup context', () => {
  test.each(['provided', 'derived'] as const)('no-cwd fresh and continued calls retain %s virtual knowledge without workspace work', async mode => {
    const f = fixture()
    await withAmbient(f, f.root, async () => {
      const projectFiles = { 'virtual.ts': 'export const virtualOnly = true\n', 'knowledge.md': 'Virtual knowledge one' }
      const knowledgeFiles = mode === 'provided' ? { 'caller.md': 'Caller knowledge one' } : undefined
      const client = new OpenbuffClient({ ...f.options, projectFiles, knowledgeFiles,
        userKnowledgeFiles: { 'caller-user.md': 'Caller user knowledge' } })
      const first = await client.run({ agent: program, prompt: 'observe-startup', signal: f.stop.signal })
      const firstSession = completed(first)
      expect(firstSession.fileContext.knowledgeFiles).toEqual(knowledgeFiles ?? { 'knowledge.md': 'Virtual knowledge one' })
      expect(firstSession.fileContext.userKnowledgeFiles?.['caller-user.md']).toBe('Caller user knowledge')
      expect(firstSession.fileContext.fileTreeSource).toBe('virtual')
      expect(firstSession.fileContext.fileTree).toEqual([])
      expect(firstSession.fileContext.fileTokenScores).toEqual({})
      expect(firstSession.fileContext.tokenCallers).toEqual({})
      expect(firstSession.fileContext.gitChanges).toEqual({ status: '', diff: '', diffCached: '', lastCommitMessages: '' })
      // Supply committed-shaped memory so continuation exercises the persistence gate.
      firstSession.mainAgentState.taskMemory = previousMemory()
      const before = JSON.stringify(first.sessionState)
      const nextFiles = { 'second-virtual.ts': 'export const next = true\n', 'knowledge.md': 'Virtual knowledge two' }
      const nextKnowledge = mode === 'provided' ? { 'caller.md': 'Caller knowledge two' } : undefined
      const second = await client.run({ agent: program, prompt: 'observe-startup', previousRun: first, signal: f.stop.signal,
        projectFiles: nextFiles, knowledgeFiles: nextKnowledge })
      const secondSession = completed(second)
      expect(secondSession.fileContext.knowledgeFiles).toEqual(nextKnowledge ?? { 'knowledge.md': 'Virtual knowledge two' })
      expect(secondSession.fileContext.fileTreeSource).toBe('virtual')
      expect(secondSession.fileContext.fileTree).toEqual([])
      expect(secondSession.fileContext.fileTokenScores).toEqual({})
      expect(secondSession.fileContext.tokenCallers).toEqual({})
      expect(secondSession.fileContext.gitChanges).toEqual({ status: '', diff: '', diffCached: '', lastCommitMessages: '' })
      expect(secondSession.mainAgentState.taskMemory).toBeDefined()
      expect(JSON.stringify(first.sessionState)).toBe(before)
      expectNoWorkspaceWork(f)
    })
  })

  test('a no-cwd call without projectFiles does not read or discover a project tree', async () => {
    const f = fixture()
    await withAmbient(f, f.root, async () => {
      const result = await new OpenbuffClient(f.options).run({ agent: program, prompt: 'observe-startup', signal: f.stop.signal })
      const session = completed(result)
      expect(session.fileContext.knowledgeFiles).toEqual({})
      expect(session.fileContext.fileTree).toEqual([])
      expect(session.fileContext.fileTokenScores).toEqual({})
      expectNoWorkspaceWork(f)
    })
  })

  test.each(['cwd', 'hostConfiguration'] as const)('%s selects and discovers its explicit project and launches there', async selection => {
    const f = fixture()
    await withAmbient(f, f.directory, async () => {
      const selected: OpenbuffClientOptions = selection === 'cwd' ? { cwd: 'project' } : {
        hostConfiguration: { environment: f.environment, platform: process.platform,
          invocationCwd: f.peer, projectRoot: f.root, home: { kind: 'none' }, globals: { kind: 'disabled' },
          selection: { kind: 'none' }, trust: { ancestorConfig: false, projectReadableRoots: false } },
      }
      const result = await new OpenbuffClient({ ...f.options, ...selected, projectContextMode: 'paths' })
        .run({ agent: program, prompt: 'observe-cwd', signal: f.stop.signal })
      const session = completed(result)
      expect(session.fileContext.cwd).toBe(f.root)
      expect(session.fileContext.projectRoot).toBe(f.root)
      expect(session.fileContext.fileTreeSource).toBe('live')
      expect(getAllFilePaths(session.fileContext.fileTree)).toContain('live-only.ts')
      expect(session.fileContext.knowledgeFiles['knowledge.md']).toBe('Live knowledge from startup-root\n')
      expect(f.fsCalls.some(call => call.operation === 'readdir' && call.path === f.root)).toBe(true)
      expect(f.fsCalls.some(call => call.operation === 'readFile' && call.path === path.join(f.root, 'knowledge.md'))).toBe(true)
      expect(f.fsCalls.some(call => call.operation === 'readdir' && call.path === f.peer)).toBe(false)
      expect(f.spawns.length).toBeGreaterThan(0)
      expect(f.spawns.every(call => call.cwd === f.root)).toBe(true)
      expect(result.actionOutcomes?.some(action => action.toolName === 'run_terminal_command' && action.outcome === 'succeeded')).toBe(true)
      expect(JSON.stringify(result.output)).toContain(f.root)
      expect(f.execution.some(event => event.phase === 'spawn-observed' && event.facts.correlation.kind === 'action')).toBe(true)
    })
  })

  for (const dependency of ['fs', 'spawn'] as const) {
    test.each([false, true])(`deferred ${dependency} initialization retains captured skills and metadata on continued=%s`, async continued => {
      const f = fixture()
      await withAmbient(f, f.root, async changeCwd => {
        const client = new OpenbuffClient({ ...f.options, projectFiles: {}, knowledgeFiles: {} })
        const previous = continued ? await client.run({ agent: program, prompt: 'observe-startup', signal: f.stop.signal }) : undefined
        if (previous) completed(previous)
        const capturedRoot = continued ? f.peer : f.root
        const skillName = continued ? 'startup-peer' : 'startup-root'
        changeCwd(capturedRoot)
        f.fsCalls.length = 0
        f.spawns.length = 0
        f.execution.length = 0
        const entered = deferred<void>()
        const filesystem = deferred<typeof f.observedFs>()
        const spawnDependency = deferred<CodebuffSpawn>()
        if (dependency === 'spawn') {
          const then = spawnDependency.promise.then.bind(spawnDependency.promise)
          Object.defineProperty(spawnDependency.promise, 'then', {
            value: (...args: Parameters<typeof then>) => { entered.resolve(); return then(...args) },
          })
        }
        const stop = new AbortController()
        const pending = client.run({ agent: program, prompt: 'observe-startup', previousRun: previous, signal: stop.signal,
          ...(dependency === 'fs' ? { fsSource: () => { entered.resolve(); return filesystem.promise } } :
            { spawnSource: spawnDependency.promise }) })
        try {
          await Promise.race([entered.promise, pending.then(() => { throw new Error('Run ended before reaching deferred dependency') })])
          changeCwd(f.late)
          filesystem.resolve(f.observedFs)
          spawnDependency.resolve(f.launch)
          const session = completed(await pending)
          expect(session.fileContext.cwd).toBe(capturedRoot)
          expect(session.fileContext.projectRoot).toBe(capturedRoot)
          expect(session.fileContext.skills?.[skillName]?.filePath).toBe(
            path.join(capturedRoot, '.agents', 'skills', skillName, 'SKILL.md'))
          expect(session.fileContext.skills?.['startup-late']).toBeUndefined()
          if (continued) expect(session.fileContext.skills?.['startup-root']).toBeUndefined()
          expectNoWorkspaceWork(f)
        } finally {
          stop.abort(new Error('Deferred initialization fixture complete'))
          filesystem.resolve(f.observedFs)
          spawnDependency.resolve(f.launch)
          await pending
        }
      })
    })
  }
})
