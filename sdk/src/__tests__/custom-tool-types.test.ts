import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

import {
  getCustomToolDefinition,
  type CustomToolDefinition,
} from '../custom-tool'

describe('custom tool schema types', () => {
  test('infers transformed handler parameters and raw optional examples', async () => {
    const schema = z.object({
      count: z.string().default('3').transform(Number),
      source: z.string().transform((value) => value.toUpperCase()),
    })
    const tool = getCustomToolDefinition({
      toolName: 'typed_transform',
      inputSchema: schema,
      description: 'Typed transform fixture',
      exampleInputs: [{ source: 'data' }, { count: '7', source: 'data' }],
      execute: ({ count, source }, context) => {
        const parsedNumber: number = count
        const parsedSource: string = source
        const signal: AbortSignal | undefined = context?.signal
        void signal
        return [{ type: 'json', value: { parsedNumber, parsedSource } }]
      },
    })
    const definition: CustomToolDefinition<
      'typed_transform',
      z.output<typeof schema>,
      z.input<typeof schema>
    > = tool
    const invalidExample: (typeof tool)['exampleInputs'][number] = {
      // @ts-expect-error Examples use the raw schema input before transformation.
      count: 3,
      source: 'data',
    }
    void invalidExample

    expect(
      await definition.execute(await schema.parseAsync({ source: 'data' })),
    ).toEqual([
      { type: 'json', value: { parsedNumber: 3, parsedSource: 'DATA' } },
    ])
  })

  test('preserves explicit output and input generic arguments', async () => {
    const tool = getCustomToolDefinition<
      'explicit_transform',
      { count: number },
      { count: string }
    >({
      toolName: 'explicit_transform',
      inputSchema: z.object({ count: z.string().transform(Number) }),
      description: 'Explicit generic fixture',
      exampleInputs: [{ count: '5' }],
      execute: ({ count }) => [{ type: 'json', value: { count } }],
    })

    expect(
      await tool.execute(await tool.inputSchema.parseAsync({ count: '5' })),
    ).toEqual([{ type: 'json', value: { count: 5 } }])
  })
})
