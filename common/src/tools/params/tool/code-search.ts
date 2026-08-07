import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'code_search'
const endsAgentStep = true
const inputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, 'Pattern cannot be empty')
      .describe(`The pattern to search for.`),
    flags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        `Optional safe ripgrep flags as one string or argv tokens (e.g., "-i -g *.ts -A 2" or ["-i", "-g", "*.ts", "-A", "2"]). Allowed: -i/--ignore-case, -S/--smart-case, -s/--case-sensitive, -w/--word-regexp, -F/--fixed-strings, -U/--multiline, --multiline-dotall, -g/--glob, -t/--type, -T/--type-not, plus context -A/-B/-C (and long forms). JSON quotes delimit the string; do not embed another quote pair around the entire expression. Line numbers are automatic; -n/--line-number are ignored. Output-shape flags such as -c/--count, --count-matches, -l, -v/--invert-match, -r/--replace, --exec, and -z/--null are rejected.`,
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        `Optional working directory or single file to search within, relative to the project root or absolute. Absolute paths may be outside the project. A directory becomes ripgrep's cwd and scopes the search under that path (plus existing blessed hidden dirs when no paths are given); a file scopes the search to that file only (process cwd = project root when the file is under the project, else the file's parent). Defaults to searching the entire project root.`,
      ),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe(
        `Optional list of file and/or directory paths to search (relative to the project root, or absolute). When non-empty, ripgrep searches only these targets instead of the whole cwd tree (and does not auto-expand hidden dirs). Can be combined with a file cwd.`,
      ),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(15)
      .describe(
        `Maximum number of results to return per file. Defaults to 15. There is also a global limit of 250 results across all files.`,
      ),
  })
  .describe(
    `Search for string patterns in the project's files. This tool uses ripgrep (rg), a fast line-oriented search tool. Use this tool only when read_files is not sufficient to find the files you need.`,
  )
const description = `
Purpose: Search through code files to find files with specific text patterns, function names, variable names, and more.

Prefer to use read_files instead of code_search unless you need to search for a specific pattern in multiple files.

Use cases:
1. Finding all references to a function, class, or variable name across the codebase
2. Searching for specific code patterns or implementations
3. Looking up where certain strings or text appear
4. Finding files that contain specific imports or dependencies
5. Locating configuration settings or environment variables

The pattern supports regular expressions and will search recursively through all files in the project by default. Some tips:
- Be as constraining in the pattern as possible to limit the number of files returned, e.g. if searching for the definition of a function, use "(function foo|const foo)" or "def foo" instead of merely "foo".
- Use Rust-style regex, not grep-style, PCRE, RE2 or JavaScript regex - you must always escape special characters like { and }
- Be as constraining as possible to limit results, e.g. use "(function foo|const foo)" or "def foo" instead of merely "foo"
- Add context to your search with surrounding terms (e.g., "function handleAuth" rather than just "handleAuth")
- Use word boundaries (\\b) to match whole words only
- Use the cwd parameter to narrow your search to a specific directory, or pass a file path as cwd to search that file only
- Use the paths parameter to search one or more specific files and/or directories without scanning the whole tree
- For case-sensitive searches like constants (e.g., ERROR vs error), omit the "-i" flag
- Searches file content and filenames
- Automatically ignores binary files, hidden files, and files in .gitignore


Advanced ripgrep flags (use the flags parameter):

- Case sensitivity: "-i" for case-insensitive search
- File type filtering: "-t ts -t js" (TypeScript and JavaScript), "-t py" (Python), etc. The equivalent structured form is ["-t", "ts", "-t", "js"].
- Exclude file types: "--type-not py" to exclude Python files
- Context lines: "-A 3" (3 lines after), "-B 2" (2 lines before), "-C 2" (2 lines before and after)
- Word boundaries: "-w" to match whole words only
- Fixed strings: "-F" to treat pattern as literal string (not regex)
- Multiline matching: "-U" and "--multiline-dotall"

Only the flags listed above are accepted (plus the safe base allowlist and context -A/-B/-C). Output-shape-changing or effectful ripgrep flags such as -c/--count, --count-matches, -l, -v/--invert-match, -r/--replace, --exec, and -z/--null are rejected.
Line numbers are enabled internally. Redundant -n/--line-number inputs are ignored for compatibility; omit them from new calls.

cwd / paths runtime notes:
- Relative cwd/paths resolve against the project root; absolute values are used as-is and may be outside the project.
- Directory cwd sets the ripgrep process cwd. File cwd searches that file only.
- Non-empty paths search only those targets (no automatic hidden-dir expansion) and can combine with a file cwd.

Note: Do not use the end_turn tool after this tool! You will want to see the output of this tool before ending your turn.

RESULT LIMITING:

- The maxResults parameter limits the number of results shown per file (default: 15)
- There is also a global limit of 250 total results across all files
- These limits allow you to see results across multiple files without being overwhelmed by matches in a single file
- If a file has more matches than maxResults, you'll see a truncation notice indicating how many results were found
- If the global limit is reached, remaining files will be skipped

Examples:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'foo' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'foo\\.bar = 1\\.0' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'import.*foo', cwd: 'src' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'export function', paths: ['src/utils.ts', 'src/lib'] },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'function.*authenticate', flags: '-i -t ts -t js' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'TODO', flags: '--type-not py' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'getUserData', maxResults: 10 },
  endsAgentStep,
})}
`.trim()

export const codeSearchParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        stdout: z.string(),
        stderr: z.string().optional(),
        exitCode: z.number().optional(),
        message: z.string(),
      }),
      z.object({
        message: z.string(),
        status: z.enum(['passed', 'failed', 'unknown']).optional(),
        stdoutOmittedForLength: z.literal(true),
        stdoutExcerpt: z.string().optional(),
        stderrExcerpt: z.string().optional(),
        exitCode: z.number().optional(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
