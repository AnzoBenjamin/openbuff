import { describe, expect, it } from 'bun:test'

import { prepareTools } from './openai-compatible-prepare-tools'

describe('OpenAI-compatible tool preparation', () => {
  it('forwards only explicit cache metadata on its function tool', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } }
    const result = prepareTools({
      tools: [
        {
          type: 'function',
          name: 'read_files',
          description: 'Read project files',
          inputSchema: schema,
          providerOptions: {
            openaiCompatible: {
              cache_control: { type: 'ephemeral' },
              internalOnly: 'must not be serialized',
            },
            anotherProvider: { internalOnly: true },
          },
        } as never,
        {
          type: 'function',
          name: 'write_file',
          inputSchema: schema,
        } as never,
      ],
      toolChoice: { type: 'tool', toolName: 'read_files' },
    })

    expect(result.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_files',
          description: 'Read project files',
          parameters: schema,
        },
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: undefined,
          parameters: schema,
        },
      },
    ])
    expect(result.toolChoice).toEqual({
      type: 'function',
      function: { name: 'read_files' },
    })
  })
})
