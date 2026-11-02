import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Maximum entries in one `list_directory` page. Declared here, next to the
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
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Continue a listing using the previous nextOffset. Defaults to 0.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST_DIRECTORY_ENTRIES)
      .optional()
      .describe(
        `Maximum entries per page, defaults to ${MAX_LIST_DIRECTORY_ENTRIES}.`,
      ),
  })
  .describe(
    'List files and directories in the specified path. Returns separate arrays of file names and directory names.',
  )
const description = `
Lists all files and directories in the specified path. Useful for exploring directory structure and finding files.

Returns up to ${MAX_LIST_DIRECTORY_ENTRIES} entries per page. When truncated is true, call again with offset set to nextOffset to retrieve the remaining entries. Pages reflect the current directory; restart at offset 0 if its contents change. Failures return an errorMessage naming the requested path, plus the errno code when the filesystem reports one.

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
          truncated: z.boolean().optional(),
          nextOffset: z.number().int().nonnegative().optional(),
        })
        .describe('Successful listing.'),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
