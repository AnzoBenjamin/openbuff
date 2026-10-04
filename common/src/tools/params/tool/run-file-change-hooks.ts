import z from 'zod/v4'

import { terminalCommandOutputSchema } from './run-terminal-command'
import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'run_file_change_hooks'
const endsAgentStep = true
const inputSchema = z.object({
  files: z
    .array(z.string())
    .describe(
      `List of file paths that were changed and should trigger file change hooks`,
    ),
})
const description = `
Purpose: Trigger client-configured and manifest-inferred native validation for the specified files. Results include normalized compiler/linter diagnostics with exact file/range/code fields when the underlying tool reports them.

Use cases:
- After making code changes, trigger the relevant tests and checks
- Ensure code quality by running configured linters and type checkers
- Validate that changes don't break the build

The client will run only the hooks whose filePattern matches the provided files.

When the opt-in OPENBUFF_DIAGNOSTIC_PREFLIGHT diagnostic-delta preflight runs, a diagnostic-delta entry reports diagnostic_delta_passed, or diagnostic_delta_rejected with the new error diagnostics (newDiagnostics) and their suggested fix-its (fixIts).

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    files: ['src/components/Button.tsx', 'src/utils/helpers.ts'],
  },
  endsAgentStep,
})}
`.trim()

const diagnosticSchema = z.object({
  file: z.string().nullable(),
  range: z
    .object({
      start: z.object({
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
      end: z.object({
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
    })
    .nullable(),
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  code: z.string().nullable(),
  message: z.string(),
  command: z.string(),
  source: z.string(),
})

/** Matches LanguageDiagnosticTextEdit from sdk/src/tools/language-diagnostics. */
const textEditSchema = z.object({
  file: z.string(),
  newText: z.string(),
  range: z.object({
    start: z.object({
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    }),
    end: z.object({
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    }),
  }),
  applicability: z
    .enum(['machineApplicable', 'maybeIncorrect', 'unspecified'])
    .optional(),
})

export const runFileChangeHooksParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z
      .union([
        terminalCommandOutputSchema.and(
          z.object({
            hookName: z.string(),
            diagnostics: z.array(diagnosticSchema).optional(),
          }),
        ),
        z.object({
          errorMessage: z.string(),
          hookName: z.string().optional(),
        }),
        z.object({
          validationStatus: z.enum(['no_hooks_configured', 'hooks_skipped']),
          message: z.string(),
          configuredHookCount: z.number().optional(),
          changedFiles: z.array(z.string()).optional(),
        }),
        // Opt-in diagnostic-delta preflight result (requires
        // OPENBUFF_DIAGNOSTIC_PREFLIGHT and an injected diagnosticDelta hook).
        // Without this arm, schema-parsing consumers rejected or stripped the
        // delta entry runFileChangeHooks appends when the preflight runs: the
        // shape matches no terminal-command arm (no command) and no run-level
        // arm (different validationStatus, no message).
        z.object({
          hookName: z.literal('diagnostic-delta'),
          validationStatus: z.enum([
            'diagnostic_delta_rejected',
            'diagnostic_delta_passed',
          ]),
          newDiagnostics: z.array(diagnosticSchema).optional(),
          fixIts: z.array(textEditSchema).optional(),
        }),
      ])
      .array(),
  ),
} satisfies $ToolParams
