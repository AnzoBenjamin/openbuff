import { describe, expect, test } from 'bun:test'

import { handleFindReferences } from '../find-references'
import { handleGoToDefinition } from '../go-to-definition'
import { handleHoverType } from '../hover-type'
import { handleWorkspaceSymbol } from '../workspace-symbol'

describe('language-intelligence proxy handlers', () => {
  test('forward only their narrow read inputs', async () => {
    const seen: unknown[] = []
    const requestClientToolCall = async (call: unknown) => {
      seen.push(call)
      return [{ type: 'json', value: { locations: [] } }] as never
    }

    await handleGoToDefinition({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'go_to_definition',
        toolCallId: 'def',
        input: { path: 'src/foo.ts', line: 5, character: 3 },
      },
      requestClientToolCall,
    } as never)
    await handleFindReferences({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'find_references',
        toolCallId: 'refs',
        input: { path: 'src/foo.ts', line: 5, character: 3 },
      },
      requestClientToolCall,
    } as never)
    await handleHoverType({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'hover_type',
        toolCallId: 'hover',
        input: { path: 'src/foo.ts', line: 5, character: 3 },
      },
      requestClientToolCall,
    } as never)
    await handleWorkspaceSymbol({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'workspace_symbol',
        toolCallId: 'ws',
        input: { query: 'createUser' },
      },
      requestClientToolCall,
    } as never)

    expect(seen).toEqual([
      {
        toolName: 'go_to_definition',
        toolCallId: 'def',
        input: { path: 'src/foo.ts', line: 5, character: 3 },
      },
      {
        toolName: 'find_references',
        toolCallId: 'refs',
        input: { path: 'src/foo.ts', line: 5, character: 3 },
      },
      {
        toolName: 'hover_type',
        toolCallId: 'hover',
        input: { path: 'src/foo.ts', line: 5, character: 3 },
      },
      {
        toolName: 'workspace_symbol',
        toolCallId: 'ws',
        input: { query: 'createUser' },
      },
    ])
  })
})
