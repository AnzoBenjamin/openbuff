import { TextAttributes } from '@opentui/core'

import { LRUCache } from '@codebuff/common/util/lru-cache'

import { DiffViewer } from './diff-viewer'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import {
  getCanonicalMutationResult,
  getStructuredErrorMessages,
} from '../../utils/tool-result-normalizer'

import type { ToolResultRecord } from '../../utils/tool-result-normalizer'
import type { ToolRenderConfig, ToolBlock } from './types'

type TransactionFile = {
  path: string
  destinationPath?: string
  diff: string | null
}

/**
 * Fully derived render inputs for one transaction payload body. Memoized per
 * `toolCallId` (the render "instance") in `transactionCache` and keyed on the
 * serialized payload string: when the same instance re-renders with an
 * unchanged payload the cached object is reused without re-walking the
 * payload, and any change to the payload (a replaced `outputRaw` or an
 * in-place mutation) serializes to a different key, discarding that
 * instance's cache entry. Consumers receive a stable per-instance view of
 * this data (see `createConsumerView`) so cache hits keep object identity
 * while staying isolated from render-path mutations. Exported for the test
 * suite.
 */
export type TransactionRenderData = {
  payloadKey: string
  files: TransactionFile[]
  error: string | null
  rows: string[]
  mutation: ToolResultRecord | null
  diffStats: { added: number; removed: number }
}

const TRANSACTION_CACHE_MAX_SIZE = 64
const transactionCache = new LRUCache<string, TransactionRenderData>(
  TRANSACTION_CACHE_MAX_SIZE,
)

function getPayloadKey(outputRaw: unknown): string | null {
  if (typeof outputRaw === 'string') return `string:${outputRaw}`
  try {
    return `json:${JSON.stringify(outputRaw) ?? 'undefined'}`
  } catch {
    // Unserializable payloads (e.g. cyclic references) cannot yield a stable
    // key; returning null forces a recompute instead of stale reuse.
    return null
  }
}

/**
 * Added/removed totals for the collapsed size suffix, summed across the
 * transaction's per-file diffs. Counting is hunk-header agnostic: streaming
 * appends frequently emit a bare hunk body with no `@@` range line, which
 * the hunk-scoped shared parser (`computeDiffStats`) files under its
 * file-header bucket and reports as 0/0 — exactly the payloads this suffix
 * exists to summarize. Git file-header forms (`--- a/…`, `+++ b/…`) are
 * excluded with the same predicates the shared parser applies, so a fully
 * headered diff's totals match the hunk-scoped counting DiffViewer renders.
 */
