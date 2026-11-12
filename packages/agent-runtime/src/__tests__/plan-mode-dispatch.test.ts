/**
 * N03: plan mode is read-only, enforced at dispatch.
 *
 * Ported from the product-audit probes
 * .agents/sessions/product-audit-2026-11-12/verification/probes/trust/p4.ts
 * (plan-mode rename_symbol reached the client) and p5.ts (a plan-lineage
 * basher ran `rm -f old.txt && touch PLAN_MARKER` under full-access).
 *
 * The SDK half of p5 (the declared read-only profile actually refusing the
 * command against a real directory) lives in
 * sdk/src/__tests__/terminal-profile-bound.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PLAN_MODE_ALLOWED_ARTIFACT_TOOL_NAMES,
  PLAN_MODE_REFUSED_TOOL_NAMES,
} from '@codebuff/common/tools/plan-mode-policy'

import base2Plan from '../../../../agents/base2/base2-plan'
import basher from '../../../../agents/basher'
import {
  __resetPlanLineageJobsForTest,
  checkPlanModeToolCall,
  PLAN_MODE_READ_ONLY_ERROR_CODE,
} from '../tools/plan-mode-guard'
import { handleRunTerminalCommand } from '../tools/handlers/tool/run-terminal-command'
import { deriveSpawnTemplateCapabilities } from '../tools/handlers/tool/spawn-agent-utils'
import { getFileProcessingValues } from '../tools/handlers/tool/write-file'
import { executeToolCall } from '../tools/tool-executor'
import { getEffectiveAgentToolNames } from '../util/agent-tool-names'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const asTemplate = (definition: unknown): AgentTemplate => {
  const template = definition as AgentTemplate
  return { ...template, toolNames: template.toolNames ?? [] }
}

const planTemplate = asTemplate(base2Plan)

let projectRoot = ''
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-dispatch-'))
  fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(projectRoot, 'old.txt'), 'old\n')
  __resetPlanLineageJobsForTest()
})
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

/** Drive executeToolCall with a minimal harness and capture what it publishes. */
async function dispatch(params: {
  toolName: string
  input: Record<string, unknown>
  agentTemplate: Partial<AgentTemplate>
  fromHandleSteps?: boolean
}) {
  const chunks: Array<Record<string, unknown>> = []
  const forwarded: unknown[] = []
  await executeToolCall({
    toolName: params.toolName,
    input: params.input,
    fromHandleSteps: params.fromHandleSteps ?? false,
    agentState: {
      agentId: 'agent-1',
      runId: 'root-plan-run',
      ancestorRunIds: [],
    },
    agentTemplate: {
      id: 'plan-agent',
      spawnableAgents: [],
      programmaticToolNames: [],
      ...params.agentTemplate,
    },
    clientSessionId: 'session-1',
    logger,
    fileContext: {
      projectRoot,
      fileTreeSource: 'virtual',
      tokenCallers: {},
    },
    fileProcessingState: getFileProcessingValues({}),
    previousToolCallFinished: Promise.resolve(),
    signal: new AbortController().signal,
    toolCalls: [],
    toolCallsToAddToMessageHistory: [],
    toolResults: [],
    toolResultsToAddToMessageHistory: [],
    onResponseChunk: (chunk: unknown) => {
      if (chunk && typeof chunk === 'object')
        chunks.push(chunk as Record<string, unknown>)
    },
    requestToolCall: async (call: unknown) => {
      forwarded.push(call)
      return { output: [{ type: 'json', value: { applied: true } }] }
    },
    onCostCalculated: async () => undefined,
  } as any)
  return { chunks, forwarded }
}

