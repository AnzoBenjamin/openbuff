/** B36 key-free producer -> diagnostic delta -> real hooks -> SDK transport fixture. */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handleToolCall } from '../../sdk/src/run'
import { createNodeFileSystem } from '../../sdk/src/tools/node-filesystem'
import {
  createDiagnosticCommandRunner,
  MAX_CAPTURED_STREAM_BYTES,
} from '../../sdk/src/services/diagnostic-delta-runner'
import { preflightDiagnosticDelta } from '../../sdk/src/services/diagnostic-delta'
import { HarnessApprovalService } from '../../sdk/src/services/harness-enforcement'
import { LocalHarnessStore } from '../../sdk/src/services/local-harness-store'
import { createDirectHostExecution } from '../../sdk/src/host-execution'
import { classifyValidationResult } from '../../cli/src/utils/output-outcome'
import type {
  DiagnosticRunResult,
  DiagnosticStatus,
} from '../../sdk/src/services/diagnostic-delta'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

export const diagnosticOutcomeCases = [
  ['empty', 'passed'],
  ['preexisting', 'passed'],
  ['shifted', 'passed'],
  ['severity-escalation', 'new_errors'],
  ['timeout', 'failed'],
  ['exit127', 'unavailable'],
  ['cancelled', 'cancelled'],
  ['missing-tool', 'unavailable'],
  ['missing-language', 'unavailable'],
  ['capped', 'incomplete'],
  ['partial', 'unknown'],
  ['unknown', 'unknown'],
] as const satisfies readonly (readonly [string, DiagnosticStatus])[]

