import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import { getToolOutputValues } from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

/**
 * UI component for read_subtree tool.
 * Render a single-line summary like other simple tools
 * (e.g., Read, List) without an extra collapsible header.
 */
export const ReadSubtreeComponent = defineToolComponent({
  toolName: 'read_subtree',

  render(toolBlock): ToolRenderConfig {
    const input = toolBlock.input as any
    const paths: string[] = Array.isArray(input?.paths)
      ? input.paths.filter((p: any) => typeof p === 'string' && p.trim().length)
      : []

    const displayPath: string =
      typeof input?.path === 'string' && input.path.trim().length > 0
        ? input.path.trim()
        : paths[0] || ''

    const finalPath = displayPath || '.'
    const entries = getToolOutputValues(toolBlock.outputRaw).flatMap((value) =>
      Array.isArray(value) ? value : [],
    ) as Array<Record<string, unknown>>
    const failures = entries.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        (typeof entry.errorMessage === 'string' ||
          (Array.isArray(entry.errors) && entry.errors.length > 0)),
    )
    const truncated = entries.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        (entry.stale === true ||
          entry.symbolsMayBeStale === true ||
          entry.provenance === 'cached' ||
          entry.variablesSource === 'cached' ||
          entry.status === 'partial' ||
          entry.printedTreeOmittedForLength === true ||
          entry.variablesOmittedForLength === true ||
          entry.liveScanTruncated === true ||
          (typeof entry.truncationLevel === 'string' &&
            entry.truncationLevel !== 'none')),
    )
    const statusName =
      toolBlock.lifecycle === 'cancelled'
        ? 'Subtree cancelled'
        : entries.length > 0 && entries.every(entry => typeof entry.errorMessage === 'string')
          ? 'Subtree failed'
          : failures.length > 0 || truncated.length > 0
            ? 'Subtree partial'
            : 'List deeply'

    // Use a wrapper component to access theme
    const ReadSubtreeContent = () => {
      const theme = useTheme()
      const notices = [
        entries.some(entry => entry?.provenance === 'cached' || entry?.variablesSource === 'cached') ? 'cached snapshot' : '',
        entries.some(entry => entry?.stale === true || entry?.symbolsMayBeStale === true) ? 'stale evidence' : '',
        entries.some(entry => entry?.printedTreeOmittedForLength === true) ? 'tree omitted for length' : '',
        entries.some(entry => entry?.variablesOmittedForLength === true) ? 'symbols omitted for length' : '',
        entries.some(entry => entry?.liveScanTruncated === true) ? 'live scan limited' : '',
      ].filter(Boolean)
      const scanErrors = entries.reduce((count, entry) => count + (Array.isArray(entry?.errors) ? entry.errors.length : 0), 0)
      if (scanErrors) notices.push(`${scanErrors} scan error${scanErrors === 1 ? '' : 's'}`)
      const scope = paths.length > 1 ? `${paths.length} requested scopes · ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ' · Inspect for all scopes' : ''}` : finalPath
      const recovery = failures.find(entry => typeof entry.errorMessage === 'string')?.errorMessage ?? truncated.find(entry => typeof entry.recovery === 'string')?.recovery
      return (
        <SimpleToolCallItem
          name={statusName}
          description={[scope, ...notices, recovery].filter(Boolean).join(' · ')}
          descriptionColor={theme.directory}
        />
      )
    }

    return {
      content: <ReadSubtreeContent />,
    }
  },
})
