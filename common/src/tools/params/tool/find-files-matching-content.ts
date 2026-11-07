import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'find_files_matching_content'
const endsAgentStep = true
/**
 * Hard cap on the output schema's `count` field. The tool returns at most
 * `maxFiles` (default 100) unique files plus its own internal safety limit,
 * so a serialized result can never claim an unbounded match count.
 */
const MAX_MATCH_COUNT = 500
/**
 * The documented safe-ripgrep-flag allowlist, declared structurally so the
 * `flags` schema and the tool description prose cannot drift apart. Value
 * flags (-g/--glob, -t/--type, -T/--type-not) take a following value token;
 * -n/--line-number are accepted and ignored (the tool forces line numbers
 * itself).
 */
const FLAG_ALLOWLIST = [
  '-i',
  '--ignore-case',
  '-S',
  '--smart-case',
  '-s',
  '--case-sensitive',
  '-w',
  '--word-regexp',
  '-F',
  '--fixed-strings',
  '-U',
  '--multiline',
  '--multiline-dotall',
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-n',
  '--line-number',
] as const
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
])

/**
 * True when `token` is a valid `flags` entry: an allowlisted flag, a value
 * token for a preceding value flag (any token not starting with `-`), or a
 * `flag=value` compound whose flag is allowlisted.
 */
const isAllowedFlagToken = (token: string, prevFlag?: string): boolean => {
  if (prevFlag !== undefined && VALUE_FLAGS.has(prevFlag)) {
    return !token.startsWith('-')
  }
  const allowlist = FLAG_ALLOWLIST as readonly string[]
  if (allowlist.includes(token)) return true
  const eq = token.indexOf('=')
  return eq > 0 && allowlist.includes(token.slice(0, eq))
}

const flagsSchema = z
  .preprocess(
    (value) => {
      // Split a single-string flags payload into argv tokens so the structural
      // allowlist validates both encodings uniformly ("-g *.ts -g *.tsx" and
      // ["-g", "*.ts", "-g", "*.tsx"] are the same input). Array payloads
      // are already argv-shaped and pass through untouched.
      if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
      return value
    },
    z
      .array(z.string())
      .superRefine((tokens, ctx) => {
        let prevFlag: string | undefined
        for (const [index, token] of tokens.entries()) {
          if (isAllowedFlagToken(token, prevFlag)) {
            prevFlag = token.startsWith('-') ? token : undefined
            continue
          }
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: `Flag "${token}" is not on the allowed ripgrep flag allowlist (allowed: ${(FLAG_ALLOWLIST as readonly string[]).join(', ')}, plus values for ${[...VALUE_FLAGS].join(', ')}).`,
          })
          prevFlag = token.startsWith('-') ? token : undefined
        }
      }),
  )
  .optional()

const inputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, 'Pattern cannot be empty')
      .describe(
        `Regex pattern (ripgrep syntax) to match file content against.`,
      ),
    flags: flagsSchema.describe(
        `Optional safe ripgrep flags as one string or argv tokens. Allowed: -i/--ignore-case, -S/--smart-case, -s/--case-sensitive, -w/--word-regexp, -F/--fixed-strings, -U/--multiline, --multiline-dotall, -g/--glob, -t/--type, -T/--type-not. Examples: "-g *.ts -g *.tsx" or ["-g", "*.ts", "-g", "*.tsx"]. Do not quote the entire expression inside the JSON string. Output-shape flags such as -c/--count, --count-matches, -l, -v/--invert-match, context -A/-B/-C, -r/--replace, --exec, and -z/--null are rejected (this tool forces -l or --json itself). Redundant -n/--line-number inputs are ignored.`,
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        `Optional working directory or single file to search within, relative to the project root or absolute. Absolute paths may be outside the project. A directory becomes ripgrep's cwd and scopes the search under that path (plus existing blessed hidden dirs); a file scopes the search to that file only (process cwd = project root when the file is under the project, else the file's parent). Defaults to the project root.`,
      ),
    maxFiles: z
      .number()
      .int()
      .positive()
      .optional()
      .default(100)
      .describe(`Maximum number of unique files to return. Defaults to 100.`),
    groupBySymbol: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        `When true, also return the names of the top-level symbols (functions, classes, methods, exports, constants) that contain each match, plus the per-file match count. Symbol extraction is heuristic and works best for JS/TS/Python/Go/Rust source files; languages without a recognized declaration shape produce an empty symbols list.`,
      ),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(600)
      .optional()
      .default(15)
      .describe(
        'Maximum seconds to let ripgrep run before returning partial results. Defaults to 15.',
      ),
  })
  .describe(
    `List unique file paths whose content matches a pattern, with optional symbol grouping. Built on top of ripgrep (rg).`,
  )

const description = `
Purpose: Return the unique set of files whose content matches a pattern, without dumping every matching line. Useful when you only want the file list (e.g., to feed into read_files or another tool) instead of the line-oriented output produced by code_search.

Use cases:
1. Determine which files reference a function/class/identifier across the repo.
2. Find every file that imports a specific module.
3. Locate the files that need to change for a refactor before doing per-file reads.
4. Quickly answer "which files contain X?" without scrolling through many match lines.

When to use this vs. code_search:
- Prefer find_files_matching_content when you only need the file list (counts, refactor planning, follow-up reads).
- Prefer code_search when you need to see the matching lines with surrounding context or need advanced ripgrep flags beyond this tool's safe allowlist.

Supported flags:
- Allowed no-value flags: -i/--ignore-case, -S/--smart-case, -s/--case-sensitive, -w/--word-regexp, -F/--fixed-strings, -U/--multiline, --multiline-dotall.
- Allowed value flags: -g/--glob, -t/--type, -T/--type-not.
- Rejected (including output-shape changers that would break -l path parsing): -c/--count, --count-matches, -v/--invert-match, -l, context -A/-B/-C, -r/--replace, --exec, -z/--null. Use code_search for context flags.
- cwd may be absolute and outside the project; file cwd searches that file only.

Symbol grouping (groupBySymbol: true):
- For each matching file, returns the names of the top-level symbols that contain at least one match, plus the total match count.
- Symbol extraction is heuristic, language-agnostic, and conservative: it scans the file for common declaration patterns (function/class/const/let/var/export, def, struct/impl/fn). Matches that fall outside any recognized declaration produce no symbol entry.

Examples:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'requestClientToolCall' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    pattern: 'from "react"',
    flags: '-F -g *.ts -g *.tsx',
  },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    pattern: 'handleCodeSearch',
    cwd: 'packages/agent-runtime/src',
    groupBySymbol: true,
  },
  endsAgentStep,
})}
`.trim()

export const findFilesMatchingContentParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        files: z
          .array(z.string())
          .describe('Unique file paths matching the pattern'),
        count: z
          .number()
          .int()
          .min(0)
          .max(MAX_MATCH_COUNT)
          .describe('Number of unique files matched'),
        truncated: z
          .boolean()
          .optional()
          .describe(
            'True when the result was capped by maxFiles, an internal safety limit, or timeoutSeconds',
          ),
        groups: z
          .array(
            z.object({
              file: z.string(),
              matchCount: z.number(),
              symbols: z.array(z.string()),
            }),
          )
          .optional()
          .describe(
            'Per-file symbol grouping. Present only when groupBySymbol=true.',
          ),
        message: z.string(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