export async function runDiagnosticOutcomeFixtures() {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const root = await mkdtemp(path.join(tmpdir(), 'openbuff-b36-'))
  const stateDir = path.join(root, 'state')
  const configPath = path.join(root, 'config.json')
  await mkdir(stateDir)
  // An explicit fixture config excludes user hooks and provider configuration.
  await writeFile(
    configPath,
    JSON.stringify({
      autoFileChangeHooks: false,
      fileChangeHooks: [{ name: 'fixture-control', command: 'true' }],
    }),
  )
  const records: Record<string, unknown>[] = []
  try {
    for (const [name, expectedStatus] of diagnosticOutcomeCases) {
      const children: ReturnType<typeof nodeSpawn>[] = []
      const closed: Promise<void>[] = []
      const targets: Record<string, unknown>[] = []
      const commandResults: Record<string, unknown>[] = []
      let launches = 0
      const cancel = new AbortController()
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined
      const bin = path.join(root, name, 'bin')
      await mkdir(bin, { recursive: true })
      await symlink('/bin/bash', path.join(bin, 'bash'))
      const countPath = path.join(bin, 'launch-count')
      let code = 'process.exit(0)'
      if (name === 'timeout' || name === 'cancelled')
        code = "process.stdout.write('partial observation');setTimeout(()=>{},10000)"
      if (name === 'exit127') code = 'process.exit(127)'
      if (name === 'capped')
        code = `process.stdout.write('x'.repeat(${MAX_CAPTURED_STREAM_BYTES + 32}))`
      if (name === 'partial') code = `process.stdout.write('{"reason":')`
      if (name === 'preexisting' || name === 'shifted' || name === 'severity-escalation') {
        const message = {
          reason: 'compiler-message',
          message: {
            level: 'error', message: 'pre-existing error', code: { code: 'E0308' },
            spans: [{ is_primary: true, file_name: 'src/lib.rs', line_start: 1,
              column_start: 1, line_end: 1, column_end: 2 }],
            children: [],
          },
        }
        code = `
const fs = require('node:fs');
const counterPath = ${JSON.stringify(countPath)};
const count = (fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0) + 1;
fs.writeFileSync(counterPath, String(count));
const message = ${JSON.stringify(message)};
if (${JSON.stringify(name)} !== 'preexisting' && count > 1) {
  message.message.spans[0].line_start = 5;
  message.message.spans[0].line_end = 5;
}
if (${JSON.stringify(name)} === 'severity-escalation' && count === 1) message.message.level = 'warning';
console.log(JSON.stringify(message));
process.exit(message.message.level === 'error' ? 101 : 0);
`
      }
      // PATH selects an owned validator before admission. The adapter then
      // dispatches the captured cargo executable/argv without substituting it.
      if (name !== 'missing-tool') {
        await writeFile(path.join(bin, 'cargo'), `#!${process.execPath}\n${code}\n`, { mode: 0o755 })
      }
      const environment = {
        PATH: bin, HOME: root, BUN_OPTIONS: '--no-env-file',
        OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
      }
      const spawn: CodebuffSpawn = (
        executable: string,
        args = [],
        options,
      ) => {
        if (executable === 'cargo') launches++
        const target: Record<string, unknown> = {
          executable, argv: [...args], cwd: options?.cwd, observations: [],
        }
        const observations = target.observations as Record<string, unknown>[]
        targets.push(target)
        const child = nodeSpawn(executable, [...args], options ?? {})
        children.push(child)
        child.once('spawn', () => {
          observations.push({ type: 'spawn', pid: child.pid })
          if (name === 'cancelled' && executable === 'cargo')
            cancellationTimer = setTimeout(() => cancel.abort(), 75)
        })
        child.once('error', error => observations.push({
          type: 'error', code: (error as NodeJS.ErrnoException).code,
        }))
        closed.push(new Promise(resolve => child.once('close', (exitCode, signal) => {
          observations.push({ type: 'close', exitCode, signal })
          resolve()
        })))
        return child
      }
      const captured = createDirectHostExecution({
        cwd: root, spawn, signal: cancel.signal, approvalMode: 'allow-all',
        profile: { policy: 'full-access', preferredBackend: 'portable-ts',
          required: ['exact-env'], allowBackendFallback: false },
        hostConfiguration: {
          invocationCwd: root, projectRoot: root, platform: process.platform, environment,
          home: { kind: 'none' }, globals: { kind: 'disabled' },
          selection: { kind: 'explicit', path: configPath, required: true },
          trust: { ancestorConfig: false, projectReadableRoots: false },
        },
      })
      if (!captured.ok) throw new Error(`${captured.reason}: ${captured.cause}`)
      const { hostServices, executionContext, resources } = captured.value
      const config = hostServices.provider.snapshot.loaded.config
      const runner = createDiagnosticCommandRunner({
        spawn,
        sigtermGraceMs: 20,
      })
      const files =
        name === 'missing-language' ? ['src/code.swift'] : ['src/lib.rs']
      try {
        const handled = await handleToolCall({
          action: {
            type: 'tool-call-request',
            requestId: `b36-${name}`,
            userInputId: 'b36',
            toolName: 'run_file_change_hooks',
            input: { files },
          },
          overrides: {},
          customToolDefinitions: {},
          cwd: root,
          fs: createNodeFileSystem(),
          trustedJobOwner: {
            clientSessionId: 'b36',
            rootRunId: 'b36',
            parentRunId: 'b36',
            parentAgentId: 'b36',
          },
          harnessStateDir: stateDir,
          approvalReceiptIds: [],
          approvalMode: 'allow-all',
          approvalService: new HarnessApprovalService(
            new LocalHarnessStore(stateDir),
          ),
          executionContext,
          resources,
          signal: executionContext.signal,
          capturedHookConfiguration: {
            autoFileChangeHooks: config.autoFileChangeHooks === true,
            fileChangeHooks: config.fileChangeHooks,
          },
          diagnosticPreflightEnabled: true,
          terminalShell: hostServices.terminalShell,
          getTerminalLaunchMetadata: hostServices.getTerminalLaunchMetadata,
          getWorkspaceState: () => undefined,
          setWorkspaceState: () => {},
          diagnosticDelta: async (params) =>
            preflightDiagnosticDelta({
              ...params,
              files,
              signal: cancel.signal,
              timeoutSeconds: 0.15,
              applyEdit: () => {},
              runCommand: async (command) => {
                const commandStartedAt = new Date().toISOString()
                const commandStarted = performance.now()
                const result: DiagnosticRunResult =
                  name === 'unknown' ? {} : await runner(command)
                const { stdout = '', stderr = '', ...metadata } = result
                commandResults.push({
                  command: command.command,
                  startedAt: commandStartedAt,
                  finishedAt: new Date().toISOString(),
                  elapsedMs: performance.now() - commandStarted,
                  ...metadata,
                  stdoutBytes: Buffer.byteLength(stdout),
                  stderrBytes: Buffer.byteLength(stderr),
                  stdoutHash: createHash('sha256').update(stdout).digest('hex'),
                  stderrHash: createHash('sha256').update(stderr).digest('hex'),
                })
                return result
              },
            }),
        })
        // Exercise the SDK wire representation and the actual CLI classifier.
        const wireOutput = JSON.parse(JSON.stringify(handled.output))
        const rows = wireOutput[0]?.type === 'json' ? wireOutput[0].value : []
        const diagnostic = Array.isArray(rows)
          ? rows.find(
              (row: Record<string, unknown>) =>
                row.hookName === 'diagnostic-delta',
            )
          : undefined
        if (!diagnostic || diagnostic.diagnosticStatus !== expectedStatus)
          throw new Error(
            `${name}: expected ${expectedStatus}, received ${JSON.stringify(wireOutput)}`,
          )
        const clientClassification = classifyValidationResult(diagnostic)
        if (expectedStatus !== 'passed' && clientClassification === 'passed')
          throw new Error(`${name}: client fabricated passed evidence`)
        records.push({
          name,
          expectedStatus,
          launches,
          targets,
          hostLaunchEvents: hostServices.events,
          commandResults,
          sdkOutput: wireOutput,
          clientClassification,
        })
      } finally {
        if (cancellationTimer) clearTimeout(cancellationTimer)
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
        await Promise.all(closed)
        cancel.abort(new Error('Diagnostic fixture host disposed'))
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    toolchain: { bun: process.version, executable: process.execPath },
    scope:
      'Linux real direct diagnostic children with exact admitted cargo argv and captured host hooks/config, real delta/SDK dispatch and CLI classifier; owned validator programs; no model/provider requests; descendant enforcement deferred to B20',
    records,
  }
}

if (import.meta.main) {
  const evidence = await runDiagnosticOutcomeFixtures()
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n')
  else process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
}
