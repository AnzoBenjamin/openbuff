import {
  launchSearchProcess,
  finishSearchProcess,
  searchExitStatus,
  searchExitError,
} from './search-execution'
import {
  scheduleNodeDeadline,
  refusalForSignal,
} from '../services/execution-launch'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import * as fs from 'fs'
import * as path from 'path'

import { formatCodeSearchOutput } from '../../../common/src/util/format-code-search'
import { getBundledRgPath } from '../native/ripgrep'
import { parseSafeRipgrepFlags } from './find-files-matching-content'
import { isReadPathBlocked } from './read-policy'
import { hasFilesystemSandbox } from '@codebuff/common/util/filesystem-sandbox'
import { resolveProjectPathForRead } from '@codebuff/common/util/project-path-containment'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { FileFilter } from './read-files'
import { Logger } from '@codebuff/common/types/contracts/logger'

// Hidden directories to include in code search by default.
// These are searched in addition to '.' to ensure important config/workflow files are discoverable.
const INCLUDED_HIDDEN_DIRS = [
  '.agents', // Codebuff agent definitions
  '.claude', // Claude settings
  '.github', // GitHub Actions, workflows, issue templates
  '.gitlab', // GitLab CI configuration
  '.circleci', // CircleCI configuration
  '.husky', // Git hooks
]

const DEFAULT_EXCLUDED_GLOBS = [
  '!**/node_modules/**',
  '!**/.bun-install/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.next/**',
  '!**/.turbo/**',
  '!**/*.generated.*',
  '!**/bundled-agents.generated.ts',
]

const MAX_MATCH_LINE_LENGTH = 1_000

/**
 * Search the project with ripgrep.
 *
 * OUTPUT CONTRACT — the resolved `stdout` has two mutually exclusive shapes,
 * discriminated by the caller's `flags`:
 *
 * - RANKED/ENVELOPE MODE (default; no `-l`): each match renders as
 *   `filename:line:content`, wrapped by `formatCodeSearchOutput`, plus bounded
 *   truncation notes. Hosts parse lines for a path, a line number and content.
 * - FILES-ONLY MODE (`-l`/`--files-with-matches` in `flags`): the result is a
 *   bare newline-separated list of matching paths with no line numbers and no
 *   envelope. A host that parses `filename:line:content` MUST check the
 *   requested flags first and treat every line as a path.
 *
 * Both modes share the same error surface (`{ errorMessage }`) and the same
 * `exitCode`/`message`/`stderr` metadata, so an invalid pattern or a missing
 * binary is reported identically in either mode.
 */