describe('plan-mode dispatch guard (p4)', () => {
  it('refuses a plan-mode rename_symbol with a typed plan_mode_read_only error and leaves the file unchanged', async () => {
    const before = fs.readFileSync(path.join(projectRoot, 'a.ts'), 'utf8')
    const { chunks, forwarded } = await dispatch({
      toolName: 'rename_symbol',
      input: { path: 'a.ts', line: 1, character: 13, new_name: 'pwned' },
      agentTemplate: {
        toolNames: ['rename_symbol'],
        programmaticConfig: { planOnly: true },
      },
    })
    expect(forwarded).toEqual([])
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'error',
      errorCode: PLAN_MODE_READ_ONLY_ERROR_CODE,
    })
    expect(String(chunks[0]?.message)).toStartWith(
      `${PLAN_MODE_READ_ONLY_ERROR_CODE}: \`rename_symbol\``,
    )
    expect(fs.readFileSync(path.join(projectRoot, 'a.ts'), 'utf8')).toBe(before)
  })

  it('refuses every plan-refused tool, including calls from handleSteps', async () => {
    for (const toolName of PLAN_MODE_REFUSED_TOOL_NAMES) {
      for (const fromHandleSteps of [false, true]) {
        const { chunks, forwarded } = await dispatch({
          toolName,
          input: { path: 'a.ts' },
          agentTemplate: {
            toolNames: [toolName],
            programmaticConfig: { planOnly: true },
          },
          fromHandleSteps,
        })
        expect(forwarded, `${toolName} fromHandleSteps=${fromHandleSteps}`).toEqual([])
        expect(chunks[0]?.errorCode, toolName).toBe(PLAN_MODE_READ_ONLY_ERROR_CODE)
      }
    }
  })

  it('leaves execute mode unaffected: the same rename_symbol call is dispatched', async () => {
    const { chunks, forwarded } = await dispatch({
      toolName: 'rename_symbol',
      input: { path: 'a.ts', line: 1, character: 13, new_name: 'renamed' },
      agentTemplate: { toolNames: ['rename_symbol'] },
    })
    expect(forwarded).toHaveLength(1)
    expect(chunks.some((chunk) => chunk.errorCode !== undefined)).toBe(false)
  })

  it('allows the plan artifact tools in plan lineage', () => {
    for (const toolName of PLAN_MODE_ALLOWED_ARTIFACT_TOOL_NAMES) {
      expect(
        checkPlanModeToolCall({
          toolName,
          input: {},
          agentTemplate: { programmaticConfig: { planOnly: true } },
          agentState: { agentId: 'a', runId: 'r', ancestorRunIds: [] },
          clientSessionId: 's',
        }),
      ).toBeUndefined()
    }
  })

  it('refuses kill_job for jobs the plan lineage did not start, and allows its own', async () => {
    const planAgentTemplate = {
      ...asTemplate(basher),
      programmaticConfig: { planOnly: true },
    }
    const childState = {
      agentId: 'basher-1',
      runId: 'basher-run',
      ancestorRunIds: ['root-plan-run'],
    }
    const kill = (jobId: string, rootRunId = 'root-plan-run') =>
      checkPlanModeToolCall({
        toolName: 'kill_job',
        input: { jobId },
        agentTemplate: planAgentTemplate,
        agentState: { ...childState, ancestorRunIds: [rootRunId] },
        clientSessionId: 'session-1',
      })

    expect(kill('job-1')?.errorCode).toBe(PLAN_MODE_READ_ONLY_ERROR_CODE)

    // A plan-lineage BACKGROUND command records its job.
    await handleRunTerminalCommand({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'run_terminal_command',
        toolCallId: 't1',
        input: { command: 'tail -f log.txt', process_type: 'BACKGROUND' },
      },
      agentTemplate: planAgentTemplate,
      agentState: childState,
      clientSessionId: 'session-1',
      requestClientToolCall: async () => [
        { type: 'json', value: { command: 'tail -f log.txt', jobId: 'job-1' } },
      ],
    } as any)

    expect(kill('job-1')).toBeUndefined()
    expect(kill('job-2')?.errorCode).toBe(PLAN_MODE_READ_ONLY_ERROR_CODE)
    // Same job id under another root run is not this lineage's job.
    expect(kill('job-1', 'other-root')?.errorCode).toBe(
      PLAN_MODE_READ_ONLY_ERROR_CODE,
    )
    // Outside plan lineage the guard does not apply (the SDK registry still
    // scopes kill_job to the owner).
    expect(
      checkPlanModeToolCall({
        toolName: 'kill_job',
        input: { jobId: 'job-9' },
        agentTemplate: asTemplate(basher),
        agentState: childState,
        clientSessionId: 'session-1',
      }),
    ).toBeUndefined()
  })
})

