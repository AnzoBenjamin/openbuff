import { TextAttributes } from '@opentui/core'

import { DiffViewer } from './diff-viewer'
import { useTheme } from '../../hooks/use-theme'
import { extractValueForKey } from '../../utils/implementor-helpers'
import {
  getCanonicalMutationActions,
  getCanonicalMutationResult,
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'

import type { PersistedToolBlock } from './registry'
import type { ToolRenderConfig, ToolRenderOptions } from './types'
import type { ChatTheme } from '../../types/theme-system'
import type { RemovedToolName } from '@codebuff/common/tools/metadata'

/**
 * Renderer for the removed patch tools (`apply_patch`, `apply_smart_patch`).
 *
 * Those names are no longer callable, but persisted chat blocks store
 * `toolName` verbatim, and their metadata deliberately stays mutation-kind so
 * restored histories keep counting them. Honouring that claim requires a
 * consumer that understands the persisted call envelopes, which the surviving
 * generic helpers do not: they only read `input.path` / `input.content`, while
 * the removed tools recorded `{ operation: { path, diff } }` or a multi-entry
 * `{ input: [{ path, diff }] }` list. Without this renderer a restored block
 * resolves neither a path nor a diff.
 */
const REMOVED_PATCH_REPLACEMENT = 'edit_transaction'

export type LegacyPatchOperation = {
  path: string | null
  diff: string | null
}

/**
 * Same vocabulary the surviving edit renderer uses, plus `not_applied` for the
 * outcomes that positively record a diff which never reached disk. A recorded
 * diff must never be presented as applied without terminal success evidence.
 */
type LegacyPatchStatus =
  | 'queued'
  | 'pending'
  | 'applied'
  | 'failed'
  | 'cancelled'
  | 'unconfirmed'
  | 'not_applied'

const statusLabel: Record<LegacyPatchStatus, string> = {
  queued: 'queued',
  pending: 'pending',
  applied: 'applied',
  failed: 'failed',
  cancelled: 'cancelled',
  unconfirmed: 'unconfirmed',
  not_applied: 'not applied',
}

/** Every non-applied status is labeled with the literal words `not applied`. */
function describeStatus(status: LegacyPatchStatus): string {
  if (status === 'applied') return statusLabel.applied
  if (status === 'not_applied') return statusLabel.not_applied
  return `${statusLabel[status]} (not applied)`
}

/**
 * Resolve the status of a restored patch block, mirroring `str-replace.tsx`'s
 * `getEditStatus` ordering so both renderers agree on what counts as applied.
 */
function getLegacyPatchStatus(
  toolBlock: PersistedToolBlock,
): LegacyPatchStatus {
  const mutation = getCanonicalMutationResult(toolBlock.outputRaw)
  if (mutation) {
    const outcome = mutation.outcome
    if (outcome === 'applied' || outcome === 'partial') return 'applied'
    if (outcome === 'failed') return 'failed'
    if (outcome === 'unconfirmed') return 'unconfirmed'
    // `not_applied`, `rolled_back` and `rollback_incomplete` all mean the
    // recorded diff is not on disk; a rolled-back patch is not applied.
    return 'not_applied'
  }
  if (getStructuredErrorMessages(toolBlock.outputRaw).length > 0) {
    return 'failed'
  }
  if (toolBlock.lifecycle === 'cancelled') return 'cancelled'
  const hasErrorMessage = getToolOutputRecords(toolBlock.outputRaw).some(
    (record) =>
      typeof record.errorMessage === 'string' &&
      record.errorMessage.trim().length > 0,
  )
  if (hasErrorMessage) return 'failed'

  const output = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  const hasOutput =
    toolBlock.outputRaw !== undefined || output.trim().length > 0
  if (!hasOutput) return toolBlock.queued === true ? 'queued' : 'pending'
  // A non-empty string output is not success evidence by itself: the removed
  // patch tools recorded failure prose the same way. The phrase list is
  // literal and ordered from most specific to least so genuine success prose
  // still resolves to `applied` — none of these phrases occur in messages
  // like `Patch applied successfully.` or `File written successfully`.
  const normalizedOutput = output.trim().toLowerCase()
  const notAppliedPhrases = [
    'no changes were written',
    'no edits were applied',
    'nothing was applied',
    'was not applied',
    'not applied',
    'unable to apply',
    'could not apply',
    'conflict',
    'failed',
  ]
  if (notAppliedPhrases.some((phrase) => normalizedOutput.includes(phrase))) {
    return 'not_applied'
  }
  return 'applied'
}

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Read one legacy operation entry, tolerating every recorded field alias. */
function readOperationEntry(entry: unknown): LegacyPatchOperation | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const path =
    coerceString(record.path) ??
    coerceString(record.file) ??
    coerceString(record.file_path) ??
    coerceString(record.destinationPath)
  const diff =
    coerceString(record.diff) ??
    coerceString(record.patch) ??
    coerceString(record.unifiedDiff)
  if (!path && !diff) return null
  return { path, diff }
}

