import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import {
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { OpenbuffClient } from '../client'
import {
  beginSdkCallback,
  createSdkCallbackFixture,
  createSdkCallbackMcpFixture,
  sdkCallbackOptions,
} from './sdk-callback-fixture'
import { createNodeFileSystem } from '../tools/node-filesystem'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import * as databaseModule from '../impl/database'
import { handleToolCall } from '../run'
import { HarnessApprovalService } from '../services/harness-enforcement'
import { LocalHarnessStore } from '../services/local-harness-store'

import type { FilesystemMutationEvent, OpenbuffClientOptions } from '../run'
import type { CommitReceiptV1 } from '@codebuff/common/tools/results/filesystem'
import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import type { HarnessApprovalRequest } from '../services/harness-enforcement'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'

// Harness/journal state is written through real node fs, so keep it inside a
// temp root instead of the user's config directory.
const harnessStateDir = mkdtempSync(
  path.join(tmpdir(), 'openbuff-run-mutation-'),
)

let callbackFixture: ReturnType<typeof createSdkCallbackFixture>
beforeEach(() => {
  callbackFixture = createSdkCallbackFixture('mutation')
})
afterEach(() => { callbackFixture.close() })

const auditInput = {
  sessionSlug: 'audit-dispatch',
  shardId: 'runtime-1',
  findings: [],
  coverage: {
    subsystemIds: ['sdk'],
    featureIds: ['tool-dispatch'],
    files: ['sdk/src/run.ts'],
  },
  noIssuesFound: true,
}
// Snapshot-bound variant, so at least one dispatch case drives the
// structuralReceipt branch through the real handleToolCall wiring.
const snapshotBoundAuditInput = {
  ...auditInput,
  snapshotId: 'snapshot-dispatch-1',
  coverage: { ...auditInput.coverage, domains: ['security'] },
}
const auditArtifactPath =
  '.agents/sessions/audit-dispatch/findings/runtime-1.md'

function mockDatabase() {
  spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
    id: 'user-123',
    email: 'test@example.com',
    discord_id: null,
    stripe_customer_id: null,
    banned: false,
    created_at: new Date('2024-01-01T00:00:00Z'),
  })
  spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
  spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
  spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
  spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
}

/**
 * Stubs the agent loop and dispatches exactly the given client tool calls
 * through the real `handleToolCall` wiring, returning each tool output.
 */
async function dispatchToolCalls(params: {
  calls: Array<{ toolName: string; input: unknown }>
  clientOptions: OpenbuffClientOptions
  /**
   * Optional sink for the canonical commit receipt each dispatch returns
   * alongside its output, so a case can pin that receipt (or its absence)
   * without changing what this helper resolves to.
   */
  canonicalReceipts?: Array<CommitReceiptV1 | undefined>
}): Promise<ToolResultOutput[][]> {
  mockDatabase()
  const outputs: ToolResultOutput[][] = []
  spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
    async (
      promptParams: Parameters<typeof mainPromptModule.callMainPrompt>[0],
    ) => {
      const { sendAction, promptId } = promptParams
      const callback = await beginSdkCallback(promptParams)
      const { sessionState, request: requestToolCall } = callback
      for (const call of params.calls) {
        const handled = await requestToolCall({
          userInputId: promptId,
          toolName: call.toolName,
          input: call.input as Parameters<typeof requestToolCall>[0]['input'],
        })
        outputs.push(handled.output)
        params.canonicalReceipts?.push(handled.canonicalReceipt)
      }
      await sendAction({
        action: {
          type: 'prompt-response',
          promptId,
          sessionState,
          output: { type: 'lastMessage', value: [] },
        },
      })
      return {
        sessionState,
        output: { type: 'lastMessage' as const, value: [] },
      }
    },
  )

  const client = new OpenbuffClient({
    ...sdkCallbackOptions(params.clientOptions.cwd ?? callbackFixture.cwd, {
      harnessStateDir: callbackFixture.harnessStateDir,
      ...params.clientOptions,
    }),
  })
  const result = await client.run({ agent: 'base2', prompt: 'dispatch' })
  expect(result.output.type).toBe('lastMessage')
  expect(outputs).toHaveLength(params.calls.length)
  return outputs
}

function jsonValue(output: ToolResultOutput[] | undefined): unknown {
  const part = output?.[0]
  return part?.type === 'json' ? part.value : undefined
}

// Every dispatch case below writes journal state under this root, so it is
// removed once, after the whole file.
afterAll(() => {
  rmSync(harnessStateDir, { recursive: true, force: true })
})