export async function codeSearch({
  projectPath,
  pattern,
  flags,
  cwd,
  paths,
  maxResults = 30,
  globalMaxResults = 250,
  maxOutputStringLength = 20_000,
  timeoutSeconds = 10,
  logger,
  signal: requestedSignal,
  executionContext,
  branchId = 'sdk.code-search',
  fileFilter,
}: {
  projectPath: string
  pattern: string
  /**
   * ripgrep flags, filtered through `parseSafeRipgrepFlags` (context flags
   * -A/-B/-C and `-l`/`--files-with-matches` are additionally allowed here).
   *
   * `-l`/`--files-with-matches` selects the FILES-ONLY OUTPUT MODE described on
   * `codeSearch`: the result is a bare newline-separated list of matching
   * paths, NOT the `filename:line:content` envelope. Flags outside the
   * allowlist fail with an `{ errorMessage }` result rather than being
   * silently dropped.
   */
  flags?: string | string[]
  cwd?: string
  /** Optional file and/or directory paths to search (relative to project root or absolute). */
  paths?: string[]
  maxResults?: number
  globalMaxResults?: number
  maxOutputStringLength?: number
  timeoutSeconds?: number
  logger?: Logger
  /** Optional abort signal. When aborted, the ripgrep child is SIGTERMed
   *  and the promise resolves with an `{ errorMessage }` result (the
   *  same shape used for every other code_search error, so the agent's
   *  tool-result-handling pipeline doesn't need a special case). If the
   *  signal is already aborted when called, the function short-circuits
   *  without spawning a child. */
  signal?: AbortSignal
  executionContext?: ExecutionAdapterContext
  branchId?: string
  fileFilter?: FileFilter
}): Promise<CodebuffToolOutput<'code_search'>> {
  const signal = requestedSignal

  const projectRoot = path.resolve(projectPath)
  if (
    hasFilesystemSandbox() &&
    [cwd ?? '.', ...(paths ?? [])].some(
      (input) => !resolveProjectPathForRead(projectRoot, input),
    )
  ) {
    return [
      {
        type: 'json',
        value: {
          errorMessage: 'Search path is outside the configured sandbox.',
        },
      },
    ]
  }
  let searchCwd = projectRoot
  const explicitSearchPaths: string[] = []
  let cwdWasFile = false

  if (cwd !== undefined) {
    const requested = cwd
    const resolvedCwd = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(projectRoot, requested)
    try {
      const realCwd = fs.realpathSync.native(resolvedCwd)
      if (fs.statSync(realCwd).isDirectory()) {
        searchCwd = realCwd
      } else {
        // File-as-cwd: search only that file; process cwd = project root when
        // the file is under the project, else the file's parent directory.
        cwdWasFile = true
        searchCwd = isPathInside(projectRoot, realCwd)
          ? projectRoot
          : path.dirname(realCwd)
        explicitSearchPaths.push(toRgPathArg(searchCwd, realCwd))
      }
    } catch {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `Invalid cwd: Path '${cwd}' does not exist or cannot be read. code_search requires an existing directory or file.`,
          },
        },
      ]
    }
  }

  if (paths && paths.length > 0) {
    for (const requestedPath of paths) {
      if (!requestedPath) {
        return [
          {
            type: 'json',
            value: {
              errorMessage:
                'Invalid paths: path entries must be non-empty strings.',
            },
          },
        ]
      }
      const resolvedPath = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : path.resolve(projectRoot, requestedPath)
      try {
        const realPath = fs.realpathSync.native(resolvedPath)
        // Confirm the path is readable (file or directory).
        fs.statSync(realPath)
        explicitSearchPaths.push(toRgPathArg(searchCwd, realPath))
      } catch {
        return [
          {
            type: 'json',
            value: {
              errorMessage: `Invalid paths: Path '${requestedPath}' does not exist or cannot be read.`,
            },
          },
        ]
      }
    }
  }

  // Parse flags through an allow-list so callers can't inject dangerous
  // ripgrep flags (e.g. --exec runs a command per match, -r/--replace mutates
  // files, -z/--null changes output framing). code_search additionally allows
  // the -A/-B/-C context flags (value-taking) since the JSON parser already
  // handles match + context events. Unsupported flags return an error result
  // instead of being silently dropped or passed through.
  const parsedFlags = parseSafeRipgrepFlags(flags || [], {
    toolName: 'code_search',
    extraSwitchesWithValue: [
      '-A',
      '-B',
      '-C',
      '--after-context',
      '--before-context',
      '--context',
    ],
    extraSwitchesWithoutValue: ['-l', '--files-with-matches'],
  })
  if ('errorMessage' in parsedFlags) {
    return [
      {
        type: 'json',
        value: { errorMessage: parsedFlags.errorMessage },
      },
    ]
  }
  const flagsArray = parsedFlags.flags
  // True when the caller explicitly requested files-only output.
  const filesOnlyMode =
    flagsArray.includes('-l') || flagsArray.includes('--files-with-matches')
  // In files-only mode, remove -l/--files-with-matches from flagsArray — we
  // control the output shape ourselves so we don't pass the flag through;
  // ripgrep's bare-path output is what we stream and format below.
  const filteredFlags = filesOnlyMode
    ? flagsArray.filter((f) => f !== '-l' && f !== '--files-with-matches')
    : flagsArray

  // Use JSON output for robust parsing and early stopping
  // --no-config prevents user/system .ripgreprc from interfering
  // -n shows line numbers
  // --json outputs in JSON format, which streams in and allows us to cut off the output if it grows too long
  // "--"" prevents pattern from being misparsed as a flag (e.g., pattern starting with '-')
  // Search paths: explicit file/dir targets when provided; otherwise '.' plus
  // blessed hidden directories that actually exist (skip non-existent dirs to
  // avoid ripgrep stderr errors).
  let searchPaths: string[]
  if (explicitSearchPaths.length > 0) {
    searchPaths = [...new Set(explicitSearchPaths)]
  } else {
    const existingHiddenDirs = INCLUDED_HIDDEN_DIRS.filter((dir) => {
      try {
        return fs.statSync(path.join(searchCwd, dir)).isDirectory()
      } catch {
        return false
      }
    })
    searchPaths = ['.', ...existingHiddenDirs]
  }
  const args = filesOnlyMode
    ? [
        '--no-config',
        '-l',
        ...DEFAULT_EXCLUDED_GLOBS.flatMap((glob) => ['-g', glob]),
        ...filteredFlags,
        '--',
        pattern,
        ...searchPaths,
      ]
    : [
        '--no-config',
        '-n',
        '--json',
        ...DEFAULT_EXCLUDED_GLOBS.flatMap((glob) => ['-g', glob]),
        ...filteredFlags,
        '--',
        pattern,
        ...searchPaths,
      ]

  const rgPath = getBundledRgPath(import.meta.url, {})
  if (logger) {
    logger.info(
      { rgPath, args, searchCwd },
      'code-search: Spawning ripgrep process',
    )
  }

  if (signal?.aborted)
    return [
      {
        type: 'json',
        value: {
          errorMessage: refusalForSignal(signal).cause,
          executionRefusal: refusalForSignal(signal),
        },
      },
    ]
  const launched = await launchSearchProcess({
    executionContext,
    callerSignal: signal,
    executable: rgPath,
    argv: args,
    cwd: searchCwd,
    branchId,
    timeoutSeconds,
  })
  if (!launched.ok)
    return [
      {
        type: 'json',
        value: { errorMessage: launched.cause, executionRefusal: launched },
      },
    ]
  const node = launched.value
  const childProcess = node.child
  const resourceSignal = node.input.resourceSignal
  return new Promise((resolve) => {
    let isResolved = false
    let removeAbortListener = () => {}
    let jsonRemainder = ''
    let stderrBuf = ''
    // Track matches by file for grouping and limiting
    const fileGroups = new Map<string, string[]>()
    // Track match count per file separately from total lines
    const fileMatchCounts = new Map<string, number>()
    const filesLimitedByMaxResults = new Set<string>()
    const matchedFiles: string[] = []
    let matchesGlobal = 0
    let estimatedOutputLen = 0
    let killedForLimit = false

    const partialOutput = () => ({
      stdout: truncateOutput(
        filesOnlyMode
          ? matchedFiles.join('\n')
          : formatCollectedOutput([...fileGroups.values()].flat().join('\n')),
        maxOutputStringLength,
      ),
      stderr: truncateOutput(stderrBuf, Math.floor(maxOutputStringLength / 5)),
      message: 'Partial search results after interruption.',
    })

    const settle = (
      payload: Extract<
        CodebuffToolOutput<'code_search'>[number],
        { type: 'json' }
      >['value'],
    ) => {
      if (isResolved) return
      isResolved = true
      removeAbortListener()
      cancelTimeout()
      void finishSearchProcess(node, payload, partialOutput).then((value) =>
        resolve([{ type: 'json', value }]),
      )
    }

    const stopForOutputLimit = () => {
      void node.scope.requestStop('output-limit')
    }

    const formatCollectedOutput = (rawOutput: string) =>
      formatCodeSearchOutput(rawOutput, {
        matchCount: matchesGlobal,
      })

    const truncateOutput = (output: string, maxLength: number) =>
      output.length > maxLength
        ? output.substring(0, maxLength) + '\n\n[Output truncated]'
        : output

    const truncateMatchLine = (line: string) =>
      line.length > MAX_MATCH_LINE_LENGTH
        ? `${line.slice(0, MAX_MATCH_LINE_LENGTH)}…[truncated ${line.length - MAX_MATCH_LINE_LENGTH} chars]`
        : line

    const cancelTimeout = scheduleNodeDeadline(node.remainingResourceMs, () => {
      if (isResolved) return

      const truncatedStdout = truncateOutput(partialOutput().stdout, 1000)
      const truncatedStderr =
        stderrBuf.length > 1000
          ? stderrBuf.substring(0, 1000) + '\n\n[Error output truncated]'
          : stderrBuf
      settle({
        errorMessage: `Code search timed out after ${timeoutSeconds} seconds. The search may be too broad or the pattern too complex. Try narrowing your search with more specific flags or a more specific pattern.`,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
      })
      stopForOutputLimit()
    })

    const onAbort = () => {
      if (isResolved) return
      const refusal = refusalForSignal(resourceSignal)
      settle({
        ...partialOutput(),
        errorMessage:
          refusal.reason === 'deadline-exhausted'
            ? `Code search timed out: ${refusal.cause}`
            : refusal.cause,
        executionRefusal: refusal,
      })
    }
    const onCallerAbort = () => {
      if (isResolved || !signal) return
      const refusal = refusalForSignal(signal)
      void node.scope.requestStop('owner-cancel')
      settle({
        ...partialOutput(),
        errorMessage:
          refusal.reason === 'deadline-exhausted'
            ? `Code search timed out: ${refusal.cause}`
            : refusal.cause,
        executionRefusal: refusal,
      })
    }
    resourceSignal.addEventListener('abort', onAbort, { once: true })
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    removeAbortListener = () => {
      resourceSignal.removeEventListener('abort', onAbort)
      signal?.removeEventListener('abort', onCallerAbort)
    }
    if (resourceSignal.aborted) onAbort()
    else if (signal?.aborted) onCallerAbort()

    childProcess.stderr?.on('data', (chunk: Buffer | string) => {
      if (isResolved) return
      const chunkStr =
        typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Keep stderr bounded during streaming
      const limit = Math.floor(maxOutputStringLength / 5)
      if (stderrBuf.length < limit) {
        const space = limit - stderrBuf.length
        stderrBuf += chunkStr.slice(0, space)
      }
    })

    if (filesOnlyMode) {
      let fileLineBuf = ''
      let filesKilledForLimit = false

      childProcess.stdout?.on('data', (chunk: Buffer | string) => {
        if (isResolved) return
        const chunkStr =
          typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        fileLineBuf += chunkStr
        const lines = fileLineBuf.split('\n')
        fileLineBuf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (isReadPathBlocked(trimmed, fileFilter)) continue
          matchedFiles.push(trimmed)
          if (matchedFiles.length >= globalMaxResults) {
            filesKilledForLimit = true
            settle({
              stdout:
                matchedFiles.join('\n') +
                `\n\n[Global limit of ${globalMaxResults} results reached.]`,
              message: `Stopped early at ${globalMaxResults} files.`,
            })
            stopForOutputLimit()
            return
          }
        }
      })

      childProcess.once('close', async (code, signal) => {
        const status = await searchExitStatus(node, code, signal)
        if (isResolved) return
        code = status.exitCode
        // Flush any trailing partial line
        if (
          fileLineBuf.trim() &&
          !isReadPathBlocked(fileLineBuf.trim(), fileFilter)
        ) {
          matchedFiles.push(fileLineBuf.trim())
        }
        const exitMessage =
          code !== null
            ? `Exit code: ${code}${filesKilledForLimit ? ' (early stop)' : ''}`
            : ''
        settle({
          stdout: matchedFiles.join('\n'),
          ...(searchExitError(status, stderrBuf)
            ? { errorMessage: searchExitError(status, stderrBuf) }
            : {}),
          ...(stderrBuf && {
            stderr: truncateOutput(
              stderrBuf,
              Math.floor(maxOutputStringLength / 5),
            ),
          }),
          ...(code !== null && { exitCode: code }),
          message: exitMessage,
        })
      })
    } else {
      // Parse ripgrep JSON for early stopping
      childProcess.stdout?.on('data', (chunk: Buffer | string) => {
        if (isResolved) return
        const chunkStr =
          typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        jsonRemainder += chunkStr

        // Split by lines; last line might be partial
        const lines = jsonRemainder.split('\n')
        jsonRemainder = lines.pop() || ''

        for (const line of lines) {
          if (!line) continue
          let evt: any
          try {
            evt = JSON.parse(line)
          } catch {
            continue
          }

          // Process both match and context events
          if (evt.type === 'match' || evt.type === 'context') {
            // Handle both text and bytes for non-UTF8 paths
            const filePath = evt.data.path?.text ?? evt.data.path?.bytes ?? ''
            if (isReadPathBlocked(filePath, fileFilter)) {
              continue
            }
            const lineNumber = evt.data.line_number ?? 0
            // Strip trailing newlines to prevent blank lines in output
            const rawText = evt.data.lines?.text ?? ''
            const lineText = truncateMatchLine(rawText.replace(/\r?\n$/, ''))

            // Format as ripgrep output: filename:line_number:content
            const formattedLine = `${filePath}:${lineNumber}:${lineText}`

            // Group by file
            if (!fileGroups.has(filePath)) {
              fileGroups.set(filePath, [])
              fileMatchCounts.set(filePath, 0)
            }
            const fileLines = fileGroups.get(filePath)!
            const fileMatchCount = fileMatchCounts.get(filePath)!

            // Only count matches toward limits, not context lines
            const isMatch = evt.type === 'match'

            // Check if we should include this line
            // For matches: only if we haven't hit the per-file limit
            // For context: always include (they don't count toward limit)
            const shouldInclude = !isMatch || fileMatchCount < maxResults
            if (isMatch && !shouldInclude) {
              filesLimitedByMaxResults.add(filePath)
            }

            if (shouldInclude) {
              // Add the line to output
              fileLines.push(formattedLine)
              estimatedOutputLen += formattedLine.length + 1

              // Only increment match counters for actual matches
              if (isMatch) {
                fileMatchCounts.set(filePath, fileMatchCount + 1)
                matchesGlobal++

                // Check global limit or output size limit
                if (
                  matchesGlobal >= globalMaxResults ||
                  estimatedOutputLen >= maxOutputStringLength
                ) {
                  killedForLimit = true

                  // Build final output from collected matches
                  const limitedLines: string[] = []
                  for (const lines of fileGroups.values()) {
                    limitedLines.push(...lines)
                  }
                  const rawOutput = limitedLines.join('\n')
                  const finalOutput = truncateOutput(
                    formatCollectedOutput(rawOutput),
                    maxOutputStringLength,
                  )

                  const limitReason =
                    matchesGlobal >= globalMaxResults
                      ? `[Global limit of ${globalMaxResults} results reached.]`
                      : '[Output size limit reached.]'
                  settle({
                    stdout: finalOutput + '\n\n' + limitReason,
                    message: `Stopped early after ${matchesGlobal} match(es).`,
                  })
                  stopForOutputLimit()
                  return
                }
              }
            }
          }
        }
      })

      childProcess.once('close', async (code, signal) => {
        const status = await searchExitStatus(node, code, signal)
        if (isResolved) return
        code = status.exitCode

        // Flush any remaining JSON - handle multiple complete lines
        try {
          if (jsonRemainder) {
            // Ensure we have a trailing newline for split to work correctly
            const maybeMany = jsonRemainder.endsWith('\n')
              ? jsonRemainder
              : jsonRemainder + '\n'
            for (const ln of maybeMany.split('\n')) {
              if (!ln) continue
              try {
                const evt = JSON.parse(ln)
                if (evt?.type === 'match' || evt?.type === 'context') {
                  const filePath =
                    evt.data.path?.text ?? evt.data.path?.bytes ?? ''
                  // Same read-policy filter as the streaming path so a final
                  // JSON chunk without a trailing newline cannot leak sensitive
                  // match/context lines via the close-handler remainder flush.
                  if (isReadPathBlocked(filePath, fileFilter)) {
                    continue
                  }
                  const lineNumber = evt.data.line_number ?? 0
                  const rawText = evt.data.lines?.text ?? ''
                  const lineText = truncateMatchLine(
                    rawText.replace(/\r?\n$/, ''),
                  )
                  const formattedLine = `${filePath}:${lineNumber}:${lineText}`

                  if (!fileGroups.has(filePath)) {
                    fileGroups.set(filePath, [])
                    fileMatchCounts.set(filePath, 0)
                  }
                  const fileLines = fileGroups.get(filePath)!
                  const fileMatchCount = fileMatchCounts.get(filePath)!
                  const isMatch = evt.type === 'match'

                  // Check if we should include this line
                  const shouldInclude =
                    !isMatch ||
                    (fileMatchCount < maxResults &&
                      matchesGlobal < globalMaxResults)
                  if (
                    isMatch &&
                    fileMatchCount >= maxResults &&
                    matchesGlobal < globalMaxResults
                  ) {
                    filesLimitedByMaxResults.add(filePath)
                  }

                  if (shouldInclude) {
                    fileLines.push(formattedLine)

                    // Only increment match counter for actual matches
                    if (isMatch) {
                      fileMatchCounts.set(filePath, fileMatchCount + 1)
                      matchesGlobal++
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}

        // Build final output from collected matches
        const limitedLines: string[] = []
        const truncatedFiles: string[] = []

        for (const [filename, fileLines] of fileGroups) {
          limitedLines.push(...fileLines)
          if (filesLimitedByMaxResults.has(filename)) {
            truncatedFiles.push(
              `${filename}: limited to ${maxResults} results per file`,
            )
          }
        }

        let rawOutput = limitedLines.join('\n')

        // Add truncation messages
        const truncationMessages: string[] = []
        if (truncatedFiles.length > 0) {
          truncationMessages.push(
            `Results limited to ${maxResults} per file. Truncated files:\n${truncatedFiles.join('\n')}`,
          )
        }
        if (killedForLimit) {
          truncationMessages.push(
            `Global limit of ${globalMaxResults} results reached.`,
          )
        }

        if (truncationMessages.length > 0) {
          rawOutput += `\n\n[${truncationMessages.join('\n\n')}]`
        }

        // Truncate output to prevent memory issues
        const truncatedStdout = truncateOutput(
          formatCollectedOutput(rawOutput),
          maxOutputStringLength,
        )

        const truncatedStderr = stderrBuf
          ? stderrBuf +
            (stderrBuf.length >= Math.floor(maxOutputStringLength / 5)
              ? '\n\n[Error output truncated]'
              : '')
          : ''

        const exitMessage =
          code !== null
            ? `Exit code: ${code}${killedForLimit ? ' (early stop)' : ''}`
            : ''
        settle({
          stdout: truncatedStdout,
          ...(searchExitError(status, truncatedStderr)
            ? { errorMessage: searchExitError(status, truncatedStderr) }
            : {}),
          ...(truncatedStderr && { stderr: truncatedStderr }),
          ...(code !== null && { exitCode: code }),
          message: cwdWasFile
            ? `${exitMessage}${exitMessage ? ' ' : ''}(cwd was a file; searched that file only)`
            : exitMessage,
        })
      })
    }

    childProcess.once('error', (error) => {
      if (isResolved) return
      settle({
        errorMessage: `Failed to execute ripgrep: ${error.message}. Vendored ripgrep not found; ensure @openbuff/sdk is up-to-date or set CODEBUFF_RG_PATH.`,
      })
    })
  })
}

/** True when `child` is `parent` or a path under it (after both are resolved). */
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

/** Prefer a path relative to searchCwd when under it; otherwise absolute. */
function toRgPathArg(searchCwd: string, realPath: string): string {
  if (isPathInside(searchCwd, realPath)) {
    const relative = path.relative(searchCwd, realPath)
    return relative === '' ? '.' : relative
  }
  return realPath
}
