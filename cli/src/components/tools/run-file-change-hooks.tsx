import { TextAttributes } from '@opentui/core'

import { useTheme } from '../../hooks/use-theme'
import { defineToolComponent } from './types'
import { getToolOutputValues } from '../../utils/tool-result-normalizer'
import { classifyValidationResult } from '../../utils/output-outcome'

import type { ToolRenderConfig } from './types'

type HookResult = {
  hookName?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  errorMessage?: string
  validationStatus?: string
  message?: string
  changedFiles?: string[]
}

export function isHookResultFailed(result: HookResult): boolean {
  return classifyValidationResult(result) === 'failed'
}

export function formatHookRunHeader(results: HookResult[]): string {
  if (results.length === 0) return 'Validation hooks'
  const failed = results.filter(isHookResultFailed).length
  const skipped = results.filter((result) =>
    ['no_hooks_configured', 'hooks_skipped'].includes(
      result.validationStatus ?? '',
    ),
  ).length
  const passed = results.filter(
    (result) => classifyValidationResult(result) === 'passed',
  ).length
  const unknown = results.length - failed - skipped - passed
  if (skipped === results.length) return 'Validation skipped'
  return `Hooks (${passed} passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}${unknown ? `, ${unknown} outcome unknown` : ''})`
}

/**
 * UI component for the run_file_change_hooks tool — the verification gate.
 * Labels the stage "Hooks" so it is visually distinct from generic terminal
 * commands, and surfaces the changed files that triggered the hooks.
 */
export const RunFileChangeHooksComponent = defineToolComponent({
  toolName: 'run_file_change_hooks',

  render(toolBlock, _theme, _options): ToolRenderConfig {
    const theme = useTheme()
    const input = toolBlock.input as { files?: string[] } | undefined
    const files = Array.isArray(input?.files) ? input!.files : []

    const results = getToolOutputValues(toolBlock.outputRaw).flatMap((value) =>
      Array.isArray(value)
        ? (value.filter(
            (entry) =>
              entry && typeof entry === 'object' && !Array.isArray(entry),
          ) as HookResult[])
        : value && typeof value === 'object' && !Array.isArray(value)
          ? [value as HookResult]
          : [],
    )
    const header = results.length
      ? formatHookRunHeader(results)
      : `Validation ${toolBlock.lifecycle === 'queued' || toolBlock.lifecycle === 'running' || toolBlock.lifecycle === 'cancelled' || toolBlock.lifecycle === 'failed' ? toolBlock.lifecycle : 'output unavailable'}`
    const body = files.length > 0 ? files.join(', ') : 'no files'

    const content = (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
            {header}
          </span>
        </text>
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.muted}>{body}</span>
        </text>
        {results.map((result, index) => {
          const isFailed = isHookResultFailed(result)
          const isSkipped = ['no_hooks_configured', 'hooks_skipped'].includes(
            result.validationStatus ?? '',
          )
          const state = classifyValidationResult(result)
          const output = [result.errorMessage, result.stderr, result.stdout]
            .find((value) => typeof value === 'string' && value.trim())
            ?.trim()
            .split('\n')
            .slice(0, 4)
            .join('\n')
          return (
            <box
              key={`${result.hookName ?? 'hook'}-${index}`}
              style={{ flexDirection: 'column' }}
            >
              <text fg={isFailed ? theme.error : theme.muted}>
                {`${isFailed ? '✗' : isSkipped ? '○' : state === 'passed' ? '✓' : '?'} ${result.hookName ?? result.message ?? 'hook'}${typeof result.exitCode === 'number' ? ` (exit ${result.exitCode})` : ''}`}
              </text>
              {output ? <text fg={theme.muted}>{output}</text> : null}
              {[result.stdout, result.stderr, result.errorMessage].some(
                (value) =>
                  typeof value === 'string' && value.split('\n').length > 4,
              ) ||
              [result.stdout, result.stderr, result.errorMessage].filter(
                Boolean,
              ).length > 1 ? (
                <text fg={theme.warning}>
                  Preview limited · Inspect for every retained stream and
                  diagnostic
                </text>
              ) : null}
            </box>
          )
        })}
      </box>
    )

    return {
      content,
      collapsedPreview: header,
    }
  },
})
