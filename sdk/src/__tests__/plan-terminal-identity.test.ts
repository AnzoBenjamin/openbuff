import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { describe, expect, spyOn, test } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { OpenbuffClient } from '../client'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { beginSdkCallback, sdkCallbackOptions } from './sdk-callback-fixture'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

/** Register through the real parent host while deliberately bypassing the child's runtime handler. */
describe('host-owned plan actor lineage', () => {
  test('a child claiming execute mode, full access and user mode cannot widen its registered plan parent', async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-plan-identity-')),
    )
    const protectedHome = process.env.HOME
    let shellCalls = 0,
      fetches = 0
    let output: ToolResultOutput[] = []
    const forbidden = () => {
      fetches++
      throw new Error('No model requests in host actor controls')
    }
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => forbidden(), { preconnect: forbidden }),
    )
    const child: AgentDefinition = {
      id: 'claimed-execute-child',
      displayName: 'Execute claimant',
      model: 'unused-fixture',
      programmaticConfig: { planOnly: false },
      terminalPermissionProfile: 'full-access',
      toolNames: ['run_terminal_command'],
    }
    const parent: AgentDefinition = {
      id: 'host-plan-parent',
      displayName: 'Host-owned plan parent',
      model: 'unused-fixture',
      programmaticConfig: { planOnly: true },
      toolNames: ['spawn_agents'],
      spawnableAgents: [child.id],
    }
    const fakeRuntime = spyOn(
      mainPromptModule,
      'callMainPrompt',
    ).mockImplementation(async (params) => {
      const callback = await beginSdkCallback(params)
      const spawn = await callback.prepare({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: child.id, prompt: 'inspect' }] },
      })
      const childState = {
        ...callback.sessionState.mainAgentState,
        agentId: 'claimed-execute-child-actor',
      }
      const childRun = await params.startAgentRun({
        ...params,
        agentId: child.id,
        agentState: childState,
        ancestorRunIds: [callback.runId],
        executionIdentity: spawn.executionIdentity,
      } as Parameters<typeof params.startAgentRun>[0])
      if (!childRun) throw new Error('Child actor was not registered')
      const original = {
        command: 'printf plan-probe',
        process_type: 'SYNC' as const,
      }
      const forwarded = {
        ...original,
        mode: 'user' as const,
        permission_profile: 'full-access' as const,
      }
      const basis = {
        inputHash: hashActionInput('run_terminal_command', original),
        ...(childState.workspaceState
          ? { workspaceRevision: childState.workspaceState.revision }
          : {}),
      }
      const workspaceSnapshotId = childState.workspaceState?.snapshotId
      const identity: ToolExecutionIdentity = {
        rootRunId: callback.runId,
        runId: childRun,
        agentId: childState.agentId,
        actionId: randomUUID(),
        attemptId: randomUUID(),
        basis,
        ...(workspaceSnapshotId ? { workspaceSnapshotId } : {}),
        basisId: hashActionInput('openbuff.execution-b02-basis.v1', {
          basis,
          workspaceSnapshotId: workspaceSnapshotId ?? null,
        }),
      }
      await params.onExecutionActionStart!({
        identity,
        toolName: 'run_terminal_command',
        input: original,
        signal: params.signal,
      })
      output = (
        await params.requestToolCall({
          userInputId: params.promptId,
          toolName: 'run_terminal_command',
          input: forwarded,
          signal: params.signal,
          executionIdentity: identity,
          executionRequestHash: hashActionInput(
            'run_terminal_command',
            forwarded,
          ),
        })
      ).output
      const result = {
        sessionState: callback.sessionState,
        output: { type: 'lastMessage' as const, value: [] },
      }
      await params.sendAction({
        action: {
          type: 'prompt-response',
          promptId: params.promptId,
          ...result,
        },
      })
      return result
    })
    try {
      const client = new OpenbuffClient({
        ...sdkCallbackOptions(root, { fsSource: createNodeFileSystem() }),
        repositoryIntelligence: false,
        harnessStateDir: path.join(root, 'harness'),
        approvalMode: 'allow-all',
        spawnSource: (command, args = [], spawnOptions) => {
          if (path.basename(command) === 'bash') shellCalls++
          return nodeSpawn(command, [...args], spawnOptions ?? {})
        },
      })
      await client.run({
        agent: parent,
        agentDefinitions: [child],
        prompt: 'Exercise authenticated plan lineage',
      })
      expect(shellCalls).toBe(0)
      expect(output[0]).toMatchObject({
        type: 'json',
        value: {
          errorCode: 'plan_mode_read_only',
          permissionProfile: 'read-only',
          executionRefusal: { ok: false, reason: 'unavailable' },
        },
      })
      expect(fetches).toBe(0)
      expect(process.env.HOME).toBe(protectedHome)
    } finally {
      fakeRuntime.mockRestore()
      fetchSpy.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
