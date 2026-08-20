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

Do not use this tool to delete or rename a file. Use edit_transaction delete/move for deletes and renames so the mutation remains authority-checked and visible in receipts and summaries.

#### Deprecation — \`apply_patch\` → \`write_file\` / \`edit_transaction\`

\`apply_patch\` has been removed (BREAKING). Use \`write_file\` / \`edit_transaction\` instead.
- Migration: \`apply_patch({ path, diff })\` → \`write_file({ path, instructions, content })\` with the full patched file content, or \`edit_transaction\` with \`str_replace\` / \`replace_range\` for surgical edits.
- Compatibility (persisted history): historical \`ApplyPatchParams\` used the discriminated \`operation\` union (\`create_file\`/\`update_file\`/\`delete_file\` with \`path\`/\`diff\`/\`basedOnRead\`), the flat \`{path,diff}\` envelope, and a loose fallback (\`type?\`, \`content?\`) for envelopes omitting \`type\`/\`diff\`. These shapes are still honored at runtime for history replay via \`removedToolMetadata\`/\`removedToolNames\` and the CLI legacy renderer; \`ApplyPatchParams\` is no longer an exported type — new callers must use \`write_file\` or \`edit_transaction\`.
- Runtime shim honors persisted envelopes using single \`operation:{path,diff,…}\` and array \`operation:[{path,diff,…}]\` (including \`delete_file\` without \`diff\` and envelopes that omit \`type\`) plus legacy \`input:[{path,diff}]\` and fallback \`file\`/\`filePath\` keys, correctly mapping \`delete_file\` → \`edit_transaction\` \`delete\` and otherwise \`patch\`, forwarding \`basedOnRead\` for large-file \`update_file\` patches where relevant. This is required for history replay.
- The \`ToolName\`/\`ToolParamsMap\` no longer contain \`apply_patch\` (removed, BREAKING). Persisted histories still replay via \`removedToolNames\`/\`removedToolMetadata\` and the CLI legacy renderer; new callers must use \`write_file\` or \`edit_transaction\`. See \`sdk/CHANGELOG.md\` / \`cli/CHANGELOG.md\`.
- Prefer \`write_file\` for whole-file rewrites and \`edit_transaction\` for anchored diffs — both preserve the current mutation receipt / capability contract.
- See \`common/src/tools/metadata.ts\` (\`removedToolMetadata\`/\`removedToolNames\`) and the CLI legacy renderer for persisted-history replay; \`agents/types/tools.ts\` and \`common/src/templates/initial-agents-dir/types/tools.ts\` no longer expose a deprecated \`apply_patch\` type.

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
