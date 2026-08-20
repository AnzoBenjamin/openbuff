import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'list_directory'
const endsAgentStep = true
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path cannot be empty')
      .refine((value) => !value.includes('\0'), {
        message: 'Path cannot contain NUL bytes',
      })
      .describe('Directory path to list, relative to the project root.'),
  })
  .describe(
    'List files and directories in the specified path. Returns separate arrays of file names and directory names.',
  )
const description = `
Lists all files and directories in the specified path. Useful for exploring directory structure and finding files.

Large directories return an errorMessage when exceeding 5000 entries to preserve the persisted error contract; consumers can detect the cap via errorMessage. Narrow path or use a fileFilter for full coverage. The cap is documented and exported as MAX_LIST_DIRECTORY_ENTRIES in sdk/src/tools/list-directory.ts. A future truncated-success shape (truncated/totalEntries/warning) would be additive optional fields on the success union and may become a configurable maxEntries param in a future minor without breaking the current error contract.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: 'src/components',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    path: '.',
  },
  endsAgentStep,
})}
    `.trim()

export const listDirectoryParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z
        .object({
          files: z.array(z.string()).describe('Array of file names'),
          directories: z.array(z.string()).describe('Array of directory names'),
          path: z.string().describe('The directory path that was listed'),
        })
        .describe('Successful listing.'),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
