import {
  formatUnsafeToolPathError,
  grantWholeFileReadAuthorization,
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
  // `readCapability` is a required `min(1)` string once the call passes
  // `replaceRangeParams`, so this guard only exists for pre-schema/legacy call
  // shapes that reach the handler without one; those fall through to the
  // strict read-before-edit block below.
  if (toolCall.input.readCapability) {
    const decoded = decodeReadCapabilityToken(toolCall.input.readCapability)
    if (
      typeof decoded === 'string' ||
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
                  : `replace_range blocked: the readCapability belongs to a different project, path, or agent run. Re-read ${path} in this run and copy its cap.v3 token.`,
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
  }

  // Lazy content load: fetch only for whole-file auth freshness before the
  // strict gate, or later for occurrence resolution. Unauthenticated strict
  // calls must hit fresh_read_required without first attempting occurrence
  // resolution (which would surface occurrence_not_found / content-unavailable).
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
  if (hadStoredWholeFileAuthorization) {
    await loadCurrentContent()
  }
  const contentForAuth =
    currentContent === undefined ? null : currentContent
  const hadFreshWholeFileAuthorization =
    typeof contentForAuth === 'string' &&
    isWholeFileReadAuthorizationFresh(
      fileProcessingState,
      path,
      contentForAuth,
    )
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
              ? `replace_range blocked: ${path} changed after its last whole-file read, so the stored authorization was revoked. Call read_files with ranges: [{ "path": "${path}", "startLine": ${recoveryStartLine}, "endLine": ${recoveryEndLine} }] and retry with only its cap.v3 readCapability plus newContent.`
              : `replace_range blocked: strict read-before-edit is enabled and no fresh path-bound read authorization exists for ${path}. Call read_files with ranges: [{ "path": "${path}", "startLine": ${recoveryStartLine}, "endLine": ${recoveryEndLine} }] and retry with its cap.v3 readCapability plus newContent.`,
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

  // This handler is the sole occurrence resolver in the codebase: it resolves
  // the requested occurrence against content read after auth gates pass and
  // forwards absolute lines to the client. The SDK applicator deliberately does
  // not re-resolve occurrence, because two resolutions against two separate
  // reads could diverge.
  const occurrenceTarget = toolCall.input.occurrence
  let resolvedStartLine = toolCall.input.startLine
  let resolvedEndLine = toolCall.input.endLine
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
    const authStart =
      toolCall.input.capabilityStartLine ?? recoveryStartLine
    const authEnd = toolCall.input.capabilityEndLine ?? recoveryEndLine
    const resolved = resolveOccurrenceRangeInCapabilityRange({
      content: occurrenceContent,
      match: occurrenceTarget.match,
      occurrence: occurrenceTarget.occurrence,
      capabilityStartLine: toolCall.input.capabilityStartLine,
      capabilityEndLine: toolCall.input.capabilityEndLine,
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

  // The forwarded payload must match `providerInputSchema` exactly: `sdk/src/
  // run.ts` re-validates it with `clientToolCallSchema.parse` and the SDK
  // applicator re-parses it with `replaceRangeParams.inputSchema`, both of
  // which are `.strict()`. So enumerate provider-shaped fields only: no
  // `occurrence` (already resolved into absolute lines) and none of the derived
  // `capability*` keys added by the input transform.
  const clientToolCall = {
    toolCallId: toolCall.toolCallId,
    toolName: 'replace_range' as const,
    input: {
      path,
      readCapability: toolCall.input.readCapability,
      // The input transform fills startLine/endLine for the non-occurrence
      // path and the resolver above fills them for the occurrence path; the
      // capability bounds are a fallback for pre-schema/legacy call shapes.
      startLine: resolvedStartLine ?? toolCall.input.capabilityStartLine,
      endLine: resolvedEndLine ?? toolCall.input.capabilityEndLine,
      newContent: toolCall.input.newContent,
    },
  }
  const application = await coordinateEditApplication<'replace_range'>({
    toolName: 'replace_range',
    fileProcessingState,
    projectId: params.fileContext?.projectRoot ?? '',
    runId: params.runId ?? '',
    paths: [path],
    apply: () => requestClientToolCall(clientToolCall),
  })
  if (application.status === 'threw') {
    return {
      output: [
        {
          type: 'json' as const,
          value: {
            file: path,
            errorMessage: `replace_range failed while applying the prepared range: ${application.error instanceof Error ? application.error.message : String(application.error)}. Re-read the range before retrying.`,
          },
        },
      ],
    }
  }
  if (application.status === 'applied' && hadFreshWholeFileAuthorization) {
    const updatedContent =
      typeof requestOptionalFile === 'function'
        ? await requestOptionalFile({ ...params, filePath: path })
        : null
    if (typeof updatedContent === 'string') {
      grantWholeFileReadAuthorization(fileProcessingState, path, updatedContent)
    } else {
      revokeWholeFileReadAuthorization(fileProcessingState, path)
    }
  }
  return { output: application.output }
}) satisfies CodebuffToolHandlerFunction<'replace_range'>
