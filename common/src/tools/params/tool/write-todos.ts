import z from 'zod/v4'

import { $getNativeToolCallExampleString, coerceToArray } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'write_todos'
const endsAgentStep = false
const inputSchema = z
  .object({
    todos: z
      .preprocess(
        coerceToArray,
        z.array(
          z.object({
            task: z.string().describe('Description of the task'),
            completed: z.boolean().describe('Whether the task is completed'),
          }),
        ),
      )
      .describe(
        "List of todos with their completion status. Add ALL of the applicable tasks to the list, so you don't forget to do anything. Try to order the todos the same way you will complete them. Do not mark todos as completed if you have not completed them yet!",
      ),
  })
  .describe(
    'Write a todo list to track tasks for multi-step implementations. Use this frequently to maintain an updated step-by-step plan.',
  )
const description = `
Track multi-step work with an ordered todo list. After gathering context, plan steps; rewrite the full list on each call and mark items completed only when done. Use often to stay on track and show progress.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    todos: [
      { task: 'Create new implementation in foo.ts', completed: true },
      { task: 'Update bar.ts to use the new implementation', completed: false },
      { task: 'Write tests for the new implementation', completed: false },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const writeTodosParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
      }),
    }),
  ]),
} satisfies $ToolParams
