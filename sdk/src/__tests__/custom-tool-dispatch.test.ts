import { describe, expect, test } from 'bun:test'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import z from 'zod/v4'

import {
  getCustomToolDefinition,
  type CustomToolDefinition,
} from '../custom-tool'
import { handleToolCall } from '../run'
import type { HarnessApprovalService } from '../services/harness-enforcement'

function dispatch(
  tool: CustomToolDefinition,
  input: unknown,
  signal?: AbortSignal,
) {
  return handleToolCall({
    action: {
      type: 'tool-call-request',
      requestId: 'call-1',
      userInputId: 'input-1',
      toolName: tool.toolName,
      input,
    },
    overrides: {},
    customToolDefinitions: { [tool.toolName]: tool },
    fs: createMockFs(),
    trustedJobOwner: {
      clientSessionId: 'session-1',
      rootRunId: 'run-1',
      parentRunId: 'run-1',
      parentAgentId: 'agent-1',
    },
    harnessStateDir: '/unused',
    approvalReceiptIds: [],
    approvalMode: 'balanced',
    approvalService: {} as HarnessApprovalService,
    getWorkspaceState: () => undefined,
    setWorkspaceState: () => {},
    signal,
  })
}

describe('custom tool input at SDK dispatch', () => {
  test('passes schema defaults and transforms to the handler', async () => {
    let received: unknown
    const tool = getCustomToolDefinition({
      toolName: 'defaults_and_transform',
      description: 'test',
      inputSchema: z.object({
        count: z.string().default('3').transform(Number),
        name: z.string().trim(),
      }),
      execute: async (input) => {
        received = input
        return [{ type: 'json', value: { ok: true } }]
      },
    })
    const result = await dispatch(tool, { name: '  Alice  ' })
    expect(received).toEqual({ count: 3, name: 'Alice' })
    expect(result.output).toEqual([{ type: 'json', value: { ok: true } }])
  })

  test('runs async validation, returning actionable rejection without executing', async () => {
    let called = false
    const tool = getCustomToolDefinition({
      toolName: 'async_validation',
      description: 'test',
      inputSchema: z.object({
        name: z
          .string()
          .refine(async (name) => name === 'allowed', 'Name is not allowed'),
      }),
      execute: async () => {
        called = true
        return [{ type: 'json', value: { ok: true } }]
      },
    })
    const result = await dispatch(tool, { name: 'rejected' })
    expect(called).toBe(false)
    expect(result.output).toEqual([
      {
        type: 'json',
        value: {
          errorMessage:
            'Invalid parameters for async_validation: name: Name is not allowed',
        },
      },
    ])
  })

  test('cancellation interrupts async validation and never starts execution', async () => {
    let called = false
    const tool = getCustomToolDefinition({
      toolName: 'slow_validation',
      description: 'test',
      inputSchema: z.object({
        name: z.string().refine(() => new Promise<boolean>(() => {})),
      }),
      execute: async () => {
        called = true
        return [{ type: 'json', value: { ok: true } }]
      },
    })
    const controller = new AbortController()
    const pending = dispatch(tool, { name: 'alice' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('preserves legacy JSON-Schema-only direct dispatch', async () => {
    let received: unknown
    const tool = {
      toolName: 'legacy_json_schema',
      description: 'test',
      endsAgentStep: true,
      exampleInputs: [],
      inputSchema: { type: 'object' },
      execute: async (input: unknown) => {
        received = input
        return [{ type: 'json', value: { ok: true } }]
      },
    } as unknown as CustomToolDefinition
    await dispatch(tool, { message: 'hello' })
    expect(received).toEqual({ message: 'hello' })
  })
})
