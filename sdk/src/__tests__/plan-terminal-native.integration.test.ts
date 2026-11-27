import { describe, expect, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import { createNodeFileSystem } from '../tools/node-filesystem'
import {
  getBackgroundJobAdapter,
  killBackgroundJob,
} from '../tools/background-jobs'
import type { NodeDispatchHandle } from '../services/execution-launch'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { RunState } from '../run-state'

// Explicit local/CI opt-in. Ordinary unit discovery must not provision or run a native installation.
const enabled =
  process.env.OPENBUFF_TEST_PLAN_NATIVE === '1' &&
  process.platform === 'linux' &&
  process.arch === 'x64'
const hash = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function commandAgent(id: string, planOnly: boolean): AgentDefinition {
  return {
    id,
    displayName: 'Native plan terminal control',
    model: 'fixture/model',
    programmaticConfig: { planOnly },
    terminalPermissionProfile: 'full-access',
    toolNames: ['run_terminal_command', 'set_output'],
    outputMode: 'structured_output',
    handleSteps: function* ({ prompt }) {
      if (!prompt) throw new Error('Native control requires a command')
      const terminal = yield {
        toolName: 'run_terminal_command',
        input: { command: prompt, process_type: 'SYNC', timeout_seconds: 12 },
      }
      yield { toolName: 'set_output', input: { terminal: terminal.toolResult } }
    },
  }
}
function findTerminal(
  value: unknown,
  command: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (
    !Array.isArray(value) &&
    (value as { command?: unknown }).command === command &&
    'exitCode' in value
  )
    return value as Record<string, unknown>
  for (const entry of Object.values(value)) {
    const found = findTerminal(entry, command)
    if (found) return found
  }
  return undefined
}

function terminalValue(state: RunState): Record<string, unknown> {
  expect(state.runOutcome?.termination, JSON.stringify(state.output)).toBe(
    'completed',
  )
  if (state.output.type !== 'structuredOutput' || !state.output.value)
    throw new Error(JSON.stringify(state.output))
  const output = state.output.value.terminal as Array<{
    type: string
    value: Record<string, unknown>
  }>
  const terminal = output.find((part) => part.type === 'json')?.value
  if (!terminal) throw new Error(JSON.stringify(state.output))
  expect(terminal.executionRefusal).toBeUndefined()
  expect(terminal.exitCode, JSON.stringify(terminal)).toBe(0)
  return terminal
}
async function listen(server: net.Server, endpoint: number | string) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if (typeof endpoint === 'number')
      server.listen(endpoint, '127.0.0.1', resolve)
    else server.listen(endpoint, resolve)
  })
}
const close = (server: net.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()))

