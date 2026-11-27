import { getErrorObject } from '@codebuff/common/util/error'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const OUTPUT_EXCERPT_LIMIT = 2_000

// Dual-window excerpt proportions: 70% head / 30% tail so both the start and
// the end of oversized output survive, and the dropped middle is reported
// with the repo-standard `…[N chars truncated]…` marker. Proportions are
// fixed (not content-dependent) so excerpts stay deterministic.
const EXCERPT_HEAD_PROPORTION = 0.7

function getOutputExcerpt(
  value: unknown,
  maxExcerptChars: number = OUTPUT_EXCERPT_LIMIT,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const limit =
    typeof maxExcerptChars === 'number' && Number.isFinite(maxExcerptChars)
      ? Math.max(1, Math.floor(maxExcerptChars))
      : OUTPUT_EXCERPT_LIMIT
  if (trimmed.length <= limit) return trimmed
  const headLength = Math.floor(limit * EXCERPT_HEAD_PROPORTION)
  const tailLength = limit - headLength
  const truncatedChars = trimmed.length - headLength - tailLength
  return `${trimmed.slice(0, headLength)}…[${truncatedChars} chars truncated]…${trimmed.slice(-tailLength)}`
}

function summarizeCommandStatus(
  exitCode: unknown,
): 'passed' | 'failed' | 'unknown' {
  if (typeof exitCode !== 'number') return 'unknown'
  return exitCode === 0 ? 'passed' : 'failed'
}

export function simplifyReadFileResults(
  messageContent: CodebuffToolOutput<'read_files'>,
): CodebuffToolOutput<'read_files'> {
  const value = structuredClone(messageContent[0]).value
  if (!Array.isArray(value)) {
    return [
      {
        type: 'json',
        value: {
          ...value,
          results: value.results.map((entry) => {
            if (entry.status === 'error') return entry
            if (entry.selector === 'symbols') {
              const { slices: _slices, ...rest } = entry
              return { ...rest, slicesOmittedForLength: true as const }
            }
            // Only whole-file and range items may drop `content` in favor of
            // `contentOmittedForLength`. window/around/symbol block items
            // require `content`/`sourceContent` and forbid the omission
            // marker, so they pass through unchanged.
            if (entry.selector !== 'file' && entry.selector !== 'range') {
              return entry
            }
            const { content: _content, ...rest } = entry
            return { ...rest, contentOmittedForLength: true as const }
          }),
        },
      },
    ]
  }
  return [
    {
      type: 'json',
      value: value.map((entry) => {
        if ('summary' in entry) {
          return entry
        }
        return {
          path: entry.path,
          contentOmittedForLength: true,
        }
      }),
    },
  ]
}

export function simplifyTerminalCommandResults(params: {
  messageContent: CodebuffToolOutput<'run_terminal_command'>
  logger: Logger
  maxExcerptChars?: number
}): CodebuffToolOutput<'run_terminal_command'> {
  const { messageContent, logger, maxExcerptChars } = params
  try {
    const clone = structuredClone(messageContent)
    const content = clone[0].value
    if ('processId' in content || 'errorMessage' in content) {
      return clone
    }
    const { command, message, exitCode, stderr } = content
    const stdout = 'stdout' in content ? content.stdout : undefined
    const status = summarizeCommandStatus(exitCode)
    const stderrExcerpt = getOutputExcerpt(stderr, maxExcerptChars)
    const stdoutExcerpt =
      status === 'failed'
        ? getOutputExcerpt(stdout, maxExcerptChars)
        : undefined

    return [
      {
        type: 'json',
        value: {
          command,
          status,
          ...(message && { message }),
          stdoutOmittedForLength: true,
          ...(stderrExcerpt && { stderrExcerpt }),
          ...(stdoutExcerpt && { stdoutExcerpt }),
          ...(exitCode !== undefined && { exitCode }),
        },
      },
    ]
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), messageContent },
      'Error simplifying terminal command results',
    )
    return [
      {
        type: 'json',
        value: {
          command: '',
          status: 'unknown',
          stdoutOmittedForLength: true,
        },
      },
    ]
  }
}

/**
 * Summarize a code_search tool result by omitting the large stdout blob while
 * preserving the message, status, and excerpts. Idempotent: already-simplified
 * results are returned as-is.
 */
export function simplifyCodeSearchResults(
  messageContent: CodebuffToolOutput<'code_search'>,
  maxExcerptChars?: number,
): CodebuffToolOutput<'code_search'> {
  const clone = structuredClone(messageContent)
  const content = clone[0].value
  if ('errorMessage' in content || 'stdoutOmittedForLength' in content) {
    return clone
  }
  const { message, exitCode, stderr } = content
  const stdout = 'stdout' in content ? content.stdout : undefined
  const status = summarizeCommandStatus(exitCode)
  const stdoutExcerpt = getOutputExcerpt(stdout, maxExcerptChars)
  const stderrExcerpt = getOutputExcerpt(stderr, maxExcerptChars)

  return [
    {
      type: 'json',
      value: {
        message,
        status,
        stdoutOmittedForLength: true,
        ...(stdoutExcerpt && { stdoutExcerpt }),
        ...(stderrExcerpt && { stderrExcerpt }),
        ...(exitCode !== undefined && { exitCode }),
      },
    },
  ]
}