function computeTransactionDiffStats(
  files: TransactionFile[],
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const file of files) {
    if (typeof file.diff !== 'string') continue
    for (const line of file.diff.split('\n')) {
      if (/^---\s+a\//.test(line) || /^\+\+\+\s+b\//.test(line)) continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

function computeTransactionRenderData(
  toolBlock: ToolBlock,
  payloadKey: string,
): TransactionRenderData {
  const files = getTransactionFiles(toolBlock)
  // Quick-scan size signal on the collapsed line: +N -M totals across the
  // transaction's per-file diffs, so the cost of an edit is visible without
  // expanding the card. Walked here (inside the memo layer), not per render.
  const diffStats = computeTransactionDiffStats(files)
  return {
    payloadKey,
    files,
    error: getTransactionError(toolBlock),
    rows: getTransactionRows(toolBlock),
    mutation: getCanonicalMutationResult(toolBlock.outputRaw),
    diffStats,
  }
}

/**
 * Cache-integrity guard (transaction-cache-mutable-shared): the memoized
 * envelope and every object it OWNS (files entries, rows, diffStats — all
 * derived fresh in computeTransactionRenderData) are frozen, so a stray
 * render-path write cannot corrupt the cache for later renders.
 *
 * The `mutation` record is deliberately NOT frozen: it aliases the caller's
 * live tool-block payload (getCanonicalMutationResult returns a view into
 * outputRaw), and the payload contract supports an in-place payload
 * mutation — freezing it would break that live-update path. Cache safety for
 * it comes from the payload-key invalidation instead (an in-place mutation
 * serializes to a different key, so the stale entry is discarded, exactly
 * like the replaced-outputRaw path).
 */
function freezeCachedRenderData(data: TransactionRenderData): void {
  Object.freeze(data.files)
  for (const file of data.files) Object.freeze(file)
  Object.freeze(data.rows)
  Object.freeze(data.diffStats)
  Object.freeze(data)
}

function isPristineCopy<T>(
  view: readonly T[],
  pristine: readonly T[],
): boolean {
  return (
    view.length === pristine.length &&
    view.every((item, index) => item === pristine[index])
  )
}

/**
 * Stable consumer view for one cache entry (render-data memoization identity
 * contract): every hit on an unchanged payload returns the SAME view object,
 * so an unchanged payload is never re-walked and re-renders observe stable
 * identity. The view wraps the frozen cache data (see freezeCachedRenderData)
 * and serves `files`/`rows` from per-entry scratch copies: when a render-path
 * consumer mutates the previously exposed copy — the
 * transaction-cache-mutable-shared audit finding — the next access re-exposes
 * a fresh shallow copy of the frozen data, so hostile mutations stay isolated
 * from the cache and from later renders without cloning on every hit.
 */
function createConsumerView(
  data: TransactionRenderData,
): TransactionRenderData {
  let filesView: TransactionFile[] = []
  let rowsView: string[] = []
  const view: TransactionRenderData = {
    get payloadKey() {
      return data.payloadKey
    },
    get files() {
      if (!isPristineCopy(filesView, data.files)) {
        filesView = [...data.files]
      }
      return filesView
    },
    get error() {
      return data.error
    },
    get rows() {
      if (!isPristineCopy(rowsView, data.rows)) {
        rowsView = [...data.rows]
      }
      return rowsView
    },
    get mutation() {
      return data.mutation
    },
    get diffStats() {
      return data.diffStats
    },
  }
  return Object.freeze(view)
}

/**
 * Per-instance memoization layer for the transaction render body: keyed by
 * `toolCallId` and reset whenever the incoming payload no longer serializes
 * to the cached key, so a different payload can never reuse another block's
 * cached results. The tool components here are render callbacks (no hooks),
 * so the cache must live at module scope; the payload-key mismatch clause is
 * the invalidation boundary instead of component state. Hits return the same
 * consumer view object every time (see createConsumerView), so an unchanged
 * payload is never re-walked, and the view's self-healing collection copies
 * keep render-path mutations away from the frozen cache data (see
 * freezeCachedRenderData).
 */
export function getTransactionRenderData(
  toolBlock: ToolBlock,
): TransactionRenderData {
  const payloadKey = getPayloadKey(toolBlock.outputRaw)
  const cached =
    payloadKey === null
      ? undefined
      : transactionCache.get(toolBlock.toolCallId)
  if (cached && cached.payloadKey === payloadKey) {
    // The cached view serves the payloadKey of the frozen derivation it
    // wraps, so this check validates the entry against the payload it was
    // built from before reusing it.
    return cached
  }
  const data = computeTransactionRenderData(toolBlock, payloadKey ?? '')
  if (payloadKey !== null) {
    freezeCachedRenderData(data)
    const view = createConsumerView(data)
    transactionCache.set(toolBlock.toolCallId, view)
    return view
  }
  return data
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
  return errors.length > 0 ? redactCapabilityText(errors.join('\n')) : null
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
    // The transaction payload body is parsed once per distinct payload (see
    // getTransactionRenderData), not re-derived on every render.
    const { files, error, rows, mutation, diffStats } =
      getTransactionRenderData(toolBlock)
    const queued = isQueued(toolBlock)
    const title = 'Edit transaction'
    // Quick-scan size signal on the collapsed line: +N -M totals across the
    // transaction's per-file diffs, so the cost of an edit is visible without
    // expanding the card. Computed inside the memo layer above.
    const sizeSuffix =
      diffStats.added + diffStats.removed > 0
        ? ` (+${diffStats.added} -${diffStats.removed})`
        : ''
    const collapsedPreview = error
      ? error.split('\n')[0]
      : files.length > 0
        ? `${title} • ${files.length} file${files.length === 1 ? '' : 's'}${sizeSuffix}`
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
