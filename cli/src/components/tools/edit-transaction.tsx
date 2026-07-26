import { TextAttributes } from '@opentui/core'

import { DiffViewer } from './diff-viewer'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import {
  getCanonicalMutationResult,
  getStructuredErrorMessages,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig, ToolBlock } from './types'

type TransactionFile = {
  path: string
  destinationPath?: string
  diff: string | null
}

// Mirrors the `queued` distinction in str-replace.tsx: a write tool call that
// is waiting on a prior same-path write (or the custom-tool barrier for
// multi-path transactions) shows "queued" instead of "pending" until its
// per-path barrier resolves and a `tool_start` event flips `queued` to false.
function isQueued(toolBlock: ToolBlock): boolean {
  const hasOutput =
    toolBlock.outputRaw !== undefined ||
    (typeof toolBlock.output === 'string' && toolBlock.output.trim().length > 0)
  return !hasOutput && toolBlock.queued === true
}

function getTransactionValue(
  toolBlock: ToolBlock,
): Record<string, unknown> | null {
  const outputRaw = toolBlock.outputRaw
  if (Array.isArray(outputRaw) && outputRaw[0]?.value) {
    return outputRaw[0].value as Record<string, unknown>
  }
  if (typeof outputRaw === 'object' && outputRaw !== null) {
    return outputRaw as Record<string, unknown>
  }
  return null
}

function getTransactionFiles(toolBlock: ToolBlock): TransactionFile[] {
  const canonical = getCanonicalMutationResult(toolBlock.outputRaw)
  if (canonical && Array.isArray(canonical.actions)) {
    return canonical.actions.map((raw) => {
      const action = raw as Record<string, unknown>
      return {
        path: String(action.path),
        destinationPath:
          typeof action.destinationPath === 'string'
            ? action.destinationPath
            : undefined,
        diff: typeof action.patch === 'string' ? action.patch : null,
      }
    })
  }
  const value = getTransactionValue(toolBlock)
  if (!value || !Array.isArray(value.files)) return []

  return value.files
    .map((file) => {
      const entry = file as Record<string, unknown>
      const path =
        typeof entry.path === 'string'
          ? entry.path
          : typeof entry.file === 'string'
            ? entry.file
            : ''
      if (!path) return null
      const diff =
        typeof entry.patch === 'string'
          ? entry.patch
          : typeof entry.unifiedDiff === 'string'
            ? entry.unifiedDiff
            : null
      return { path, diff }
    })
    .filter((entry): entry is TransactionFile => Boolean(entry))
}

const REDACTED_CAPABILITY = '[REDACTED]'

function redactCapabilityText(text: string): string {
  return text
    .replace(
      /(\b(?:basedOnRead|readCapability)\b\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
      `$1${REDACTED_CAPABILITY}`,
    )
    .replace(/cap\.v3\.[A-Za-z0-9._-]+/g, REDACTED_CAPABILITY)
}

function getTransactionError(toolBlock: ToolBlock): string | null {
  const value = getTransactionValue(toolBlock)
  if (value && typeof value.errorMessage === 'string') {
    return redactCapabilityText(value.errorMessage)
  }
  if (value && typeof value.error === 'string') {
    return redactCapabilityText(value.error)
  }
  const errors = getStructuredErrorMessages(toolBlock.outputRaw)
  return errors.length > 0
    ? redactCapabilityText(errors.join('\n'))
    : null
}

function getPostEditAnchorLabel(
  action: Record<string, unknown>,
  mutation: Record<string, unknown>,
): string {
  const anchor = action.editAnchor
  const receipt = mutation.authorityReceipt
  if (
    action.outcome !== 'applied' ||
    !anchor ||
    typeof anchor !== 'object' ||
    Array.isArray(anchor) ||
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt)
  ) {
    return ''
  }
  const value = anchor as Record<string, unknown>
  const authority = receipt as Record<string, unknown>
  const receiptActions = Array.isArray(authority.actions)
    ? authority.actions
    : []
  const finalHashes =
    authority.finalHashes &&
    typeof authority.finalHashes === 'object' &&
    !Array.isArray(authority.finalHashes)
      ? (authority.finalHashes as Record<string, unknown>)
      : null
  const effectiveTarget =
    action.action === 'move' ? action.destinationPath : action.path
  const indexMatches = receiptActions.filter(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).index === action.index,
  )
  const actionIdMatches = receiptActions.filter(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).actionId === action.actionId,
  )
  const committed =
    indexMatches.length === 1 &&
    actionIdMatches.length === 1 &&
    indexMatches[0] === actionIdMatches[0]
      ? (indexMatches[0] as Record<string, unknown>)
      : null
  if (
    mutation.kind !== 'file_mutation_result' ||
    mutation.version !== 1 ||
    (mutation.outcome !== 'applied' && mutation.outcome !== 'partial') ||
    mutation.operationId !== authority.operationId ||
    mutation.receiptId !== authority.receiptId ||
    mutation.authorityTier !== authority.authorityTier ||
    !Array.isArray(mutation.errors) ||
    !Array.isArray(mutation.freshCapabilities) ||
    authority.kind !== 'commit_receipt' ||
    authority.version !== 1 ||
    authority.status !== 'committed' ||
    typeof authority.operationId !== 'string' ||
    authority.operationId.length === 0 ||
    typeof authority.receiptId !== 'string' ||
    authority.receiptId.length === 0 ||
    typeof authority.callId !== 'string' ||
    authority.callId.length === 0 ||
    typeof authority.authorityTier !== 'string' ||
    authority.authorityTier.length === 0 ||
    !Array.isArray(authority.actions) ||
    finalHashes === null ||
    !Number.isInteger(action.index) ||
    (action.index as number) < 0 ||
    typeof action.actionId !== 'string' ||
    action.actionId.length === 0 ||
    committed === null ||
    committed.status !== 'committed' ||
    committed.action !== action.action ||
    committed.path !== action.path ||
    committed.destinationPath !== action.destinationPath ||
    committed.afterHash !== action.afterHash ||
    typeof effectiveTarget !== 'string' ||
    effectiveTarget.length === 0 ||
    typeof action.afterHash !== 'string' ||
    finalHashes[effectiveTarget] !== action.afterHash ||
    !Number.isInteger(value.startLine) ||
    (value.startLine as number) < 1 ||
    !Number.isInteger(value.endLine) ||
    (value.endLine as number) < (value.startLine as number) ||
    value.contentHash !== action.afterHash ||
    !/^sha256:[a-f0-9]{64}$/i.test(value.contentHash as string) ||
    typeof value.readCapability !== 'string' ||
    !value.readCapability.startsWith('cap.v3.') ||
    value.readCapability.length > 4096
  ) {
    return ''
  }
  const shortHash = (value.contentHash as string)
    .slice('sha256:'.length)
    .slice(0, 16)
  return ` • post-edit ${shortHash} • fresh capability available`
}

