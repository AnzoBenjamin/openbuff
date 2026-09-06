import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import { jsonToolResult } from '@codebuff/common/util/messages'

import {
  requestRelevantFiles,
  requestRelevantFilesForTraining,
} from '../../../find-files/request-files-prompt'
import { getFileReadingUpdates } from '../../../get-file-reading-updates'
import { getSearchSystemPrompt } from '../../../system-prompt/search-system-prompt'
import { renderReadFilesResult } from '../../../util/render-read-files-result'
import { countTokens, countTokensJson } from '../../../util/token-counter'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { RequestFilesFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  ParamsExcluding,
  ParamsOf,
} from '@codebuff/common/types/function-params'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'

// Whether to collect full file context (using Claude-4-Opus to pick which
// files to send up). Defaults off; enable per-repo by setting the
// OPENBUFF_COLLECT_FULL_FILE_CONTEXT env var to "1"/"true"/"yes"/"on"
// (case-insensitive), or by adding
// `"collectFullFileContext": true` to the project's openbuff.json under
// `experimental`.
const OPENBUFF_CONFIG_FILE_NAME = 'openbuff.json'
// Maximum number of ancestor directories to scan for openbuff.json. Mirrors
// the SDK's provider-config bound: a monorepo workspace root is typically
// 3-5 levels above a subpackage, so 10 comfortably covers legitimate cases
// while guaranteeing the walk terminates before reaching the filesystem root.
const MAX_ANCESTOR_SCAN_DEPTH = 10
function isFullFileContextEnabled(): boolean {
  const envValue = process.env.OPENBUFF_COLLECT_FULL_FILE_CONTEXT
  if (envValue !== undefined) {
    return /^(1|true|yes|on)$/i.test(envValue.trim())
  }
  // Env var unset: check openbuff.json in the project root or ancestor
  // directories for experimental.collectFullFileContext. Bounded walk that
  // stops at the home directory boundary (security: never walk above the
  // user's home, matching the SDK's provider-config behavior).
  let currentDir = path.resolve(process.cwd())
  const home = os.homedir()
  for (let depth = 0; depth < MAX_ANCESTOR_SCAN_DEPTH; depth++) {
    const configPath = path.join(currentDir, OPENBUFF_CONFIG_FILE_NAME)
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        if (config?.experimental?.collectFullFileContext === true) {
          return true
        }
      } catch {
        // Malformed config at this level — skip and keep walking.
      }
    }
    if (currentDir === home) {
      return false
    }
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return false
    }
    currentDir = parentDir
  }
  return false
}

export const handleFindFiles = (async (
  params: {
    previousToolCallFinished: Promise<any>
    toolCall: CodebuffToolCall<'find_files'>
    logger: Logger

    agentState: AgentState
    agentStepId: string
    clientSessionId: string
    fileContext: ProjectFileContext
    fingerprintId: string
    repoId: string | undefined
    userId: string | undefined
    userInputId: string
  } & ParamsExcluding<
    typeof requestRelevantFiles,
    'messages' | 'system' | 'assistantPrompt'
  > &
    ParamsExcluding<
      typeof prepareExpandedFileContextForTraining,
      'messages' | 'system' | 'assistantPrompt'
    > &
    ParamsExcluding<typeof getFileReadingUpdates, 'requestedFiles'>,
): Promise<{ output: CodebuffToolOutput<'find_files'> }> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentState,
    agentStepId,
    clientSessionId,
    fileContext,
    fingerprintId,
    logger,
    userId,
    userInputId,
  } = params
  const { prompt } = toolCall.input

  const fileRequestMessagesTokens = countTokensJson(agentState.messageHistory)
  const system = getSearchSystemPrompt({
    fileContext,
    messagesTokens: fileRequestMessagesTokens,
    logger,
    options: {
      agentStepId,
      clientSessionId,
      fingerprintId,
      userInputId,
      userId,
    },
  })

  await previousToolCallFinished

  const requestedFiles = await requestRelevantFiles({
    ...params,
    messages: agentState.messageHistory,
    system,
    assistantPrompt: prompt,
  })

  if (requestedFiles && requestedFiles.length > 0) {
    const readResult = await getFileReadingUpdates({
      ...params,
      requestedFiles,
    })
    const addedFiles = readResult.results.flatMap((result) =>
      result.status !== 'error' &&
      result.selector !== 'symbols' &&
      typeof result.content === 'string'
        ? [{ path: result.path, content: result.content }]
        : [],
    )

    if (isFullFileContextEnabled() && addedFiles.length > 0) {
      prepareExpandedFileContextForTraining({
        ...params,
        messages: agentState.messageHistory,
        system,
        assistantPrompt: prompt,
      }).catch((error) => {
        logger.error(
          { error },
          'Error preparing expanded file context for training',
        )
      })
    }

    if (addedFiles.length > 0) {
      return {
        output: jsonToolResult(
          renderReadFilesResult(addedFiles, fileContext.tokenCallers ?? {}),
        ),
      }
    }
    return {
      output: jsonToolResult({
        message: `No new relevant files found for prompt: ${prompt}`,
      }),
    }
  } else {
    return {
      output: jsonToolResult({
        message: `No relevant files found for prompt: ${prompt}`,
      }),
    }
  }
}) satisfies CodebuffToolHandlerFunction<'find_files'>

async function prepareExpandedFileContextForTraining(
  params: {
    requestFiles: RequestFilesFn
  } & ParamsOf<typeof requestRelevantFilesForTraining>,
) {
  const { requestFiles } = params
  const files = await requestRelevantFilesForTraining(params)

  const loadedFiles = await requestFiles({ filePaths: files })

  // Prepare a map of:
  // {file_path: {content, token_count}}
  // up to 50k tokens
  const filesToUpload: Record<string, { content: string; tokens: number }> = {}
  for (const file of files) {
    const structuredItem = isReadFilesResultV1(loadedFiles)
      ? loadedFiles.results.find(
          (result) =>
            result.selector === 'file' &&
            result.path === file &&
            result.status !== 'error',
        )
      : undefined
    const content = isReadFilesResultV1(loadedFiles)
      ? structuredItem &&
        'content' in structuredItem &&
        typeof structuredItem.content === 'string'
        ? structuredItem.content
        : undefined
      : loadedFiles[file]
    if (content === null || content === undefined) {
      continue
    }
    const tokens = countTokens(content)
    if (tokens > 50000) {
      break
    }
    filesToUpload[file] = { content, tokens }
  }

  // TODO: Upload mechanism not yet implemented. filesToUpload is prepared
  // (file_path -> {content, tokens}, capped at 50k tokens per file) but the
  // upload endpoint/API/storage target is unknown. Re-enable this upload
  // once the upload mechanism is defined.
}