describe('plan-lineage terminal profile (p5)', () => {
  it('derives basher under base2-plan as plan-only read-only and forwards read-only', async () => {
    expect(planTemplate.spawnableAgents).toContain('basher')
    const derived = deriveSpawnTemplateCapabilities({
      agentTemplate: asTemplate(basher),
      parentAgentTemplate: planTemplate,
      handoff: undefined,
      projectRoot,
    })
    expect(derived.programmaticConfig?.planOnly).toBe(true)
    expect(derived.terminalPermissionProfile).toBe('read-only')

    let clientCall: any
    const { output } = await handleRunTerminalCommand({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'run_terminal_command',
        toolCallId: 't1',
        input: { command: 'rm -f old.txt && touch PLAN_MARKER' },
      },
      agentTemplate: derived,
      agentState: {
        agentId: 'a1',
        runId: 'r1',
        ancestorRunIds: ['root-plan-run'],
      },
      clientSessionId: 's1',
      // The SDK's read-only policy denial, as sdk/src/run.ts returns it.
      requestClientToolCall: async (call: any) => {
        clientCall = call
        return [
          {
            type: 'json',
            value: {
              command: call.input.command,
              errorMessage:
                'Command denied by read-only terminal policy: filesystem mutation is not allowed in read-only mode',
              permissionProfile: 'read-only',
              permissionDenied: true,
            },
          },
        ]
      },
    } as any)

    expect(clientCall.input.permission_profile).toBe('read-only')
    expect(output[0]).toMatchObject({
      type: 'json',
      value: {
        errorCode: PLAN_MODE_READ_ONLY_ERROR_CODE,
        permissionDenied: true,
      },
    })
    expect(
      String((output[0] as { value: { errorMessage: string } }).value.errorMessage),
    ).toStartWith(`${PLAN_MODE_READ_ONLY_ERROR_CODE}:`)
    expect(fs.existsSync(path.join(projectRoot, 'old.txt'))).toBe(true)
    expect(fs.existsSync(path.join(projectRoot, 'PLAN_MARKER'))).toBe(false)
  })

  it('keeps execute-mode basher on its declared workspace-write profile', async () => {
    let clientCall: any
    await handleRunTerminalCommand({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'run_terminal_command',
        toolCallId: 't1',
        input: { command: 'bun test' },
      },
      agentTemplate: asTemplate(basher),
      agentState: { agentId: 'a1', runId: 'r1', ancestorRunIds: ['root'] },
      clientSessionId: 's1',
      requestClientToolCall: async (call: any) => {
        clientCall = call
        return [{ type: 'json', value: { command: 'bun test', exitCode: 0 } }]
      },
    } as any)
    expect(clientCall.input.permission_profile).toBe('workspace-write')
  })

  it('strips plan-refused tools from any plan-lineage child, including custom writers', () => {
    const customWriter = asTemplate({
      id: 'home-writer',
      toolNames: [
        'edit_transaction',
        'write_file',
        'str_replace',
        'rename_symbol',
        'run_terminal_command',
        'read_files',
      ],
      spawnableAgents: [],
    })
    const derived = deriveSpawnTemplateCapabilities({
      agentTemplate: customWriter,
      parentAgentTemplate: planTemplate,
      handoff: undefined,
      projectRoot,
    })
    expect(derived.toolNames).toEqual(['run_terminal_command', 'read_files'])
    expect(derived.terminalPermissionProfile).toBe('read-only')
    expect(derived.programmaticConfig?.planOnly).toBe(true)

    // Grandchildren inherit the lineage from the derived child.
    const grandchild = deriveSpawnTemplateCapabilities({
      agentTemplate: customWriter,
      parentAgentTemplate: derived,
      handoff: undefined,
      projectRoot,
    })
    expect(grandchild.programmaticConfig?.planOnly).toBe(true)
    expect(
      getEffectiveAgentToolNames(grandchild).filter((name) =>
        (PLAN_MODE_REFUSED_TOOL_NAMES as readonly string[]).includes(name),
      ),
    ).toEqual([])
  })
})