describe('[B36] diagnostic SDK/client projection', () => {
  afterEach(() => {
    mock.restore()
  })

  it.each([
    ['new-error', 'default', 'new_errors', 'before_after'],
    ['shifted-error', 'default', 'passed', 'before_after'],
    ['shifted-error', 'StRiCt', 'new_errors', 'before_after'],
    ['failed-baseline', 'default', 'unavailable', 'before_after'],
    ['mismatched-files', 'default', 'unknown', 'before_after'],
    ['foreign-bytes', 'default', 'unknown', 'before_after'],
    ['failed-foreign-baseline', 'default', 'unknown', 'before_after'],
  ] as const)(
    'retains the correct baseline across actual client calls: %s (host mode %s)',
    async (name, mode, status, basis) => {
      const workspace = mkdtempSync(path.join(harnessStateDir, 'b36-client-'))
      const configPath = path.join(harnessStateDir, `b36-${name}.json`)
      writeFileSync(
        configPath,
        JSON.stringify({
          autoFileChangeHooks: false,
          fileChangeHooks: [{ name: 'fixture-control', command: 'true' }],
        }),
      )
      const bin = path.join(workspace, 'bin')
      const counter = path.join(workspace, 'cargo-invocations.txt')
      mkdirSync(bin)
      // Invoke the admitted cargo argv through PATH; the peer is a real process.
      writeFileSync(path.join(bin, 'cargo'), '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const counter = process.env.OPENBUFF_CALLBACK_CARGO_COUNTER;
const name = process.env.OPENBUFF_CALLBACK_CARGO_CASE;
let previous = 0;
try { previous = Number(fs.readFileSync(counter, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const invocation = previous + 1;
fs.writeFileSync(counter, String(invocation));
if (name === 'failed-baseline' || name === 'failed-foreign-baseline') {
  process.exit(invocation === 1 ? 127 : 0);
}
const hasError = name === 'shifted-error' || (name === 'new-error' && invocation > 1);
if (hasError) console.log(JSON.stringify({
  reason: 'compiler-message',
  message: {
    level: 'error', message: 'synthetic fixture error', code: { code: 'E0308' },
    spans: [{ is_primary: true, file_name: 'src/lib.rs',
      line_start: invocation === 1 ? 1 : 5, column_start: 1,
      line_end: invocation === 1 ? 1 : 5, column_end: 2 }],
    children: [],
  },
}));
process.exit(hasError ? 101 : 0);
`, { mode: 0o755 })
      const hostConfiguration = sdkCallbackOptions(workspace).hostConfiguration!
      const environment = {
        ...hostConfiguration.environment,
        PATH: bin + path.delimiter + hostConfiguration.environment.PATH,
        OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true',
        OPENBUFF_CALLBACK_CARGO_COUNTER: counter,
        OPENBUFF_CALLBACK_CARGO_CASE: name,
        ...(mode === 'default' ? {} : { OPENBUFF_DIAGNOSTIC_DELTA_MODE: mode }),
      }
      let launches = 0
      const spawn: CodebuffSpawn = (command, argv, options) => {
        if (command === 'cargo') {
          expect(argv).toEqual(['check', '--message-format=json'])
          launches++
        }
        return nodeSpawn(command, [...argv ?? []], options ?? {})
      }
      if (name === 'shifted-error') {
        mkdirSync(path.join(workspace, 'src'))
        writeFileSync(path.join(workspace, 'src/lib.rs'), 'fn fixture() {}\n')
      }
      try {
        const outputs = await dispatchToolCalls({
          calls: [
            {
              toolName: 'write_file',
              input: {
                type: 'file',
                path: 'src/lib.rs',
                instructions: 'Create the fixture source',
                content: name === 'shifted-error'
                  ? '// inserted line 1\n// inserted line 2\n// inserted line 3\n// inserted line 4\nfn fixture() {}\n'
                  : 'fn fixture() {}\n',
              },
            },
            {
              toolName: 'run_file_change_hooks',
              input: {
                files: [
                  name === 'mismatched-files' ? 'src/other.rs' : 'src/lib.rs',
                ],
              },
            },
          ],
          clientOptions: {
            cwd: workspace,
            // Use the SDK's real filesystem with its conditional mutation broker.
            fsSource: undefined,
            spawnSource: spawn,
            approvalMode: 'allow-all',
            hostConfiguration: {
              ...hostConfiguration,
              environment,
              selection: { kind: 'explicit', path: configPath, required: true },
            },
            env: {
              OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true',
              OPENBUFF_PROVIDER_CONFIG: configPath,
              OPENBUFF_DIAGNOSTIC_DELTA_MODE: mode === 'default' ? 'strict' : 'tolerant',
            },
            onFilesystemMutation:
              name === 'foreign-bytes' || name === 'failed-foreign-baseline'
                ? () => {
                    writeFileSync(
                      path.join(workspace, 'src/lib.rs'),
                      'foreign bytes\n',
                    )
                  }
                : undefined,
          },
        })
        expect(jsonValue(outputs[0])).toMatchObject({
          kind: 'file_mutation_result',
          outcome: 'applied',
        })
        const rows = jsonValue(outputs[1]) as Array<Record<string, unknown>>
        const diagnostic = rows.find(
          (row) => row.hookName === 'diagnostic-delta',
        )!
        console.log(
          JSON.stringify({
            b36: 'client-multi-call-observed',
            name,
            launches,
            diagnostic,
          }),
        )
        expect(diagnostic.diagnosticStatus).toBe(status)
        expect(diagnostic.observations).toMatchObject({ basis })
        if (
          name === 'mismatched-files' ||
          name === 'foreign-bytes' ||
          name === 'failed-foreign-baseline'
        ) {
          expect(diagnostic.observations).toMatchObject({
            before: {
              coverage: {
                status: 'unknown',
                reasons: expect.arrayContaining([
                  'baseline_postimage_or_scope_unverified',
                ]),
              },
            },
            after: { diagnostics: [], coverage: { status: 'complete' } },
          })
        }
        if (name === 'failed-foreign-baseline') {
          expect(diagnostic.observations).toMatchObject({
            before: {
              commands: [
                expect.objectContaining({
                  exitCode: 127,
                  status: 'unavailable',
                }),
              ],
            },
          })
        }
        expect(launches).toBe(2)
        expect(Number(readFileSync(counter, 'utf8'))).toBe(2)
        console.log(
          JSON.stringify({
            b36: 'client-multi-call',
            name,
            launches,
            diagnostic,
          }),
        )
      } finally {
        rmSync(workspace, { recursive: true, force: true })
        rmSync(configPath, { force: true })
      }
    },
    15_000,
  )

  it('preserves real command coverage through hooks, SDK wire output and client classification', async () => {
    const artifact = path.join(harnessStateDir, 'b36-diagnostic-outcomes.json')
    const fixture = path.resolve(
      import.meta.dir,
      '../../../scripts/body-fixtures/diagnostic-outcomes.ts',
    )
    const child = Bun.spawn([process.execPath, fixture, artifact], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exit !== 0)
      throw new Error(`Diagnostic fixture exited ${exit}: ${stdout}\n${stderr}`)
    const evidence = JSON.parse(readFileSync(artifact, 'utf8'))
    expect(evidence.records).toHaveLength(12)
    for (const record of evidence.records) {
      const row = record.sdkOutput[0].value.find(
        (entry: Record<string, unknown>) =>
          entry.hookName === 'diagnostic-delta',
      )
      expect(row.diagnosticStatus).toBe(record.expectedStatus)
      expect(row.observations).toBeDefined()
      if (record.expectedStatus === 'passed')
        expect(record.clientClassification).toBe('passed')
      else expect(record.clientClassification).not.toBe('passed')
    }
  }, 20_000)
})

describe('registered SDK callback admission controls', () => {
  afterEach(() => { mock.restore() })

  it('refuses changed forwarded input before invoking the registered tool override', async () => {
    let calls = 0
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(async params => {
      const callback = await beginSdkCallback(params)
      const prepared = await callback.prepare({ toolName: 'git_status', input: {} })
      await expect(params.requestToolCall({
        ...prepared,
        input: { include_diff: true },
      })).rejects.toThrow('registered B02 action and exact forwarded input')
      expect(calls).toBe(0)
      return { sessionState: callback.sessionState, output: { type: 'lastMessage' as const, value: [] } }
    })
    const result = await new OpenbuffClient({
      ...callbackFixture.options,
      overrideTools: { git_status: async () => { calls++; return [{ type: 'json', value: { status: '' } }] } },
    }).run({ agent: 'base2', prompt: 'exact request binding' })
    expect(result.output.type).toBe('lastMessage')
    expect(calls).toBe(0)
  })

  it('child-only diagnostic flags do not enable captured host diagnostics', async () => {
    let cargoDispatches = 0
    const spawn: CodebuffSpawn = (command, argv, options) => {
      if (command === 'cargo') cargoDispatches++
      return nodeSpawn(command, [...argv ?? []], options ?? {})
    }
    const outputs = await dispatchToolCalls({
      calls: [{ toolName: 'run_file_change_hooks', input: { files: ['src/lib.rs'] } }],
      clientOptions: {
        cwd: callbackFixture.cwd,
        spawnSource: spawn,
        env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
      },
    })
    expect(cargoDispatches).toBe(0)
    expect(JSON.stringify(outputs)).not.toContain('diagnostic-delta')
  })
})

describe('[B03] SDK confirmed mutation dispatch', () => {
  afterEach(() => {
    mock.restore()
  })

  it('retains a refused receipt after later recovery without publishing the refused edit', async () => {
    const fs = createMockFs({ files: { [callbackFixture.file('a.txt')]: 'before\n' } })
    const commit = fs.conditionalCommit!.bind(fs)
    let attempts = 0
    fs.conditionalCommit = async (filePath, data, options) => {
      attempts++
      if (attempts === 1) {
        await fs.writeFile(callbackFixture.file('a.txt'), 'foreign\r\n')
        return {
          applied: false,
          actualHash: getExactContentHash('foreign\r\n'),
        }
      }
      return commit(filePath, data, options)
    }
    const events: FilesystemMutationEvent[] = []
    const canonicalReceipts: Array<CommitReceiptV1 | undefined> = []
    const outputs = await dispatchToolCalls({
      calls: [
        {
          toolName: 'edit_transaction',
          input: [
            {
              type: 'file',
              path: 'a.txt',
              content: 'after\n',
              expectedHash: getContentHash('before\n'),
            },
          ],
        },
        {
          toolName: 'edit_transaction',
          input: [
            {
              type: 'file',
              path: 'a.txt',
              content: 'recovered\n',
              expectedHash: getContentHash('foreign\r\n'),
            },
          ],
        },
      ],
      canonicalReceipts,
      clientOptions: {
        cwd: callbackFixture.cwd,
        fsSource: fs,
        onFilesystemMutation: (event) => {
          events.push(event)
        },
      },
    })
    const refused = fileMutationResultV1Schema.parse(jsonValue(outputs[0]))
    const recovered = fileMutationResultV1Schema.parse(jsonValue(outputs[1]))
    expect(refused.outcome).toBe('not_applied')
    expect(refused.actions[0]?.forward?.outcome).toBe('not_applied')
    expect(getConfirmedAppliedActionsV1(refused)).toEqual([])
    expect(canonicalReceipts[0]).toMatchObject({
      status: 'failed',
      finalHashes: { 'a.txt': getExactContentHash('foreign\r\n') },
    })
    expect(canonicalReceipts[0]?.receiptId).toBe(refused.receiptId)
    expect(recovered.outcome).toBe('applied')
    expect(getConfirmedAppliedActionsV1(recovered)).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(events[0]?.operationId).toBe(recovered.operationId)
    expect(events[0]?.actions[0]?.afterHash).toBe(
      getExactContentHash('recovered\n'),
    )
    expect(attempts).toBe(2)
    expect(await fs.readFile(callbackFixture.file('a.txt'), 'utf8')).toBe('recovered\n')
    expect(JSON.parse(JSON.stringify(refused)).authorityReceipt.status).toBe(
      'failed',
    )
  })

  it('publishes only the confirmed surviving forward change when another action throws', async () => {
    const fs = createMockFs({
      files: { [callbackFixture.file('a.txt')]: 'a-before\n', [callbackFixture.file('b.txt')]: 'b-before\n' },
    })
    const commit = fs.conditionalCommit!.bind(fs)
    fs.conditionalCommit = async (filePath, data, options) => {
      if (String(filePath) === callbackFixture.file('b.txt')) {
        await fs.writeFile(callbackFixture.file('b.txt'), 'partial\n')
        throw new Error('partial write failure')
      }
      if (String(data) === 'a-before\n')
        return { applied: false, actualHash: getExactContentHash('a-after\n') }
      return commit(filePath, data, options)
    }
    const events: FilesystemMutationEvent[] = []
    const canonicalReceipts: Array<CommitReceiptV1 | undefined> = []
    const outputs = await dispatchToolCalls({
      calls: [
        {
          toolName: 'edit_transaction',
          input: [
            { type: 'file', path: 'a.txt', content: 'a-after\n' },
            { type: 'file', path: 'b.txt', content: 'b-after\n' },
          ],
        },
      ],
      canonicalReceipts,
      clientOptions: {
        cwd: callbackFixture.cwd,
        fsSource: fs,
        onFilesystemMutation: (event) => {
          events.push(event)
        },
      },
    })
    const mutation = fileMutationResultV1Schema.parse(jsonValue(outputs[0]))
    expect(mutation.outcome).toBe('rollback_incomplete')
    expect(mutation.actions.map((action) => action.outcome)).toEqual([
      'applied',
      'rollback_incomplete',
    ])
    expect(mutation.actions[1]?.forward).toEqual({
      outcome: 'unconfirmed',
      afterHashes: { 'b.txt': getExactContentHash('partial\n') },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.actions.map((action) => action.path)).toEqual(['a.txt'])
    expect(events[0]?.actions[0]?.afterHash).toBe(
      getExactContentHash('a-after\n'),
    )
    expect(canonicalReceipts[0]?.actions[1]?.forward?.outcome).toBe(
      'unconfirmed',
    )
    expect(await fs.readFile(callbackFixture.file('a.txt'), 'utf8')).toBe('a-after\n')
    expect(await fs.readFile(callbackFixture.file('b.txt'), 'utf8')).toBe('partial\n')
  })
})

describe('write_audit_findings dispatch advances workspace state', () => {
  afterEach(() => {
    mock.restore()
  })

  it('notifies onFilesystemMutation for the findings artifact write', async () => {
    const fs: CodebuffFileSystem = createMockFs()
    const events: FilesystemMutationEvent[] = []
    const canonicalReceipts: Array<CommitReceiptV1 | undefined> = []

    const outputs = await dispatchToolCalls({
      calls: [
        { toolName: 'write_audit_findings', input: snapshotBoundAuditInput },
      ],
      canonicalReceipts,
      clientOptions: {
        cwd: callbackFixture.cwd,
        fsSource: fs,
        onFilesystemMutation: (event) => {
          events.push(event)
        },
      },
    })

    // The tool still publishes its own compact receipt, not the mutation
    // payload — including the structural attestation for a snapshot-bound call,
    // which only the real dispatch path can produce end to end.
    expect(jsonValue(outputs[0])).toMatchObject({
      artifactPath: auditArtifactPath,
      artifacts: [auditArtifactPath],
      findingCount: 0,
      structuralReceipt: {
        schema_version: 1,
        snapshot_id: 'snapshot-dispatch-1',
        shard_id: 'runtime-1',
        subsystem_ids: ['sdk'],
        files: ['sdk/src/run.ts'],
        domains: ['security'],
      },
    })
    // ...and the underlying mutation is still surfaced to the host, so index
    // invalidation sees the new artifact.
    expect(events).toHaveLength(1)
    const event = events[0]
    if (!event) throw new Error('expected a filesystem mutation event')
    expect(event).toMatchObject({
      toolName: 'write_audit_findings',
      actions: [
        expect.objectContaining({
          action: 'create',
          path: auditArtifactPath,
        }),
      ],
    })
    expect(event.workspaceRevision).toBeGreaterThan(0)
    expect(event.workspaceSnapshotId).toContain('workspace.v1.')
    // The returned mutation also feeds the canonical-receipt fallback, so
    // the compact tool output is still correlated to a committed receipt for
    // the same operation the event reports.
    const receipt = canonicalReceipts[0]
    if (!receipt) throw new Error('expected a canonical commit receipt')
    expect(receipt).toMatchObject({
      kind: 'commit_receipt',
      status: 'committed',
      operationId: event.operationId,
      actions: [
        expect.objectContaining({
          action: 'create',
          path: auditArtifactPath,
          status: 'committed',
        }),
      ],
    })
    expect(await fs.readFile(callbackFixture.file(auditArtifactPath), 'utf8')).toContain(
      '# Audit findings: runtime-1',
    )
  })

  it('falls back to onFilesChanged when no mutation observer is registered', async () => {
    const fs: CodebuffFileSystem = createMockFs()
    let fileChangeCalls = 0

    await dispatchToolCalls({
      calls: [{ toolName: 'write_audit_findings', input: auditInput }],
      clientOptions: {
        cwd: callbackFixture.cwd,
        fsSource: fs,
        onFilesChanged: () => {
          fileChangeCalls++
        },
      },
    })

    expect(fileChangeCalls).toBe(1)
    // Pins the notification to this artifact write: the counter alone would
    // also pass for an unrelated change notification.
    expect(await fs.readFile(callbackFixture.file(auditArtifactPath), 'utf8')).toContain(
      '# Audit findings: runtime-1',
    )
  })

  it('does not notify observers when the artifact write is rejected', async () => {
    // The artifact already exists, so the exclusive create is not applied.
    const fs: CodebuffFileSystem = createMockFs({
      files: { [callbackFixture.file(auditArtifactPath)]: 'existing\n' },
    })
    const events: FilesystemMutationEvent[] = []
    const canonicalReceipts: Array<CommitReceiptV1 | undefined> = []
    let fileChangeCalls = 0

    const outputs = await dispatchToolCalls({
      calls: [{ toolName: 'write_audit_findings', input: auditInput }],
      canonicalReceipts,
      clientOptions: {
        cwd: callbackFixture.cwd,
        fsSource: fs,
        onFilesystemMutation: (event) => {
          events.push(event)
        },
        onFilesChanged: () => {
          fileChangeCalls++
        },
      },
    })

    expect(jsonValue(outputs[0])).toMatchObject({
      artifactPath: auditArtifactPath,
      errorMessage: expect.stringContaining('already exists'),
    })
    expect(events).toHaveLength(0)
    expect(fileChangeCalls).toBe(0)
    // The mutation is returned for `not_applied` results too, so the rejected
    // write still reaches run.ts's canonical-receipt fallback; it must not
    // publish a committed-looking receipt for an edit that never landed.
    expect(canonicalReceipts).toHaveLength(1)
    expect(canonicalReceipts[0]).toBeUndefined()
    expect(await fs.readFile(callbackFixture.file(auditArtifactPath), 'utf8')).toBe(
      'existing\n',
    )
  })
})

describe('replace_range dispatch wiring', () => {
  afterEach(() => {
    mock.restore()
  })

  it('rejects the call when the run has no cwd (and therefore no issuer)', async () => {
    // The direct dispatcher retains its missing-authority guard. Public SDK
    // startup captures a root even when the caller omits cwd (tested below).
    const handled = await handleToolCall({
      action: {
        type: 'tool-call-request',
        requestId: 'missing-cwd',
        userInputId: 'input-1',
        toolName: 'replace_range',
        input: {
          path: 'src/file.ts',
          readCapability: encodeReadCapabilityToken({
            startLine: 1,
            endLine: 1,
            hash: getContentHash('line 1'),
            scope: {
              projectId: callbackFixture.cwd,
              path: 'src/file.ts',
              runId: 'some-run',
            },
          }),
          newContent: 'updated line 1',
        },
      },
      overrides: {},
      customToolDefinitions: {},
      fs: createMockFs(),
      trustedJobOwner: {
        clientSessionId: 'session-1', rootRunId: 'run-1',
        parentRunId: 'run-1', parentAgentId: 'agent-1',
      },
      approvalReceiptIds: [],
      approvalMode: 'balanced',
      getWorkspaceState: () => undefined,
      setWorkspaceState: () => {},
    })
    const outputs = [handled.output]
    expect(jsonValue(outputs[0])).toMatchObject({
      errorMessage: expect.stringContaining(
        'is required for the replace_range tool',
      ),
    })
  })

  it('the public SDK captures its host root when cwd is omitted and refuses a foreign capability', async () => {
    const original = 'line 1\nline 2\n'
    const fs = createMockFs({ files: { [callbackFixture.file('src/file.ts')]: original } })
    let output: ToolResultOutput[] | undefined
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(async params => {
      const callback = await beginSdkCallback(params)
      expect(callback.sessionState.fileContext.projectRoot).toBe(callbackFixture.cwd)
      output = (await callback.request({
        toolName: 'replace_range',
        input: {
          path: 'src/file.ts',
          readCapability: encodeReadCapabilityToken({
            startLine: 1, endLine: 1, hash: getContentHash('line 1'),
            scope: { projectId: callbackFixture.cwd, path: 'src/file.ts', runId: 'foreign-run' },
          }),
          newContent: 'updated line 1',
        },
      })).output
      return { sessionState: callback.sessionState, output: { type: 'lastMessage' as const, value: [] } }
    })
    const { cwd: _cwd, ...options } = sdkCallbackOptions(callbackFixture.cwd, {
      fsSource: fs, harnessStateDir: callbackFixture.harnessStateDir,
    })
    const result = await new OpenbuffClient(options).run({ agent: 'base2', prompt: 'implicit root' })
    expect(result.output.type).toBe('lastMessage')
    expect(jsonValue(output)).toMatchObject({
      file: 'src/file.ts',
      errorMessage: expect.stringContaining('different project, path, or agent run'),
    })
    expect(await fs.readFile(callbackFixture.file('src/file.ts'), 'utf8')).toBe(original)
  })

  it('forwards the run-scoped capability issuer to the applicator', async () => {
    const original = 'line 1\nline 2\n'
    const fs: CodebuffFileSystem = createMockFs({
      files: { [callbackFixture.file('src/file.ts')]: original },
    })

    const outputs = await dispatchToolCalls({
      calls: [
        {
          toolName: 'replace_range',
          input: {
            path: 'src/file.ts',
            readCapability: encodeReadCapabilityToken({
              startLine: 1,
              endLine: 1,
              hash: getContentHash('line 1'),
              scope: {
                projectId: callbackFixture.cwd,
                path: 'src/file.ts',
                // Not this run's id, so the scope check must reject it.
                runId: 'foreign-run',
              },
            }),
            newContent: 'updated line 1',
          },
        },
      ],
      clientOptions: { cwd: callbackFixture.cwd, fsSource: fs },
    })

    // Reaching the scope check proves the dispatch passed both cwd and the
    // run-scoped issuer through: a missing issuer would have failed earlier
    // with the `requireCapabilityIssuer` error instead.
    expect(jsonValue(outputs[0])).toMatchObject({
      file: 'src/file.ts',
      errorMessage: expect.stringContaining(
        'different project, path, or agent run',
      ),
    })
    expect(await fs.readFile(callbackFixture.file('src/file.ts'), 'utf8')).toBe(original)
  })

  it('applies a range edit when the capability scope matches the run and notifies observers', async () => {
    const original = 'line 1\nline 2\nline 3\n'
    const fs: CodebuffFileSystem = createMockFs({
      files: { [callbackFixture.file('src/file.ts')]: original },
    })
    const events: FilesystemMutationEvent[] = []
    let workspaceState: WorkspaceStateV1 | undefined
    const capabilityIssuer = { projectId: callbackFixture.cwd, runId: 'run-1' }
    const document = captureTextDocument(
      await fs.readFile(callbackFixture.file('src/file.ts'), 'utf8'),
    )
    const readCapability = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash('line 1'),
      rawBasis: getRawReadBasis(document, 1, 1, 'lines'),
      scope: { projectId: callbackFixture.cwd, path: 'src/file.ts', runId: 'run-1' },
    })
    const handled = await handleToolCall({
      action: {
        type: 'tool-call-request',
        requestId: 'call-replace-range-applied',
        userInputId: 'input-1',
        toolName: 'replace_range',
        input: {
          path: 'src/file.ts',
          readCapability,
          newContent: 'updated line 1',
        },
      },
      overrides: {},
      customToolDefinitions: {},
      cwd: callbackFixture.cwd,
      fs,
      trustedJobOwner: {
        clientSessionId: 'session-1',
        rootRunId: 'run-1',
        parentRunId: 'run-1',
        parentAgentId: 'agent-1',
      },
      capabilityIssuer,
      harnessStateDir,
      approvalReceiptIds: [],
      approvalMode: 'balanced',
      approvalService: new HarnessApprovalService(
        new LocalHarnessStore(harnessStateDir),
      ),
      getWorkspaceState: () => workspaceState,
      setWorkspaceState: (state) => {
        workspaceState = state
      },
      onFilesystemMutation: (event) => {
        events.push(event)
      },
    })
    expect(handled.output[0]).toMatchObject({
      type: 'json',
      value: { kind: 'file_mutation_result', outcome: 'applied' },
    })
    expect(await fs.readFile(callbackFixture.file('src/file.ts'), 'utf8')).toBe(
      'updated line 1\nline 2\nline 3\n',
    )
    if (!workspaceState) throw new Error('expected workspace state to be set')
    expect(workspaceState.revision).toBe(1)
    expect(workspaceState.snapshotId).toContain('workspace.v1.')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolName: 'replace_range',
      callId: 'call-replace-range-applied',
      workspaceRevision: workspaceState.revision,
      workspaceSnapshotId: workspaceState.snapshotId,
      actions: [
        expect.objectContaining({ action: 'update', path: 'src/file.ts' }),
      ],
    })
  })
})

/**
 * Drives the exported dispatcher directly (no agent loop, no client), so the
 * returned-mutation wiring for compact-receipt tools can be asserted on
 * exactly the state it advances: the caller-owned workspace state, the emitted
 * event, and the tool output handed back to the agent.
 */
async function dispatchAuditWriteDirectly(params: {
  fs: CodebuffFileSystem
  input: unknown
  requestId: string
  workspaceState?: WorkspaceStateV1
  onFilesystemMutation?: (event: FilesystemMutationEvent) => void
  onFilesChanged?: () => void
}): Promise<{
  output: ToolResultOutput[]
  workspaceState: WorkspaceStateV1 | undefined
}> {
  let workspaceState = params.workspaceState
  const handled = await handleToolCall({
    action: {
      type: 'tool-call-request',
      requestId: params.requestId,
      userInputId: 'input-1',
      toolName: 'write_audit_findings',
      input: params.input,
    },
    overrides: {},
    customToolDefinitions: {},
    cwd: callbackFixture.cwd,
    fs: params.fs,
    trustedJobOwner: {
      clientSessionId: 'session-1',
      rootRunId: 'run-1',
      parentRunId: 'run-1',
      parentAgentId: 'agent-1',
    },
    harnessStateDir,
    approvalReceiptIds: [],
    approvalMode: 'balanced',
    approvalService: new HarnessApprovalService(
      new LocalHarnessStore(harnessStateDir),
    ),
    getWorkspaceState: () => workspaceState,
    setWorkspaceState: (state) => {
      workspaceState = state
    },
    onFilesystemMutation: params.onFilesystemMutation,
    onFilesChanged: params.onFilesChanged,
  })
  return { output: handled.output, workspaceState }
}

describe('handleToolCall compact-receipt mutation wiring', () => {
  it('advances workspace state and emits the artifact actions for an applied write', async () => {
    const fs: CodebuffFileSystem = createMockFs()
    const events: FilesystemMutationEvent[] = []

    const { output, workspaceState } = await dispatchAuditWriteDirectly({
      fs,
      input: snapshotBoundAuditInput,
      requestId: 'call-applied',
      onFilesystemMutation: (event) => {
        events.push(event)
      },
    })

    if (!workspaceState) throw new Error('expected advanced workspace state')
    expect(workspaceState.revision).toBe(1)
    expect(workspaceState.snapshotId).toStartWith('workspace.v1.1.')
    expect(events).toHaveLength(1)
    const event = events[0]
    if (!event) throw new Error('expected a filesystem mutation event')
    expect(event).toMatchObject({
      toolName: 'write_audit_findings',
      callId: 'call-applied',
      workspaceRevision: workspaceState.revision,
      workspaceSnapshotId: workspaceState.snapshotId,
    })
    // Asserted as the whole action list, so the hoisted action shaping is
    // pinned: the journal record and this event are built from one array, and
    // the hashes must describe the artifact that was actually created.
    // Receipt hashes are byte-exact, so the expectation uses the byte-exact
    // digest rather than the LF-normalized read/edit hash.
    const written = await fs.readFile(callbackFixture.file(auditArtifactPath), 'utf8')
    expect(event.actions).toEqual([
      {
        action: 'create',
        path: auditArtifactPath,
        beforeHash: null,
        afterHash: getExactContentHash(written),
      },
    ])
    // The journal record must describe the same revision the event reports.
    expect(workspaceState.changes.at(-1)).toMatchObject({
      revision: workspaceState.revision,
      source: 'sdk:write_audit_findings',
      actions: event.actions,
    })

    // (b) The agent still receives the tool's compact declared receipt: its
    // output schema declares no workspace fields, so enriching it here would
    // publish coordinates a schema-parsing consumer silently strips.
    const receipt = jsonValue(output)
    expect(receipt).toMatchObject({ artifactPath: auditArtifactPath })
    expect(receipt).not.toHaveProperty('workspaceRevision')
    expect(receipt).not.toHaveProperty('workspaceSnapshotId')
  })

  it('advances nothing and notifies nobody for a not_applied write', async () => {
    // The artifact already exists, so the exclusive create is refused and the
    // returned mutation carries a `not_applied` receipt: it is returned for
    // every well-formed mutation, applied or not.
    const fs: CodebuffFileSystem = createMockFs({
      files: { [callbackFixture.file(auditArtifactPath)]: 'existing\n' },
    })
    const events: FilesystemMutationEvent[] = []
    let fileChangeCalls = 0
    const priorState: WorkspaceStateV1 = {
      schemaVersion: 1,
      revision: 7,
      snapshotId: 'workspace.v1.7.deadbeef',
      updatedAt: 1,
      changes: [],
    }

    const { output, workspaceState } = await dispatchAuditWriteDirectly({
      fs,
      input: auditInput,
      requestId: 'call-not-applied',
      workspaceState: priorState,
      onFilesystemMutation: (event) => {
        events.push(event)
      },
      onFilesChanged: () => {
        fileChangeCalls++
      },
    })

    expect(jsonValue(output)).toMatchObject({
      artifactPath: auditArtifactPath,
      errorMessage: expect.stringContaining('already exists'),
    })
    expect(workspaceState).toBe(priorState)
    expect(events).toHaveLength(0)
    expect(fileChangeCalls).toBe(0)
    expect(await fs.readFile(callbackFixture.file(auditArtifactPath), 'utf8')).toBe(
      'existing\n',
    )
  })
})

describe('client-origin MCP tool approval gate (P1-T2)', () => {
  afterEach(() => {
    mock.restore()
  })

  const peers = new Map<MCPConfig, ReturnType<typeof createSdkCallbackMcpFixture>>()
  afterEach(async () => {
    await Promise.all([...peers.values()].map(peer => peer.close()))
    peers.clear()
  })
  function createPeer(
    origin: 'client' | 'project',
    options: { approvalMode?: OpenbuffClientOptions['approvalMode'] } = { approvalMode: 'allow-all' },
  ) {
    const peer = createSdkCallbackMcpFixture(callbackFixture.cwd, origin, options)
    peers.set(peer.config, peer)
    return peer
  }

  /** Tool approval is tested separately from the real owned peer's host policy. */
  async function dispatchMcpToolCall(params: {
    mcpConfig: MCPConfig
    toolName: string
    requestApproval?: (request: HarnessApprovalRequest) => Promise<boolean>
    approvedClientMcpTools?: Set<string>
    omitResolver?: boolean
  }): Promise<{ output: ToolResultOutput[]; callMcpToolCalls: number }> {
    const peer = peers.get(params.mcpConfig)
    if (!peer) throw new Error('Expected an owned MCP fixture config')
    const before = peer.calls()
    const handled = await handleToolCall({
      action: {
        type: 'tool-call-request',
        requestId: 'call-mcp-1',
        userInputId: 'input-1',
        toolName: params.toolName,
        input: { arg: 1 },
        mcpConfig: params.mcpConfig,
      },
      overrides: {},
      customToolDefinitions: {},
      cwd: callbackFixture.cwd,
      fs: createMockFs(),
      trustedJobOwner: {
        clientSessionId: 'session-1',
        rootRunId: 'run-1',
        parentRunId: 'run-1',
        parentAgentId: 'agent-1',
      },
      harnessStateDir,
      approvalReceiptIds: [],
      approvalMode: 'balanced',
      requestApproval: params.requestApproval,
      approvedClientMcpTools: params.approvedClientMcpTools,
      approvalService: new HarnessApprovalService(new LocalHarnessStore(harnessStateDir)),
      getWorkspaceState: () => undefined,
      setWorkspaceState: () => {},
      resolveMcpRequest: params.omitResolver ? undefined : peer.resolve,
    })
    return { output: handled.output, callMcpToolCalls: peer.calls() - before }
  }

  function clientConfig(): MCPConfig {
    return createPeer('client').config
  }

  it('(a) prompts and runs the tool on the first client-origin call, recording the key', async () => {
    const requests: HarnessApprovalRequest[] = []
    const approvedClientMcpTools = new Set<string>()
    const { output, callMcpToolCalls } = await dispatchMcpToolCall({
      mcpConfig: clientConfig(),
      toolName: 'search',
      approvedClientMcpTools,
      requestApproval: async (request) => {
        requests.push(request)
        return true
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      action: 'mcp-tool',
      risk: 'high',
    })
    expect(requests[0]?.target).toContain('search')
    expect(requests[0]?.reason).toContain('search')
    expect(callMcpToolCalls).toBe(1)
    expect(jsonValue([output[0]])).toMatchObject({ kind: 'mcp_tool_result' })
    expect(
      (jsonValue([output[0]]) as { structuredContent: unknown }).structuredContent,
    ).toEqual({ ok: true })
    // The approved key is recorded so subsequent same-tool calls run freely.
    expect(approvedClientMcpTools.size).toBe(1)
  })

  it('(b) does not re-prompt on the second call of the same tool this run', async () => {
    const approvedClientMcpTools = new Set<string>()
    const config = clientConfig()
    let prompts = 0
    const requestApproval = async () => {
      prompts++
      return true
    }

    const first = await dispatchMcpToolCall({
      mcpConfig: config,
      toolName: 'search',
      approvedClientMcpTools,
      requestApproval,
    })
    const second = await dispatchMcpToolCall({
      mcpConfig: config,
      toolName: 'search',
      approvedClientMcpTools,
      requestApproval,
    })

    expect(prompts).toBe(1)
    expect(first.callMcpToolCalls).toBe(1)
    expect(second.callMcpToolCalls).toBe(1)
  })

  it('(c) returns an error output and never calls the tool when denied', async () => {
    const approvedClientMcpTools = new Set<string>()
    const { output, callMcpToolCalls } = await dispatchMcpToolCall({
      mcpConfig: clientConfig(),
      toolName: 'search',
      approvedClientMcpTools,
      requestApproval: async () => false,
    })

    expect(callMcpToolCalls).toBe(0)
    expect(jsonValue([output[0]])).toMatchObject({
      errorMessage: "Client MCP tool 'search' was denied approval.",
    })
    // Nothing recorded, so a later approved retry can still gate.
    expect(approvedClientMcpTools.size).toBe(0)
  })

  it('(d) fails open and runs when no approver is present', async () => {
    const approvedClientMcpTools = new Set<string>()
    const { callMcpToolCalls } = await dispatchMcpToolCall({
      mcpConfig: clientConfig(),
      toolName: 'search',
      approvedClientMcpTools,
      requestApproval: undefined,
    })

    expect(callMcpToolCalls).toBe(1)
    // Fail-open still records the key so subsequent calls run freely.
    expect(approvedClientMcpTools.size).toBe(1)
  })

  it('(e) never prompts for a trusted (project) origin config', async () => {
    const trustedConfig = createPeer('project').config
    let prompts = 0
    const approvedClientMcpTools = new Set<string>()
    const { callMcpToolCalls } = await dispatchMcpToolCall({
      mcpConfig: trustedConfig,
      toolName: 'search',
      approvedClientMcpTools,
      requestApproval: async () => {
        prompts++
        return true
      },
    })

    expect(prompts).toBe(0)
    expect(callMcpToolCalls).toBe(1)
    expect(approvedClientMcpTools.size).toBe(0)
  })

  it('default balanced process policy refuses the owned peer after tool approval', async () => {
    const peer = createPeer('client', {})
    const { output, callMcpToolCalls } = await dispatchMcpToolCall({
      mcpConfig: peer.config,
      toolName: 'search',
      requestApproval: async () => true,
    })
    expect(callMcpToolCalls).toBe(0)
    expect(peer.dispatches()).toBe(0)
    expect(jsonValue(output)).toMatchObject({
      executionRefusal: { ok: false, reason: 'unavailable' },
      errorMessage: expect.stringMatching(/approval/i),
    })
    const events = peer.events.filter(event => 'facts' in event && event.facts.family === 'mcp-stdio')
    expect(events.some(event => event.phase === 'no-launch')).toBe(true)
    expect(events.some(event => event.phase === 'dispatched' || event.phase === 'spawn-observed')).toBe(false)
  })

  it('missing MCP resolver refuses without dispatching an owned peer', async () => {
    const peer = createPeer('project')
    const { output, callMcpToolCalls } = await dispatchMcpToolCall({
      mcpConfig: peer.config,
      toolName: 'search',
      omitResolver: true,
    })
    expect(callMcpToolCalls).toBe(0)
    expect(peer.dispatches()).toBe(0)
    expect(jsonValue(output)).toMatchObject({
      errorMessage: 'Captured MCP execution context is unavailable',
      executionRefusal: { ok: false, reason: 'unavailable' },
    })
  })
})
