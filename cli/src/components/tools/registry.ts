import { ApplyPatchComponent } from './apply-patch'
import { CodeSearchComponent } from './code-search'
import { EditTransactionComponent } from './edit-transaction'
import { GlobComponent } from './glob'
import { GitStatusComponent } from './git-status'
import { ListDirectoryComponent } from './list-directory'
import { QueryIndexComponent } from './query-index'
import { ReadDocsComponent } from './read-docs'
import { ReadFilesComponent } from './read-files'
import { ReadSubtreeComponent } from './read-subtree'
import { RenderUIComponent } from './render-ui'
import { RunFileChangeHooksComponent } from './run-file-change-hooks'
import { RunTerminalCommandComponent } from './run-terminal-command'
import { SkillComponent } from './skill'
import { SpawnAgentsComponent } from './spawn-agents'
import { StrReplaceComponent } from './str-replace'
import { SuggestFollowupsComponent } from './suggest-followups'
import { TaskCompleteComponent } from './task-completed'
import { WriteFileComponent } from './write-file'
import { WriteTodosComponent } from './write-todos'
import {
  CheckJobComponent,
  KillJobComponent,
  ReadLogsComponent,
} from './background-job-tools'

import type { ToolRenderConfig, ToolRenderOptions, ToolBlock } from './types'
import type { ChatTheme } from '../../types/theme-system'
import type { ToolName } from '@openbuff/sdk'
import type { RemovedToolName } from '@codebuff/common/tools/metadata'
import {
  getToolMetadata,
  removedToolNames,
  toolMetadata,
} from '@codebuff/common/tools/metadata'
import { toolNames } from '@codebuff/common/tools/constants'

/**
 * Every name this registry can be keyed by. Removed tools (`apply_patch`,
 * `apply_smart_patch`) are no longer members of the live `ToolName` union, but
 * persisted blocks still carry them verbatim, so the registry widens its key
 * type instead of asserting removed names back into `ToolName`.
 */
export type RegisteredToolName = ToolName | RemovedToolName

/**
 * A tool block as restored from persisted history. The persisted block type
 * declares `toolName: ToolName`, which no longer contains removed names such as
 * `apply_patch`, so this widens the field to the names restored sessions
 * actually carry (removed, custom, or MCP) and keeps such blocks representable
 * without a cast.
 */
export type PersistedToolBlock = Omit<ToolBlock, 'toolName'> & {
  toolName: RegisteredToolName | (string & {})
}

/**
 * A registry entry. Declared with method syntax so a component specialized to a
 * single native tool name stays assignable, and keyed by `RegisteredToolName`
 * so a removed-tool renderer needs no cast.
 */
export type RegisteredToolComponent = {
  toolName: RegisteredToolName
  render(
    toolBlock: PersistedToolBlock,
    theme: ChatTheme,
    options: ToolRenderOptions,
  ): ToolRenderConfig
}

/**
 * Registry of all tool-specific UI components.
 * Add new tool components here to make them available in the CLI.
 */
const toolComponentRegistry = new Map<
  RegisteredToolName,
  RegisteredToolComponent
>([
  [CodeSearchComponent.toolName, CodeSearchComponent],
  [GlobComponent.toolName, GlobComponent],
  [GitStatusComponent.toolName, GitStatusComponent],
  [ListDirectoryComponent.toolName, ListDirectoryComponent],
  [QueryIndexComponent.toolName, QueryIndexComponent],
  [RunFileChangeHooksComponent.toolName, RunFileChangeHooksComponent],
  [RunTerminalCommandComponent.toolName, RunTerminalCommandComponent],
  [CheckJobComponent.toolName, CheckJobComponent],
  [ReadLogsComponent.toolName, ReadLogsComponent],
  [KillJobComponent.toolName, KillJobComponent],
  [ReadDocsComponent.toolName, ReadDocsComponent],
  [ReadFilesComponent.toolName, ReadFilesComponent],
  [ReadSubtreeComponent.toolName, ReadSubtreeComponent],
  [RenderUIComponent.toolName, RenderUIComponent],
  [WriteTodosComponent.toolName, WriteTodosComponent],
  [StrReplaceComponent.toolName, StrReplaceComponent],
  [EditTransactionComponent.toolName, EditTransactionComponent],
  [SuggestFollowupsComponent.toolName, SuggestFollowupsComponent],
  [WriteFileComponent.toolName, WriteFileComponent],
  [TaskCompleteComponent.toolName, TaskCompleteComponent],
  ['replace_range', StrReplaceComponent],
  // Removed edit tools still appear verbatim in restored sessions and keep
  // mutation-kind metadata, so they need a renderer that understands their
  // persisted `{ operation: { path, diff } }` / `{ input: [...] }` envelopes.
  ['apply_patch', ApplyPatchComponent],
  ['apply_smart_patch', ApplyPatchComponent],
  [SkillComponent.toolName, SkillComponent],
  [SpawnAgentsComponent.toolName, SpawnAgentsComponent],
])