/**
 * Summarize a read_subtree tool result by omitting the large printedTree strings
 * and variable arrays while preserving paths, types, and metadata. Idempotent.
 */
export function simplifyReadSubtreeResults(
  messageContent: CodebuffToolOutput<'read_subtree'>,
): CodebuffToolOutput<'read_subtree'> {
  const clone = structuredClone(messageContent)
  const entries = clone[0].value
  return [
    {
      type: 'json',
      value: entries.map((entry) => {
        if ('errorMessage' in entry) {
          return entry
        }
        if (entry.type === 'directory') {
          if ('printedTreeOmittedForLength' in entry) {
            return entry
          }
          const { path, type, tokenCount, truncationLevel } = entry
          return {
            path,
            type,
            tokenCount,
            truncationLevel,
            printedTreeOmittedForLength: true,
          }
        }
        // File entry
        if ('variablesOmittedForLength' in entry) {
          return entry
        }
        const { path, type } = entry
        return { path, type, variablesOmittedForLength: true }
      }),
    },
  ]
}

/**
 * Summarize a query_index tool result by omitting the large matchedSnippets and
 * relatedFiles arrays while preserving paths, scores, symbols, and headings.
 * Idempotent.
 */
export function simplifyQueryIndexResults(
  messageContent: CodebuffToolOutput<'query_index'>,
): CodebuffToolOutput<'query_index'> {
  const clone = structuredClone(messageContent)
  const content = clone[0].value
  return [
    {
      type: 'json',
      value: {
        ...content,
        results: content.results.map((r) => {
          if ('matchedSnippetsOmittedForLength' in r) {
            return r
          }
          const { matchedSnippets, relatedFiles, ...rest } = r
          void matchedSnippets
          return {
            ...rest,
            matchedSnippetsOmittedForLength: true,
            ...(relatedFiles && { relatedFilesOmittedForLength: true }),
          }
        }),
      },
    },
  ]
}

/**
 * Summarize a web_search tool result by omitting the large result string while
 * preserving an excerpt and up to 5 links. Idempotent.
 */
export function simplifyWebSearchResults(
  messageContent: CodebuffToolOutput<'web_search'>,
  maxExcerptChars?: number,
): CodebuffToolOutput<'web_search'> {
  const clone = structuredClone(messageContent)
  const content = clone[0].value
  if ('errorMessage' in content || 'resultOmittedForLength' in content) {
    return clone
  }
  const { result, links } = content
  const resultExcerpt = getOutputExcerpt(result, maxExcerptChars)

  return [
    {
      type: 'json',
      value: {
        resultOmittedForLength: true,
        ...(resultExcerpt && { resultExcerpt }),
        ...(links && { links: links.slice(0, 5) }),
      },
    },
  ]
}

/**
 * Set of tool names whose results can be summarized (rather than dropped
 * wholesale) when trimming the message history to fit within token limits.
 */
export const SUMMARIZABLE_TOOL_NAMES: Set<string> = new Set([
  'run_terminal_command',
  'code_search',
  'read_subtree',
  'query_index',
  'web_search',
  'read_files',
])

/**
 * Dispatcher that simplifies a tool result's content based on the tool name.
 * Returns the original content if the tool is not summarizable or if
 * simplification fails (with an error log). Each per-tool simplifier is
 * idempotent, so calling this on already-simplified content is safe.
 * Pass maxExcerptChars to raise the per-excerpt character budget above the
 * default 2_000 (excerpts always stay bounded, never un-bounded).
 */
export function simplifyToolResultContent(params: {
  toolName: string
  content: CodebuffToolOutput
  logger: Logger
  maxExcerptChars?: number
}): CodebuffToolOutput {
  const { toolName, content, logger, maxExcerptChars } = params
  try {
    switch (toolName) {
      case 'run_terminal_command':
        return simplifyTerminalCommandResults({
          messageContent: content as CodebuffToolOutput<'run_terminal_command'>,
          logger,
          maxExcerptChars,
        })
      case 'code_search':
        return simplifyCodeSearchResults(
          content as CodebuffToolOutput<'code_search'>,
          maxExcerptChars,
        )
      case 'read_subtree':
        return simplifyReadSubtreeResults(
          content as CodebuffToolOutput<'read_subtree'>,
        )
      case 'query_index':
        return simplifyQueryIndexResults(
          content as CodebuffToolOutput<'query_index'>,
        )
      case 'web_search':
        return simplifyWebSearchResults(
          content as CodebuffToolOutput<'web_search'>,
          maxExcerptChars,
        )
      case 'read_files':
        return simplifyReadFileResults(
          content as CodebuffToolOutput<'read_files'>,
        )
      default:
        return content
    }
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), toolName },
      'Error simplifying tool result',
    )
    return content
  }
}
