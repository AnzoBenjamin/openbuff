import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import * as mcpClientModule from '@codebuff/common/mcp/client'
import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { OpenbuffClient } from '../client'
import { createNodeFileSystem } from '../tools/node-filesystem'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ChildProcess } from 'node:child_process'
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
      const { requestToolCall, sendAction, promptId } = promptParams
      const sessionState = getInitialSessionState(getStubProjectFileContext())
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
    apiKey: 'test-key',
    handleEvent: () => {},
    // Skip live project discovery; the mock filesystem only holds the files
    // these dispatch cases touch.
    projectFiles: {},
    harnessStateDir,
    ...params.clientOptions,
  })
  await client.run({ agent: 'base2', prompt: 'dispatch' })
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
    ['new-error', 'new_errors', 'before_after'],
    ['shifted-error', 'passed', 'before_after'],
    ['failed-baseline', 'unavailable', 'before_after'],
    ['mismatched-files', 'unknown', 'before_after'],
    ['foreign-bytes', 'unknown', 'before_after'],
    ['failed-foreign-baseline', 'unknown', 'before_after'],
  ] as const)(
    'retains the correct baseline across actual client calls: %s',
    async (name, status, basis) => {
      const workspace = mkdtempSync(path.join(harnessStateDir, 'b36-client-'))
      const configPath = path.join(harnessStateDir, `b36-${name}.json`)
      writeFileSync(
        configPath,
        JSON.stringify({
          autoFileChangeHooks: false,
          fileChangeHooks: [{ name: 'fixture-control', command: 'true' }],
        }),
      )
      const previousConfig = process.env.OPENBUFF_PROVIDER_CONFIG
      process.env.OPENBUFF_PROVIDER_CONFIG = configPath
      let launches = 0
      const spawn = ((_file: string) => {
        if (_file !== 'cargo') {
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
          }) as unknown as ChildProcess
          process.nextTick(() => child.emit('close', 0))
          return child
        }
        launches++
        const invocation = launches
        const stdout = new EventEmitter()
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr: new EventEmitter(),
        }) as unknown as ChildProcess
        process.nextTick(() => {
          if (
            name === 'failed-baseline' ||
            name === 'failed-foreign-baseline'
          ) {
            child.emit('close', invocation === 1 ? 127 : 0)
            return
          }
          const hasError =
            name === 'shifted-error' || (name === 'new-error' && invocation > 1)
          if (hasError)
            stdout.emit(
              'data',
              JSON.stringify({
                reason: 'compiler-message',
                message: {
                  level: 'error',
                  message: 'synthetic fixture error',
                  code: { code: 'E0308' },
                  spans: [
                    {
                      is_primary: true,
                      file_name: 'src/lib.rs',
                      line_start: invocation === 1 ? 1 : 5,
                      column_start: 1,
                      line_end: invocation === 1 ? 1 : 5,
                      column_end: 2,
                    },
                  ],
                  children: [],
                },
              }) + '\n',
            )
          child.emit('close', hasError ? 101 : 0)
        })
        return child
      }) as CodebuffSpawn
      try {
        const outputs = await dispatchToolCalls({
          calls: [
            {
              toolName: 'write_file',
              input: {
                type: 'file',
                path: 'src/lib.rs',
                instructions: 'Create the fixture source',
                content: 'fn fixture() {}\n',
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
            fsSource: createNodeFileSystem(),
            spawnSource: spawn,
            env: {
              OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true',
              OPENBUFF_PROVIDER_CONFIG: configPath,
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
        console.log(
          JSON.stringify({
            b36: 'client-multi-call',
            name,
            launches,
            diagnostic,
          }),
        )
      } finally {
        if (previousConfig === undefined)
          delete process.env.OPENBUFF_PROVIDER_CONFIG
        else process.env.OPENBUFF_PROVIDER_CONFIG = previousConfig
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

describe('[B03] SDK confirmed mutation dispatch', () => {
  afterEach(() => {
    mock.restore()
  })

  it('retains a refused receipt after later recovery without publishing the refused edit', async () => {
    const fs = createMockFs({ files: { '/repo/a.txt': 'before\n' } })
    const commit = fs.conditionalCommit!.bind(fs)
    let attempts = 0
    fs.conditionalCommit = async (filePath, data, options) => {
      attempts++
      if (attempts === 1) {
        await fs.writeFile('/repo/a.txt', 'foreign\r\n')
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
        cwd: '/repo',
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
    expect(await fs.readFile('/repo/a.txt', 'utf8')).toBe('recovered\n')
    expect(JSON.parse(JSON.stringify(refused)).authorityReceipt.status).toBe(
      'failed',
    )
  })

  it('publishes only the confirmed surviving forward change when another action throws', async () => {
    const fs = createMockFs({
      files: { '/repo/a.txt': 'a-before\n', '/repo/b.txt': 'b-before\n' },
    })
    const commit = fs.conditionalCommit!.bind(fs)
    fs.conditionalCommit = async (filePath, data, options) => {
      if (String(filePath) === '/repo/b.txt') {
        await fs.writeFile('/repo/b.txt', 'partial\n')
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
        cwd: '/repo',
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
    expect(await fs.readFile('/repo/a.txt', 'utf8')).toBe('a-after\n')
    expect(await fs.readFile('/repo/b.txt', 'utf8')).toBe('partial\n')
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
        cwd: '/repo',
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
    expect(await fs.readFile(`/repo/${auditArtifactPath}`, 'utf8')).toContain(
      '# Audit findings: runtime-1',
    )
  })

  it('falls back to onFilesChanged when no mutation observer is registered', async () => {
    const fs: CodebuffFileSystem = createMockFs()
    let fileChangeCalls = 0

    await dispatchToolCalls({
      calls: [{ toolName: 'write_audit_findings', input: auditInput }],
      clientOptions: {
        cwd: '/repo',
        fsSource: fs,
        onFilesChanged: () => {
          fileChangeCalls++
        },
      },
    })

    expect(fileChangeCalls).toBe(1)
    // Pins the notification to this artifact write: the counter alone would
    // also pass for an unrelated change notification.
    expect(await fs.readFile(`/repo/${auditArtifactPath}`, 'utf8')).toContain(
      '# Audit findings: runtime-1',
    )
  })

  it('does not notify observers when the artifact write is rejected', async () => {
    // The artifact already exists, so the exclusive create is not applied.
    const fs: CodebuffFileSystem = createMockFs({
      files: { [`/repo/${auditArtifactPath}`]: 'existing\n' },
    })
    const events: FilesystemMutationEvent[] = []
    const canonicalReceipts: Array<CommitReceiptV1 | undefined> = []
    let fileChangeCalls = 0

    const outputs = await dispatchToolCalls({
      calls: [{ toolName: 'write_audit_findings', input: auditInput }],
      canonicalReceipts,
      clientOptions: {
        cwd: '/repo',
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
    expect(await fs.readFile(`/repo/${auditArtifactPath}`, 'utf8')).toBe(
      'existing\n',
    )
  })
})

describe('replace_range dispatch wiring', () => {
  afterEach(() => {
    mock.restore()
  })

  it('rejects the call when the run has no cwd (and therefore no issuer)', async () => {
    // Both dispatch preconditions (`requireCwd` / `requireCapabilityIssuer`)
    // are unsatisfiable without cwd: the issuer is constructed exactly when
    // cwd is set, so the tool must never reach the applicator.
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
                projectId: '/repo',
                path: 'src/file.ts',
                runId: 'some-run',
              },
            }),
            newContent: 'updated line 1',
          },
        },
      ],
      clientOptions: {},
    })

    expect(jsonValue(outputs[0])).toMatchObject({
      errorMessage: expect.stringContaining(
        'is required for the replace_range tool',
      ),
    })
  })

  it('forwards the run-scoped capability issuer to the applicator', async () => {
    const original = 'line 1\nline 2\n'
    const fs: CodebuffFileSystem = createMockFs({
      files: { '/repo/src/file.ts': original },
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
                projectId: '/repo',
                path: 'src/file.ts',
                // Not this run's id, so the scope check must reject it.
                runId: 'foreign-run',
              },
            }),
            newContent: 'updated line 1',
          },
        },
      ],
      clientOptions: { cwd: '/repo', fsSource: fs },
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
    expect(await fs.readFile('/repo/src/file.ts', 'utf8')).toBe(original)
  })

  it('applies a range edit when the capability scope matches the run and notifies observers', async () => {
    const original = 'line 1\nline 2\nline 3\n'
    const fs: CodebuffFileSystem = createMockFs({
      files: { '/repo/src/file.ts': original },
    })
    const events: FilesystemMutationEvent[] = []
    let workspaceState: WorkspaceStateV1 | undefined
    const capabilityIssuer = { projectId: '/repo', runId: 'run-1' }
    const readCapability = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash('line 1'),
      scope: { projectId: '/repo', path: 'src/file.ts', runId: 'run-1' },
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
      cwd: '/repo',
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
    expect(await fs.readFile('/repo/src/file.ts', 'utf8')).toBe(
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
    cwd: '/repo',
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
    const written = await fs.readFile(`/repo/${auditArtifactPath}`, 'utf8')
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
      files: { [`/repo/${auditArtifactPath}`]: 'existing\n' },
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
    expect(await fs.readFile(`/repo/${auditArtifactPath}`, 'utf8')).toBe(
      'existing\n',
    )
  })
})

describe('client-origin MCP tool approval gate (P1-T2)', () => {
  afterEach(() => {
    mock.restore()
  })

  /**
   * Drives `handleToolCall` directly for an MCP tool call, mocking the shared
   * MCP client so `getMCPClient`/`callMCPTool` never hit the network. Returns
   * whether the tool actually ran alongside the tool output.
   */
  async function dispatchMcpToolCall(params: {
    mcpConfig: MCPConfig
    toolName: string
    requestApproval?: (request: HarnessApprovalRequest) => Promise<boolean>
    approvedClientMcpTools?: Set<string>
  }): Promise<{ output: ToolResultOutput[]; callMcpToolCalls: number }> {
    // Reset any prior spies so `callToolSpy.mock.calls.length` reflects only
    // THIS dispatch. Without this, a second dispatchMcpToolCall in the same
    // test (e.g. the same-tool re-call case) re-wraps an already-spied module
    // method and the call count reads cumulatively across both dispatches.
    mock.restore()
    const getClientSpy = spyOn(
      mcpClientModule,
      'getMCPClient',
    ).mockResolvedValue('mock-client-id')
    const callToolSpy = spyOn(mcpClientModule, 'callMCPTool').mockResolvedValue(
      [{ type: 'json', value: { ok: true } }],
    )

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
      cwd: '/repo',
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
      approvalService: new HarnessApprovalService(
        new LocalHarnessStore(harnessStateDir),
      ),
      getWorkspaceState: () => undefined,
      setWorkspaceState: () => {},
    })

    void getClientSpy
    return {
      output: handled.output,
      callMcpToolCalls: callToolSpy.mock.calls.length,
    }
  }

  function clientConfig(): MCPConfig {
    const config: MCPConfig = {
      type: 'stdio',
      command: 'untrusted-server',
      args: [],
      env: {},
    }
    markMCPConfigOrigin(config, 'client')
    return config
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
    expect(jsonValue([output[0]])).toEqual({ ok: true })
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
    const trustedConfig: MCPConfig = {
      type: 'stdio',
      command: 'trusted-server',
      args: [],
      env: {},
    }
    markMCPConfigOrigin(trustedConfig, 'project')
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
})