/**
 * String-keyed read view of the registry. Restored sessions persist `toolName`
 * verbatim and can carry any string (removed, custom, or MCP tool), so lookups
 * accept a plain string without widening the registry's own key type.
 */
const toolComponentsByName: ReadonlyMap<string, RegisteredToolComponent> =
  toolComponentRegistry

/**
 * Register a new tool component.
 * This allows plugins or extensions to add custom tool renderers.
 *
 * Typed by `RegisteredToolComponent` so the registration entry point can
 * express every renderer shape the registry stores, including renderers for
 * removed tool names that are no longer members of the live `ToolName` union.
 *
 * @param component - The tool component to register
 */
export function registerToolComponent(
  component: RegisteredToolComponent,
): void {
  toolComponentRegistry.set(component.toolName, component)
}

/**
 * Get the registered component for a specific tool name. The parameter accepts
 * any persisted string because restored blocks are not limited to live tool
 * names.
 *
 * @param toolName - The name of the tool
 * @returns The tool component, or undefined if not registered
 */
export function getToolComponent(
  toolName: RegisteredToolName | (string & {}),
): RegisteredToolComponent | undefined {
  return toolComponentsByName.get(toolName)
}

/**
 * Render a tool using its registered component, or return null for default rendering.
 * This is the main entry point for the tool rendering system.
 *
 * @param toolBlock - The tool block to render
 * @param theme - The current chat theme
 * @param options - Rendering options
 * @returns Render configuration, or null to use default rendering
 */
export function renderToolComponent(
  toolBlock: PersistedToolBlock,
  theme: ChatTheme,
  options: ToolRenderOptions,
): ToolRenderConfig | undefined {
  const component = getToolComponent(toolBlock.toolName)

  if (component === undefined) {
    return undefined
  }

  try {
    return component.render(toolBlock, theme, options)
  } catch (error) {
    console.error(
      `Error rendering tool component for ${toolBlock.toolName}:`,
      error,
    )
    return undefined
  }
}

/**
 * Get all registered tool names. The registry also holds removed names kept
 * renderable for restored sessions, so the return type is the wider
 * `RegisteredToolName` set rather than the live `ToolName` union.
 * Useful for debugging or listing available tool renderers.
 */
export function getRegisteredToolNames(): RegisteredToolName[] {
  return Array.from(toolComponentRegistry.keys())
}

export type ToolRendererDisposition = 'custom' | 'fallback' | 'hidden'

/**
 * Metadata is the exhaustive source of truth; registration may only enhance
 * fallback. Restored sessions persist `toolName` verbatim and can carry names of
 * removed tools (e.g. `apply_patch`), so the lookup goes through the total
 * `getToolMetadata` accessor rather than indexing the native-only record.
 */
export function getToolRendererDisposition(
  toolName: ToolName | (string & {}),
): ToolRendererDisposition {
  const intent = getToolMetadata(toolName).renderer
  if (intent === 'hidden') return 'hidden'
  return toolComponentsByName.has(toolName) ? 'custom' : 'fallback'
}

export const toolRendererDispositions = Object.fromEntries(
  toolNames.map((toolName) => [toolName, getToolRendererDisposition(toolName)]),
) as Record<ToolName, ToolRendererDisposition>

for (const toolName of toolNames) {
  if (
    toolMetadata[toolName].renderer === 'custom' &&
    !toolComponentRegistry.has(toolName)
  ) {
    throw new Error(`Missing metadata-declared custom renderer: ${toolName}`)
  }
}

// Removed mutation-kind tools claim that restored blocks still render their
// recorded diffs (see common/src/tools/metadata.ts). Registration may only
// enhance a `fallback` metadata intent, so keep that claim backed by a real
// surviving renderer instead of the generic fallback path, which reads only
// `input.path` / `input.content` and resolves nothing for a legacy envelope.
for (const toolName of removedToolNames) {
  if (
    getToolMetadata(toolName).kind === 'mutation' &&
    !toolComponentRegistry.has(toolName)
  ) {
    throw new Error(
      `Missing renderer for removed mutation-kind tool: ${toolName}`,
    )
  }
}
