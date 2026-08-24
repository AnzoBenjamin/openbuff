import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import {
  encodeReadCapabilityToken,
  getContentHash,
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
import * as databaseModule from '../impl/database'
import { requireCapabilityIssuer } from '../run'

import type { FilesystemMutationEvent, OpenbuffClientOptions } from '../run'
import type { CommitReceiptV1 } from '@codebuff/common/tools/results/filesystem'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

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
  calls: Array<{ toolName: string; input: Record<string, unknown> }>
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
          input: call.input,
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
    // The side-channel mutation also feeds the canonical-receipt fallback, so
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
    // `onMutationResult` also fires for `not_applied` results, so the rejected
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
})

describe('requireCapabilityIssuer', () => {
  it('throws an actionable error when no issuer is available', () => {
    expect(() => requireCapabilityIssuer(undefined, 'replace_range')).toThrow(
      'a read capability issuer is required for the replace_range tool',
    )
  })

  it('returns the issuer unchanged when present', () => {
    const issuer = { projectId: '/repo', runId: 'run-1' }
    expect(requireCapabilityIssuer(issuer, 'replace_range')).toBe(issuer)
  })
})
