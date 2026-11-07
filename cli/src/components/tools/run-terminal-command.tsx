import { defineToolComponent } from './types'
import { TerminalCommandDisplay } from '../terminal-command-display'
import {
  getToolOutputRecords,
  getToolOutputValues,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

export interface ParsedTerminalOutput {
  output: string | null
  startingCwd?: string
  jobId?: string
  status?: string
  detached?: boolean
  logFile?: string
  exitCode?: number
  stdout?: string
  stderr?: string
}

export function parseTerminalResult(
  raw: unknown,
  fallback?: string,
): ParsedTerminalOutput {
  const value = getToolOutputRecords(raw)[0]
  if (!value) {
    const captured = getToolOutputValues(raw)
    return {
      output:
        captured.length === 1 &&
        (captured[0] === null ||
          ['string', 'number', 'boolean'].includes(typeof captured[0]))
          ? String(captured[0])
          : (fallback ?? null),
    }
  }
  const stdout = typeof value.stdout === 'string' ? value.stdout : ''
  const stderr = typeof value.stderr === 'string' ? value.stderr : ''
  const error =
    typeof value.errorMessage === 'string' ? `Error: ${value.errorMessage}` : ''
  const exitCode =
    typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
      ? value.exitCode
      : undefined
  return {
    output: error
      ? [error, stdout, stderr].filter(Boolean).join('\n')
      : stdout + stderr,
    stdout,
    stderr,
    exitCode,
    startingCwd:
      typeof value.startingCwd === 'string' ? value.startingCwd : undefined,
    jobId: typeof value.jobId === 'string' ? value.jobId : undefined,
    logFile: typeof value.logFile === 'string' ? value.logFile : undefined,
    detached: typeof value.detached === 'boolean' ? value.detached : undefined,
    status:
      value.timedOut === true
        ? 'timed out'
        : error || (exitCode !== undefined && exitCode !== 0)
          ? 'error'
          : typeof value.backgroundProcessStatus === 'string'
            ? value.backgroundProcessStatus
            : exitCode === 0
              ? 'completed'
              : undefined,
  }
}

/**
 * Parse terminal command output from JSON or raw string format.
 * Exported for testing.
 */
export const parseTerminalOutput = (
  rawOutput: string | undefined,
): ParsedTerminalOutput => {
  if (!rawOutput) {
    return { output: null }
  }

  try {
    const parsed = JSON.parse(rawOutput)
    // Handle array format [{ type: 'json', value: {...} }]
    const value = Array.isArray(parsed)
      ? parsed.find((part) => part?.type === 'json')?.value
      : parsed
    // Legacy direct results must carry terminal fields. Arbitrary JSON from
    // a command is content, not a tool envelope.
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      [
        'stdout',
        'stderr',
        'errorMessage',
        'backgroundProcessStatus',
        'exitCode',
      ].some((key) => key in value)
    ) {
      const startingCwd =
        typeof value.startingCwd === 'string' ? value.startingCwd : undefined
      const stdout = typeof value.stdout === 'string' ? value.stdout : ''
      const stderr = typeof value.stderr === 'string' ? value.stderr : ''
      const exitCode =
        typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
          ? value.exitCode
          : undefined
      const metadata = {
        startingCwd,
        stdout,
        stderr,
        exitCode,
        jobId: typeof value.jobId === 'string' ? value.jobId : undefined,
        status:
          typeof value.backgroundProcessStatus === 'string'
            ? value.backgroundProcessStatus
            : value.timedOut === true
              ? 'timed out'
              : exitCode === undefined
                ? undefined
                : exitCode === 0
                  ? 'completed'
                  : 'error',
        detached:
          typeof value.detached === 'boolean' ? value.detached : undefined,
        logFile: typeof value.logFile === 'string' ? value.logFile : undefined,
      }
      // Handle error case
      if (value.errorMessage) {
        return {
          ...metadata,
          status: value.timedOut === true ? 'timed out' : 'error',
          output: [`Error: ${value.errorMessage}`, stdout, stderr]
            .filter(Boolean)
            .join('\n')
            .trimEnd(),
        }
      }
      // Combine stdout and stderr for display
      // Use trimEnd() to preserve leading spaces (used for UI elements like trees/tables)
      const output = (stdout + stderr).trimEnd() || null
      return { output, ...metadata }
    }
    return { output: rawOutput.trimEnd() || null }
  } catch {
    // If not JSON, use raw output (preserve leading spaces)
    return { output: rawOutput.trimEnd() || null }
  }
}

/**
 * UI component for run_terminal_command tool.
 * Displays the command in bold next to the bullet point,
 * with the output indented below.
 */
/** Map tool-block lifecycle to the status string shown in the terminal card. */
const lifecycleToDisplayStatus = (
  lifecycle: string | undefined,
): string | undefined => {
  switch (lifecycle) {
    case 'queued':
    case 'running':
      return 'running'
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

export const RunTerminalCommandComponent = defineToolComponent({
  toolName: 'run_terminal_command',

  render(toolBlock, _theme, options): ToolRenderConfig {
    // Extract command and timeout from input
    const input = toolBlock.input as
      | { command?: string; timeout_seconds?: number }
      | undefined
    const command =
      typeof input?.command === 'string' ? input.command.trim() : ''
    const timeoutSeconds =
      typeof input?.timeout_seconds === 'number'
        ? input.timeout_seconds
        : undefined

    // Extract output and startingCwd from tool result
    const {
      output,
      startingCwd,
      jobId: parsedJobId,
      status: parsedStatus,
      detached,
      logFile,
      exitCode,
    } = toolBlock.outputRaw !== undefined
      ? parseTerminalResult(toolBlock.outputRaw, toolBlock.output)
      : parseTerminalOutput(toolBlock.output)

    // Prefer the live tool-block correlation id + lifecycle over the frozen
    // backgroundProcessStatus string baked into the initial tool_result JSON
    // (which stays "running" even after job_update settles the card).
    const jobId = toolBlock.backgroundJobId ?? parsedJobId
    const isBackgroundJob = Boolean(jobId)
    const lifecycleStatus = lifecycleToDisplayStatus(toolBlock.lifecycle)
    const status =
      parsedStatus === 'error' || parsedStatus === 'timed out'
        ? parsedStatus
        : (lifecycleStatus ?? parsedStatus)
    const isRunning =
      toolBlock.lifecycle === 'running' ||
      toolBlock.lifecycle === 'queued' ||
      // Pre-result or missing lifecycle: fall back to parsed BACKGROUND status.
      (toolBlock.lifecycle === undefined &&
        isBackgroundJob &&
        parsedStatus === 'running')

    // Custom content component using shared TerminalCommandDisplay
    const content = (
      <TerminalCommandDisplay
        command={command}
        output={output}
        expandable={true}
        maxVisibleLines={5}
        cwd={startingCwd}
        jobId={jobId}
        status={status}
        exitCode={exitCode}
        isRunning={isRunning}
        detached={detached}
        logFile={logFile}
        timeoutSeconds={timeoutSeconds}
        availableWidth={options.availableWidth}
      />
    )

    return {
      content,
      collapsedPreview: `$ ${command}${status ? ` · ${status}` : ''}${exitCode !== undefined ? ` · exit ${exitCode}` : ''}`,
    }
  },
})
