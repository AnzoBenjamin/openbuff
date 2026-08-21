import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Maximum entries a `list_directory` listing may contain before the tool
 * returns an errorMessage instead of a listing. Declared here, next to the
 * description that states it, so the number cannot drift from the prompt text;
 * the SDK implementation imports it (common cannot import the SDK).
 */
export const MAX_LIST_DIRECTORY_ENTRIES = 5000

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

Directories with more than ${MAX_LIST_DIRECTORY_ENTRIES} entries return an errorMessage instead of a listing: list a specific subdirectory instead. Any other failure also returns an errorMessage naming the requested path, plus the errno code when the filesystem reports one.

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
