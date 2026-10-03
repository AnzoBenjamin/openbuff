import React from 'react'

import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'
import { getStructuredErrorMessages } from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig, ToolRenderOptions } from './types'
import { statusGlyph } from './discovery-results'

type LiLocation = {
  path?: unknown
  range?: {
    start?: { line?: unknown; character?: unknown }
  }
}

type LiSymbol = {
  name?: unknown
  kind?: unknown
  containerName?: unknown
  location?: LiLocation
}

type LiOutput = {
  locations?: unknown
  symbols?: unknown
  hover?: unknown
  unavailable?: unknown
  errorMessage?: unknown
}

const INDENT_LEFT = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractOutput(output: unknown): LiOutput | undefined {
  const outputArray = Array.isArray(output) ? output : [output]
  for (const item of outputArray) {
    if (isRecord(item) && item.type === 'json' && isRecord(item.value)) {
      return item.value as LiOutput
    }
    if (isRecord(item)) return item as LiOutput
  }
  return undefined
}

function extractLocations(output: LiOutput | undefined): LiLocation[] {
  if (!Array.isArray(output?.locations)) return []
  return output.locations.filter(isRecord) as LiLocation[]
}

function extractSymbols(output: LiOutput | undefined): LiSymbol[] {
  if (!Array.isArray(output?.symbols)) return []
  return output.symbols.filter(isRecord) as LiSymbol[]
}

function formatLocation(location: LiLocation): string {
  const path = typeof location.path === 'string' ? location.path : '(unknown)'
  const line = location.range?.start?.line
  const character = location.range?.start?.character
  const lineNum = typeof line === 'number' ? line + 1 : undefined
  const charNum = typeof character === 'number' ? character : undefined
  const pos =
    lineNum !== undefined
      ? `:${lineNum}${charNum !== undefined ? `:${charNum}` : ''}`
      : ''
  return `${path}${pos}`
}

function formatHover(output: LiOutput | undefined): string {
  const hover = output?.hover
  if (!isRecord(hover)) return ''
  const contents = hover.contents
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents
      .map((part) =>
        typeof part === 'string'
          ? part
          : isRecord(part) && typeof part.value === 'string'
            ? part.value
            : '',
      )
      .filter(Boolean)
      .join('\n')
  }
  if (isRecord(contents) && typeof contents.value === 'string') {
    return contents.value
  }
  return ''
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}

function makeLanguageIntelligenceComponent(
  toolName:
    | 'go_to_definition'
    | 'find_references'
    | 'hover_type'
    | 'workspace_symbol',
) {
  const label =
    toolName === 'go_to_definition'
      ? 'Definition'
      : toolName === 'find_references'
        ? 'References'
        : toolName === 'hover_type'
          ? 'Type'
          : 'Symbols'

  return defineToolComponent({
    toolName,

    render(toolBlock, theme, options: ToolRenderOptions): ToolRenderConfig {
      const input = toolBlock.input as Record<string, unknown> | undefined
      const query = typeof input?.query === 'string' ? input.query : ''
      const path = typeof input?.path === 'string' ? input.path : ''
      const line = typeof input?.line === 'number' ? input.line : undefined
      const output = extractOutput(toolBlock.outputRaw ?? toolBlock.output)
      const locations = extractLocations(output)
      const symbols = extractSymbols(output)
      const hoverText = formatHover(output)
      const error =
        getStructuredErrorMessages(toolBlock.outputRaw ?? toolBlock.output)[0] ??
        (typeof output?.errorMessage === 'string' ? output.errorMessage : undefined)
      const unavailableReason =
        isRecord(output?.unavailable) &&
        typeof output.unavailable.reason === 'string'
          ? output.unavailable.reason
          : undefined

      const target =
        toolName === 'workspace_symbol'
          ? `"${query}"`
          : `${path}${line !== undefined ? `:${line}` : ''}`

      const resultCount =
        toolName === 'workspace_symbol' ? symbols.length : locations.length

      let status: string
      if (error) status = 'failed'
      else if (toolBlock.lifecycle === 'queued') status = 'queued'
      else if (toolBlock.lifecycle === 'running' || !output) status = 'running'
      else if (unavailableReason) status = 'unavailable'
      else status = 'ready'
      const { glyph, color } = statusGlyph(status, theme)

      const availableWidth = Math.max(20, options?.availableWidth ?? 80)
      const colWidth = Math.max(10, availableWidth - INDENT_LEFT - 3)

      const summary =
        unavailableReason !== undefined
          ? `${target} — no language server (${unavailableReason})`
          : error
            ? `${target} — error`
            : toolName === 'hover_type'
              ? hoverText
                ? target
                : `${target} — no type info`
              : `${target} — ${resultCount} ${toolName === 'workspace_symbol' ? 'symbol' : 'location'}${resultCount === 1 ? '' : 's'}`

      const Content = () => {
        const theme = useTheme()
        return (
          <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
            <SimpleToolCallItem
              name={label}
              description={
                <>
                  {wrapTextPreservingNewlines(summary, colWidth)}
                  {' '}
                  <span fg={color}>{glyph}</span>
                </>
              }
              descriptionColor={theme.primary}
            />
            <box
              style={{
                flexDirection: 'column',
                gap: 0,
                paddingLeft: INDENT_LEFT,
                width: '100%',
              }}
            >
              {unavailableReason ? (
                <text style={{ wrapMode: 'word' }}>
                  <span fg={theme.muted}>
                    {wrapTextPreservingNewlines(
                      'No language server available for this language. Falling back to grep/index is recommended.',
                      colWidth,
                    )}
                  </span>
                </text>
              ) : null}
              {error ? (
                <text style={{ wrapMode: 'word' }}>
                  <span fg={theme.error}>
                    {wrapTextPreservingNewlines(error, colWidth)}
                  </span>
                </text>
              ) : null}
              {hoverText ? (
                <text style={{ wrapMode: 'word' }}>
                  <span fg={theme.muted}>
                    {wrapTextPreservingNewlines(truncate(hoverText, 600), colWidth)}
                  </span>
                </text>
              ) : null}
              {locations.slice(0, 30).map((location, index) => (
                <text key={`loc-${index}`} style={{ wrapMode: 'word' }}>
                  <span fg={theme.directory}>
                    {wrapTextPreservingNewlines(formatLocation(location), colWidth)}
                  </span>
                </text>
              ))}
              {symbols.slice(0, 30).map((symbol, index) => {
                const name =
                  typeof symbol.name === 'string' ? symbol.name : '(symbol)'
                const container =
                  typeof symbol.containerName === 'string'
                    ? ` · ${symbol.containerName}`
                    : ''
                const loc = symbol.location
                  ? ` · ${formatLocation(symbol.location)}`
                  : ''
                return (
                  <text key={`sym-${index}`} style={{ wrapMode: 'word' }}>
                    <span fg={theme.foreground}>
                      {wrapTextPreservingNewlines(`${name}${container}${loc}`, colWidth)}
                    </span>
                  </text>
                )
              })}
            </box>
          </box>
        )
      }

      return {
        collapsedPreview: `${summary} ${glyph}`,
        content: <Content />,
      }
    },
  })
}

export const GoToDefinitionComponent =
  makeLanguageIntelligenceComponent('go_to_definition')
export const FindReferencesComponent =
  makeLanguageIntelligenceComponent('find_references')
export const HoverTypeComponent = makeLanguageIntelligenceComponent('hover_type')
export const WorkspaceSymbolComponent =
  makeLanguageIntelligenceComponent('workspace_symbol')
