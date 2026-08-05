import { defineToolComponent } from './types'
import { TerminalCommandDisplay } from '../terminal-command-display'

import type { ToolRenderConfig } from './types'

export interface ParsedTerminalOutput {
  output: string | null
  startingCwd?: string
  jobId?: string
  status?: string
  detached?: boolean
  logFile?: string
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
    const value = Array.isArray(parsed) ? parsed[0]?.value : parsed
    if (value) {
      const startingCwd = value.startingCwd
      const metadata = {
        startingCwd,
        jobId: typeof value.jobId === 'string' ? value.jobId : undefined,
        status:
          typeof value.backgroundProcessStatus === 'string'
            ? value.backgroundProcessStatus
            : undefined,
        detached:
          typeof value.detached === 'boolean' ? value.detached : undefined,
        logFile: typeof value.logFile === 'string' ? value.logFile : undefined,
      }
      // Handle error case
      if (value.errorMessage) {
        return { output: `Error: ${value.errorMessage}`, ...metadata }
      }
      // Combine stdout and stderr for display
      // Use trimEnd() to preserve leading spaces (used for UI elements like trees/tables)
      const stdout = value.stdout || ''
      const stderr = value.stderr || ''
      const output = (stdout + stderr).trimEnd() || null
      return { output, ...metadata }
    }
    return { output: null }
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
    } = parseTerminalOutput(toolBlock.output)

    // Prefer the live tool-block correlation id + lifecycle over the frozen
    // backgroundProcessStatus string baked into the initial tool_result JSON
    // (which stays "running" even after job_update settles the card).
    const jobId = toolBlock.backgroundJobId ?? parsedJobId
    const isBackgroundJob = Boolean(jobId)
    const lifecycleStatus = lifecycleToDisplayStatus(toolBlock.lifecycle)
    const status = isBackgroundJob
      ? (lifecycleStatus ?? parsedStatus)
      : parsedStatus
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
        isRunning={isRunning}
        detached={detached}
        logFile={logFile}
        timeoutSeconds={timeoutSeconds}
        availableWidth={options.availableWidth}
      />
    )

    return {
      content,
      collapsedPreview: `$ ${command}`,
    }
  },
})
