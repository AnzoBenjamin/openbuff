import { jsonToolResult } from '@codebuff/common/util/messages'

import { fetchContext7LibraryDocumentation } from '../../../llm-api/context7-api'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

export const handleReadDocs = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<'read_docs'>

    agentStepId: string
    clientSessionId: string
    fingerprintId: string
    logger: Logger
    repoId: string | undefined
    userId: string | undefined
    userInputId: string
    signal?: AbortSignal
    /**
     * Test seam: Context7 key override. Omitted in production, where the key
     * comes from CONTEXT7_API_KEY. The runtime's provider `apiKey` is never
     * forwarded to Context7.
     */
    context7ApiKey?: string
  } & ParamsExcluding<
    typeof fetchContext7LibraryDocumentation,
    'query' | 'topic' | 'tokens' | 'signal' | 'context7ApiKey'
  >,
): Promise<{
  output: CodebuffToolOutput<'read_docs'>
  creditsUsed: number
}> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentStepId,
    clientSessionId,
    fingerprintId,
    logger,
    repoId,
    userId,
    userInputId,

    fetch,
    signal,
  } = params
  const { libraryTitle, topic, max_tokens } = toolCall.input

  const docsStartTime = Date.now()
  const docsContext = {
    toolCallId: toolCall.toolCallId,
    libraryTitle,
    topic,
    max_tokens,
    userId,
    agentStepId,
    clientSessionId,
    fingerprintId,
    userInputId,
    repoId,
  }

  await previousToolCallFinished

  const creditsUsed = 0

  try {
    const documentationResult = await fetchContext7LibraryDocumentation({
      query: libraryTitle,
      topic,
      tokens: max_tokens,
      logger,
      fetch,
      signal,
      ...('context7ApiKey' in params
        ? { context7ApiKey: params.context7ApiKey }
        : {}),
    })

    if (!documentationResult.ok) {
      // N04: keep each failure distinct. Only `not_found` means Context7 has
      // no documentation; auth, rate limit, timeout and network failures say
      // so and give a next step.
      const { status, reason, nextStep, httpStatus, retryAfterSeconds } =
        documentationResult
      const docMsg =
        status === 'not_found'
          ? `No documentation found for "${libraryTitle}"${topic ? ` (topic: ${topic})` : ''}. ${reason}`
          : `Could not fetch documentation for "${libraryTitle}" (${status}): ${reason}`
      logger.warn(
        {
          ...docsContext,
          status,
          httpStatus,
          durationMs: Date.now() - docsStartTime,
        },
        'Documentation request did not return documentation',
      )
      return {
        output: jsonToolResult({
          documentation: docMsg,
          errorMessage: docMsg,
          status,
          reason,
          nextStep,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        }),
        creditsUsed,
      }
    }

    const { documentation, selectedLibrary, alternatives } = documentationResult

    const docsDuration = Date.now() - docsStartTime
    const resultLength = documentation.length
    const estimatedTokens = Math.ceil(resultLength / 4)
    logger.info(
      {
        ...docsContext,
        docsDuration,
        resultLength,
        estimatedTokens,
        hasResults: Boolean(documentation.trim()),
        creditsUsed,
        success: true,
      },
      'Documentation request completed successfully via Context7 API',
    )

    return {
      output: [
        {
          type: 'json' as const,
          value: {
            documentation,
            library: {
              id: selectedLibrary.id,
              title: selectedLibrary.title,
              branch: selectedLibrary.branch,
              lastUpdateDate: selectedLibrary.lastUpdateDate,
              ...(selectedLibrary.trustScore !== undefined
                ? { trustScore: selectedLibrary.trustScore }
                : {}),
              alternatives: alternatives.map((library) => ({
                id: library.id,
                title: library.title,
                branch: library.branch,
                ...(library.trustScore !== undefined
                  ? { trustScore: library.trustScore }
                  : {}),
              })),
            },
          },
        },
      ],
      creditsUsed,
    }
  } catch (error) {
    const docsDuration = Date.now() - docsStartTime
    const errMsg = `Error fetching documentation for "${libraryTitle}": ${
      error instanceof Error ? error.message : 'Unknown error'
    }`
    logger.error(
      {
        ...docsContext,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        docsDuration,
        success: false,
      },
      'Documentation request failed with error',
    )
    return {
      output: jsonToolResult({ documentation: errMsg, errorMessage: errMsg }),
      creditsUsed,
    }
  }
}) satisfies CodebuffToolHandlerFunction<'read_docs'>