function getTransactionRows(toolBlock: ToolBlock): string[] {
  const canonical = getCanonicalMutationResult(toolBlock.outputRaw)
  if (canonical && Array.isArray(canonical.actions)) {
    const mutation = canonical as Record<string, unknown>
    return canonical.actions.map((raw) => {
      const action = raw as Record<string, unknown>
      const rollback = action.rollback as Record<string, unknown> | undefined
      const error = action.error as Record<string, unknown> | undefined
      const pathLabel =
        action.action === 'move' && typeof action.destinationPath === 'string'
          ? `${String(action.path)} → ${action.destinationPath}`
          : String(action.path)
      const actionNumber =
        typeof action.index === 'number' && action.index >= 0
          ? action.index + 1
          : '?'
      return `${String(actionNumber)}. ${pathLabel} • ${String(action.action)} • ${String(action.outcome)}${getPostEditAnchorLabel(action, mutation)}${rollback?.attempted ? ` • rollback ${rollback.succeeded ? 'succeeded' : 'failed'}` : ''}${error?.message ? ` • ${redactCapabilityText(String(error.message))}` : ''}`
    })
  }
  const value = getTransactionValue(toolBlock)
  if (!value || !Array.isArray(value.failures)) return []
  return value.failures.map((raw) => {
    const failure = raw as Record<string, unknown>
    const editNumber =
      typeof failure.editIndex === 'number' && failure.editIndex >= 0
        ? failure.editIndex + 1
        : '?'
    return `${String(editNumber)}. ${String(failure.path ?? failure.id ?? 'unknown')} • ${redactCapabilityText(String(failure.errorMessage ?? failure.error ?? 'failed'))}`
  })
}

const TransactionHeader = ({
  name,
  queued,
}: {
  name: string
  queued: boolean
}) => {
  const theme = useTheme()
  return (
    <text style={{ wrapMode: 'word' }}>
      <span fg={theme.foreground}>• </span>
      <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
        {name}
      </span>
      {queued ? <span fg={theme.muted}>{' queued'}</span> : null}
    </text>
  )
}

export const EditTransactionComponent = defineToolComponent({
  toolName: 'edit_transaction',

  render(toolBlock, _theme, options): ToolRenderConfig {
    const files = getTransactionFiles(toolBlock)
    const error = getTransactionError(toolBlock)
    const rows = getTransactionRows(toolBlock)
    const queued = isQueued(toolBlock)
    const mutation = getCanonicalMutationResult(toolBlock.outputRaw)
    const title = 'Edit transaction'
    const collapsedPreview = error
      ? error.split('\n')[0]
      : files.length > 0
        ? `${title} • ${files.length} file${files.length === 1 ? '' : 's'}`
        : queued
          ? `${title} queued...`
          : `${title} pending...`

    return {
      collapsedPreview,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <TransactionHeader
            name={`${title}${toolBlock.lifecycle === 'cancelled' ? ' cancelled' : mutation ? ` ${String(mutation.outcome)}` : ''}`}
            queued={queued}
          />
          {error ? (
            <box style={{ paddingLeft: 2, width: '100%' }}>
              <text style={{ wrapMode: 'word' }}>{error}</text>
            </box>
          ) : null}
          {rows.map((row, index) => (
            <text
              key={`${index}-${row}`}
              fg={_theme.muted}
              style={{ wrapMode: 'word' }}
            >
              {row}
            </text>
          ))}
          {files.map((file) => (
            <box
              key={file.path}
              style={{ flexDirection: 'column', paddingLeft: 2, width: '100%' }}
            >
              <text style={{ wrapMode: 'word' }}>{file.path}</text>
              {file.diff ? (
                <DiffViewer
                  diffText={file.diff}
                  availableWidth={Math.max(10, options.availableWidth - 4)}
                />
              ) : null}
            </box>
          ))}
        </box>
      ),
    }
  },
})