describe('opt-in actual Linux plan terminal enforcement', () => {
  test.skipIf(!enabled)(
    'read-only descendants and network denial are enforced before target execution; execute stays writable',
    async () => {
      const protectedHome = process.env.HOME
      const artifact = process.env.OPENBUFF_TEST_NATIVE_ARTIFACT
      if (!artifact || !path.isAbsolute(artifact))
        throw new Error(
          'Select an existing trusted native ELF with OPENBUFF_TEST_NATIVE_ARTIFACT',
        )
      const bwrap = process.env.OPENBUFF_TEST_NATIVE_BWRAP ?? '/usr/bin/bwrap'
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-plan-native-')),
      )
      const project = path.join(root, 'project'),
        configDir = path.join(root, 'config'),
        sibling = path.join(root, 'sibling')
      fs.mkdirSync(project)
      fs.mkdirSync(configDir)
      fs.mkdirSync(sibling)
      const socketPath = path.join(project, 'host-control.sock')
      const scratch = `/tmp/openbuff-plan-native-scratch-${randomUUID()}`
      const outsideMarker = path.join(sibling, 'OUTSIDE_MARKER')
      let connections = 0,
        fetches = 0
      let backgroundJobId: string | undefined
      let backgroundLaunch: NodeDispatchHandle | undefined
      const peers = new Set<net.Socket>()
      const accepted = (socket: net.Socket) => {
        connections++
        peers.add(socket)
        socket.on('close', () => peers.delete(socket))
        socket.end()
      }
      const tcp = net.createServer(accepted),
        unix = net.createServer(accepted)
      const forbidden = () => {
        fetches++
        throw new Error('Native plan control must not call a provider')
      }
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(async () => forbidden(), { preconnect: forbidden }),
      )
      try {
        await listen(tcp, 0)
        await listen(unix, socketPath)
        const address = tcp.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing owned TCP listener')
        fs.writeFileSync(path.join(project, 'old.txt'), 'original\n')
        fs.symlinkSync(sibling, path.join(project, 'escape'))
        fs.writeFileSync(
          path.join(project, 'package.json'),
          JSON.stringify({
            scripts: {
              test: 'bun --no-env-file probe.ts',
              mutate: 'bun --no-env-file mutate.ts',
            },
          }),
        )
        fs.writeFileSync(
          path.join(project, 'child.ts'),
          `import fs from 'node:fs';
try { fs.writeFileSync('CHILD_MARKER', 'written'); console.log('child:write-allowed') }
catch { console.log('child:write-denied') }
`,
        )
        fs.writeFileSync(
          path.join(project, 'mutate.ts'),
          `import fs from 'node:fs'; import net from 'node:net'; fs.writeFileSync('EXEC_MARKER', 'execute');
const connected = await new Promise<boolean>(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port: ${address.port} });
  socket.once('connect', () => { socket.destroy(); resolve(true) });
  socket.once('error', () => resolve(false)); socket.setTimeout(250, () => { socket.destroy(); resolve(false) });
});
console.log('execute:writable:network=' + connected);\n`,
        )
        fs.writeFileSync(
          path.join(project, 'probe.ts'),
          `import fs from 'node:fs'; import net from 'node:net';
const result: Record<string, unknown> = {};
const denied = (operation: () => void) => { try { operation(); return false } catch { return true } };
result.overwriteDenied = denied(() => fs.writeFileSync('old.txt', 'mutated'));
result.createDenied = denied(() => fs.writeFileSync('PLAN_MARKER', 'written'));
result.unlinkDenied = denied(() => fs.unlinkSync('old.txt'));
result.renameDenied = denied(() => fs.renameSync('old.txt', 'renamed.txt'));
result.symlinkEscapeDenied = denied(() => fs.writeFileSync('escape/OUTSIDE_MARKER', 'written'));
result.outsideDenied = denied(() => fs.writeFileSync(${JSON.stringify(outsideMarker)}, 'written'));
fs.writeFileSync(${JSON.stringify(scratch)}, 'sandbox-private');
result.privateScratch = fs.readFileSync(${JSON.stringify(scratch)}, 'utf8') === 'sandbox-private';
const child = Bun.spawnSync([process.execPath, '--no-env-file', 'child.ts'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
result.childDenied = child.exitCode === 0 && new TextDecoder().decode(child.stdout).includes('child:write-denied');
async function blocked(endpoint: { host?: string; port?: number; path?: string }): Promise<boolean> {
  return new Promise(resolve => {
    let socket: net.Socket;
    try { socket = net.createConnection(endpoint as any) } catch { resolve(true); return }
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolve(value) };
    socket.once('connect', () => finish(false)); socket.once('error', () => finish(true)); socket.setTimeout(250, () => finish(true));
  });
}
result.tcpDenied = await blocked({ host: '127.0.0.1', port: ${address.port} });
result.unixDenied = await blocked({ path: ${JSON.stringify(socketPath)} });
console.log(JSON.stringify(result));
`,
        )
        const config = path.join(configDir, 'openbuff.json')
        fs.writeFileSync(
          config,
          JSON.stringify({
            defaultModel: 'fixture/model',
            autoFileChangeHooks: false,
            providers: {
              fixture: {
                type: 'openai-compatible',
                baseURL: 'https://fixture.invalid/v1',
                models: ['model'],
              },
            },
            execution: {
              profile: {
                policy: 'full-access',
                preferredBackend: 'native-exec',
                required: ['exact-env'],
                allowBackendFallback: false,
              },
              native: {
                artifact: {
                  path: artifact,
                  sha256: hash(artifact),
                  platform: 'linux-x64-gnu',
                  crateVersion: '0.1.0',
                  workspaceProtocol: '1',
                },
                bwrap: { path: bwrap, sha256: hash(bwrap) },
                runtimePaths: [
                  '/usr',
                  '/bin',
                  '/lib',
                  '/lib64',
                  path.dirname(process.execPath),
                ].filter((p) => fs.existsSync(p)),
                network: 'inherit',
                landlock: 'optional',
              },
            },
          }),
        )
        const launches: LaunchEvent[] = []
        const client = new OpenbuffClient({
          cwd: project,
          fsSource: createNodeFileSystem(),
          projectFiles: {},
          knowledgeFiles: {},
          userKnowledgeFiles: {},
          repositoryIntelligence: false,
          harnessStateDir: path.join(configDir, 'harness'),
          approvalMode: 'allow-all',
          runTimeoutMs: 30_000,
          hostConfiguration: {
            environment: {
              PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0',
              OPENBUFF_PROCESS_SUPERVISION: '0',
              OPENBUFF_TELEMETRY: '0',
              DO_NOT_TRACK: '1',
            },
            platform: 'linux',
            invocationCwd: project,
            projectRoot: project,
            home: { kind: 'none' },
            globals: { kind: 'disabled' },
            selection: { kind: 'explicit', path: config, required: true },
            trust: { ancestorConfig: false, projectReadableRoots: false },
          },
          configReadFs: nodeConfigReadFs,
          recordExecution: (event) => launches.push(event),
          handleEvent() {},
        })
        const plan = terminalValue(
          await client.run({
            agent: commandAgent('native-plan-control', true),
            prompt: 'bun run test',
          }),
        )
        expect(JSON.parse(String(plan.stdout).trim())).toEqual({
          overwriteDenied: true,
          createDenied: true,
          unlinkDenied: true,
          renameDenied: true,
          symlinkEscapeDenied: true,
          outsideDenied: true,
          privateScratch: true,
          childDenied: true,
          tcpDenied: true,
          unixDenied: true,
        })
        expect(fs.readFileSync(path.join(project, 'old.txt'), 'utf8')).toBe(
          'original\n',
        )
        for (const marker of ['PLAN_MARKER', 'CHILD_MARKER', 'renamed.txt'])
          expect(fs.existsSync(path.join(project, marker))).toBe(false)
        expect(fs.existsSync(outsideMarker)).toBe(false)
        expect(fs.existsSync(scratch)).toBe(false)
        expect(connections).toBe(0)
        const child = commandAgent('native-plan-child', false)
        const parent: AgentDefinition = {
          id: 'native-plan-parent',
          displayName: 'Plan parent control',
          model: 'fixture/model',
          programmaticConfig: { planOnly: true },
          toolNames: ['spawn_agents', 'set_output'],
          spawnableAgents: [child.id],
          outputMode: 'structured_output',
          handleSteps: function* ({ prompt }) {
            if (!prompt)
              throw new Error('Plan child control requires a command')
            const spawned = yield {
              toolName: 'spawn_agents',
              input: { agents: [{ agent_type: 'native-plan-child', prompt }] },
            }
            yield {
              toolName: 'set_output',
              input: { spawned: spawned.toolResult },
            }
          },
        }
        const childRun = await client.run({
          agent: parent,
          agentDefinitions: [child],
          prompt: 'bun run test',
        })
        expect(
          childRun.runOutcome?.termination,
          JSON.stringify(childRun.output),
        ).toBe('completed')
        const childTerminal = findTerminal(childRun.output, 'bun run test')
        expect(childTerminal, JSON.stringify(childRun.output)).toBeDefined()
        expect(childTerminal?.executionRefusal).toBeUndefined()
        expect(childTerminal?.exitCode).toBe(0)
        expect(JSON.parse(String(childTerminal?.stdout).trim())).toEqual(
          JSON.parse(String(plan.stdout).trim()),
        )
        expect(connections).toBe(0)
        const backgroundAgent: AgentDefinition = {
          ...commandAgent('native-plan-background', true),
          handleSteps: function* ({ prompt }) {
            if (!prompt)
              throw new Error('Background control requires a command')
            const terminal = yield {
              toolName: 'run_terminal_command',
              input: {
                command: prompt,
                process_type: 'BACKGROUND',
                detach: true,
                timeout_seconds: 12,
              },
            }
            yield {
              toolName: 'set_output',
              input: { terminal: terminal.toolResult },
            }
          },
        }
        const background = await client.run({
          agent: backgroundAgent,
          prompt: 'bun run test',
        })
        expect(
          background.runOutcome?.termination,
          JSON.stringify(background.output),
        ).toBe('completed')
        if (
          background.output.type !== 'structuredOutput' ||
          !background.output.value
        )
          throw new Error(JSON.stringify(background.output))
        const start = (
          background.output.value.terminal as Array<{
            value: { jobId?: string }
          }>
        )[0].value
        backgroundJobId = start.jobId
        expect(backgroundJobId).toBeDefined()
        const job = getBackgroundJobAdapter(backgroundJobId!)
        backgroundLaunch = job?.nodeLaunch
        expect(backgroundLaunch?.nativeResult).toBeDefined()
        const final = await backgroundLaunch!.nativeResult!
        if (!final.ok) throw new Error(final.cause)
        expect(final.value.targetEntry).toBe('entered')
        expect(final.value.exitCode).toBe(0)
        expect(final.value.cleanup.complete).toBe(true)
        expect(fs.readFileSync(job!.logFile, 'utf8')).toContain(
          '"createDenied":true',
        )
        expect(fs.existsSync(path.join(project, 'PLAN_MARKER'))).toBe(false)
        expect(fs.existsSync(path.join(project, 'CHILD_MARKER'))).toBe(false)
        expect(fs.existsSync(outsideMarker)).toBe(false)
        expect(connections).toBe(0)
        const entered = launches.filter(
          (event) =>
            event.phase === 'spawn-observed' &&
            event.facts.profile.requested.policy === 'read-only',
        )
        expect(entered.length).toBeGreaterThan(0)
        for (const event of entered) {
          if (event.phase !== 'spawn-observed')
            throw new Error('Missing native entry')
          expect(event.facts.profile.active?.backend).toBe('native-exec')
          expect(event.facts.profile.requested.allowBackendFallback).toBe(false)
          for (const capability of [
            'exact-env',
            'filesystem-isolation',
            'network-isolation',
            'process-tree-containment',
          ])
            expect(
              event.facts.profile.enforced.some(
                (item) =>
                  item.capability === capability && item.status === 'enforced',
              ),
            ).toBe(true)
        }
        const execute = terminalValue(
          await client.run({
            agent: commandAgent('native-execute-control', false),
            prompt: 'bun run mutate',
          }),
        )
        expect(String(execute.stdout)).toContain(
          'execute:writable:network=true',
        )
        expect(connections).toBe(1)
        expect(fs.readFileSync(path.join(project, 'EXEC_MARKER'), 'utf8')).toBe(
          'execute',
        )
        expect(fetches).toBe(0)
        expect(process.env.HOME).toBe(protectedHome)
        const evidence = process.env.OPENBUFF_TEST_PLAN_NATIVE_EVIDENCE_DIR
        if (evidence) {
          if (!path.isAbsolute(evidence))
            throw new Error('Native test evidence directory must be absolute')
          fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
          fs.writeFileSync(
            path.join(evidence, 'result.json'),
            JSON.stringify(
              {
                fixture: 'actual-source-SDK-and-selected-Linux-native-ELF',
                formalRoadmapAcceptance: false,
                artifact: { path: artifact, sha256: hash(artifact) },
                bwrap: { path: bwrap, sha256: hash(bwrap) },
                probe: JSON.parse(String(plan.stdout).trim()),
                childProbe: JSON.parse(String(childTerminal?.stdout).trim()),
                nativeEntries: entered,
                planConnections: 0,
                executeConnections: connections,
                detachedBackground: {
                  exitCode: final.value.exitCode,
                  cleanup: final.value.cleanup,
                },
                fetches,
                homeUnchanged: process.env.HOME === protectedHome,
                executeWritable:
                  fs.readFileSync(path.join(project, 'EXEC_MARKER'), 'utf8') ===
                  'execute',
                childRunOutcome: childRun.runOutcome,
                childCleanup: childRun.executionCleanup,
              },
              null,
              2,
            ) + '\n',
            { mode: 0o600, flag: 'wx' },
          )
        }
      } finally {
        if (backgroundJobId) killBackgroundJob(backgroundJobId)
        await backgroundLaunch?.scope.requestStop('owner-shutdown')
        fetchSpy.mockRestore()
        for (const peer of peers) peer.destroy()
        await Promise.all([close(tcp), close(unix)])
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(scratch, { force: true })
      }
    },
    60_000,
  )
})
