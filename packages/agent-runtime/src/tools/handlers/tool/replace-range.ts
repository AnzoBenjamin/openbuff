import {
  formatUnsafeToolPathError,
  hasWholeFileReadAuthorization,
  isWholeFileReadAuthorizationFresh,
  normalizeToolPath,
  revokeWholeFileReadAuthorization,
} from './write-file'
import {
  coordinateEditApplication,
  invalidatePreparedEditPaths,
} from './edit-application-coordinator'
import {
  decodeReadCapabilityToken,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import type { ReplacementReadCapability } from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  describeRawReadFailure,
  reanchorRawReadCapability,
  spliceDocumentRange,
} from '@codebuff/common/util/byte-text'
import { MAX_TRANSACTION_FILE_BYTES } from '@codebuff/common/actions'

import { resolveOccurrenceRangeInCapabilityRange } from '../../../structural-read'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'

export const handleReplaceRange = (async (params) => {
  const {
    previousToolCallFinished,
    toolCall,
    fileProcessingState,
    requestClientToolCall,
    requestOptionalFile,
  } = params
  const path = normalizeToolPath(toolCall.input.path)
  if (!path) {
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: toolCall.input.path,
            errorMessage: formatUnsafeToolPathError(
              'replace_range',
              toolCall.input.path,
            ),
          },
        },
      ],
    }
  }

  await previousToolCallFinished
  // Recovery/diagnostic line hints must be concrete numbers: startLine/endLine
  // are optional once the occurrence mode is used, and the tool result value is
  // typed as JSONValue (no `undefined`).
  const recoveryStartLine =
    toolCall.input.startLine ?? toolCall.input.capabilityStartLine
  const recoveryEndLine =
    toolCall.input.endLine ?? toolCall.input.capabilityEndLine
  let hasBoundReadCapability = false
  let boundCapability: ReplacementReadCapability | undefined
  // `readCapability` is a required `min(1)` string once the call passes
  // `replaceRangeParams`, so this guard only exists for pre-schema/legacy call
  // shapes that reach the handler without one; those fall through to the
  // strict read-before-edit block below.
  if (toolCall.input.readCapability) {
    const decoded = decodeReadCapabilityToken(toolCall.input.readCapability)
    if (
      typeof decoded === 'string' ||
      decoded.tokenVersion !== 'v4' ||
      !decoded.rawBasis ||
      !readCapabilityMatchesScope(decoded, {
        projectId: params.fileContext?.projectRoot ?? '',
        path,
        runId: params.runId ?? '',
      })
    ) {
      return {
        output: [
          {
            type: 'json' as const,
            value: {
              file: path,
              errorMessage:
                typeof decoded === 'string'
                  ? decoded
                  : `replace_range blocked: the readCapability requires a current authenticated raw basis for this project, path and run. Re-read ${path} and copy its cap.v4 token.`,
              errorCode: 'fresh_read_required',
              recovery: {
                tool: 'read_files',
                input: {
                  paths: [],
                  ranges: [
                    {
                      path,
                      startLine: recoveryStartLine,
                      endLine: recoveryEndLine,
                    },
                  ],
                },
              },
            },
          },
        ],
      }
    }
    hasBoundReadCapability = true
    boundCapability = decoded
  }

  // Authenticate before loading current content or resolving an occurrence.
  // The same lossless capture supplies raw freshness and the prepared splice.
  let currentContent: string | null | undefined
  const loadCurrentContent = async (): Promise<string | null> => {
    if (currentContent !== undefined) {
      return currentContent
    }
    currentContent =
      typeof requestOptionalFile === 'function'
        ? await requestOptionalFile({ ...params, filePath: path })
        : null
    return currentContent
  }

  const hadStoredWholeFileAuthorization = hasWholeFileReadAuthorization(
    fileProcessingState,
    path,
  )
  if (hadStoredWholeFileAuthorization || boundCapability) {
    await loadCurrentContent()
  }
  const relocated =
    boundCapability && typeof currentContent === 'string'
      ? reanchorRawReadCapability({
          content: currentContent,
          capability: boundCapability,
        })
      : undefined
  if (boundCapability && (!relocated || !relocated.ok)) {
    invalidatePreparedEditPaths({
      fileProcessingState,
      paths: [path],
      reason: 'stale_capability',
      sourceTool: 'replace_range',
    })
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: path,
            errorCode: 'fresh_read_required',
            errorMessage: `replace_range blocked: ${relocated && !relocated.ok ? describeRawReadFailure(relocated) : 'a lossless current source is unavailable'}. Re-read the range before editing.`,
          },
        },
      ],
    }
  }
  const contentForAuth = currentContent === undefined ? null : currentContent
  const hadFreshWholeFileAuthorization =
    typeof contentForAuth === 'string' &&
    isWholeFileReadAuthorizationFresh(fileProcessingState, path, contentForAuth)
  if (hadStoredWholeFileAuthorization && !hadFreshWholeFileAuthorization) {
    revokeWholeFileReadAuthorization(fileProcessingState, path)
  }
  if (
    fileProcessingState.strictReadBeforeEdit &&
    !hasBoundReadCapability &&
    !hadFreshWholeFileAuthorization
  ) {
    invalidatePreparedEditPaths({
      fileProcessingState,
      paths: [path],
    })
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: path,
            errorMessage: hadStoredWholeFileAuthorization
              ? `replace_range blocked: ${path} changed after its last whole-file read, so the stored authorization was revoked. Call read_files with ranges: [{ "path": "${path}", "startLine": ${recoveryStartLine}, "endLine": ${recoveryEndLine} }] and retry with only its cap.v4 readCapability plus newContent.`
              : `replace_range blocked: strict read-before-edit is enabled and no fresh path-bound read authorization exists for ${path}. Call read_files with ranges: [{ "path": "${path}", "startLine": ${recoveryStartLine}, "endLine": ${recoveryEndLine} }] and retry with its cap.v4 readCapability plus newContent.`,
            errorCode: 'fresh_read_required',
            recovery: {
              tool: 'read_files',
              input: {
                paths: [],
                ranges: [
                  {
                    path,
                    startLine: recoveryStartLine,
                    endLine: recoveryEndLine,
                  },
                ],
              },
            },
          },
        },
      ],
    }
  }

  // Resolve an occurrence once against the authenticated current raw capture.
  // The SDK receives exact prepared content and verifies its raw preimage.
  const occurrenceTarget = toolCall.input.occurrence
  const shift = relocated?.ok ? (relocated.shiftedBy ?? 0) : 0
  let resolvedStartLine =
    (toolCall.input.startLine ?? recoveryStartLine) + shift
  let resolvedEndLine = (toolCall.input.endLine ?? recoveryEndLine) + shift
  if (occurrenceTarget) {
    const occurrenceContent = await loadCurrentContent()
    if (typeof occurrenceContent !== 'string') {
      return {
        output: [
          {
            type: 'json' as const,
            value: {
              file: path,
              errorMessage: `replace_range blocked: could not read current content of ${path} to resolve the requested occurrence. Re-read the range and retry.`,
              errorCode: 'fresh_read_required',
              recovery: {
                tool: 'read_files' as const,
                input: { paths: [path] },
              },
            },
          },
        ],
      }
    }
    const authStart = toolCall.input.capabilityStartLine ?? recoveryStartLine
    const authEnd = toolCall.input.capabilityEndLine ?? recoveryEndLine
    const resolved = resolveOccurrenceRangeInCapabilityRange({
      content: captureTextDocument(occurrenceContent).observation,
      match: occurrenceTarget.match,
      occurrence: occurrenceTarget.occurrence,
      capabilityStartLine: relocated?.ok
        ? relocated.startLine
        : toolCall.input.capabilityStartLine,
      capabilityEndLine: relocated?.ok
        ? relocated.endLine
        : toolCall.input.capabilityEndLine,
    })
    if (!resolved.range) {
      const requested = occurrenceTarget.occurrence ?? 1
      return {
        output: [
          {
            type: 'json' as const,
            value: {
              file: path,
              errorMessage: `replace_range found ${resolved.found} occurrence(s) of the requested match inside the authorized range ${authStart}-${authEnd} of ${path}, so occurrence ${requested} does not exist. Re-read the range and target an existing occurrence or absolute lines.`,
              errorCode: 'occurrence_not_found',
              recovery: {
                tool: 'read_files' as const,
                input: { paths: [path] },
              },
            },
          },
        ],
      }
    }
    resolvedStartLine = resolved.range.startLine
    resolvedEndLine = resolved.range.endLine
  }

  if (
    typeof currentContent !== 'string' ||
    !relocated?.ok ||
    !Number.isSafeInteger(resolvedStartLine) ||
    !Number.isSafeInteger(resolvedEndLine) ||
    resolvedStartLine < relocated.startLine ||
    resolvedEndLine > relocated.endLine ||
    resolvedEndLine < resolvedStartLine
  ) {
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: path,
            errorCode: 'fresh_read_required',
            errorMessage:
              'replace_range requires a lossless current source and a contained authenticated range. Re-read the range before editing.',
          },
        },
      ],
    }
  }
  const document = captureTextDocument(currentContent)
  let updatedContent: string
  try {
    updatedContent = spliceDocumentRange(
      document,
      resolvedStartLine,
      resolvedEndLine,
      toolCall.input.newContent,
    )
    if (Buffer.byteLength(updatedContent) > MAX_TRANSACTION_FILE_BYTES) {
      throw new RangeError('Prepared content exceeds the per-file byte limit')
    }
  } catch {
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: path,
            errorMessage:
              'replace_range rejected invalid replacement text, bounds or an oversized prepared file.',
          },
        },
      ],
    }
  }

  const clientToolCall = {
    toolCallId: toolCall.toolCallId,
    toolName: 'replace_range' as const,
    input: {
      type: 'file' as const,
      path,
      content: updatedContent,
      expectedHash: document.observationHash,
      expectedRawHash: document.rawHash,
    },
  }
  const application = await coordinateEditApplication<'replace_range'>({
    toolName: 'replace_range',
    fileProcessingState,
    projectId: params.fileContext?.projectRoot ?? '',
    runId: params.runId ?? '',
    paths: [path],
    wholeFileContentByPath: new Map([[path, updatedContent]]),
    apply: () => requestClientToolCall(clientToolCall),
  })
  if (application.status === 'threw') {
    // M2-T6: the raw application error can leak internal details into
    // agent-visible tool output; emit only the static recovery message.
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: path,
            errorMessage:
              'replace_range failed while applying the prepared range. Re-read the range before retrying.',
          },
        },
      ],
    }
  }
  // The coordinator refreshes authority only from exact confirmed after-content.
  return { output: application.output }
}) satisfies CodebuffToolHandlerFunction<'replace_range'>