/** Path/diff recorded on the persisted tool result rather than its input. */
function readRecordedResult(
  toolBlock: PersistedToolBlock,
): LegacyPatchOperation {
  const outputRaw = toolBlock.outputRaw as unknown
  const recorded =
    Array.isArray(outputRaw) && outputRaw[0] && typeof outputRaw[0] === 'object'
      ? readOperationEntry((outputRaw[0] as { value?: unknown }).value)
      : readOperationEntry(outputRaw)
  const output = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  return {
    path:
      recorded?.path ??
      coerceString(extractValueForKey(output, 'file')) ??
      coerceString(extractValueForKey(output, 'path')),
    diff:
      recorded?.diff ??
      coerceString(extractValueForKey(output, 'unifiedDiff')) ??
      coerceString(extractValueForKey(output, 'patch')),
  }
}

/**
 * Resolve the per-file operations a restored removed-patch block recorded, so
 * its diffs stay renderable across every persisted envelope shape.
 */
export function getLegacyPatchOperations(
  toolBlock: PersistedToolBlock,
): LegacyPatchOperation[] {
  const operations: LegacyPatchOperation[] = []
  const push = (entry: unknown) => {
    const operation = readOperationEntry(entry)
    if (operation) operations.push(operation)
  }

  // Blocks recorded after the canonical mutation contract landed.
  for (const action of getCanonicalMutationActions(toolBlock.outputRaw)) {
    push(action)
  }

  if (operations.length === 0) {
    const rawInput = toolBlock.input as unknown
    const input =
      rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {}
    push(input.operation)
    for (const key of ['input', 'operations'] as const) {
      const entries = input[key]
      if (Array.isArray(entries)) entries.forEach(push)
    }
    // Last resort: a flat `{ path, diff }` input.
    if (operations.length === 0) push(input)
  }

  const recorded = readRecordedResult(toolBlock)
  if (operations.length === 0) {
    return recorded.path || recorded.diff ? [recorded] : []
  }
  // The recorded result carries a single diff; only attribute it to the input
  // operations when there is exactly one, otherwise a multi-file block would
  // repeat the same diff on every operation.
  return operations.length === 1
    ? [
        {
          path: operations[0]?.path ?? recorded.path,
          diff: operations[0]?.diff ?? recorded.diff,
        },
      ]
    : operations
}

const LegacyPatchBody = ({
  toolName,
  operations,
  status,
  error,
  availableWidth,
}: {
  toolName: string
  operations: LegacyPatchOperation[]
  status: LegacyPatchStatus
  error: string | null
  availableWidth: number
}) => {
  const theme = useTheme()
  const statusColor =
    status === 'failed'
      ? theme.error
      : status === 'applied'
        ? theme.success
        : status === 'queued'
          ? theme.muted
          : theme.warning

  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      <text style={{ wrapMode: 'word' }}>
        <span fg={theme.foreground}>• </span>
        <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
          Legacy patch
        </span>
        <span fg={theme.muted}>{` ${toolName} removed`}</span>
        <span fg={statusColor}>{` ${describeStatus(status)}`}</span>
      </text>
      <box style={{ paddingLeft: 2, width: '100%' }}>
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.muted}>
            {`Restored from history. \`${toolName}\` can no longer be called; use \`${REMOVED_PATCH_REPLACEMENT}\` for new edits.`}
          </span>
        </text>
      </box>
      {error ? (
        <box style={{ paddingLeft: 2, width: '100%' }}>
          <text style={{ wrapMode: 'word' }}>
            <span fg={theme.error}>{error}</span>
          </text>
        </box>
      ) : null}
      {operations.map((operation, index) => (
        <box
          key={`${index}-${operation.path ?? 'unknown'}`}
          style={{ flexDirection: 'column', paddingLeft: 2, width: '100%' }}
        >
          <text style={{ wrapMode: 'word' }}>
            {operation.path ?? 'unknown file'}
          </text>
          {operation.diff ? (
            <DiffViewer
              diffText={operation.diff}
              availableWidth={Math.max(10, availableWidth - 4)}
            />
          ) : null}
        </box>
      ))}
    </box>
  )
}

/**
 * `apply_patch` / `apply_smart_patch` are removed, so their names are not part
 * of the live `ToolName` union. The renderer is therefore typed by the
 * removed-name set instead of asserting a removed name back into `ToolName`,
 * while staying structurally compatible with the CLI tool registry.
 */
export type LegacyPatchToolComponent = {
  toolName: RemovedToolName
  render(
    toolBlock: PersistedToolBlock,
    theme: ChatTheme,
    options: ToolRenderOptions,
  ): ToolRenderConfig
}

export const ApplyPatchComponent: LegacyPatchToolComponent = {
  toolName: 'apply_patch',

  render(toolBlock, _theme, options): ToolRenderConfig {
    const operations = getLegacyPatchOperations(toolBlock)
    const error = getStructuredErrorMessages(toolBlock.outputRaw)[0] ?? null
    const status = getLegacyPatchStatus(toolBlock)
    const primaryPath =
      operations.find((operation) => operation.path)?.path ?? undefined
    // The preview is the string-inspectable surface, so it carries the status
    // too: a non-applied block must not read like a successful patch.
    const filesText =
      operations.length > 0
        ? `${operations.length} file${operations.length === 1 ? '' : 's'}`
        : 'removed tool'
    const collapsedPreview = `Legacy patch • ${describeStatus(status)} • ${filesText}${
      error ? ` • ${error}` : ''
    }`

    return {
      path: primaryPath,
      collapsedPreview,
      content: (
        <LegacyPatchBody
          toolName={String(toolBlock.toolName)}
          operations={operations}
          status={status}
          error={error}
          availableWidth={options.availableWidth}
        />
      ),
    }
  },
}
