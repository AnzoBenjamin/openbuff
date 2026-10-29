import { describe, expect, test } from 'bun:test'

import { handleCodeAction } from '../code-action'
import { handleExtractSymbol } from '../extract-symbol'
import { handleFindReferences } from '../find-references'
import { handleGoToDefinition } from '../go-to-definition'
import { handleHoverType } from '../hover-type'
import { handleRenameSymbol } from '../rename-symbol'
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

describe('semantic-edit proxy handlers', () => {
  test('rename_symbol forwards exactly its narrow mutation inputs', async () => {
    const seen: unknown[] = []
    const requestClientToolCall = async (call: unknown) => {
      seen.push(call)
      return [{ type: 'json', value: { success: true } }] as never
    }

    await handleRenameSymbol({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'rename_symbol',
        toolCallId: 'rename',
        input: {
          path: 'src/foo.ts',
          line: 5,
          character: 3,
          new_name: 'createUserV2',
          extra: 'should-not-forward',
        },
      },
      requestClientToolCall,
    } as never)

    expect(seen).toEqual([
      {
        toolName: 'rename_symbol',
        toolCallId: 'rename',
        input: {
          path: 'src/foo.ts',
          line: 5,
          character: 3,
          new_name: 'createUserV2',
        },
      },
    ])
  })

  test('code_action forwards exactly its narrow mutation inputs', async () => {
    const seen: unknown[] = []
    const requestClientToolCall = async (call: unknown) => {
      seen.push(call)
      return [{ type: 'json', value: { edits: [] } }] as never
    }

    await handleCodeAction({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'code_action',
        toolCallId: 'action',
        input: {
          path: 'src/foo.ts',
          line: 5,
          character: 3,
          kind: 'quickfix',
          extra: 'should-not-forward',
        },
      },
      requestClientToolCall,
    } as never)

    expect(seen).toEqual([
      {
        toolName: 'code_action',
        toolCallId: 'action',
        input: {
          path: 'src/foo.ts',
          line: 5,
          character: 3,
          kind: 'quickfix',
        },
      },
    ])
  })

  test('extract_symbol forwards exactly its narrow mutation inputs', async () => {
    const seen: unknown[] = []
    const requestClientToolCall = async (call: unknown) => {
      seen.push(call)
      return [{ type: 'json', value: { edits: [] } }] as never
    }

    await handleExtractSymbol({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'extract_symbol',
        toolCallId: 'extract',
        input: {
          path: 'src/foo.ts',
          line: 5,
          character: 3,
          destination_path: 'src/foo-extracted.ts',
          symbol_name: 'extractedHelper',
          extra: 'should-not-forward',
        },
      },
      requestClientToolCall,
    } as never)

    expect(seen).toEqual([
      {
        toolName: 'extract_symbol',
        toolCallId: 'extract',
        input: {
          path: 'src/foo.ts',
          line: 5,
          character: 3,
          destination_path: 'src/foo-extracted.ts',
          symbol_name: 'extractedHelper',
        },
      },
    ])
  })
})
