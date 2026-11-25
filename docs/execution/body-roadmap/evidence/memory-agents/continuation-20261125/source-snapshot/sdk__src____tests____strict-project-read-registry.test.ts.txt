import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSupervisedExecutionScope } from '../impl/agent-runtime'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { bindHostFileSystem } from '../services/host-filesystem'
import { getFilesStructured } from '../tools/read-files'
import {
  createHostReadPolicy,
  deriveProjectOnlyReadPolicy,
} from '@codebuff/common/util/project-path-containment'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import type {
  ExecutionActor,
  ToolExecutionIdentity,
} from '@codebuff/common/types/contracts/client'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import type { StartAgentRunFn } from '@codebuff/common/types/contracts/database'

let root: string, project: string, outside: string
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const sensitiveCanary = 'CONTROLLED_SENSITIVE_STRICT_ACTOR_CANARY'
const outsideCanary = 'CONTROLLED_OUTSIDE_STRICT_ACTOR_CANARY'
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'strict-read-registry-')),
  )
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  fs.writeFileSync(
    path.join(project, 'source.ts'),
    'export const SAFE_CURRENT_SOURCE = true\n',
  )
  fs.writeFileSync(path.join(project, '.env'), sensitiveCanary)
  outside = path.join(root, 'outside.txt')
  fs.writeFileSync(outside, outsideCanary)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const paths = () => ['source.ts', '.env', outside]
function noCanaries(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain(sensitiveCanary)
  expect(text).not.toContain(outsideCanary)
  expect(text).toContain('SAFE_CURRENT_SOURCE')
}
function identity(
  actor: ExecutionActor,
  toolName = 'read_files',
  input: unknown = {},
): ToolExecutionIdentity {
  const basis = { inputHash: hashActionInput(toolName, input) }
  return {
    ...actor,
    actionId: 'read-action',
    attemptId: 'read-attempt',
    basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', {
      basis,
      workspaceSnapshotId: null,
    }),
  }
}
describe('parent-owned supervised read registry', () => {
  test('real guarded reads reject root/sibling/issuer/identity substitution and retain parent cancellation', async () => {
    const controller = new AbortController()
    const context = {
      execution: { signal: controller.signal },
      signal: controller.signal,
    } as ExecutionAdapterContext
    const parentActor = {
      runId: 'parent-run',
      rootRunId: 'parent-run',
      agentId: 'parent-agent',
    }
    const strict = bindHostFileSystem(
      createNodeFileSystem(),
      deriveProjectOnlyReadPolicy(
        createHostReadPolicy(project, [root], fs.realpathSync, {
          mode: 'unrestricted',
          allowPaths: [root],
        }),
      ),
    )
    let reads = 0,
      issued = 0
    const registered: ExecutionActor[] = []
    const scope = createSupervisedExecutionScope({
      request: {
        agentType: 'read-probe',
        prompt: '',
        spawnParams: undefined,
        child: { agentId: 'child-agent' },
        ancestorRunIds: [parentActor.runId],
        executionIdentity: identity(parentActor, 'spawn_agents'),
      },
      executionContext: context,
      registerExecutionActor: (registration) =>
        registered.push(registration.actor),
      startAgentRun: async () => `issued-${++issued}`,
      onExecutionActionStart() {},
      requestToolCall: async () => ({ output: [] }),
      requestMcpToolData: async () => [],
      requestFiles: async (input) => {
        reads++
        return getFilesStructured({
          filePaths: input.filePaths,
          cwd: project,
          fs: strict,
        })
      },
      requestOptionalFile: async (input) => {
        reads++
        return strict.readFile(path.resolve(project, input.filePath), 'utf8')
      },
    })
    const runId = await scope.startAgentRun({
      apiKey: '',
      logger,
      agentId: 'read-probe',
      ancestorRunIds: [parentActor.runId],
      agentState: { agentId: 'child-agent' },
    } as Parameters<StartAgentRunFn>[0])
    const actor = registered[0]!,
      id = identity(actor)
    expect(runId).toBe(actor.runId)
    await scope.onExecutionActionStart({
      identity: id,
      toolName: 'read_files',
      input: {},
      signal: controller.signal,
    })
    const input = {
      filePaths: paths(),
      executionActor: actor,
      executionIdentity: id,
      capabilityIssuer: { projectId: project, runId: actor.runId },
    }
    noCanaries(await scope.requestFiles(input))
    const before = reads
    for (const substituted of [
      parentActor,
      { ...actor, runId: 'sibling-run' },
      { ...actor, agentId: 'sibling-agent' },
    ]) {
      expect(() =>
        scope.requestFiles({ ...input, executionActor: substituted }),
      ).toThrow('Unregistered')
      expect(() =>
        scope.requestOptionalFile({
          filePath: 'source.ts',
          executionActor: substituted,
          executionIdentity: id,
        }),
      ).toThrow('Unregistered')
    }
    expect(() =>
      scope.requestFiles({
        ...input,
        capabilityIssuer: { projectId: project, runId: parentActor.runId },
      }),
    ).toThrow('issuer')
    expect(() =>
      scope.requestFiles({
        ...input,
        executionIdentity: { ...id, actionId: 'unregistered' },
      }),
    ).toThrow('attribution')
    expect(() => scope.requestFiles({ filePaths: ['source.ts'] })).toThrow(
      'Unregistered',
    )
    expect(reads).toBe(before)
    controller.abort(new Error('parent read lifetime ended'))
    expect(() => scope.requestFiles(input)).toThrow(
      'parent read lifetime ended',
    )
    expect(reads).toBe(before)
  })
})
