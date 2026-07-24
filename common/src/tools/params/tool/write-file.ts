import z from 'zod/v4'

import { basedOnReadSchema } from '../based-on-read'
import { updateFileResultSchema } from './str-replace'
import {
  $getNativeToolCallExampleString,
  isObviousEditPlaceholder,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'write_file'
const endsAgentStep = false
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .describe(`Path to the file relative to the **project root**`),
    instructions: z
      .string()
      .describe('What the change is intended to do in only one sentence.'),
    content: z
      .string()
      .refine((value) => !isObviousEditPlaceholder(value), {
        message:
          'content is an explicit placeholder. Provide the complete file content; write_file cannot read an out-of-band patch.',
      })
      .describe(`Complete file content to write to the file.`),
    basedOnRead: basedOnReadSchema.describe(
      'Optional whole-file-covering cap.v3 from a fresh complete whole-file read (paths or full-file range). Only a capability that covers the entire current file (startLine=1 through the current line count) with a hash matching current content may authorize overwrite; partial range capabilities never authorize write_file.',
    ),
  })
  .describe(`Create or overwrite a file with the given content.`)
const description = `
Create or replace a file with the given content.

Format the \`content\` parameter with the entire content of the file.
Never pass references such as "[see patch above]"; every call must contain the complete bytes to write.

#### Additional Info

Existing-file overwrites require a fresh whole-file sticky authorization or an explicit whole-file-covering basedOnRead capability (from a complete paths/full-file range read). Partial range caps never authorize overwrite; capability echo on write_file failures is retry-usable as basedOnRead without an exploratory re-read.

Do not use this tool to delete or rename a file. Use apply_patch.delete_file for a simple deletion, or edit_transaction delete/move for coordinated deletes and renames so the mutation remains authority-checked and visible in receipts and summaries.

Examples:

Example 1 - Simple file creation:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'new-file.ts',
    instructions: 'Prints Hello, world',
    content: 'console.log("Hello, world!");',
  },
  endsAgentStep,
})}

Example 2 - Overwriting a file:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'foo.ts',
    instructions: 'Update foo function',
    content: `function foo() {
  doSomethingNew();
}
  
function bar() {
  doSomethingOld();
}
`,
  },
  endsAgentStep,
})}
`.trim()

export const writeFileParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(updateFileResultSchema),
} satisfies $ToolParams
