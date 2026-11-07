/** B36 key-free producer -> diagnostic delta -> real hooks -> SDK transport fixture. */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
  const previousConfig = process.env.OPENBUFF_PROVIDER_CONFIG
  process.env.OPENBUFF_PROVIDER_CONFIG = configPath
  const records: Record<string, unknown>[] = []
  try {
    for (const [name, expectedStatus] of diagnosticOutcomeCases) {
      const children: ReturnType<typeof nodeSpawn>[] = []
      const commandResults: Record<string, unknown>[] = []
      let launches = 0
      const cancel = new AbortController()
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined
      const spawn = ((
        _: string,
        _args: string[],
        options: Parameters<CodebuffSpawn>[2],
      ) => {
        launches++
        let code = 'process.exit(0)'
        if (name === 'timeout' || name === 'cancelled')
          code =
            "process.stdout.write('partial observation');setTimeout(()=>{},10000)"
        if (name === 'exit127') code = 'process.exit(127)'
        if (name === 'capped')
          code = `process.stdout.write('x'.repeat(${MAX_CAPTURED_STREAM_BYTES + 32}))`
        if (name === 'partial') code = `process.stdout.write('{"reason":')`
        if (
          name === 'preexisting' ||
          name === 'shifted' ||
          name === 'severity-escalation'
        ) {
          const line = name !== 'preexisting' && launches > 1 ? 5 : 1
          const severity =
            name === 'severity-escalation' && launches === 1
              ? 'warning'
              : 'error'
          const message = {
            reason: 'compiler-message',
            message: {
              level: severity,
              message: 'pre-existing error',
              code: { code: 'E0308' },
              spans: [
                {
                  is_primary: true,
                  file_name: 'src/lib.rs',
                  line_start: line,
                  column_start: 1,
                  line_end: line,
                  column_end: 2,
                },
              ],
              children: [],
            },
          }
          code = `console.log(${JSON.stringify(JSON.stringify(message))});process.exit(${severity === 'error' ? 101 : 0})`
        }
        // Only fixture code runs. No keys or provider endpoints enter a child environment.
        const child = nodeSpawn(
          name === 'missing-tool'
            ? path.join(root, 'absent-validator')
            : process.execPath,
          name === 'missing-tool' ? [] : ['-e', code],
          { ...options, env: { PATH: path.dirname(process.execPath) } },
        )
        children.push(child)
        if (name === 'cancelled')
          cancellationTimer = setTimeout(() => cancel.abort(), 75)
        return child
      }) as CodebuffSpawn
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
          getWorkspaceState: () => undefined,
          setWorkspaceState: () => {},
          env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
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
          commandResults,
          sdkOutput: wireOutput,
          clientClassification,
        })
      } finally {
        if (cancellationTimer) clearTimeout(cancellationTimer)
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
      }
    }
  } finally {
    if (previousConfig === undefined)
      delete process.env.OPENBUFF_PROVIDER_CONFIG
    else process.env.OPENBUFF_PROVIDER_CONFIG = previousConfig
    await rm(root, { recursive: true, force: true })
  }
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    toolchain: { bun: process.version, executable: process.execPath },
    scope:
      'real direct diagnostic children, real delta/hook/SDK dispatch and CLI classifier; injected validator programs; no model/provider requests; descendant enforcement deferred to B20',
    records,
  }
}

if (import.meta.main) {
  const evidence = await runDiagnosticOutcomeFixtures()
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n')
  else process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
}
